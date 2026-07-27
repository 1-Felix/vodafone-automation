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
  assert.equal(parseCountersTotal("ERR\n"), null);
});
