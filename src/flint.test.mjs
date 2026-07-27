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
  assert.equal(parseGuardState(LOCKED.replace("HOOKED\n", "")), "missing");
});
