import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "lte-test-"));
process.env.LTE_LINK_GRACE_MS = "0";
const { startLteMonitor } = await import("./lte-monitor.mjs");
const { BALANCE_LOW_EUR } = await import("./lte.mjs");
const { Tier } = await import("./notify.mjs");

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
  const m = startLteMonitor({ flint, send: async (msg, color) => sent.push({ msg, color }), autoStart: false });

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
  const m = startLteMonitor({ flint, send: async () => {}, autoStart: false });
  await m.tick();
  const armed = await m.toggleArmed();
  assert.equal(armed, false);
  assert.equal(script[0].armedSet, false);
});

test("tracked balance: set anchor, decrements with usage, alerts when low", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
    { wan: { up: false, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
    { wan: { up: false, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 10_000_000 },
  ];
  const flint = fakeFlint(script);
  const sent = [];
  const m = startLteMonitor({ flint, send: async (msg, color) => sent.push({ msg, color }), autoStart: false });
  await m.tick(); flint.advance();
  const set = await m.setBalance(10.2);
  assert.equal(set.eur, 10.2);
  await new Promise((r) => setTimeout(r, 5)); // usage ts must sort after anchor ts
  flint.advance();                 // +10 MB during failover → 0.30 €
  await m.tick();
  const status = await m.getStatus();
  assert.equal(status.balance.eur, 9.9);
  assert.equal(status.balance.low, true);
  assert.equal(status.balance.anchorEur, 10.2);
  assert.equal(status.balance.lowEur, BALANCE_LOW_EUR); // dashboard draws the reserve line from this
  assert.ok(sent.some((s) => /balance low/i.test(s.msg)));
});

test("setBalance rejects garbage", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0 },
  ];
  const m = startLteMonitor({ flint: fakeFlint(script), send: async () => {}, autoStart: false });
  await assert.rejects(() => m.setBalance(NaN), /invalid balance/);
  await assert.rejects(() => m.setBalance(-5), /invalid balance/);
});

test("guard open without timer is relocked on next tick (startup/external)", async () => {
  const script = [
    { wan: { up: true, autostart: true }, secondwan: { up: true, autostart: true, device: "lan5" }, counter: 0, guard: "open" },
  ];
  const flint = fakeFlint(script);
  const m = startLteMonitor({ flint, send: async () => {}, autoStart: false });
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
  const m = startLteMonitor({ flint, send: async (msg, color, tier) => sent.push({ msg, color, tier }), autoStart: false });
  await m.tick();
  const g = await m.toggleGuard();
  assert.equal(g.state, "open");
  assert.ok(g.openUntil, "open sets an expiry");
  assert.ok(sent.some((s) => /guard \*\*opened\*\*/.test(s.msg) && s.tier === Tier.LOG));
  const g2 = await m.toggleGuard();
  assert.equal(g2.state, "locked");
  assert.ok(sent.some((s) => /guard \*\*locked\*\*/.test(s.msg) && s.tier === Tier.LOG));
});

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
  // isDrillDue needs hour >= 03:00 UTC and a different month from the last
  // drill. All monitors in this file share one DATA_DIR, so the state file may
  // already hold a real-clock lastDrillTs from an earlier test — the far-future
  // years keep both drills due regardless of what is in there, and the two
  // distinct months keep the second drill due after the first one persists.
  const okSent = [];
  const okMonitor = startLteMonitor({
    flint: fakeFlint(script), autoStart: false,
    nowIso: () => "2099-01-01T03:00:00.000Z",
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
    nowIso: () => "2099-02-01T03:00:00.000Z",
    send: async (msg, color, tier) => failSent.push({ msg, color, tier }),
  });
  await failMonitor.tick();
  const failed = failSent.find((s) => /drill \*\*FAILED\*\*/.test(s.msg));
  assert.ok(failed, "drill failure announced");
  assert.equal(failed.tier, Tier.WARN);
});
