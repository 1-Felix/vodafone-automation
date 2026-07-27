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

  await m.tick(); flint.advance(); // baseline, CABLE_OK
  await m.tick(); flint.advance(); // wan down → LTE_ACTIVE
  assert.ok(sent.some((s) => /Failover active/.test(s.msg)));
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
