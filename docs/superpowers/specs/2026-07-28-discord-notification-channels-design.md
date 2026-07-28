# Discord Notification Channels — Design

Date: 2026-07-28
Status: approved in brainstorming
Follow-up to: `2026-07-27-callya-balance-lte-guard-design.md` (which added the last
batch of alerts and pushed the single webhook past the noise threshold).

## Goal

Split the single Discord webhook into three severity-tiered channels so routine
telemetry can be muted in Discord without also silencing outage alerts.

Today every message from every subsystem — bridge monitor, DOCSIS collector, LTE
monitor — lands in one channel via `notify(message, color)` in `src/notify.mjs`.
There are 29 distinct messages. Muting that channel to escape the routine ones
(monthly drill OK, T3/T4 timeouts, the "failover still active" tick every 30 minutes)
also mutes "bridge mode lost" and "ALL DOWN". That trade-off is the problem.

## Context (as deployed 2026-07-27)

- Collector container `vodafone-bridge-monitor` on the NUC (192.168.0.37); dashboard
  on :8799; Discord via `src/notify.mjs`.
- `notify.mjs` reads `DISCORD_WEBHOOK_URL` into a module-level `const` at import time
  and posts a single-embed payload titled "Vodafone Bridge Monitor".
- Alerts originate two ways: pure derive functions returning `{message, color}`
  arrays (`deriveAlerts` in `src/collector.mjs`, `deriveLteAlerts` in `src/lte.mjs`),
  and ~8 direct `notify()` / `send()` calls in `src/index.mjs` and
  `src/lte-monitor.mjs`.
- Zero npm runtime dependencies; pure logic modules tested with `node --test`.
- `notify.mjs` has no test file today.

## Decisions (brainstorming outcomes)

1. **Three channels split by severity** — `#vf-critical`, `#vf-warn`, `#vf-log` —
   not two, and not by subsystem. Three gives a middle tier so "CallYa balance low"
   does not sit next to "ALL DOWN". Subsystem splitting was rejected: the messages
   are already self-describing, and it would mean four webhooks to wire.
2. **No `@mention` in the payload.** Loudness is controlled entirely from Discord's
   per-channel notification settings, so it can change without a redeploy.
3. **Tier is declared explicitly at each message site**, not derived from colour.
   Colour and tier are not correlated — `Color.YELLOW` covers both "balance low"
   (warn) and "T3/T4 timeouts" (log); `Color.GREEN` covers both "DOCSIS back online"
   (critical) and "monitor started" (log).
4. **Colour is retained** alongside tier. It still carries good/bad information
   *within* a tier: a green "drill OK" and a yellow "T3/T4 timeout" are both `LOG`.
5. **Recovery pairing rule**: a recovery notification is assigned the same tier as
   the problem it clears. See "Recovery pairing" below.
6. **Backward compatible by construction** — the existing single-webhook deployment
   keeps working with no config change.

## Routing model

`src/notify.mjs` gains an exported `Tier` constant:

```js
export const Tier = {
  CRITICAL: "critical",
  WARN: "warn",
  LOG: "log",
};
```

Signature becomes:

```js
export async function notify(message, color = Color.RED, tier = Tier.WARN)
```

`Tier.WARN` is the default for unclassified messages — visible, but not screaming.
Defaulting to `CRITICAL` would be how alert fatigue starts; defaulting to `LOG`
would risk silently swallowing something new.

### Webhook resolution

| Env var | Channel |
|---|---|
| `DISCORD_WEBHOOK_CRITICAL` | `#vf-critical` |
| `DISCORD_WEBHOOK_WARN` | `#vf-warn` |
| `DISCORD_WEBHOOK_LOG` | `#vf-log` |
| `DISCORD_WEBHOOK_URL` | fallback for any tier left unset |

Resolution order for a given tier:

1. The tier-specific variable, if set and non-empty.
2. `DISCORD_WEBHOOK_URL`, if set and non-empty.
3. Neither → log locally via `log()` and skip the POST (current no-webhook behaviour).

This makes the change backward compatible: set none of the three new variables and
all tiers collapse onto the existing `DISCORD_WEBHOOK_URL`, behaving exactly as
today. Partial configuration also works — set only `DISCORD_WEBHOOK_LOG` and the
noisy tier moves to its own channel while critical and warn stay on the old webhook.

### Read env at call time

Resolution happens inside the function on every call, not in a module-level `const`
at import time. The current import-time capture makes webhook configuration
untestable, and adding four variables would multiply that problem. This is a
targeted fix to existing code in service of the current goal, not general
refactoring.

The local `log()` line stays unconditional, so the console remains a complete record
of every notification regardless of tier or webhook configuration.

## Tier assignment

All 29 messages, with their source location. The drill row in WARN covers two
distinct messages (the `r.ok === false` branch and the thrown-error branch), so the
tables have 28 rows for 29 messages.

### CRITICAL — act now

| Message | Source |
|---|---|
| Bridge mode lost, restoring | `index.mjs:73` |
| Bridge mode successfully re-enabled | `index.mjs:102` |
| After reboot, mode is not bridge — may need manual check | `index.mjs:105` |
| DOCSIS no longer online | `collector.mjs:89` |
| DOCSIS back online | `collector.mjs:93` |
| Failover active — traffic running over LTE | `lte.mjs:88` |
| Failover ended after N min | `lte.mjs:95` |
| ALL DOWN — cable down and LTE unavailable/disarmed | `lte.mjs:100` |
| LTE guard chain missing on the Flint | `lte.mjs:151` |
| LTE guard relock FAILED — guard stuck open | `lte-monitor.mjs:138` |

### WARN — act today

| Message | Source |
|---|---|
| Error during check | `index.mjs:143` |
| CallYa balance low | `lte.mjs:131` |
| LTE backup looks broken (health ping failed) | `lte.mjs:120` |
| LTE guard was opened outside the dashboard — re-locked | `lte-monitor.mjs:130` |
| Monthly LTE drill FAILED | `lte-monitor.mjs:172`, `lte-monitor.mjs:176` |
| Monthly LTE drill skipped — fallback disarmed | `lte-monitor.mjs:179` |

### LOG — mutable record

| Message | Source |
|---|---|
| Monitor started | `index.mjs:167` |
| Station firmware changed | `collector.mjs:80` |
| Upstream TX power critical | `collector.mjs:100` |
| Upstream TX power recovered | `collector.mjs:106` |
| T3/T4 ranging time-outs | `collector.mjs:116` |
| LTE fallback armed | `lte.mjs:109` |
| LTE fallback disarmed | `lte.mjs:110` |
| LTE guard opened | `lte.mjs:141` |
| LTE guard locked | `lte.mjs:146` |
| LTE guard re-locked on startup | `lte-monitor.mjs:132` |
| LTE failover still active (30-min tick) | `lte-monitor.mjs:155` |
| Monthly LTE drill OK | `lte-monitor.mjs:171` |

### Recovery pairing

A recovery notification takes the same tier as the problem it clears. Applied:

- DOCSIS offline (`CRITICAL`) → DOCSIS back online (`CRITICAL`)
- Failover active (`CRITICAL`) → failover ended (`CRITICAL`)
- US power critical (`LOG`) → US power recovered (`LOG`)
- Guard opened (`LOG`) → guard locked (`LOG`)
- LTE disarmed (`LOG`) → LTE armed (`LOG`)

Without this rule, "upstream TX power recovered" would ping `#vf-critical` for a
problem whose onset was never announced there. The rule guarantees no green message
notifies about a condition its red counterpart did not.

Note the asymmetry this creates with the drill: "drill FAILED" is `WARN` while
"drill OK" is `LOG`. This is intentional and not a violation of the rule — the drill
result is a fresh monthly observation, not a recovery edge clearing a prior alert.

## Where tier is declared

Tier lives next to the message text, so there is one place to look and no separate
routing table to keep in sync.

**Derive functions** — `deriveAlerts` (`src/collector.mjs`) and `deriveLteAlerts`
(`src/lte.mjs`) already return `{message, color}` objects; each gains a `tier` field.
Both remain pure, and their dispatch loops become:

```js
for (const a of alerts) await notify(a.message, a.color, a.tier);
```

**Direct calls** — the sites in `src/index.mjs` and `src/lte-monitor.mjs` pass their
tier as a third argument. In `lte-monitor.mjs` these go through the injected `send`
dependency, which defaults to `notify` and therefore takes the same third argument.

No new module is introduced. The change is confined to `notify.mjs` (routing) plus a
one-argument addition at each message site.

## Testing

**New `src/notify.test.mjs`** — the module has no tests today. `fetch` is stubbed by
assigning `globalThis.fetch`, and `process.env` is set per test (possible only
because resolution moved to call time). Cases:

- Each tier POSTs to its own configured webhook URL.
- A tier with no specific variable falls back to `DISCORD_WEBHOOK_URL`.
- A tier with a specific variable ignores `DISCORD_WEBHOOK_URL`.
- No variables set → no fetch call, no throw.
- Empty-string variable is treated as unset.
- A rejecting `fetch` is swallowed and does not throw (existing behaviour; the
  webhook is expected to fail exactly when the network is down).
- The posted body still carries the message and colour in the embed.

**`src/collector.test.mjs` and `src/lte.test.mjs`** — extend the existing alert
assertions so every derived alert asserts its `tier` alongside `message` and `color`.

**`src/lte-monitor.test.mjs`** — the `send` spy currently captures `(msg, color)`;
widen to `(msg, color, tier)` and assert tier on the guard relock paths (startup
relock is `LOG`, outside-dashboard relock is `WARN`, relock failure is `CRITICAL`)
and the drill paths (OK is `LOG`, FAILED and skipped are `WARN`).

## Deployment

1. Create three Discord channels and a webhook for each.
2. Add `DISCORD_WEBHOOK_CRITICAL`, `DISCORD_WEBHOOK_WARN`, `DISCORD_WEBHOOK_LOG` to
   `.env` on the NUC. Keep `DISCORD_WEBHOOK_URL` as the safety net for any tier
   whose variable is missing or mistyped.
3. Set Discord notification preferences per channel: `#vf-critical` to All Messages
   with mobile push, `#vf-warn` to default, `#vf-log` muted.
4. Update `.env.example` and the README's configuration section with the three new
   variables and the fallback rule.

## Out of scope

- Per-message rate limiting or digesting. The edge-triggered alert pattern in the
  derive functions already prevents repeat spam; the 30-minute failover tick is
  deliberate and now lands in the muted channel.
- Changing the embed title ("Vodafone Bridge Monitor") or adding a subsystem field.
  The messages are self-describing.
- Routing dashboard or collector events anywhere other than Discord.
- Configurable `@mention` on critical messages. Rejected in favour of Discord's
  per-channel settings; revisit only if a muted-server-at-night case appears.
