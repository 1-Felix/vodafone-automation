# CallYa Balance Display + LTE Guard — Design

Date: 2026-07-27
Status: approved in brainstorming
Follow-up to: `2026-07-27-spitz-plus-callya-failover-design.md` (items "CallYa balance
display" and "Traffic shaping / blocking bulk traffic while on LTE" from its
out-of-scope list; Dayflat booking and Home Assistant integration remain out of scope).

## Goal

Two additions to the deployed LTE failover monitor:

1. **CallYa balance display** — show the prepaid balance on the dashboard and alert on
   Discord when it drops below €10, so the failover never silently dies on empty credit.
2. **LTE guard** — while traffic runs over LTE, only allowlisted devices (NUC,
   Felix-PC) get through; everything else (IoT, TVs, speakers, …) is blocked. A
   dashboard button opens LTE for all devices for 60 minutes, then auto-relocks.
   Rationale: CallYa bills per byte (3 ct/MB), and measured household background
   traffic burns €6–10/h — throttling would not cap that, blocking does.

## Context (as deployed 2026-07-27)

- Collector container `vodafone-bridge-monitor` on the NUC (192.168.0.37) SSHes to
  the Flint (192.168.0.1, dropbear, key mounted at `/app/ssh/`) for state, byte
  counters, kill switch; dashboard on :8799; Discord via `src/notify.mjs`.
- Spitz Plus (GL-X2000, fw 4.0) is the LTE WAN on Flint port lan5 (`secondwan`,
  metric 15). Its admin/LAN IP 192.168.8.1 is reachable from the NUC through the
  Flint's masquerade (verified: rpc challenge answers, HTTP 200).
- Flint: OpenWrt 21.02 (GL 4.x), fw3/iptables. Felix-PC (MAC `04:7C:16:07:D8:70`)
  currently has a dynamic lease on 192.168.0.59; NUC has a static lease on .37.
- Zero npm runtime dependencies; pure logic modules with `node --test`; edge-triggered
  alert pattern in `deriveLteAlerts` (`src/lte.mjs`).

## Decisions (brainstorming outcomes)

1. Balance via **USSD `*100#` through the Spitz over SSH** (free, authoritative) —
   not the GL rpc HTTP API (would require a no-dependency sha256-crypt
   implementation), not SMS (costs money, no reliable keyword), not MeinVodafone
   scraping (brittle, credentials).
2. Low-balance alert threshold **€10**, repeated at most once per 24 h while below.
3. Guard policy: **hybrid device allowlist + temporary open toggle**. Allowlist =
   NUC (192.168.0.37) + Felix-PC (192.168.0.59). Router-originated traffic (health
   ping, drill) is unaffected (it is OUTPUT, not FORWARD).
4. Guard is a **static, persistent firewall chain** — inert while cable is up because
   nothing routes out lan5 then; no activation state machine, no hotplug coupling.
5. Open toggle auto-relocks after **60 minutes**; Flint reboot and collector restart
   also return to locked (same "safe by default" philosophy as the kill switch).

## Feature 1: CallYa balance

### Spitz SSH client (new `src/spitz.mjs`)

- Same `execFile("ssh")` pattern as `src/flint.mjs`; env `SPITZ_SSH_HOST`
  (default `192.168.8.1`), `SPITZ_SSH_USER` (`root`), key/known_hosts shared with the
  Flint mount. Deploy step: authorize the container key on the Spitz dropbear and add
  its host key to `known_hosts`.
- `queryBalanceRaw()` issues `AT+CUSD=1,"*100#",15` on the modem. The exact AT
  wrapper on GL fw 4.x (`gl_modem`, ubus modem service, or direct tty via microcom)
  is a discovery step at the start of implementation; the design only assumes "run an
  AT command over SSH, get the response text back".
- `parseUssdBalance(raw) -> {eur: number, text: string} | null` — pure, tested.
  Handles plain GSM text (`… X,XX EUR …`) and UCS2-hex payloads (all-hex string →
  UTF-16BE decode). Unparseable → `null`; raw text is still logged and shown.

### Scheduling, persistence, display

- Check cadence: once per day (first tick after 06:00 Berlin) + once when a failover
  session closes. Predicate `isBalanceCheckDue(...)` pure and tested (pattern of
  `isDrillDue`).
- Persist `{ts, eur, text}` to `data/lte-balance.jsonl`; last entry restored on
  startup.
- Dashboard tile: `Guthaben: X,XX € (checked <ts>)`; warning styling below
  `BALANCE_LOW_EUR`; "stale" marker when the last successful check is older than 48 h.
- Alerts (in `deriveLteAlerts`): balance below threshold → YELLOW, edge-triggered on
  crossing, repeated max once per 24 h while low. Persistent query failure (>3 days
  without a successful check) → single rate-limited YELLOW alert.
- A failed balance check never affects the failover/metering logic; it only degrades
  the tile to stale.

## Feature 2: LTE guard

### Flint-side (applied during deploy, persisted)

- Firewall include script (e.g. `/etc/firewall.lte_guard`, registered as a `uci`
  firewall include with reload) that idempotently rebuilds:
  - chain `lte_guard`: `RETURN` for 192.168.0.37 and 192.168.0.59, then
    `REJECT --reject-with icmp-admin-prohibited` (fail fast, not silent drop);
  - hook `-I forwarding_rule -o lan5 -j lte_guard` (delete-then-insert, idempotent).
- Static DHCP reservation for Felix-PC (`04:7C:16:07:D8:70` → 192.168.0.59) so the
  allowlisted IP stays stable.
- Allowlist changes are a Flint config edit (rerun of the include), not collector
  runtime state — YAGNI: no UI for editing the list.

### Collector-side (`src/flint.mjs` + `src/lte-monitor.mjs`)

- `getGuardState() -> "locked" | "open" | "missing"` — from `iptables -S lte_guard`;
  parser `parseGuardState(output)` pure and tested. `missing` = chain absent (include
  not installed / manually removed).
- `openGuard()` = `iptables -I lte_guard 1 -j ACCEPT`; `relockGuard()` = rerun the
  include script (rebuild). Collector starts a 60-min timer (`GUARD_OPEN_MINUTES`)
  on open; on expiry, relocks.
- Failure handling: relock failure → RED Discord alert + retry every tick until
  locked (a stuck-open guard is a money leak, so it is loud). Open failure → dashboard
  button surfaces the error; state unchanged.
- Collector restart while open: startup relocks unconditionally (safe default);
  a Discord line notes the relock-on-startup if the guard was open.
- Guard state is read during the normal tick and included in `/api/status`.

### Dashboard + alerts

- Guard row: state badge (`locked` / `OPEN` / `⚠ missing`) + button
  "Open for all (60 min)" ↔ "Relock now" → `POST /api/guard`.
- Discord (edge-triggered): opened (YELLOW, names the auto-relock time), relocked
  (GREEN, whether by button, timer, or startup), `missing` detected (RED, rate-limited).

## Config additions (.env)

```
SPITZ_SSH_HOST=192.168.8.1
SPITZ_SSH_USER=root
BALANCE_LOW_EUR=10
GUARD_OPEN_MINUTES=60
```

Key/known_hosts paths reuse the existing `FLINT_SSH_KEY` / `FLINT_KNOWN_HOSTS` mount.

## Error handling summary

- Spitz SSH unreachable: balance check logs and skips (dead-Spitz alerting already
  exists via the health ping); tile goes stale.
- USSD garbage: `parseUssdBalance` returns `null`, raw kept, no crash.
- Guard SSH failures: open fails visibly; relock retries loudly (RED).
- All new logic is additive — failover detection, metering, kill switch, and drill
  are untouched by failures in balance or guard paths.

## Testing

- Unit (`node --test`): `parseUssdBalance` (plain, UCS2-hex, garbage, comma/point
  decimals), `parseGuardState` (locked/open/missing outputs), `isBalanceCheckDue`,
  new `deriveLteAlerts` edges (low balance crossing + 24 h repeat, guard open/relock/
  missing), guard-timer behavior in `lte-monitor` with fake flint/spitz.
- Acceptance (live, costs cents):
  1. Balance tile matches `*100#` dialed on a phone; Discord low-balance alert
     verifiable by temporarily setting `BALANCE_LOW_EUR` above the real balance.
  2. Guard locked + `ifdown wan`: NUC and Felix-PC have connectivity via LTE; another
     device (e.g. a Shelly or a phone on Wi-Fi) is provably blocked.
  3. Dashboard open → blocked device works; auto-relock after 60 min (or shortened
     via env for the test) → blocked again; Discord messages for both.
  4. `ifup wan` → normal traffic for all devices (guard inert on cable).
  5. Flint reboot → guard present and locked (include persisted).

## Out of scope (unchanged)

- Automated Dayflat booking via Spitz SMS API.
- Home Assistant integration (MQTT sensors).
