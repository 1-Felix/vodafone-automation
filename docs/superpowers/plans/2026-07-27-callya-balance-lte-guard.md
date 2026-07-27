# CallYa Balance Display + LTE Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the CallYa prepaid balance on the dashboard (USSD `*100#` via the Spitz over SSH, low-balance Discord alert below €10) and add an LTE guard: a persistent Flint firewall chain that lets only the NUC and Felix-PC use the LTE uplink, with a dashboard button that opens it for all devices for 60 minutes and then auto-relocks.

**Architecture:** New `src/spitz.mjs` SSH client (same `execFile("ssh")` pattern as `src/flint.mjs`, same mounted key) issues the free USSD balance query through the Spitz's modem AT interface. The guard is a static `lte_guard` iptables chain on the Flint hooked into `FORWARD -o lan5` via a firewall include — inert while cable is up (nothing routes out lan5 then), so no activation state machine. `src/lte-monitor.mjs` schedules balance checks (daily + after each failover session), reads guard state every tick, auto-relocks expired/ownerless opens, and feeds both into the existing edge-triggered alert pipeline.

**Tech Stack:** Plain Node 22 ESM (.mjs), `node:test`, `node:http`, `node:child_process` + OpenSSH client already in the Alpine image. No npm dependencies.

Spec: `docs/superpowers/specs/2026-07-27-callya-balance-lte-guard-design.md`

## Global Constraints

- Zero npm runtime dependencies.
- ESM `.mjs`; pure functions exported for tests, stateful wrappers separate.
- Tests via `node --test` (`pnpm test`).
- No Co-Authored-By lines in commits; imperative commit messages.
- All timestamps ISO-8601 UTC via `new Date().toISOString()`.
- Balance threshold env `BALANCE_LOW_EUR` default `10`; guard window env `GUARD_OPEN_MINUTES` default `60`.
- Allowlist: 192.168.0.37 (NUC) and 192.168.0.59 (Felix-PC). Lives ONLY in the Flint include script — no collector config, no UI editing.
- Failures in balance/guard paths must never break failover detection, metering, kill switch, or drill.

## As-is state (deployed 2026-07-27 — do NOT redo)

- Collector container `vodafone-bridge-monitor` on the NUC (192.168.0.37) with SSH key at `/app/ssh/id_ed25519` + `/app/ssh/known_hosts` (mounted from `./ssh/` next to the compose file on the NUC), authorized on the Flint (192.168.0.1, dropbear). Dashboard :8799.
- Spitz GL-X2000 admin/SSH at 192.168.8.1, reachable from the NUC through the Flint's masquerade (verified). Container key NOT yet authorized there (Task 7). Root SSH password = Spitz admin UI password.
- Flint: OpenWrt 21.02 (GL 4.x), fw3/iptables. fw3 jumps to `forwarding_rule` at the TOP of FORWARD, before conntrack ACCEPT — so guard REJECT also cuts established flows. Felix-PC MAC `04:7C:16:07:D8:70`, currently dynamic lease on 192.168.0.59.
- `src/lte.mjs` exports `deriveLteAlerts(state, curr, now)` (edge-triggered), `costEur`, `fmtMb`, `fmtEur`, `isDrillDue`, constants. `src/lte-monitor.mjs` `startLteMonitor(deps)` takes `{flint?, send?, autoStart?}` and returns `{getStatus, toggleArmed, onWanEvent, tick}`. `src/index.mjs` wires `startDashboard({ port: DASHBOARD_PORT, ...monitor })` — monitor return-object spread, so a new `toggleGuard` key flows to the dashboard without touching `index.mjs`.
- NUC compose file is a COPY of the repo's — `.env` changes there are manual (Task 7). `docker-compose.yml` itself does not change in this project.

---

### Task 1: Spitz SSH client + USSD balance parser (src/spitz.mjs)

**Files:**
- Create: `src/spitz.mjs`
- Test: `src/spitz.test.mjs` (pure parser only)

**Interfaces:**
- Consumes: nothing from this repo.
- Produces:
  - `parseUssdBalance(raw: string) -> {eur: number|null, text: string} | null` — `null` = nothing usable; `eur: null` = readable payload but no amount found.
  - `spitzSsh(command: string) -> Promise<string>`
  - `queryBalance() -> Promise<{eur, text} | null>`
- Env: `SPITZ_SSH_HOST` (default `192.168.8.1`), `SPITZ_SSH_USER` (`root`), key/known_hosts reuse `FLINT_SSH_KEY`/`FLINT_KNOWN_HOSTS`, `SPITZ_USSD_CMD` (default `gl_modem AT 'AT+CUSD=1,"*100#",15'` — verified/corrected during deploy, Task 7).

- [ ] **Step 1: Write the failing tests** (`src/spitz.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseUssdBalance } from "./spitz.mjs";

const ucs2 = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");

test("parses German plain-text balance with comma decimal", () => {
  const r = parseUssdBalance('+CUSD: 0,"Ihr aktuelles Guthaben betraegt: 12,34 EUR.",15');
  assert.equal(r.eur, 12.34);
  assert.match(r.text, /Guthaben/);
});
test("parses dot-decimal and € symbol", () => {
  assert.equal(parseUssdBalance('+CUSD: 0,"Guthaben: 7.05 €",15').eur, 7.05);
});
test("decodes UCS2-hex payload", () => {
  const r = parseUssdBalance(`+CUSD: 0,"${ucs2("Ihr Guthaben: 9,99 EUR")}",72`);
  assert.equal(r.eur, 9.99);
  assert.match(r.text, /Ihr Guthaben/);
});
test("readable payload without amount keeps text, eur null", () => {
  const r = parseUssdBalance('+CUSD: 0,"Dieser Dienst ist derzeit nicht verfuegbar",15');
  assert.equal(r.eur, null);
  assert.match(r.text, /Dienst/);
});
test("returns null on no payload or garbage", () => {
  assert.equal(parseUssdBalance("+CUSD: 2"), null);
  assert.equal(parseUssdBalance("ERROR"), null);
  assert.equal(parseUssdBalance(""), null);
  assert.equal(parseUssdBalance('+CUSD: 0,"",15'), null);
});
```

- [ ] **Step 2: Run tests, verify FAIL**: `node --test src/spitz.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** (`src/spitz.mjs`)

```js
import { execFile } from "node:child_process";

const HOST = process.env.SPITZ_SSH_HOST ?? "192.168.8.1";
const USER = process.env.SPITZ_SSH_USER ?? "root";
const KEY = process.env.FLINT_SSH_KEY ?? "/app/ssh/id_ed25519";
const KNOWN_HOSTS = process.env.FLINT_KNOWN_HOSTS ?? "/app/ssh/known_hosts";
const USSD_CMD = process.env.SPITZ_USSD_CMD ?? `gl_modem AT 'AT+CUSD=1,"*100#",15'`;

function decodeUcs2Hex(s) {
  const chars = [];
  for (let i = 0; i + 4 <= s.length; i += 4) chars.push(parseInt(s.slice(i, i + 4), 16));
  return String.fromCharCode(...chars);
}

export function parseUssdBalance(raw) {
  if (!raw || typeof raw !== "string") return null;
  const quoted = raw.match(/"([^"]*)"/);
  let text = (quoted?.[1] ?? raw).trim();
  if (/^[0-9A-Fa-f]{8,}$/.test(text) && text.length % 4 === 0) text = decodeUcs2Hex(text);
  const m = text.match(/(\d+)[.,](\d{2})\s*(?:EUR|€)/i);
  if (m) return { eur: parseInt(m[1], 10) + parseInt(m[2], 10) / 100, text };
  if (quoted && text) return { eur: null, text };
  return null;
}

export function spitzSsh(command) {
  const args = [
    "-i", KEY,
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    `${USER}@${HOST}`,
    command,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`spitz ssh ${command}: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

export async function queryBalance() {
  return parseUssdBalance(await spitzSsh(USSD_CMD));
}
```

- [ ] **Step 4: Run tests, verify PASS**: `node --test src/spitz.test.mjs`
- [ ] **Step 5: Commit**: `git add src/spitz.mjs src/spitz.test.mjs && git commit -m "Add Spitz SSH client with USSD balance query and parser"`

---

### Task 2: Pure logic — balance schedule + alert extensions (src/lte.mjs)

**Files:**
- Modify: `src/lte.mjs` (new constants, `isBalanceCheckDue`, extend `deriveLteAlerts`)
- Test: `src/lte.test.mjs` (append)

**Interfaces:**
- Consumes: existing `Color`, `fmtEur`.
- Produces:
  - `isBalanceCheckDue(lastCheckTs: string|null, nowIso: string) -> boolean`
  - Constants: `BALANCE_LOW_EUR` (env, default 10), `BALANCE_ALERT_REPEAT_MS = 86_400_000`, `BALANCE_STALE_MS = 259_200_000` (72 h)
  - `deriveLteAlerts(state, curr, now)` — `curr` gains optional `balanceEur: number|null`, `balanceStale: boolean`, `guardState: "locked"|"open"|"missing"|null`, `guardOpenUntil: string|null` (ISO). `state` gains `lastBalanceAlertAt?`, `balanceStale?`, `guardState?`. All additive: existing callers passing the old shape get identical behavior (all existing tests must still pass unchanged).

- [ ] **Step 1: Write the failing tests** (append to `src/lte.test.mjs`; the file already imports `deriveLteAlerts` and `Color`, and defines `const NOW = 1_800_000_000_000`)

```js
import { isBalanceCheckDue, BALANCE_ALERT_REPEAT_MS } from "./lte.mjs";

const STEADY = { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null };

test("isBalanceCheckDue: daily after 04:00 UTC", () => {
  assert.equal(isBalanceCheckDue(null, "2026-07-27T05:00:00.000Z"), true);
  assert.equal(isBalanceCheckDue("2026-07-26T05:00:00.000Z", "2026-07-27T05:00:00.000Z"), true);
  assert.equal(isBalanceCheckDue("2026-07-27T05:00:00.000Z", "2026-07-27T09:00:00.000Z"), false);
  assert.equal(isBalanceCheckDue(null, "2026-07-27T02:00:00.000Z"), false);
});
test("low balance alerts once, repeats after 24 h while low", () => {
  const a = deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: 8.5 }, NOW);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0].message, /8\.50 €/);
  assert.equal(a.alerts[0].color, Color.YELLOW);
  const b = deriveLteAlerts(a.state, { ...STEADY, balanceEur: 8.4 }, NOW + 60_000);
  assert.equal(b.alerts.length, 0);
  const c = deriveLteAlerts(b.state, { ...STEADY, balanceEur: 8.4 }, NOW + BALANCE_ALERT_REPEAT_MS + 1);
  assert.equal(c.alerts.length, 1);
});
test("healthy balance and null balance never alert", () => {
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: 15 }, NOW).alerts.length, 0);
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: null }, NOW).alerts.length, 0);
});
test("balance stale alerts on edge only", () => {
  const a = deriveLteAlerts({ ...STEADY, balanceStale: false }, { ...STEADY, balanceStale: true }, NOW);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0].message, /balance check/i);
  const b = deriveLteAlerts(a.state, { ...STEADY, balanceStale: true }, NOW + 60_000);
  assert.equal(b.alerts.length, 0);
});
test("guard transitions alert: open YELLOW with until-time, relock GREEN, missing RED", () => {
  const open = deriveLteAlerts({ ...STEADY, guardState: "locked" },
    { ...STEADY, guardState: "open", guardOpenUntil: "2026-07-27T13:45:00.000Z" }, NOW);
  assert.equal(open.alerts.length, 1);
  assert.equal(open.alerts[0].color, Color.YELLOW);
  assert.match(open.alerts[0].message, /13:45/);
  const lock = deriveLteAlerts(open.state, { ...STEADY, guardState: "locked" }, NOW);
  assert.equal(lock.alerts.length, 1);
  assert.equal(lock.alerts[0].color, Color.GREEN);
  const miss = deriveLteAlerts(lock.state, { ...STEADY, guardState: "missing" }, NOW);
  assert.equal(miss.alerts.length, 1);
  assert.equal(miss.alerts[0].color, Color.RED);
});
test("guard first observation: locked silent, missing alerts", () => {
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, guardState: "locked" }, NOW).alerts.length, 0);
  const miss = deriveLteAlerts({ ...STEADY }, { ...STEADY, guardState: "missing" }, NOW);
  assert.equal(miss.alerts.length, 1);
  assert.equal(miss.alerts[0].color, Color.RED);
});
```

Note: `STEADY` spreads must not carry `guardState`/`balanceStale` into unrelated tests — each test builds its own `state` object, so existing tests are untouched.

- [ ] **Step 2: Run, verify FAIL**: `node --test src/lte.test.mjs`
- [ ] **Step 3: Implement** — add constants + `isBalanceCheckDue` near `isDrillDue`, and insert the three new blocks into `deriveLteAlerts` just before the final `next.connState = curr.connState;` line:

```js
export const BALANCE_LOW_EUR = parseFloat(process.env.BALANCE_LOW_EUR ?? "10");
export const BALANCE_ALERT_REPEAT_MS = 24 * 60 * 60_000;
export const BALANCE_STALE_MS = 72 * 60 * 60_000;

// Due once per UTC day, first tick after 04:00 UTC (05/06:00 Berlin)
export function isBalanceCheckDue(lastCheckTs, nowIso) {
  if (parseInt(nowIso.slice(11, 13), 10) < 4) return false;
  return (lastCheckTs ?? "").slice(0, 10) < nowIso.slice(0, 10);
}
```

```js
  // --- inside deriveLteAlerts, before the trailing next.* assignments ---

  if (
    typeof curr.balanceEur === "number" && curr.balanceEur < BALANCE_LOW_EUR &&
    now - (state.lastBalanceAlertAt ?? 0) >= BALANCE_ALERT_REPEAT_MS
  ) {
    alerts.push({
      message: `CallYa balance low: **${fmtEur(curr.balanceEur)}** — top up soon, the LTE fallback dies with the credit.`,
      color: Color.YELLOW,
    });
    next.lastBalanceAlertAt = now;
  }

  if (curr.balanceStale === true && state.balanceStale !== true) {
    alerts.push({
      message: "CallYa balance check has been **failing for 3+ days** — balance shown is stale.",
      color: Color.YELLOW,
    });
  }
  if (curr.balanceStale !== undefined) next.balanceStale = curr.balanceStale;

  if (curr.guardState && curr.guardState !== state.guardState &&
      (state.guardState !== undefined || curr.guardState === "missing")) {
    if (curr.guardState === "open") {
      alerts.push({
        message: `LTE guard **opened** — ALL devices may use LTE${curr.guardOpenUntil ? ` until ${curr.guardOpenUntil.slice(11, 16)} UTC` : ""}.`,
        color: Color.YELLOW,
      });
    } else if (curr.guardState === "locked") {
      alerts.push({
        message: "LTE guard **locked** — only allowlisted devices (NUC, Felix-PC) may use LTE.",
        color: Color.GREEN,
      });
    } else if (curr.guardState === "missing") {
      alerts.push({
        message: "LTE guard chain **missing** on the Flint — LTE is unrestricted for all devices. Reinstall /etc/firewall.lte_guard.",
        color: Color.RED,
      });
    }
  }
  if (curr.guardState) next.guardState = curr.guardState;
```

- [ ] **Step 4: Run, verify PASS (whole file — old tests must be green too)**: `node --test src/lte.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lte.mjs src/lte.test.mjs && git commit -m "Add balance schedule predicate and balance/guard alert logic"`

---

### Task 3: Guard control on the Flint client (src/flint.mjs)

**Files:**
- Modify: `src/flint.mjs` (append)
- Test: `src/flint.test.mjs` (append; pure parser only)

**Interfaces:**
- Consumes: existing `flintSsh`.
- Produces:
  - `parseGuardState(out: string) -> "locked" | "open" | "missing"`
  - `getGuardState() -> Promise<"locked"|"open"|"missing">`
  - `openGuard() -> Promise<void>` (`iptables -I lte_guard 1 -j ACCEPT`)
  - `relockGuard() -> Promise<void>` (rerun include script — idempotent rebuild; also heals "missing" if the script file exists)
- Env: `GUARD_SCRIPT` (default `/etc/firewall.lte_guard`).

- [ ] **Step 1: Write the failing tests** (append to `src/flint.test.mjs`)

```js
import { parseGuardState } from "./flint.mjs";

const LOCKED = `-N lte_guard
-A lte_guard -s 192.168.0.37/32 -j RETURN
-A lte_guard -s 192.168.0.59/32 -j RETURN
-A lte_guard -j REJECT --reject-with icmp-admin-prohibited
HOOKED
`;

test("parseGuardState: locked chain", () => {
  assert.equal(parseGuardState(LOCKED), "locked");
});
test("parseGuardState: open when ACCEPT-all present", () => {
  assert.equal(parseGuardState(LOCKED.replace("-A lte_guard -s", "-A lte_guard -j ACCEPT\n-A lte_guard -s")), "open");
});
test("parseGuardState: missing when chain absent or not hooked", () => {
  assert.equal(parseGuardState(""), "missing");
  assert.equal(parseGuardState("iptables: No chain by that name.\n"), "missing");
  assert.equal(parseGuardState(LOCKED.replace("HOOKED\n", "")), "missing"); // chain exists but no FORWARD hook
});
```

- [ ] **Step 2: Run, verify FAIL**: `node --test src/flint.test.mjs`
- [ ] **Step 3: Implement** (append to `src/flint.mjs`)

```js
const GUARD_SCRIPT = process.env.GUARD_SCRIPT ?? "/etc/firewall.lte_guard";

export function parseGuardState(out) {
  if (!out || !out.includes("-N lte_guard")) return "missing";
  if (!out.includes("HOOKED")) return "missing";
  if (/-A lte_guard -j ACCEPT\b/.test(out)) return "open";
  if (/-A lte_guard .*-j REJECT/.test(out)) return "locked";
  return "missing"; // chain exists but is empty/partial — not guarding
}

export async function getGuardState() {
  const out = await flintSsh(
    "iptables -S lte_guard 2>/dev/null; iptables -S forwarding_rule 2>/dev/null | grep -q lte_guard && echo HOOKED",
  );
  return parseGuardState(out);
}

export async function openGuard() {
  await flintSsh("iptables -I lte_guard 1 -j ACCEPT");
}

export async function relockGuard() {
  await flintSsh(`sh ${GUARD_SCRIPT}`);
}
```

- [ ] **Step 4: Run, verify PASS**: `node --test src/flint.test.mjs`
- [ ] **Step 5: Commit**: `git add src/flint.mjs src/flint.test.mjs && git commit -m "Add LTE guard state parsing and open/relock via Flint SSH"`

---

### Task 4: Monitor wiring — balance checks, guard lifecycle (src/lte-monitor.mjs)

**Files:**
- Modify: `src/lte-monitor.mjs`
- Test: `src/lte-monitor.test.mjs` (extend fakes + new tests)

**Interfaces:**
- Consumes: Task 1 `queryBalance` (via injectable `deps.spitz`), Task 2 `isBalanceCheckDue`/`BALANCE_LOW_EUR`/`BALANCE_STALE_MS`, Task 3 `getGuardState`/`openGuard`/`relockGuard` (via `deps.flint`).
- Produces:
  - `startLteMonitor(deps)` — `deps` gains `spitz?` (defaults to `src/spitz.mjs` exports). Return object gains `toggleGuard() -> Promise<{state, openUntil, openMinutes}>` (spread into `startDashboard` by `index.mjs` automatically — `index.mjs` unchanged).
  - `getStatus()` gains `balance: {eur, text, ts, low, stale} | null` and `guard: {state, openUntil, openMinutes}`.
  - New data file: `data/lte-balance.jsonl` (`{ts, eur, text}` per successful USSD contact).
  - `data/lte-state.json` gains `lastBalanceCheckTs` (attempt timestamp, so failures don't hot-loop retry).
- Env: `GUARD_OPEN_MINUTES` (default `60`).

- [ ] **Step 1: Extend the fakes and write the failing tests** (`src/lte-monitor.test.mjs`)

Add guard methods to the existing `fakeFlint` (script entries may now carry a `guard` field; default "locked"), and a `fakeSpitz`:

```js
// inside fakeFlint's returned object, add:
    getGuardState: async () => cur().guard ?? "locked",
    openGuard: async () => { cur().guard = "open"; },
    relockGuard: async () => { cur().guard = "locked"; },
```

```js
function fakeSpitz(result = { eur: 8.5, text: "Guthaben: 8,50 EUR" }) {
  const calls = { n: 0 };
  return { calls, queryBalance: async () => { calls.n++; return result; } };
}
```

**Update the three existing tests** to pass `spitz: fakeSpitz()` in `startLteMonitor({...})` — without it, a closing session would hit the real `spitz.mjs` and attempt SSH from the test run.

New tests:

```js
test("session close triggers balance check, low balance alerts", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
    { wan: { up: false, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
  ];
  const flint = fakeFlint(script);
  const spitz = fakeSpitz({ eur: 8.5, text: "Guthaben: 8,50 EUR" });
  const sent = [];
  const m = startLteMonitor({ flint, spitz, send: async (msg, color) => sent.push({ msg, color }), autoStart: false });
  await m.tick(); flint.advance();
  await m.tick(); flint.advance(); // failover
  await m.tick();                  // failback → session closes → balance check
  // >= 1, not === 1: the daily-due predicate uses the real clock and may add a check on tick 1
  assert.ok(spitz.calls.n >= 1);
  const status = await m.getStatus();
  assert.equal(status.balance.eur, 8.5);
  assert.equal(status.balance.low, true);
  assert.ok(sent.some((s) => /balance low/i.test(s.msg)));
});

test("guard open without timer is relocked on next tick (startup/external)", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0, guard: "open" },
  ];
  const flint = fakeFlint(script);
  const m = startLteMonitor({ flint, spitz: fakeSpitz(), send: async () => {}, autoStart: false });
  await m.tick();
  assert.equal(script[0].guard, "locked");
  assert.equal((await m.getStatus()).guard.state, "locked");
});

test("toggleGuard opens with expiry, second toggle relocks", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0, guard: "locked" },
  ];
  const flint = fakeFlint(script);
  const sent = [];
  const m = startLteMonitor({ flint, spitz: fakeSpitz(), send: async (msg, color) => sent.push({ msg, color }), autoStart: false });
  await m.tick();
  const g = await m.toggleGuard();
  assert.equal(g.state, "open");
  assert.ok(g.openUntil, "open sets an expiry");
  assert.ok(sent.some((s) => /guard \*\*opened\*\*/.test(s.msg)));
  const g2 = await m.toggleGuard();
  assert.equal(g2.state, "locked");
  assert.ok(sent.some((s) => /guard \*\*locked\*\*/.test(s.msg)));
});
```

- [ ] **Step 2: Run, verify FAIL**: `node --test src/lte-monitor.test.mjs`
- [ ] **Step 3: Implement** (`src/lte-monitor.mjs`)

New imports/constants at the top (alongside the existing ones):

```js
import * as realSpitz from "./spitz.mjs";
// add to the ./lte.mjs import list: isBalanceCheckDue, BALANCE_LOW_EUR, BALANCE_STALE_MS

const BALANCE_FILE = join(DATA_DIR, "lte-balance.jsonl");
const GUARD_OPEN_MS = parseInt(process.env.GUARD_OPEN_MINUTES ?? "60") * 60_000;
const GUARD_STUCK_ALERT_MS = 30 * 60_000;
```

Inside `startLteMonitor`, next to the existing state:

```js
  const spitz = deps.spitz ?? realSpitz;
  const balanceHistory = loadJsonl(BALANCE_FILE);
  let balance = balanceHistory.at(-1) ?? null; // {ts, eur, text}
  let guardState = null;
  let guardOpenUntil = null; // epoch ms | null (null while open = not ours → relock)
  let lastGuardStuckAlertAt = 0;
```

In `tick()`, insert after the backup-health block and BEFORE the `deriveLteAlerts` call:

```js
    // LTE guard: read state; relock when the window expired or nobody owns the open
    const firstGuardRead = alertState.guardState === undefined;
    guardState = await flint.getGuardState();
    if (guardState === "open" && (guardOpenUntil === null || now >= guardOpenUntil)) {
      try {
        await flint.relockGuard();
        guardState = await flint.getGuardState();
        if (guardOpenUntil === null && !firstGuardRead) {
          await send("LTE guard was opened outside the dashboard — **re-locked** it.", Color.YELLOW);
        } else if (guardOpenUntil === null) {
          await send("LTE guard **re-locked on startup** (was open).", Color.GREEN);
        }
        guardOpenUntil = null;
      } catch (err) {
        if (now - lastGuardStuckAlertAt >= GUARD_STUCK_ALERT_MS) {
          lastGuardStuckAlertAt = now;
          await send(`LTE guard relock **FAILED** (${err.message}) — guard is stuck OPEN, retrying every tick.`, Color.RED);
        }
      }
    }
    if (guardState !== "open") guardOpenUntil = null;

    // Balance: daily + after each failover session; attempt ts persisted so
    // failures retry next day, not every tick
    if (closedSession || isBalanceCheckDue(persisted.lastBalanceCheckTs, ts)) {
      persisted.lastBalanceCheckTs = ts;
      writeFileSync(STATE_FILE, JSON.stringify(persisted));
      try {
        const b = await spitz.queryBalance();
        if (b) {
          balance = { ts, eur: b.eur, text: b.text };
          appendFileSync(BALANCE_FILE, JSON.stringify(balance) + "\n");
        } else {
          log("Balance check: unparseable USSD response");
        }
      } catch (err) {
        log(`Balance check failed: ${err.message}`);
      }
    }
    const balanceStale = balance !== null && now - Date.parse(balance.ts) > BALANCE_STALE_MS;
```

Change the `deriveLteAlerts` call to pass the new fields:

```js
    const { alerts, state } = deriveLteAlerts(alertState, {
      connState, armed, backupOk, closedSession,
      balanceEur: balance?.eur ?? null,
      balanceStale,
      guardState,
      guardOpenUntil: guardOpenUntil ? new Date(guardOpenUntil).toISOString() : null,
    }, now);
```

Extend `getStatus()` (inside the returned object):

```js
      balance: balance ? {
        ...balance,
        low: typeof balance.eur === "number" && balance.eur < BALANCE_LOW_EUR,
        stale: Date.now() - Date.parse(balance.ts) > BALANCE_STALE_MS,
      } : null,
      guard: {
        state: guardState,
        openUntil: guardOpenUntil ? new Date(guardOpenUntil).toISOString() : null,
        openMinutes: GUARD_OPEN_MS / 60_000,
      },
```

Add `toggleGuard` next to `toggleArmed`, and include it in the return object (`return { getStatus, toggleArmed, toggleGuard, onWanEvent, tick }`):

```js
  async function toggleGuard() {
    const s = await flint.getGuardState();
    if (s === "open") {
      guardOpenUntil = null;
      await flint.relockGuard();
    } else if (s === "locked") {
      guardOpenUntil = Date.now() + GUARD_OPEN_MS;
      await flint.openGuard();
    } else {
      await flint.relockGuard(); // "missing": try to rebuild from the include script
    }
    await tick();
    return (await getStatus()).guard;
  }
```

- [ ] **Step 4: Run FULL suite, verify PASS**: `pnpm test`
- [ ] **Step 5: Commit**: `git add src/lte-monitor.mjs src/lte-monitor.test.mjs && git commit -m "Wire balance checks and guard lifecycle into LTE monitor"`

---

### Task 5: Dashboard — balance tile, guard row (src/dashboard.mjs)

**Files:**
- Modify: `src/dashboard.mjs`
- Test: `src/dashboard.test.mjs` (extend)

**Interfaces:**
- Consumes: `getStatus()` shape from Task 4 (`balance`, `guard`).
- Produces: `startDashboard({port, getStatus, toggleArmed, toggleGuard, onWanEvent, ...})` — extra keys from the monitor spread (e.g. `tick`) are accepted and ignored. New route `POST /api/guard` → `{guard: await toggleGuard()}`.

- [ ] **Step 1: Write the failing tests** (extend `src/dashboard.test.mjs`)

Add `toggleGuard` to the `serve()` helper's defaults:

```js
    toggleGuard: async () => { calls.guards = (calls.guards ?? 0) + 1; return { state: "open", openUntil: "2026-07-27T14:00:00.000Z", openMinutes: 60 }; },
```

New tests:

```js
test("POST /api/guard calls toggleGuard and returns guard", async () => {
  const { server, base, calls } = serve();
  const res = await fetch(`${base()}/api/guard`, { method: "POST" });
  assert.deepEqual(await res.json(), { guard: { state: "open", openUntil: "2026-07-27T14:00:00.000Z", openMinutes: 60 } });
  assert.equal(calls.guards, 1);
  server.close();
});
test("GET / includes guard and balance UI", async () => {
  const { server, base } = serve();
  const html = await (await fetch(base() + "/")).text();
  assert.match(html, /api\/guard/);
  assert.match(html, /Guthaben/);
  server.close();
});
```

- [ ] **Step 2: Run, verify FAIL**: `node --test src/dashboard.test.mjs`
- [ ] **Step 3: Implement** — three changes in `src/dashboard.mjs`:

3a. CSS: add `.warn{background:#78350f}` to the `.pill` styles line.

3b. HTML body — after the existing toggle-button row, add:

```html
<div class="row"><span id="guard" class="pill">…</span> <button id="gbtn" onclick="guardToggle()">…</button></div>
<div class="row" id="balance">CallYa Guthaben: –</div>
```

3c. Script — extend `refresh()` before the history rendering, and add `guardToggle()`:

```js
  const g=s.guard??{};
  const gp=document.getElementById("guard");
  gp.textContent = g.state==="open" ? "guard OPEN"+(g.openUntil?" until "+g.openUntil.slice(11,16)+" UTC":"")
    : g.state==="missing" ? "⚠ guard missing" : "guard locked";
  gp.className = "pill"+(g.state==="locked"?"":" warn");
  const gb=document.getElementById("gbtn");
  gb.textContent = g.state==="open" ? "Relock now" : g.state==="missing" ? "Rebuild guard" : "Open for all ("+(g.openMinutes??60)+" min)";
  const bal=s.balance;
  document.getElementById("balance").innerHTML = "CallYa Guthaben: "+(bal
    ? "<b"+(bal.low?' class="warn pill"':"")+">"+(bal.eur!=null?eur(bal.eur):"?")+"</b> <span class=\"muted\">(checked "+bal.ts.slice(0,16).replace("T"," ")+(bal.stale?", STALE":"")+")</span>"
    : "–");
```

```js
async function guardToggle(){
  const b=document.getElementById("gbtn");
  b.disabled=true;
  try{await fetch("api/guard",{method:"POST"});}finally{b.disabled=false;}
  refresh();
}
```

3d. Route — in `startDashboard`, accept `toggleGuard` in the destructured params and add before the 404 branch:

```js
      } else if (req.method === "POST" && req.url === "/api/guard") {
        json(res, { guard: await toggleGuard() });
```

- [ ] **Step 4: Run FULL suite, verify PASS**: `pnpm test`
- [ ] **Step 5: Commit**: `git add src/dashboard.mjs src/dashboard.test.mjs && git commit -m "Add balance tile and guard controls to dashboard"`

---

### Task 6: Packaging — .env.example, README

**Files:**
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: .env.example** — append to the LTE block:

```
# SPITZ_SSH_HOST=192.168.8.1
# SPITZ_SSH_USER=root
# SPITZ_USSD_CMD=gl_modem AT 'AT+CUSD=1,"*100#",15'
# BALANCE_LOW_EUR=10
# GUARD_OPEN_MINUTES=60
# GUARD_SCRIPT=/etc/firewall.lte_guard
```

- [ ] **Step 2: README.md** — extend the "LTE failover monitor" section with a short paragraph: CallYa balance shown on the dashboard (USSD `*100#` via the Spitz, daily + after each failover session, Discord alert below €10) and the LTE guard (only NUC + Felix-PC may use LTE; dashboard button opens it for all devices for 60 min, auto-relocks; allowlist lives in `/etc/firewall.lte_guard` on the Flint). Pointer to the new spec/plan docs.
- [ ] **Step 3: Run `pnpm test`, verify PASS. Commit**: `git add .env.example README.md && git commit -m "Document balance display and LTE guard config"`

---

### Task 7: Deploy — Spitz SSH + USSD discovery, Flint guard install, NUC rollout

Live infrastructure steps over SSH (`ssh nuc`, `ssh flint`), from the repo owner's machine.

- [ ] **Step 1: Push main** → wait for the GHCR publish workflow (`gh run watch`) to build `ghcr.io/1-felix/vodafone-automation:latest`.
- [ ] **Step 2: Authorize the container key on the Spitz** (root password = Spitz admin UI password). On the NUC in `~/dev/docker-compose-files/vodafone-automation/`:

```bash
ssh-keyscan 192.168.8.1 >> ssh/known_hosts
cat ssh/id_ed25519.pub | ssh root@192.168.8.1 "cat >> /etc/dropbear/authorized_keys"
ssh -i ssh/id_ed25519 -o UserKnownHostsFile=ssh/known_hosts root@192.168.8.1 echo ok   # → ok
```

Note: the Spitz has "save data when power off" ON, but confirm the key survives a reboot during acceptance; if dropbear keys are not persisted by GL's config layer, move the key line into GL's persistent config per its docs.
- [ ] **Step 3: USSD command discovery on the Spitz** — find the working AT transport, in this order, and put the winner into `SPITZ_USSD_CMD`:

```bash
ssh root@192.168.8.1 "which gl_modem; ubus list | grep -i modem; ls /dev/ttyUSB* /dev/mhi* 2>/dev/null"
# Candidate A (GL classic):
ssh root@192.168.8.1 "gl_modem AT 'AT+CUSD=1,\"*100#\",15'"
# Candidate B (GL fw 4.x ubus, adjust object/method names to what ubus list showed):
ssh root@192.168.8.1 "ubus call gl.modem at '{\"cmd\":\"AT+CUSD=1,\\\"*100#\\\",15\"}'"
# Candidate C (raw AT tty — use the AT port found above, often the 2nd/3rd ttyUSB or mhi_DUN):
ssh root@192.168.8.1 "(printf 'AT+CUSD=1,\"*100#\",15\r'; sleep 10) | microcom -t 12000 /dev/ttyUSB2"
```

Success = output containing a `+CUSD:` line with a text or UCS2-hex payload mentioning the balance. Record the exact command.
- [ ] **Step 4: Install the guard on the Flint** — write `/etc/firewall.lte_guard`:

```sh
#!/bin/sh
# LTE guard: only allowlisted devices may forward onto the LTE uplink (lan5).
# Rebuilding is idempotent; run manually to relock after an "open all" window.
iptables -N lte_guard 2>/dev/null
iptables -F lte_guard
iptables -A lte_guard -s 192.168.0.37 -j RETURN   # NUC (collector/alerts)
iptables -A lte_guard -s 192.168.0.59 -j RETURN   # Felix-PC
iptables -A lte_guard -j REJECT --reject-with icmp-admin-prohibited
iptables -D forwarding_rule -o lan5 -j lte_guard 2>/dev/null
iptables -I forwarding_rule -o lan5 -j lte_guard
```

Register + apply, and add the Felix-PC reservation:

```bash
ssh flint "uci add firewall include && uci set firewall.@include[-1].path='/etc/firewall.lte_guard' && uci set firewall.@include[-1].reload='1' && uci commit firewall && /etc/init.d/firewall restart"
ssh flint "iptables -S lte_guard && iptables -S forwarding_rule | grep lte_guard"   # chain + hook present
ssh flint "uci add dhcp host && uci set dhcp.@host[-1].mac='04:7C:16:07:D8:70' && uci set dhcp.@host[-1].ip='192.168.0.59' && uci set dhcp.@host[-1].name='Felix-PC' && uci commit dhcp && /etc/init.d/dnsmasq restart"
```

- [ ] **Step 5: NUC .env + rollout** — add the Task 6 vars (uncommented, `SPITZ_USSD_CMD` = the Step 3 winner) to the NUC's `.env` (the compose file there is a copy — no compose change needed this time), then:

```bash
docker compose pull && docker compose up -d
docker exec vodafone-bridge-monitor ssh -i /app/ssh/id_ed25519 -o UserKnownHostsFile=/app/ssh/known_hosts root@192.168.8.1 echo ok   # → ok
docker exec vodafone-bridge-monitor node -e "import('/app/src/spitz.mjs').then(async m => console.log(await m.queryBalance()))"       # → {eur: …, text: …}
curl -s http://192.168.0.37:8799/api/status   # → guard.state "locked", balance null or filled
```

---

### Task 8: Live acceptance tests (healthy-cable window; costs cents)

Watch Discord + `http://192.168.0.37:8799` throughout.

- [ ] **Test 1 — Balance:** dashboard shows the balance matching `*100#` dialed on a phone. Then set `BALANCE_LOW_EUR` above the real balance in the NUC `.env`, `docker compose up -d`, wait for the next check (or force one via a short failover in Test 2) → Discord low-balance YELLOW. Revert to 10 afterwards.
- [ ] **Test 2 — Guard blocks:** `ssh flint ifdown wan` → NUC and Felix-PC reach the internet via LTE (`curl https://ifconfig.me` from the PC → CGNAT/mobile IP); a non-allowlisted device (e.g. phone on Wi-Fi with mobile data off) gets connection-refused. Discord "Failover active" still arrives (NUC allowlisted).
- [ ] **Test 3 — Open + auto-relock:** with wan still down, press "Open for all" → blocked device works; Discord "guard opened … until HH:MM". Temporarily set `GUARD_OPEN_MINUTES=2` (compose up) → after ~2 min + next tick, device blocked again, Discord "guard locked". Restore 60.
- [ ] **Test 4 — Failback + inertness:** `ssh flint ifup wan` → all devices work normally on cable (guard chain inert, counters on `iptables -vL lte_guard` stop increasing).
- [ ] **Test 5 — Reboot persistence:** `ssh flint reboot` → `iptables -S lte_guard` shows the chain locked and hooked; dashboard shows guard locked. Also confirm Spitz SSH still works (dropbear key survived — see Task 7 Step 2 note) and the balance check still succeeds.
- [ ] **Wrap-up:** update the memory file (deployment state, USSD command that won, acceptance results); mark project done.
