import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GUARD_STATE_CMD, parseGuardState, parseIfaceStatus } from "./flint.mjs";

test("parseIfaceStatus reads up/autostart/l3_device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: true, autostart: true, l3_device: "lan5" }));
  assert.deepEqual(s, { up: true, autostart: true, device: "lan5" });
});

test("parseIfaceStatus handles down iface without device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: false, autostart: false }));
  assert.deepEqual(s, { up: false, autostart: false, device: null });
});


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

test("GUARD_STATE_CMD exits 0 when the chain is missing, so 'missing' is reported instead of thrown", (t) => {
  // Stub iptables the way a Flint without the guard answers: nothing on stdout, exit 1.
  const dir = mkdtempSync(join(tmpdir(), "fake-iptables-"));
  writeFileSync(join(dir, "iptables"), "#!/bin/sh\necho 'iptables: No chain/target/match by that name.' >&2\nexit 1\n");
  chmodSync(join(dir, "iptables"), 0o755);
  let out;
  try {
    out = execFileSync("sh", ["-c", GUARD_STATE_CMD], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if (err.code === "ENOENT") return t.skip("no POSIX sh on this machine");
    throw err;
  }
  assert.equal(parseGuardState(out), "missing");
});
