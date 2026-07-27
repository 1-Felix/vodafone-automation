# Spitz Plus + CallYa LTE Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LTE failover monitoring for the home LAN: meter billable LTE bytes, show cost + kill switch on a LAN dashboard, alert via Discord, and drill the path monthly.

**Architecture:** The Flint (GL-MT6000) already fails over cable→`secondwan` (Spitz LTE on port lan5, metric 15)→tethering via kmwan — applied live 2026-07-27. The existing collector container on the NUC gains three modules: an SSH client to the Flint (state, byte counters, arm/disarm), a pure-logic module (deltas, cost, state machine, alerts), and a zero-dependency HTTP dashboard. Detection is edge-triggered by a hotplug POST from the Flint plus polling backup.

**Tech Stack:** Plain Node 22 ESM (.mjs), `node:test`, `node:http`, `node:child_process` + OpenSSH client in the Alpine image. No npm dependencies.

## Global Constraints

- Zero npm runtime dependencies (repo has none today; keep it that way).
- ESM `.mjs` modules; pure functions exported for tests, stateful wrappers separate (pattern of `src/collector.mjs`).
- Tests via `node --test` (`pnpm test`); style of `src/collector.test.mjs`.
- No Co-Authored-By lines in commits; imperative commit messages like existing history.
- Cost rate: €0.03 per MB (1e6 bytes), env-overridable `LTE_COST_PER_MB`.
- All timestamps ISO-8601 UTC via `new Date().toISOString()` (repo convention).
- Container runs `network_mode: host` as user `node` (uid 1000).

## As-built state (already applied live 2026-07-27 — do NOT redo)

- Flint: `lan5` removed from br-lan; `network.secondwan` = dhcp on lan5, metric 15, ipv6 0; `kmwan.secondwan.track_mode='passive'`; firewall wan zone already contained `secondwan`. Verified: secondwan up, IP 192.168.8.184 from Spitz, `ping -I lan5 1.1.1.1` = 2/2 replies.
- Spitz (GL-X2000, fw 4.0 0713release2, admin at 192.168.8.1 on the LTE side of lan5): cellular connected (auto APN, vodafone.de, CGNAT 100.84.x.x), SIM 1 = CallYa (+4915221923495), both Wi-Fi radios OFF, GoodCloud unconfigured, no auto-upgrade, "save data when power off" ON. Signal: LTE B1, RSRP −107 (Fair), SINR 11.
- Flint `/etc/hotplug.d/iface/99-wanlog` is MISSING (lost since Jul 16) — recreated in Task 7 (deploy) below, because its POST target only exists after deploy.
- kmwan member metrics: wan=10, secondwan=15, wwan=20, tethering=30, modem=40.
- NUC = 192.168.0.37 (LAN). Flint = 192.168.0.1, dropbear SSH as root. Dashboard port: 8799.

---

### Task 1: Pure LTE logic — counters, cost, state (src/lte.mjs part 1)

**Files:**
- Create: `src/lte.mjs`
- Test: `src/lte.test.mjs`

**Interfaces:**
- Produces:
  - `deltaBytes(prev: number|null|undefined, curr: number) -> number` (≥0; counter reset → returns `curr`)
  - `costEur(bytes: number, ratePerMb = RATE_PER_MB) -> number`
  - `deriveConnState({wanUp: boolean, lteUp: boolean}) -> "CABLE_OK"|"LTE_ACTIVE"|"ALL_DOWN"`
  - `nextSampleDelayMs(connState) -> 60000|600000`
  - `aggregateUsage(entries: {ts,bytes}[], nowIso: string) -> {day,month,total: {bytes, costEur}}`
  - `isDrillDue(lastDrillTs: string|null, nowIso: string) -> boolean`
  - `shouldSendRunningUpdate(connState, lastUpdateAt: number|null, now: number) -> boolean`
  - `fmtMb(bytes) -> string`, `fmtEur(eur) -> string`
  - Constants: `RATE_PER_MB`, `FAST_SAMPLE_MS=60_000`, `SLOW_SAMPLE_MS=600_000`, `RUNNING_UPDATE_MS=1_800_000`, `BACKUP_ALERT_COOLDOWN_MS=21_600_000`

- [ ] **Step 1: Write the failing tests** (`src/lte.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  deltaBytes, costEur, deriveConnState, nextSampleDelayMs,
  aggregateUsage, isDrillDue, shouldSendRunningUpdate,
} from "./lte.mjs";

test("deltaBytes: first sample establishes baseline", () => {
  assert.equal(deltaBytes(null, 5000), 0);
  assert.equal(deltaBytes(undefined, 5000), 0);
});
test("deltaBytes: normal monotonic delta", () => {
  assert.equal(deltaBytes(1000, 1500), 500);
});
test("deltaBytes: counter reset returns bytes since reset", () => {
  assert.equal(deltaBytes(900000, 200), 200);
});
test("costEur: 3 ct per MB", () => {
  assert.equal(costEur(1_000_000, 0.03), 0.03);
  assert.equal(costEur(0, 0.03), 0);
});
test("deriveConnState", () => {
  assert.equal(deriveConnState({ wanUp: true, lteUp: true }), "CABLE_OK");
  assert.equal(deriveConnState({ wanUp: false, lteUp: true }), "LTE_ACTIVE");
  assert.equal(deriveConnState({ wanUp: false, lteUp: false }), "ALL_DOWN");
});
test("nextSampleDelayMs: fast only while LTE active", () => {
  assert.equal(nextSampleDelayMs("LTE_ACTIVE"), 60_000);
  assert.equal(nextSampleDelayMs("CABLE_OK"), 600_000);
});
test("aggregateUsage buckets by UTC day and month", () => {
  const entries = [
    { ts: "2026-07-27T10:00:00Z", bytes: 1_000_000 },
    { ts: "2026-07-26T10:00:00Z", bytes: 2_000_000 },
    { ts: "2026-06-01T10:00:00Z", bytes: 4_000_000 },
  ];
  const a = aggregateUsage(entries, "2026-07-27T12:00:00.000Z");
  assert.equal(a.day.bytes, 1_000_000);
  assert.equal(a.month.bytes, 3_000_000);
  assert.equal(a.total.bytes, 7_000_000);
  assert.ok(Math.abs(a.month.costEur - 0.09) < 1e-9);
});
test("isDrillDue: due once per month after ~04:00 Berlin (03 UTC)", () => {
  assert.equal(isDrillDue(null, "2026-07-01T05:00:00.000Z"), true);
  assert.equal(isDrillDue("2026-06-01T05:00:00.000Z", "2026-07-01T05:00:00.000Z"), true);
  assert.equal(isDrillDue("2026-07-01T05:00:00.000Z", "2026-07-15T09:00:00.000Z"), false);
  assert.equal(isDrillDue(null, "2026-07-01T01:00:00.000Z"), false); // before 03 UTC
});
test("shouldSendRunningUpdate: every 30 min while LTE active", () => {
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", null, 10_000_000), true);
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", 10_000_000, 10_000_000 + 1_800_000), true);
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", 10_000_000, 10_000_000 + 60_000), false);
  assert.equal(shouldSendRunningUpdate("CABLE_OK", null, 10_000_000), false);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test src/lte.test.mjs`  — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/lte.mjs`)

```js
export const RATE_PER_MB = parseFloat(process.env.LTE_COST_PER_MB ?? "0.03");
export const FAST_SAMPLE_MS = 60_000;
export const SLOW_SAMPLE_MS = 600_000;
export const RUNNING_UPDATE_MS = 30 * 60_000;
export const BACKUP_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

export function deltaBytes(prev, curr) {
  if (prev === null || prev === undefined || !Number.isFinite(curr)) return 0;
  return curr >= prev ? curr - prev : curr; // reset → bytes since reset
}

export function costEur(bytes, ratePerMb = RATE_PER_MB) {
  return (bytes / 1e6) * ratePerMb;
}

export function deriveConnState({ wanUp, lteUp }) {
  if (wanUp) return "CABLE_OK";
  return lteUp ? "LTE_ACTIVE" : "ALL_DOWN";
}

export function nextSampleDelayMs(connState) {
  return connState === "LTE_ACTIVE" ? FAST_SAMPLE_MS : SLOW_SAMPLE_MS;
}

export function aggregateUsage(entries, nowIso) {
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  let d = 0, m = 0, t = 0;
  for (const e of entries) {
    t += e.bytes;
    if (e.ts.slice(0, 7) === month) m += e.bytes;
    if (e.ts.slice(0, 10) === day) d += e.bytes;
  }
  const wrap = (bytes) => ({ bytes, costEur: costEur(bytes) });
  return { day: wrap(d), month: wrap(m), total: wrap(t) };
}

// Due when we enter a new calendar month, but only after 03:00 UTC (~04:00 Berlin)
export function isDrillDue(lastDrillTs, nowIso) {
  if (parseInt(nowIso.slice(11, 13), 10) < 3) return false;
  return (lastDrillTs ?? "").slice(0, 7) < nowIso.slice(0, 7);
}

export function shouldSendRunningUpdate(connState, lastUpdateAt, now) {
  return connState === "LTE_ACTIVE" && now - (lastUpdateAt ?? 0) >= RUNNING_UPDATE_MS;
}

export function fmtMb(bytes) {
  return (bytes / 1e6).toFixed(1);
}

export function fmtEur(eur) {
  return eur.toFixed(2) + " €";
}
```

- [ ] **Step 4: Run tests, verify PASS**: `node --test src/lte.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lte.mjs src/lte.test.mjs && git commit -m "Add LTE metering pure logic: deltas, cost, state, schedules"`

---

### Task 2: Pure LTE alerts (src/lte.mjs part 2)

**Files:**
- Modify: `src/lte.mjs` (append)
- Test: `src/lte.test.mjs` (append)

**Interfaces:**
- Consumes: `costEur`, `fmtMb`, `fmtEur`, `BACKUP_ALERT_COOLDOWN_MS` (Task 1), `Color` from `src/notify.mjs`
- Produces: `deriveLteAlerts(state, curr, now) -> {alerts: {message,color}[], state}`
  - `state`: `{connState?, armed?, backupOk?, lastBackupAlertAt?}` (previous; empty `{}` on first run)
  - `curr`: `{connState, armed, backupOk, closedSession: {startTs,endTs,bytes}|null}`
  - Edge-triggered like `deriveAlerts` in `src/collector.mjs`.

- [ ] **Step 1: Write the failing tests** (append to `src/lte.test.mjs`)

```js
import { deriveLteAlerts } from "./lte.mjs";
import { Color } from "./notify.mjs";

const NOW = 1_800_000_000_000;

test("alert on failover start", () => {
  const { alerts, state } = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "LTE_ACTIVE", armed: true, backupOk: true, closedSession: null },
    NOW,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Failover active/);
  assert.equal(alerts[0].color, Color.RED);
  assert.equal(state.connState, "LTE_ACTIVE");
});
test("alert with cost summary on failover end", () => {
  const { alerts } = deriveLteAlerts(
    { connState: "LTE_ACTIVE", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: true,
      closedSession: { startTs: new Date(NOW - 3_600_000).toISOString(), endTs: new Date(NOW).toISOString(), bytes: 50_000_000 } },
    NOW,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /50\.0 MB/);
  assert.match(alerts[0].message, /1\.50 €/);
  assert.equal(alerts[0].color, Color.GREEN);
});
test("alert on disarm and re-arm", () => {
  const a = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: false, backupOk: true, closedSession: null }, NOW);
  assert.match(a.alerts[0].message, /disarmed/);
  const b = deriveLteAlerts(a.state,
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.match(b.alerts[0].message, /armed/);
});
test("backup-broken alert once per cooldown, only while cable ok", () => {
  const first = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: false, closedSession: null }, NOW);
  assert.equal(first.alerts.length, 1);
  assert.match(first.alerts[0].message, /broken/);
  const second = deriveLteAlerts(first.state,
    { connState: "CABLE_OK", armed: true, backupOk: false, closedSession: null }, NOW + 60_000);
  assert.equal(second.alerts.length, 0);
});
test("no alerts on steady state or first run", () => {
  const steady = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.equal(steady.alerts.length, 0);
  const first = deriveLteAlerts({},
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.equal(first.alerts.length, 0);
});
```

- [ ] **Step 2: Run, verify FAIL**: `node --test src/lte.test.mjs`
- [ ] **Step 3: Implement** (append to `src/lte.mjs`)

```js
import { Color } from "./notify.mjs";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://192.168.0.37:8799";

export function deriveLteAlerts(state, curr, now) {
  const alerts = [];
  const next = { ...state };

  if (state.connState !== undefined && state.connState !== curr.connState) {
    if (curr.connState === "LTE_ACTIVE") {
      alerts.push({
        message: `**Failover active** — traffic is running over LTE at ${(RATE_PER_MB * 100).toFixed(0)} ct/MB. ${DASHBOARD_URL}`,
        color: Color.RED,
      });
    } else if (state.connState === "LTE_ACTIVE" && curr.closedSession) {
      const s = curr.closedSession;
      const mins = Math.max(1, Math.round((Date.parse(s.endTs) - Date.parse(s.startTs)) / 60_000));
      alerts.push({
        message: `Failover ended after ${mins} min — ${fmtMb(s.bytes)} MB ≈ ${fmtEur(costEur(s.bytes))}.`,
        color: Color.GREEN,
      });
    } else if (curr.connState === "ALL_DOWN") {
      alerts.push({
        message: `**ALL DOWN** — cable is down and LTE fallback is ${curr.armed ? "unavailable" : "disarmed"}.`,
        color: Color.RED,
      });
    }
  }

  if (state.armed !== undefined && state.armed !== curr.armed) {
    alerts.push(
      curr.armed
        ? { message: "LTE fallback **armed**.", color: Color.GREEN }
        : { message: "LTE fallback **disarmed** — no automatic failover until re-armed.", color: Color.YELLOW },
    );
  }

  if (
    curr.connState === "CABLE_OK" && curr.armed &&
    curr.backupOk === false && state.backupOk !== false &&
    now - (state.lastBackupAlertAt ?? 0) > BACKUP_ALERT_COOLDOWN_MS
  ) {
    alerts.push({
      message: "LTE backup looks **broken** (health ping via Spitz failed) — failover would not work right now.",
      color: Color.YELLOW,
    });
    next.lastBackupAlertAt = now;
  }

  next.connState = curr.connState;
  next.armed = curr.armed;
  next.backupOk = curr.backupOk;
  return { alerts, state: next };
}
```

- [ ] **Step 4: Run, verify PASS**: `node --test src/lte.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lte.mjs src/lte.test.mjs && git commit -m "Add edge-triggered LTE failover alerts"`

---

### Task 3: Flint SSH client (src/flint.mjs)

**Files:**
- Create: `src/flint.mjs`
- Test: `src/flint.test.mjs` (pure parsers only)

**Interfaces:**
- Produces:
  - `parseIfaceStatus(jsonStr) -> {up: boolean, autostart: boolean, device: string|null}`
  - `parseCountersTotal(out: string) -> number|null` (sum rx+tx from two-line output)
  - `flintSsh(command: string) -> Promise<string>` (stdout; throws on ssh failure)
  - `getIfaceStatus(iface) -> Promise<{up,autostart,device}>`
  - `readCountersTotal() -> Promise<number|null>` (null when device stats unreadable)
  - `setLteArmed(up: boolean) -> Promise<void>` (`ifup`/`ifdown` on LTE_IFACE)
  - `healthPing() -> Promise<boolean>` (1 ping via LTE_DEVICE)
  - `runDrill() -> Promise<{ok: boolean, bytes: number, seconds: number}>`
- Env: `FLINT_SSH_HOST` (default `192.168.0.1`), `FLINT_SSH_USER` (`root`), `FLINT_SSH_KEY` (`/app/ssh/id_ed25519`), `FLINT_KNOWN_HOSTS` (`/app/ssh/known_hosts`), `LTE_IFACE` (`secondwan`), `LTE_DEVICE` (`lan5`), `DRILL_URL` (`https://speed.cloudflare.com/__down?bytes=2000000`)

- [ ] **Step 1: Failing tests** (`src/flint.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseIfaceStatus, parseCountersTotal } from "./flint.mjs";

test("parseIfaceStatus reads up/autostart/l3_device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: true, autostart: true, l3_device: "lan5" }));
  assert.deepEqual(s, { up: true, autostart: true, device: "lan5" });
});
test("parseIfaceStatus handles down iface without device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: false, autostart: false }));
  assert.deepEqual(s, { up: false, autostart: false, device: null });
});
test("parseCountersTotal sums rx and tx lines", () => {
  assert.equal(parseCountersTotal("12345\n678\n"), 13023);
});
test("parseCountersTotal returns null on garbage", () => {
  assert.equal(parseCountersTotal("cat: no such file\n"), null);
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** (`src/flint.mjs`)

```js
import { execFile } from "node:child_process";

const HOST = process.env.FLINT_SSH_HOST ?? "192.168.0.1";
const USER = process.env.FLINT_SSH_USER ?? "root";
const KEY = process.env.FLINT_SSH_KEY ?? "/app/ssh/id_ed25519";
const KNOWN_HOSTS = process.env.FLINT_KNOWN_HOSTS ?? "/app/ssh/known_hosts";
const LTE_IFACE = process.env.LTE_IFACE ?? "secondwan";
const LTE_DEVICE = process.env.LTE_DEVICE ?? "lan5";
const DRILL_URL = process.env.DRILL_URL ?? "https://speed.cloudflare.com/__down?bytes=2000000";

export function parseIfaceStatus(jsonStr) {
  const j = JSON.parse(jsonStr);
  return { up: !!j.up, autostart: !!j.autostart, device: j.l3_device ?? j.device ?? null };
}

export function parseCountersTotal(out) {
  const [rx, tx] = out.trim().split("\n").map((l) => parseInt(l, 10));
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return rx + tx;
}

export function flintSsh(command) {
  const args = [
    "-i", KEY,
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    `${USER}@${HOST}`,
    command,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 150_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ssh ${command}: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

export async function getIfaceStatus(iface) {
  return parseIfaceStatus(await flintSsh(`ubus call network.interface.${iface} status`));
}

export async function readCountersTotal() {
  const out = await flintSsh(
    `cat /sys/class/net/${LTE_DEVICE}/statistics/rx_bytes /sys/class/net/${LTE_DEVICE}/statistics/tx_bytes 2>/dev/null || echo ERR`,
  );
  return parseCountersTotal(out);
}

export async function setLteArmed(up) {
  await flintSsh(`${up ? "ifup" : "ifdown"} ${LTE_IFACE}`);
}

export async function healthPing() {
  const out = await flintSsh(`ping -I ${LTE_DEVICE} -c 1 -W 5 1.1.1.1 >/dev/null 2>&1 && echo OK || echo FAIL`);
  return out.includes("OK");
}

export async function runDrill() {
  const out = await flintSsh(
    `curl --interface ${LTE_DEVICE} -s -o /dev/null --max-time 120 -w '%{size_download} %{time_total}' '${DRILL_URL}' || echo '0 0'`,
  );
  const [bytes, seconds] = out.trim().split(/\s+/).map(Number);
  return { ok: bytes > 1_000_000, bytes: bytes || 0, seconds: seconds || 0 };
}
```

- [ ] **Step 4: Run, verify PASS**: `node --test src/flint.test.mjs`
- [ ] **Step 5: Commit**: `git add src/flint.mjs src/flint.test.mjs && git commit -m "Add Flint SSH client for LTE state, counters and drill"`

Note: the Flint has curl (GL 4.x ships it) — verified during deploy smoke test (Task 7); fallback documented there.

---

### Task 4: Dashboard HTTP server (src/dashboard.mjs)

**Files:**
- Create: `src/dashboard.mjs`
- Test: `src/dashboard.test.mjs`

**Interfaces:**
- Consumes: none (deps injected).
- Produces: `startDashboard({port, getStatus, toggleArmed, onWanEvent}) -> http.Server`
  - `GET /` → HTML page; `GET /api/status` → JSON from `getStatus()`;
  - `POST /api/toggle` → `{armed}` from `await toggleArmed()`;
  - `POST /event` (hotplug) → parses `{iface, action}`, calls `onWanEvent(evt)`, returns `{ok:true}`.

- [ ] **Step 1: Failing tests** (`src/dashboard.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./dashboard.mjs";

function serve(overrides = {}) {
  const calls = { toggles: 0, events: [] };
  const server = startDashboard({
    port: 0,
    getStatus: () => ({ connState: "CABLE_OK", armed: true }),
    toggleArmed: async () => { calls.toggles++; return false; },
    onWanEvent: (e) => calls.events.push(e),
    ...overrides,
  });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, base, calls };
}

test("GET /api/status returns status JSON", async () => {
  const { server, base } = serve();
  const res = await fetch(`${base()}/api/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connState: "CABLE_OK", armed: true });
  server.close();
});
test("GET / serves HTML with toggle button", async () => {
  const { server, base } = serve();
  const html = await (await fetch(base() + "/")).text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /api\/toggle/);
  server.close();
});
test("POST /api/toggle calls toggleArmed", async () => {
  const { server, base, calls } = serve();
  const res = await fetch(`${base()}/api/toggle`, { method: "POST" });
  assert.deepEqual(await res.json(), { armed: false });
  assert.equal(calls.toggles, 1);
  server.close();
});
test("POST /event dispatches wan event", async () => {
  const { server, base, calls } = serve();
  await fetch(`${base()}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iface: "wan", action: "ifdown" }),
  });
  assert.deepEqual(calls.events, [{ iface: "wan", action: "ifdown" }]);
  server.close();
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** (`src/dashboard.mjs`) — single HTML template literal, dark theme, 10 s polling:

```js
import { createServer } from "node:http";
import { log } from "./log.mjs";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LTE Failover</title>
<style>
body{font:16px/1.5 system-ui;background:#0f1117;color:#e6e6e6;max-width:680px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.3rem} .row{margin:.8rem 0}
.badge{display:inline-block;padding:.25rem .8rem;border-radius:.5rem;font-weight:700}
.CABLE_OK{background:#14532d}.LTE_ACTIVE{background:#7f1d1d}.ALL_DOWN{background:#450a0a;outline:2px solid #ef4444}
.pill{padding:.15rem .6rem;border-radius:1rem;font-size:.8rem;background:#1f2937}
button{font:inherit;padding:.5rem 1.4rem;border-radius:.5rem;border:0;cursor:pointer;background:#2563eb;color:#fff}
button.off{background:#4b5563}
table{width:100%;border-collapse:collapse;margin-top:1rem}
td,th{padding:.35rem .5rem;border-bottom:1px solid #262b36;text-align:left;font-size:.85rem}
.muted{color:#8b93a7;font-size:.8rem}.num{font-variant-numeric:tabular-nums}
</style></head><body>
<h1>LTE Failover — Spitz Plus / CallYa</h1>
<div class="row"><span id="state" class="badge">…</span> <span id="armed" class="pill"></span> <span id="backup" class="pill"></span></div>
<div class="row" id="session"></div>
<div class="row num">Today <b id="day">–</b> · Month <b id="month">–</b> · Total <b id="total">–</b></div>
<div class="row"><button id="btn" onclick="toggle()">…</button></div>
<table><thead><tr><th>Start</th><th>Duration</th><th>MB</th><th>Cost</th></tr></thead><tbody id="hist"></tbody></table>
<p class="muted" id="updated"></p>
<script>
const mb=b=>(b/1e6).toFixed(1), eur=v=>v.toFixed(2)+" €";
async function refresh(){
  const s=await (await fetch("api/status")).json();
  const st=document.getElementById("state");
  st.textContent=s.connState??"UNKNOWN"; st.className="badge "+(s.connState??"");
  document.getElementById("armed").textContent=s.armed?"armed":"DISARMED";
  document.getElementById("backup").textContent=s.backupOk===false?"⚠ backup broken":"backup ok";
  document.getElementById("session").textContent=s.session?("Active session: "+mb(s.session.bytes)+" MB ≈ "+eur(s.session.costEur)):"";
  if(s.totals)for(const k of["day","month","total"])document.getElementById(k).textContent=mb(s.totals[k].bytes)+" MB / "+eur(s.totals[k].costEur);
  const b=document.getElementById("btn");
  b.textContent=s.armed?"Disarm fallback":"Arm fallback"; b.className=s.armed?"":"off";
  document.getElementById("hist").innerHTML=(s.history??[]).map(h=>{
    const min=Math.max(1,Math.round((Date.parse(h.endTs)-Date.parse(h.startTs))/60000));
    return "<tr><td>"+h.startTs.slice(0,16).replace("T"," ")+"</td><td>"+min+" min</td><td>"+mb(h.bytes)+"</td><td>"+eur(h.costEur??0)+"</td></tr>";
  }).join("");
  document.getElementById("updated").textContent="updated "+(s.updatedAt??"never");
}
async function toggle(){
  document.getElementById("btn").disabled=true;
  try{await fetch("api/toggle",{method:"POST"});}finally{document.getElementById("btn").disabled=false;}
  refresh();
}
setInterval(refresh,10000);refresh();
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function startDashboard({ port, getStatus, toggleArmed, onWanEvent }) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (req.method === "GET" && req.url === "/api/status") {
        json(res, await getStatus());
      } else if (req.method === "POST" && req.url === "/api/toggle") {
        json(res, { armed: await toggleArmed() });
      } else if (req.method === "POST" && req.url === "/event") {
        let evt = {};
        try { evt = JSON.parse((await readBody(req)) || "{}"); } catch { /* ignore malformed */ }
        if (evt.iface) onWanEvent({ iface: evt.iface, action: evt.action });
        json(res, { ok: true });
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      log(`Dashboard error ${req.method} ${req.url}: ${err.message}`);
      json(res, { error: err.message }, 500);
    }
  });
  server.listen(port);
  return server;
}
```

- [ ] **Step 4: Run, verify PASS**: `node --test src/dashboard.test.mjs`
- [ ] **Step 5: Commit**: `git add src/dashboard.mjs src/dashboard.test.mjs && git commit -m "Add LTE dashboard web app with kill switch"`

---

### Task 5: Monitor orchestration (src/lte-monitor.mjs) + wiring (src/index.mjs)

**Files:**
- Create: `src/lte-monitor.mjs`
- Modify: `src/index.mjs` (add startup block after existing `log(...)` banner section)
- Test: `src/lte-monitor.test.mjs` (with injected fakes)

**Interfaces:**
- Consumes: Task 1–4 exports.
- Produces: `startLteMonitor(deps?) -> {getStatus, toggleArmed, onWanEvent, tick}`
  - `deps`: `{flint?, send?, autoStart?}` — `flint` defaults to `src/flint.mjs` exports, `send` to `notify`, `autoStart` true (schedules ticks). Tests pass fakes + `autoStart:false` and drive `tick()` manually.
- Data files: `data/lte-usage.jsonl` (`{ts,bytes}` per positive delta), `data/lte-sessions.jsonl` (`{startTs,endTs,bytes,costEur}`), `data/lte-state.json` (`{lastDrillTs}`).

- [ ] **Step 1: Failing tests** (`src/lte-monitor.test.mjs`) — fake flint scripted per tick; assert: session opens on wan down (alert sent), bytes accumulate, session closes with summary alert; toggleArmed calls `setLteArmed(false)` and re-ticks; onWanEvent triggers a near-immediate tick (use `autoStart:false` + manual `tick()`; for the event test assert a scheduled tick fires within ~3 s).

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lte-test-"));
const { startLteMonitor } = await import("./lte-monitor.mjs");

function fakeFlint(script) {
  let i = 0;
  const cur = () => script[Math.min(i, script.length - 1)];
  return {
    advance: () => i++,
    getIfaceStatus: async (iface) => cur()[iface],
    readCountersTotal: async () => cur().counter,
    setLteArmed: async (up) => { cur().armedSet = up; },
    healthPing: async () => true,
    runDrill: async () => ({ ok: true, bytes: 2_000_000, seconds: 1.5 }),
  };
}

test("failover session lifecycle produces alerts and usage", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 1000 },
    { wan: { up: false, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 1000 },
    { wan: { up: false, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 5_001_000 },
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 5_001_000 },
  ];
  const flint = fakeFlint(script);
  const sent = [];
  const m = startLteMonitor({ flint, send: async (msg, color) => sent.push({ msg, color }), autoStart: false });

  await m.tick(); flint.advance();          // baseline, CABLE_OK
  await m.tick(); flint.advance();          // wan down → LTE_ACTIVE
  assert.ok(sent.some((s) => /Failover active/.test(s.msg)));
  await m.tick(); flint.advance();          // +5 MB while active
  const status = await m.getStatus();
  assert.equal(status.session.bytes, 5_000_000);
  await m.tick();                           // wan back → session closed
  assert.ok(sent.some((s) => /Failover ended/.test(s.msg) && /5\.0 MB/.test(s.msg)));
  assert.equal((await m.getStatus()).session, null);
});

test("toggleArmed disarms via flint and reports state", async () => {
  const script = [{ wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 }];
  const flint = fakeFlint(script);
  const m = startLteMonitor({ flint, send: async () => {}, autoStart: false });
  await m.tick();
  const armed = await m.toggleArmed();
  assert.equal(armed, false);
  assert.equal(script[0].armedSet, false);
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** (`src/lte-monitor.mjs`)

```js
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";
import * as realFlint from "./flint.mjs";
import {
  aggregateUsage, costEur, deltaBytes, deriveConnState, deriveLteAlerts,
  fmtEur, fmtMb, isDrillDue, nextSampleDelayMs, shouldSendRunningUpdate,
  SLOW_SAMPLE_MS,
} from "./lte.mjs";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const LTE_IFACE = process.env.LTE_IFACE ?? "secondwan";
const USAGE_FILE = join(DATA_DIR, "lte-usage.jsonl");
const SESSIONS_FILE = join(DATA_DIR, "lte-sessions.jsonl");
const STATE_FILE = join(DATA_DIR, "lte-state.json");

function loadJsonl(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}

export function startLteMonitor(deps = {}) {
  const flint = deps.flint ?? realFlint;
  const send = deps.send ?? notify;
  const autoStart = deps.autoStart ?? true;

  mkdirSync(DATA_DIR, { recursive: true });
  const usage = loadJsonl(USAGE_FILE);
  const sessions = loadJsonl(SESSIONS_FILE);
  let persisted = {};
  try { persisted = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }

  let alertState = {};
  let session = null;
  let lastCounter = null;
  let lastHealthAt = 0;
  let backupOk = undefined;
  let lastRunningUpdateAt = null;
  let lastTickTs = null;
  let timer = null;

  async function tick() {
    const ts = new Date().toISOString();
    const now = Date.now();
    const [wan, lte] = await Promise.all([
      flint.getIfaceStatus("wan"),
      flint.getIfaceStatus(LTE_IFACE),
    ]);
    const armed = !!lte.autostart;

    const counter = await flint.readCountersTotal();
    const delta = counter === null ? 0 : deltaBytes(lastCounter, counter);
    if (counter !== null) lastCounter = counter;
    if (delta > 0) {
      const entry = { ts, bytes: delta };
      appendFileSync(USAGE_FILE, JSON.stringify(entry) + "\n");
      usage.push(entry);
      if (session) session.bytes += delta;
    }

    const connState = deriveConnState({ wanUp: wan.up, lteUp: lte.up });

    let closedSession = null;
    if (connState === "LTE_ACTIVE" && !session) {
      session = { startTs: ts, bytes: 0 };
    } else if (connState !== "LTE_ACTIVE" && session) {
      closedSession = { ...session, endTs: ts };
      const rec = { ...closedSession, costEur: costEur(closedSession.bytes) };
      appendFileSync(SESSIONS_FILE, JSON.stringify(rec) + "\n");
      sessions.push(rec);
      session = null;
    }

    // Health ping at slow cadence, only when idle+armed (LTE_ACTIVE traffic proves itself)
    if (connState === "CABLE_OK" && armed && lte.up && now - lastHealthAt >= SLOW_SAMPLE_MS) {
      lastHealthAt = now;
      try { backupOk = await flint.healthPing(); } catch { backupOk = false; }
    } else if (connState === "LTE_ACTIVE") {
      backupOk = true;
    }

    const { alerts, state } = deriveLteAlerts(alertState, { connState, armed, backupOk, closedSession }, now);
    alertState = state;
    for (const a of alerts) await send(a.message, a.color);

    if (session && shouldSendRunningUpdate(connState, lastRunningUpdateAt, now)) {
      lastRunningUpdateAt = now;
      await send(`LTE failover still active — session ${fmtMb(session.bytes)} MB ≈ ${fmtEur(costEur(session.bytes))}.`, Color.YELLOW);
    }
    if (!session) lastRunningUpdateAt = null;

    if (connState === "CABLE_OK" && isDrillDue(persisted.lastDrillTs, ts)) {
      persisted.lastDrillTs = ts;
      writeFileSync(STATE_FILE, JSON.stringify(persisted));
      if (armed) {
        try {
          const r = await flint.runDrill();
          const mbit = r.seconds > 0 ? ((r.bytes * 8) / r.seconds / 1e6).toFixed(0) : "?";
          await send(
            r.ok
              ? `Monthly LTE drill OK — ${fmtMb(r.bytes)} MB in ${r.seconds.toFixed(1)} s (~${mbit} Mbit/s), cost ≈ ${fmtEur(costEur(r.bytes))}.`
              : "Monthly LTE drill **FAILED** — check the Spitz/SIM.",
            r.ok ? Color.GREEN : Color.RED,
          );
        } catch (err) {
          await send(`Monthly LTE drill **FAILED**: ${err.message}`, Color.RED);
        }
      } else {
        await send("Monthly LTE drill skipped — fallback is disarmed.", Color.YELLOW);
      }
    }

    lastTickTs = ts;
    if (autoStart) schedule(nextSampleDelayMs(connState));
    return connState;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tick().catch((err) => {
        log(`LTE monitor tick failed: ${err.message}`);
        schedule(SLOW_SAMPLE_MS);
      });
    }, ms);
    timer.unref?.();
  }

  async function getStatus() {
    return {
      connState: alertState.connState ?? null,
      armed: alertState.armed ?? null,
      backupOk: backupOk ?? null,
      session: session ? { ...session, costEur: costEur(session.bytes) } : null,
      totals: aggregateUsage(usage, new Date().toISOString()),
      history: sessions.slice(-20).reverse(),
      updatedAt: lastTickTs,
    };
  }

  async function toggleArmed() {
    const lte = await flint.getIfaceStatus(LTE_IFACE);
    await flint.setLteArmed(!lte.autostart);
    await tick();
    return !lte.autostart;
  }

  function onWanEvent(evt) {
    log(`WAN event from Flint: ${evt.iface} ${evt.action}`);
    if (autoStart) schedule(2_000);
  }

  if (autoStart) {
    tick().catch((err) => {
      log(`LTE monitor initial tick failed: ${err.message}`);
      schedule(SLOW_SAMPLE_MS);
    });
  }

  return { getStatus, toggleArmed, onWanEvent, tick };
}
```

- [ ] **Step 4: Wire into `src/index.mjs`** — after the startup `log(...)` lines, before `await runCheck()`:

```js
import { startLteMonitor } from "./lte-monitor.mjs";
import { startDashboard } from "./dashboard.mjs";

const LTE_ENABLED = (process.env.LTE_ENABLED ?? "true") !== "false";
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "8799");

if (LTE_ENABLED && !once) {
  try {
    const monitor = startLteMonitor();
    startDashboard({ port: DASHBOARD_PORT, ...monitor });
    log(`LTE failover monitor started, dashboard on :${DASHBOARD_PORT}`);
  } catch (err) {
    log(`LTE monitor disabled: ${err.message}`);
  }
}
```

- [ ] **Step 5: Run FULL suite, verify PASS**: `pnpm test`
- [ ] **Step 6: Commit**: `git add src/lte-monitor.mjs src/lte-monitor.test.mjs src/index.mjs && git commit -m "Add LTE monitor orchestration and dashboard wiring"`

---

### Task 6: Packaging — Dockerfile, compose, env, README

**Files:**
- Modify: `Dockerfile` (add ssh client), `docker-compose.yml` (ssh mount), `.env.example`, `README.md`

- [ ] **Step 1: Dockerfile** — after `FROM node:22-alpine`:

```dockerfile
RUN apk add --no-cache openssh-client
```

- [ ] **Step 2: docker-compose.yml** — add under `volumes:`:

```yaml
      # SSH key for Flint access (LTE failover metering + kill switch)
      - ./ssh:/app/ssh:ro
```

- [ ] **Step 3: .env.example** — append:

```
# LTE failover monitor (Spitz Plus + CallYa via Flint secondwan)
# LTE_ENABLED=true
# FLINT_SSH_HOST=192.168.0.1
# FLINT_SSH_USER=root
# FLINT_SSH_KEY=/app/ssh/id_ed25519
# FLINT_KNOWN_HOSTS=/app/ssh/known_hosts
# LTE_IFACE=secondwan
# LTE_DEVICE=lan5
# LTE_COST_PER_MB=0.03
# DASHBOARD_PORT=8799
# DASHBOARD_URL=http://192.168.0.37:8799
# DRILL_URL=https://speed.cloudflare.com/__down?bytes=2000000
```

- [ ] **Step 4: README.md** — add an "LTE failover monitor" section: what it does (metering at 3 ct/MB, dashboard + kill switch on :8799, Discord alerts, monthly drill), pointer to the spec/plan docs.
- [ ] **Step 5: Run `pnpm test`, verify PASS. Commit**: `git add Dockerfile docker-compose.yml .env.example README.md && git commit -m "Package LTE monitor: ssh client, key mount, env, docs"`

---

### Task 7: Deploy to NUC + Flint hotplug POST

Live infrastructure steps over SSH (`ssh nuc`, `ssh flint`), from the repo owner's machine.

- [ ] **Step 1: Push main** → wait for the GHCR publish workflow (`gh run watch`) to build `ghcr.io/1-felix/vodafone-automation:latest`.
- [ ] **Step 2: SSH key for the container** (on the NUC, in `~/dev/docker-compose-files/vodafone-automation/`):

```bash
mkdir -p ssh
ssh-keygen -t ed25519 -f ssh/id_ed25519 -N "" -C vodafone-monitor
ssh-keyscan 192.168.0.1 > ssh/known_hosts
sudo chown -R 1000:1000 ssh && chmod 600 ssh/id_ed25519
```

- [ ] **Step 3: Authorize on the Flint** (dropbear): append `ssh/id_ed25519.pub` content to `/etc/dropbear/authorized_keys` on the Flint.
- [ ] **Step 4: NUC .env** — add the `LTE_*`/`FLINT_*`/`DASHBOARD_*` values from Task 6 (uncommented). Check port first: `ss -tlnp | grep 8799` (pick another if taken, keep .env + hotplug in sync).
- [ ] **Step 5: `docker compose pull && docker compose up -d`**, then smoke-test:
  - `docker exec vodafone-bridge-monitor ssh -i /app/ssh/id_ed25519 -o UserKnownHostsFile=/app/ssh/known_hosts root@192.168.0.1 echo ok` → `ok`
  - `docker exec vodafone-bridge-monitor sh -c "which ssh"` → present
  - `curl http://192.168.0.37:8799/api/status` → JSON with `connState: "CABLE_OK"`, `armed: true`
  - Verify Flint has curl: `ssh flint "curl --version | head -1"` (if absent: switch `runDrill`/hotplug to `wget -O /dev/null` / `wget --post-data`).
- [ ] **Step 6: Recreate the hotplug script** on the Flint at `/etc/hotplug.d/iface/99-wanlog`:

```sh
[ "$INTERFACE" = "wan" ] || [ "$INTERFACE" = "secondwan" ] || exit 0
echo "$(date -Iseconds) $INTERFACE $ACTION" >> /root/wan-events.log
( curl -m 5 -s -X POST "http://192.168.0.37:8799/event" \
    -H "Content-Type: application/json" \
    -d "{\"iface\":\"$INTERFACE\",\"action\":\"$ACTION\"}" >/dev/null 2>&1 & )
```

  Then test: `ssh flint "ACTION=ifup INTERFACE=secondwan sh /etc/hotplug.d/iface/99-wanlog"` and confirm a `WAN event from Flint` line in `docker logs vodafone-bridge-monitor`.

---

### Task 8: Live acceptance tests (run during a healthy-cable window)

Costs a few cents of LTE data total. Watch Discord + `http://192.168.0.37:8799` throughout.

- [ ] **Test 1 — Baseline:** dashboard shows CABLE_OK / armed / backup ok.
- [ ] **Test 2 — Failover:** `ssh flint ifdown wan` → within ~20 s: traffic flows (from a LAN client, `curl https://ifconfig.me` returns a Vodafone CGNAT/mobile IP), Discord "Failover active", dashboard LTE_ACTIVE with MB counting.
- [ ] **Test 3 — Failback:** `ssh flint ifup wan` → Discord "Failover ended after N min — X MB ≈ Y €", session appears in history table.
- [ ] **Test 4 — Kill switch:** Disarm on dashboard (Discord "disarmed") → `ssh flint ifdown wan` → NO failover (ALL_DOWN badge; no traffic) → `ssh flint ifup wan` → re-arm via dashboard. Also verifies kmwan doesn't resurrect the member on its own; if it does, switch disarm mechanism to `uci set kmwan.secondwan.disabled` + explicit boot-time re-arm and update spec.
- [ ] **Test 5 — Reboot default:** `ssh flint reboot` → after boot, dashboard shows armed (ifdown non-persistence confirmed).
- [ ] **Test 6 — Backup broken:** unplug Spitz power for ~25 min → Discord "backup looks broken"; replug → recovers on next health tick.
- [ ] **Wrap-up:** update memory file (deployment state, acceptance results), mark project done.
