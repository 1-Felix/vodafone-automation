# Discord Notification Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the 29 Discord notifications into three severity-tiered channels (critical / warn / log) so routine telemetry can be muted without silencing outage alerts.

**Architecture:** `src/notify.mjs` gains a `Tier` constant and resolves a webhook URL per tier at call time, falling back to the existing `DISCORD_WEBHOOK_URL` for any tier left unconfigured. Every message site declares its tier explicitly — the two pure alert-deriving functions gain a `tier` field on the objects they already return, and the direct `notify()` / `send()` calls pass tier as a third argument.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies, `node --test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-28-discord-notification-channels-design.md`

## Global Constraints

- Zero npm runtime dependencies. Do not add packages. Use built-in `fetch` and `node:test`.
- ESM only (`"type": "module"`). Use `import`, not `require`.
- Run the full suite with `pnpm test` (which runs `node --test`). Never `npm`.
- Use real Unicode characters in strings (`≈`, `→`, `€`, `—`), never `\uXXXX` escapes.
- No `Co-Authored-By` line and no Claude attribution in commit messages.
- Backward compatibility is mandatory: with only `DISCORD_WEBHOOK_URL` set, behaviour must be identical to today. Existing `.env` on the NUC must keep working untouched.
- Tier values are the exact strings `"critical"`, `"warn"`, `"log"`.
- The local `log()` call in `notify()` stays unconditional — the console remains a complete record regardless of webhook configuration.

---

### Task 1: Tier constant and per-tier webhook routing

**Files:**
- Modify: `src/notify.mjs` (whole file, currently 35 lines)
- Create: `src/notify.test.mjs`
- Modify: `.env.example:4`
- Modify: `README.md:89` (config table)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const Tier = { CRITICAL: "critical", WARN: "warn", LOG: "log" }`
  - `export function resolveWebhook(tier: string): string | null`
  - `export async function notify(message: string, color?: number, tier?: string): Promise<void>` — `color` defaults to `Color.RED`, `tier` defaults to `Tier.WARN`
  - `export const Color = { RED, GREEN, YELLOW }` (unchanged values, moved above `notify` in the file)

Tasks 2–4 all import `Tier` from this module and pass it as the third argument to `notify` / `send`.

- [ ] **Step 1: Write the failing test**

Create `src/notify.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { notify, resolveWebhook, Color, Tier } from "./notify.mjs";

const ENV_KEYS = [
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_CRITICAL",
  "DISCORD_WEBHOOK_WARN",
  "DISCORD_WEBHOOK_LOG",
];

// Clears all four vars, applies `vars`, runs `fn`, then restores. Must await
// fn before restoring or the finally block would run mid-request.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("each tier posts to its own webhook", async () => {
  const f = captureFetch();
  try {
    await withEnv({
      DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
      DISCORD_WEBHOOK_WARN: "https://d/warn",
      DISCORD_WEBHOOK_LOG: "https://d/log",
    }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.YELLOW, Tier.WARN);
      await notify("c", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/crit", "https://d/warn", "https://d/log"]);
});

test("a tier with no webhook of its own falls back to DISCORD_WEBHOOK_URL", async () => {
  const f = captureFetch();
  try {
    await withEnv({
      DISCORD_WEBHOOK_URL: "https://d/all",
      DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
    }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/crit", "https://d/all"]);
});

test("legacy single-webhook config routes every tier to DISCORD_WEBHOOK_URL", async () => {
  const f = captureFetch();
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.YELLOW, Tier.WARN);
      await notify("c", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/all", "https://d/all", "https://d/all"]);
});

test("no webhook configured sends nothing and does not throw", async () => {
  const f = captureFetch();
  try {
    await withEnv({}, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
    });
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 0);
});

test("empty-string webhook counts as unset", async () => {
  await withEnv({ DISCORD_WEBHOOK_LOG: "", DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
    assert.equal(resolveWebhook(Tier.LOG), "https://d/all");
  });
  await withEnv({ DISCORD_WEBHOOK_URL: "" }, async () => {
    assert.equal(resolveWebhook(Tier.WARN), null);
  });
});

test("tier defaults to warn when omitted", async () => {
  await withEnv({
    DISCORD_WEBHOOK_WARN: "https://d/warn",
    DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
  }, async () => {
    const f = captureFetch();
    try {
      await notify("no tier given", Color.YELLOW);
    } finally {
      f.restore();
    }
    assert.equal(f.calls[0].url, "https://d/warn");
  });
});

test("embed carries the message and colour", async () => {
  const f = captureFetch();
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      await notify("hello **world**", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.embeds[0].description, "hello **world**");
  assert.equal(body.embeds[0].color, Color.GREEN);
});

test("webhook failure is swallowed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      // Reaching the next line without throwing is the assertion: the webhook
      // fails exactly when the network is down, which is when we alert most.
      await notify("during an outage", Color.RED, Tier.CRITICAL);
    });
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --test-name-pattern="tier"`

Expected: FAIL — `Tier` and `resolveWebhook` are not exported from `./notify.mjs`, so the import yields `undefined` and the first tier test throws.

- [ ] **Step 3: Rewrite `src/notify.mjs`**

Replace the entire file with:

```js
import { log } from "./log.mjs";

export const Color = {
  RED: 0xff0000,
  GREEN: 0x00ff00,
  YELLOW: 0xffaa00,
};

export const Tier = {
  CRITICAL: "critical",
  WARN: "warn",
  LOG: "log",
};

const TIER_ENV = {
  [Tier.CRITICAL]: "DISCORD_WEBHOOK_CRITICAL",
  [Tier.WARN]: "DISCORD_WEBHOOK_WARN",
  [Tier.LOG]: "DISCORD_WEBHOOK_LOG",
};

/**
 * Webhook for a tier: its own channel, else the shared fallback, else nothing.
 * Read from process.env on every call rather than captured at import time —
 * import-time capture made webhook config untestable, and there are four vars now.
 * Empty strings count as unset so a blank line in .env falls through.
 */
export function resolveWebhook(tier) {
  const specific = process.env[TIER_ENV[tier] ?? ""];
  if (specific) return specific;
  return process.env.DISCORD_WEBHOOK_URL || null;
}

export async function notify(message, color = Color.RED, tier = Tier.WARN) {
  log(`[Discord:${tier}] ${message}`);

  const url = resolveWebhook(tier);
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Vodafone Bridge Monitor",
            description: message,
            color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    // Silently ignore — webhook failures are expected when the network is
    // disrupted (which is exactly when bridge mode gets lost).
  }
}
```

Two things to note while editing. `Color` moves above `notify` so the `color = Color.RED` default reads top-down (default params evaluate at call time, so declaration order is not strictly required, but the file is clearer this way). The `log()` line now carries the tier, which makes the container log show routing decisions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`

Expected: PASS — all 8 new `notify.test.mjs` tests plus every pre-existing test. The existing suites still pass unchanged because all current call sites pass two arguments and land on the `Tier.WARN` default.

- [ ] **Step 5: Document the new variables**

In `.env.example`, replace line 4 (`DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook`) with:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook
# Optional per-severity channels. Any tier left unset falls back to
# DISCORD_WEBHOOK_URL above, so setting none of these keeps current behaviour.
# DISCORD_WEBHOOK_CRITICAL=https://discord.com/api/webhooks/your/critical
# DISCORD_WEBHOOK_WARN=https://discord.com/api/webhooks/your/warn
# DISCORD_WEBHOOK_LOG=https://discord.com/api/webhooks/your/log
```

In `README.md`, the config table has this row at line 89:

```
| `DISCORD_WEBHOOK_URL` | — | Optional Discord webhook for notifications |
```

Add three rows directly below it:

```
| `DISCORD_WEBHOOK_CRITICAL` | — | Optional `#vf-critical` webhook (outages, failover, bridge lost). Falls back to `DISCORD_WEBHOOK_URL` |
| `DISCORD_WEBHOOK_WARN` | — | Optional `#vf-warn` webhook (balance low, backup broken, poll errors). Falls back to `DISCORD_WEBHOOK_URL` |
| `DISCORD_WEBHOOK_LOG` | — | Optional `#vf-log` webhook (signal telemetry, state toggles, drill OK). Falls back to `DISCORD_WEBHOOK_URL` |
```

- [ ] **Step 6: Commit**

```bash
git add src/notify.mjs src/notify.test.mjs .env.example README.md
git commit -m "Route Discord notifications by severity tier"
```

---

### Task 2: Tier on the DOCSIS collector alerts

**Files:**
- Modify: `src/collector.mjs:4` (import), `:74-123` (`deriveAlerts`), `:205-207` (dispatch)
- Test: `src/collector.test.mjs:57-118`

**Interfaces:**
- Consumes: `Tier` from `./notify.mjs` (Task 1).
- Produces: `deriveAlerts(state, snapshot, newDocsisEvents, now)` now returns alerts shaped `{message, color, tier}` instead of `{message, color}`. No signature change.

Tier assignment for this task's six alerts: DOCSIS offline and DOCSIS back online are `CRITICAL`; firmware changed, upstream power critical, upstream power recovered, and T3/T4 timeouts are `LOG`.

- [ ] **Step 1: Write the failing test**

In `src/collector.test.mjs`, first extend the import on line 8 — it currently pulls `deriveAlerts` from `./collector.mjs`. Add a separate import for the tier constant near the top of the file:

```js
import { Tier } from "./notify.mjs";
```

Then add tier assertions to the four existing tests. In `test("upstream power alert is edge-triggered with hysteresis")`, after line 62 (`assert.match(r.alerts[0].message, /Upstream TX power critical/);`) add:

```js
  assert.equal(r.alerts[0].tier, Tier.LOG);
```

and after line 75 (`assert.match(r.alerts[0].message, /recovered/);`) add:

```js
  // recovery pairs with its problem: both muted, so no green ping for a
  // condition whose onset was never announced
  assert.equal(r.alerts[0].tier, Tier.LOG);
```

In `test("firmware change alerts once")`, after line 84 add:

```js
  assert.equal(r.alerts[0].tier, Tier.LOG);
```

In `test("offline and recovery transitions alert once each")`, after line 94 add:

```js
  assert.equal(r.alerts[0].tier, Tier.CRITICAL);
```

and after line 101 add:

```js
  assert.equal(r.alerts[0].tier, Tier.CRITICAL);
```

In `test("T3 alerts are rate-limited to one per cooldown window")`, after line 109 add:

```js
  assert.equal(r.alerts[0].tier, Tier.LOG);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --test-name-pattern="upstream power alert is edge-triggered"`

Expected: FAIL with `Expected values to be strictly equal: undefined !== 'log'` — `deriveAlerts` does not set `tier` yet.

- [ ] **Step 3: Add `tier` to `deriveAlerts`**

In `src/collector.mjs`, change the import on line 4 from:

```js
import { notify, Color } from "./notify.mjs";
```

to:

```js
import { notify, Color, Tier } from "./notify.mjs";
```

Then add a `tier` field to each of the six `alerts.push(...)` calls in `deriveAlerts`:

```js
  if (state.firmware && snapshot.firmware && state.firmware !== snapshot.firmware) {
    alerts.push({
      message: `Station firmware changed: \`${state.firmware}\` → \`${snapshot.firmware}\`. Watch for setting resets (bridge mode!).`,
      color: Color.YELLOW,
      tier: Tier.LOG,
    });
  }
  next.firmware = snapshot.firmware ?? state.firmware;

  const online = snapshot.operational === "Docsis_Online";
  if (state.online === true && !online) {
    alerts.push({
      message: `DOCSIS no longer online: **${snapshot.operational}**`,
      color: Color.RED,
      tier: Tier.CRITICAL,
    });
  } else if (state.online === false && online) {
    alerts.push({ message: "DOCSIS back online.", color: Color.GREEN, tier: Tier.CRITICAL });
  }
  next.online = online;

  if (snapshot.usMaxPower !== null) {
    if (!state.usPowerHigh && snapshot.usMaxPower > US_POWER_WARN_DBMV) {
      alerts.push({
        message: `Upstream TX power critical: **${snapshot.usMaxPower} dBmV** (healthy ≤ 47, critical > ${US_POWER_WARN_DBMV}). Signal path is degraded.`,
        color: Color.YELLOW,
        tier: Tier.LOG,
      });
      next.usPowerHigh = true;
    } else if (state.usPowerHigh && snapshot.usMaxPower <= US_POWER_CLEAR_DBMV) {
      alerts.push({
        message: `Upstream TX power recovered: ${snapshot.usMaxPower} dBmV.`,
        color: Color.GREEN,
        tier: Tier.LOG,
      });
      next.usPowerHigh = false;
    }
  }

  const t3Count = newDocsisEvents.filter(isRangingFailure).length;
  if (t3Count > 0 && now - (state.lastT3AlertAt ?? 0) > T3_ALERT_COOLDOWN_MS) {
    alerts.push({
      message: `${t3Count} new T3/T4 ranging time-out(s) in the Station event log — upstream is failing intermittently.`,
      color: Color.YELLOW,
      tier: Tier.LOG,
    });
    next.lastT3AlertAt = now;
  }
```

- [ ] **Step 4: Pass tier through the dispatch loop**

In `src/collector.mjs`, change the loop at lines 205-207 from:

```js
  for (const a of alerts) {
    await notify(a.message, a.color);
  }
```

to:

```js
  for (const a of alerts) {
    await notify(a.message, a.color, a.tier);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`

Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add src/collector.mjs src/collector.test.mjs
git commit -m "Tier the DOCSIS collector alerts"
```

---

### Task 3: Tier on the LTE alerts

**Files:**
- Modify: `src/lte.mjs:81-160` (`deriveLteAlerts`), and its `Color` import on line 1
- Test: `src/lte.test.mjs:64-140`

**Interfaces:**
- Consumes: `Tier` from `./notify.mjs` (Task 1).
- Produces: `deriveLteAlerts(state, curr, now)` now returns alerts shaped `{message, color, tier}`. No signature change. The dispatch loop that consumes these lives in `src/lte-monitor.mjs:151` and is updated in Task 4.

Tier assignment for this task's ten alerts: failover active, failover ended, ALL DOWN, and guard chain missing are `CRITICAL`; backup broken and balance low are `WARN`; armed, disarmed, guard opened, and guard locked are `LOG`.

- [ ] **Step 1: Write the failing test**

In `src/lte.test.mjs`, extend the import on line 67 from:

```js
import { Color } from "./notify.mjs";
```

to:

```js
import { Color, Tier } from "./notify.mjs";
```

Add tier assertions to the existing tests. After line 79 (`assert.equal(alerts[0].color, Color.RED);` in `test("alert on failover start")`) add:

```js
  assert.equal(alerts[0].tier, Tier.CRITICAL);
```

After line 99 (`assert.equal(alerts[0].color, Color.GREEN);` in `test("alert with cost summary on failover end")`) add:

```js
  // pairs with failover start — both critical, because a session ending is
  // the all-clear for money burning
  assert.equal(alerts[0].tier, Tier.CRITICAL);
```

In `test("alert on disarm and re-arm")`, after line 106 (`assert.match(a.alerts[0].message, /disarmed/);`) add:

```js
  assert.equal(a.alerts[0].tier, Tier.LOG);
```

and after line 109 (`assert.match(b.alerts[0].message, /armed/);`) add:

```js
  assert.equal(b.alerts[0].tier, Tier.LOG);
```

Then append a new test at the end of the file that covers the remaining six alerts in one pass:

```js
test("tier assignment across the remaining LTE alerts", () => {
  const all = (state, curr, now = NOW) => deriveLteAlerts(state, curr, now).alerts;
  const base = { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null };

  const allDown = all(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { ...base, connState: "ALL_DOWN", armed: false },
  );
  assert.match(allDown[0].message, /ALL DOWN/);
  assert.equal(allDown[0].tier, Tier.CRITICAL);

  const backupBroken = all(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { ...base, backupOk: false },
  );
  assert.match(backupBroken[0].message, /backup looks \*\*broken\*\*/);
  assert.equal(backupBroken[0].tier, Tier.WARN);

  const balanceLow = all(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { ...base, balanceEur: 3.5 },
  );
  assert.match(balanceLow[0].message, /balance low/);
  assert.equal(balanceLow[0].tier, Tier.WARN);

  const guardOpened = all(
    { connState: "CABLE_OK", armed: true, backupOk: true, guardState: "locked" },
    { ...base, guardState: "open" },
  );
  assert.match(guardOpened[0].message, /guard \*\*opened\*\*/);
  assert.equal(guardOpened[0].tier, Tier.LOG);

  const guardLocked = all(
    { connState: "CABLE_OK", armed: true, backupOk: true, guardState: "open" },
    { ...base, guardState: "locked" },
  );
  assert.match(guardLocked[0].message, /guard \*\*locked\*\*/);
  assert.equal(guardLocked[0].tier, Tier.LOG);

  // "missing" alerts even on first observation — see the guardState condition
  const guardMissing = all(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { ...base, guardState: "missing" },
  );
  assert.match(guardMissing[0].message, /guard chain \*\*missing\*\*/);
  assert.equal(guardMissing[0].tier, Tier.CRITICAL);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --test-name-pattern="tier assignment across the remaining LTE alerts"`

Expected: FAIL with `Expected values to be strictly equal: undefined !== 'critical'` — `deriveLteAlerts` does not set `tier` yet.

- [ ] **Step 3: Add `tier` to `deriveLteAlerts`**

In `src/lte.mjs`, change line 1 from:

```js
import { Color } from "./notify.mjs";
```

to:

```js
import { Color, Tier } from "./notify.mjs";
```

Then add a `tier` field to each of the ten alert objects in `deriveLteAlerts`:

```js
  if (state.connState !== undefined && state.connState !== curr.connState) {
    if (curr.connState === "LTE_ACTIVE") {
      alerts.push({
        message: `**Failover active** — traffic is running over LTE at ${(RATE_PER_MB * 100).toFixed(0)} ct/MB. ${DASHBOARD_URL}`,
        color: Color.RED,
        tier: Tier.CRITICAL,
      });
    } else if (state.connState === "LTE_ACTIVE" && curr.closedSession) {
      const s = curr.closedSession;
      const mins = Math.max(1, Math.round((Date.parse(s.endTs) - Date.parse(s.startTs)) / 60_000));
      alerts.push({
        message: `Failover ended after ${mins} min — ${fmtMb(s.bytes)} MB ≈ ${fmtEur(costEur(s.bytes))}.`,
        color: Color.GREEN,
        tier: Tier.CRITICAL,
      });
    } else if (curr.connState === "ALL_DOWN") {
      alerts.push({
        message: `**ALL DOWN** — cable is down and LTE fallback is ${curr.armed ? "unavailable" : "disarmed"}.`,
        color: Color.RED,
        tier: Tier.CRITICAL,
      });
    }
  }

  if (state.armed !== undefined && state.armed !== curr.armed) {
    alerts.push(
      curr.armed
        ? { message: "LTE fallback **armed**.", color: Color.GREEN, tier: Tier.LOG }
        : { message: "LTE fallback **disarmed** — no automatic failover until re-armed.", color: Color.YELLOW, tier: Tier.LOG },
    );
  }
```

For the backup-broken block, add `tier: Tier.WARN`:

```js
    alerts.push({
      message: "LTE backup looks **broken** (health ping via Spitz failed) — failover would not work right now.",
      color: Color.YELLOW,
      tier: Tier.WARN,
    });
```

For the balance-low block, add `tier: Tier.WARN`:

```js
    alerts.push({
      message: `CallYa balance low: **${fmtEur(curr.balanceEur)}** — top up soon, the LTE fallback dies with the credit.`,
      color: Color.YELLOW,
      tier: Tier.WARN,
    });
```

For the three guard-state blocks:

```js
    if (curr.guardState === "open") {
      alerts.push({
        message: `LTE guard **opened** — ALL devices may use LTE${curr.guardOpenUntil ? ` until ${curr.guardOpenUntil.slice(11, 16)} UTC` : ""}.`,
        color: Color.YELLOW,
        tier: Tier.LOG,
      });
    } else if (curr.guardState === "locked") {
      alerts.push({
        message: "LTE guard **locked** — only allowlisted devices (NUC, Felix-PC) may use LTE.",
        color: Color.GREEN,
        tier: Tier.LOG,
      });
    } else if (curr.guardState === "missing") {
      alerts.push({
        message: "LTE guard chain **missing** on the Flint — LTE is unrestricted for all devices. Reinstall /etc/firewall.lte_guard.",
        color: Color.RED,
        tier: Tier.CRITICAL,
      });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`

Expected: PASS — all suites. The `lte-monitor.test.mjs` suite still passes because its `send` spy ignores extra arguments.

- [ ] **Step 5: Commit**

```bash
git add src/lte.mjs src/lte.test.mjs
git commit -m "Tier the LTE failover alerts"
```

---

### Task 4: Tier on the direct notify calls

**Files:**
- Modify: `src/index.mjs:2` (import), `:73`, `:102`, `:105`, `:143`, `:167`
- Modify: `src/lte-monitor.mjs:35-38` (deps), `:66` (timestamp), `:130`, `:132`, `:138`, `:151` (dispatch), `:155`, `:169-174`, `:176`, `:179`
- Test: `src/lte-monitor.test.mjs`

**Interfaces:**
- Consumes: `Tier` from `./notify.mjs` (Task 1); the `tier` field on alerts from Tasks 2 and 3.
- Produces: `startLteMonitor(deps)` accepts one new optional dep, `deps.nowIso: () => string`, defaulting to `() => new Date().toISOString()`. Everything else is unchanged.

`src/index.mjs` has no test file — its five changes are verified by the suite still passing plus reading the diff. Do not create one; adding coverage for the bridge-restore flow means faking the Station HTTP API and is well outside this change.

The `deps.nowIso` injection is a small addition beyond the spec's letter. It exists because the drill is gated behind `isDrillDue`, which only fires before 03:00 UTC (`src/lte.mjs:43-46`), so the drill tiers the spec asks us to test are otherwise unreachable from a test at most times of day. It follows the module's established injection pattern (`flint`, `send`, `autoStart` are already deps).

- [ ] **Step 1: Write the failing test**

In `src/lte-monitor.test.mjs`, add the tier import after the existing dynamic imports on line 10:

```js
const { Tier } = await import("./notify.mjs");
```

Widen the `send` spy in `test("toggleGuard opens with expiry, second toggle relocks")` from `(msg, color)` to `(msg, color, tier)`:

```js
  const m = startLteMonitor({ flint, send: async (msg, color, tier) => sent.push({ msg, color, tier }), autoStart: false });
```

and assert tier on both guard messages by replacing the two `assert.ok(sent.some(...))` lines with:

```js
  assert.ok(sent.some((s) => /guard \*\*opened\*\*/.test(s.msg) && s.tier === Tier.LOG));
  ...
  assert.ok(sent.some((s) => /guard \*\*locked\*\*/.test(s.msg) && s.tier === Tier.LOG));
```

Then append two new tests at the end of the file:

```js
test("guard relock messages carry their own tiers", async () => {
  // Startup relock (nobody owns the open) is routine; a relock we did not
  // initiate later on is worth a warning.
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0, guard: "open" },
  ];
  const flint = fakeFlint(script);
  const sent = [];
  const m = startLteMonitor({ flint, send: async (msg, color, tier) => sent.push({ msg, color, tier }), autoStart: false });

  await m.tick();
  const startup = sent.find((s) => /re-locked on startup/.test(s.msg));
  assert.ok(startup, "startup relock announced");
  assert.equal(startup.tier, Tier.LOG);

  // someone opens the guard behind our back
  script[0].guard = "open";
  await m.tick();
  const external = sent.find((s) => /opened outside the dashboard/.test(s.msg));
  assert.ok(external, "external open announced");
  assert.equal(external.tier, Tier.WARN);
});

test("drill result tiers: OK is muted, failure warns", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0, guard: "locked" },
  ];
  // isDrillDue needs hour < 03:00 UTC and a different month from the last
  // drill. All monitors in this file share one DATA_DIR, so the state file may
  // already hold a real-clock lastDrillTs from an earlier test — the far-future
  // years keep both drills due regardless of what is in there, and the two
  // distinct months keep the second drill due after the first one persists.
  const okSent = [];
  const okMonitor = startLteMonitor({
    flint: fakeFlint(script), autoStart: false,
    nowIso: () => "2099-01-01T01:00:00.000Z",
    send: async (msg, color, tier) => okSent.push({ msg, color, tier }),
  });
  await okMonitor.tick();
  const ok = okSent.find((s) => /drill OK/.test(s.msg));
  assert.ok(ok, "drill ran and reported OK");
  assert.equal(ok.tier, Tier.LOG);

  const failSent = [];
  const failFlint = fakeFlint(script);
  failFlint.runDrill = async () => { throw new Error("no route to host"); };
  const failMonitor = startLteMonitor({
    flint: failFlint, autoStart: false,
    nowIso: () => "2099-02-01T01:00:00.000Z",
    send: async (msg, color, tier) => failSent.push({ msg, color, tier }),
  });
  await failMonitor.tick();
  const failed = failSent.find((s) => /drill \*\*FAILED\*\*/.test(s.msg));
  assert.ok(failed, "drill failure announced");
  assert.equal(failed.tier, Tier.WARN);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --test-name-pattern="drill result tiers"`

Expected: FAIL — `startLteMonitor` ignores `deps.nowIso`, so `isDrillDue` uses the real clock and no drill message is sent; the assertion `assert.ok(ok, "drill ran and reported OK")` fails.

- [ ] **Step 3: Add the `nowIso` dep and tier the `lte-monitor.mjs` calls**

In `src/lte-monitor.mjs`, change the import on line 4 to include `Tier`:

```js
import { notify, Color, Tier } from "./notify.mjs";
```

Add the dep alongside the existing three (lines 35-38):

```js
export function startLteMonitor(deps = {}) {
  const flint = deps.flint ?? realFlint;
  const send = deps.send ?? notify;
  const autoStart = deps.autoStart ?? true;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
```

Change line 66 inside `tick()` from `const ts = new Date().toISOString();` to:

```js
    const ts = nowIso();
```

Tier the two guard relock messages (lines 130 and 132):

```js
        if (guardOpenUntil === null && !firstGuardRead) {
          await send("LTE guard was opened outside the dashboard — **re-locked** it.", Color.YELLOW, Tier.WARN);
        } else if (guardOpenUntil === null) {
          await send("LTE guard **re-locked on startup** (was open).", Color.GREEN, Tier.LOG);
        }
```

Tier the relock failure (line 138):

```js
          await send(`LTE guard relock **FAILED** (${err.message}) — guard is stuck OPEN, retrying every tick.`, Color.RED, Tier.CRITICAL);
```

Pass tier through the derived-alert dispatch (line 151):

```js
    for (const a of alerts) await send(a.message, a.color, a.tier);
```

Tier the running update (line 155):

```js
      await send(
        `LTE failover still active — session ${fmtMb(session.bytes)} MB ≈ ${fmtEur(costEur(session.bytes))}.`,
        Color.YELLOW,
        Tier.LOG,
      );
```

Tier the three drill outcomes (lines 169-179):

```js
        try {
          const r = await flint.runDrill();
          const mbit = r.seconds > 0 ? ((r.bytes * 8) / r.seconds / 1e6).toFixed(0) : "?";
          await send(
            r.ok
              ? `Monthly LTE drill OK — ${fmtMb(r.bytes)} MB in ${r.seconds.toFixed(1)} s (~${mbit} Mbit/s), cost ≈ ${fmtEur(costEur(r.bytes))}.`
              : "Monthly LTE drill **FAILED** — check the Spitz/SIM.",
            r.ok ? Color.GREEN : Color.RED,
            r.ok ? Tier.LOG : Tier.WARN,
          );
        } catch (err) {
          await send(`Monthly LTE drill **FAILED**: ${err.message}`, Color.RED, Tier.WARN);
        }
      } else {
        await send("Monthly LTE drill skipped — fallback is disarmed.", Color.YELLOW, Tier.WARN);
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`

Expected: PASS — all suites.

- [ ] **Step 5: Tier the `index.mjs` calls**

Change the import on line 2:

```js
import { notify, Color, Tier } from "./notify.mjs";
```

Line 73 — bridge mode lost:

```js
  await notify(
    `Bridge mode lost! Router is in **${deviceMode}** mode. Attempting to re-enable bridge mode...`,
    Color.RED,
    Tier.CRITICAL,
  );
```

Line 102 — restore succeeded:

```js
          await notify("Bridge mode successfully re-enabled!", Color.GREEN, Tier.CRITICAL);
```

Line 105 — restore failed:

```js
          await notify(
            `Failed to restore bridge mode. Router is in **${newMode}** mode after reboot. Manual intervention may be needed.`,
            Color.YELLOW,
            Tier.CRITICAL,
          );
```

Line 143 — poll error:

```js
    await notify(`Error during check: ${err.message}`, Color.YELLOW, Tier.WARN);
```

Line 167 — startup banner:

```js
  await notify("Monitor started, watching for bridge mode changes.", Color.GREEN, Tier.LOG);
```

- [ ] **Step 6: Verify the whole suite and confirm no untiered calls remain**

Run: `pnpm test`

Expected: PASS — all suites.

Run: `grep -rn "notify(\|await send(" src --include=*.mjs | grep -v "\.test\.mjs" | grep -v "Tier\." | grep -v "a\.tier"`

Expected: only the `export async function notify(` declaration in `src/notify.mjs` and the `const send = deps.send ?? notify;` line in `src/lte-monitor.mjs`. Any other line printed is a message site that still defaults to `Tier.WARN` — go back and tier it.

- [ ] **Step 7: Commit**

```bash
git add src/index.mjs src/lte-monitor.mjs src/lte-monitor.test.mjs
git commit -m "Tier the bridge monitor and LTE monitor notifications"
```

---

## Deployment (manual, after all tasks land)

Not a code task — this is the handoff checklist for the NUC.

1. In Discord, create `#vf-critical`, `#vf-warn`, `#vf-log` and a webhook for each.
2. Add `DISCORD_WEBHOOK_CRITICAL`, `DISCORD_WEBHOOK_WARN`, `DISCORD_WEBHOOK_LOG` to `.env` on the NUC (192.168.0.37). Leave `DISCORD_WEBHOOK_URL` in place as the safety net for any tier whose variable is missing or mistyped.
3. Rebuild and restart the `vodafone-bridge-monitor` container.
4. Confirm routing: the startup banner ("Monitor started…") must appear in `#vf-log`. If it lands in the old channel, `DISCORD_WEBHOOK_LOG` is not being read.
5. Set Discord per-channel notification preferences: `#vf-critical` to All Messages with mobile push, `#vf-warn` to default, `#vf-log` muted.
