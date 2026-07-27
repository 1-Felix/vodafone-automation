import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lte-test-"));
process.env.LTE_LINK_GRACE_MS = "0";
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
    getGuardState: async () => cur().guard ?? "locked",
    openGuard: async () => { cur().guard = "open"; },
    relockGuard: async () => { cur().guard = "locked"; },
  };
}

function fakeSpitz(result = { eur: 8.5, text: "Guthaben: 8,50 EUR" }) {
  const calls = { n: 0 };
  return { calls, queryBalance: async () => { calls.n++; return result; } };
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
  const m = startLteMonitor({ flint, spitz: fakeSpitz(), send: async (msg, color) => sent.push({ msg, color }), autoStart: false });

  await m.tick(); flint.advance(); // baseline, CABLE_OK
  await m.tick(); flint.advance(); // wan down → LTE_ACTIVE
  assert.ok(sent.some((s) => /Failover active/.test(s.msg)));
  assert.ok(!sent.some((s) => /still active/.test(s.msg)), "no running update at session start");
  await m.tick(); flint.advance(); // +5 MB while active
  const status = await m.getStatus();
  assert.equal(status.session.bytes, 5_000_000);
  assert.equal(status.connState, "LTE_ACTIVE");
  await m.tick(); // wan back → session closed
  assert.ok(sent.some((s) => /Failover ended/.test(s.msg) && /5\.0 MB/.test(s.msg)));
  assert.equal((await m.getStatus()).session, null);
  const totals = (await m.getStatus()).totals;
  assert.equal(totals.total.bytes, 5_000_000);
});

test("dead Spitz link marks backup broken and recovers on relink", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: false, autostart: true, device: null }, counter: 0 },
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
  ];
  const flint = fakeFlint(script);
  const sent = [];
  const m = startLteMonitor({ flint, spitz: fakeSpitz(), send: async (msg, color) => sent.push({ msg, color }), autoStart: false });

  await m.tick(); flint.advance(); // link down, grace 0 in test → broken
  assert.ok(sent.some((s) => /broken/.test(s.msg)));
  assert.equal((await m.getStatus()).backupOk, false);
  await m.tick();                  // link back → immediate health ping clears
  assert.equal((await m.getStatus()).backupOk, true);
});

test("toggleArmed disarms via flint and reports state", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
  ];
  const flint = fakeFlint(script);
  const m = startLteMonitor({ flint, spitz: fakeSpitz(), send: async () => {}, autoStart: false });
  await m.tick();
  const armed = await m.toggleArmed();
  assert.equal(armed, false);
  assert.equal(script[0].armedSet, false);
});

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
