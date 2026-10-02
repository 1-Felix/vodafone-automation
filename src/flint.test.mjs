import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GUARD_STATE_CMD, RELAY_CMD, parseGuardState, parseIfaceStatus, parseKmwanStatus } from "./flint.mjs";

test("parseIfaceStatus reads up/autostart/l3_device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: true, autostart: true, l3_device: "lan5" }));
  assert.deepEqual(s, { up: true, autostart: true, device: "lan5" });
});

test("parseIfaceStatus handles down iface without device", () => {
  const s = parseIfaceStatus(JSON.stringify({ up: false, autostart: false }));
  assert.deepEqual(s, { up: false, autostart: false, device: null });
});

test("parseKmwanStatus reads kmwan's verdict per member", () => {
  assert.deepEqual(parseKmwanStatus("wan:online\nsecondwan:online\n"), { wan: "online", secondwan: "online" });
  assert.deepEqual(parseKmwanStatus("wan:offline\nsecondwan:online\n"), { wan: "offline", secondwan: "online" });
});

test("parseKmwanStatus: no file means no verdict, a dropped member means offline", () => {
  // kmwan deletes a member's node on netifd ifdown; GL's own kmwan.lua reads
  // an absent line as offline. No output at all means kmwan isn't running.
  assert.equal(parseKmwanStatus(""), null);
  assert.deepEqual(parseKmwanStatus("secondwan:online\n"), { secondwan: "online" });
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

test("RELAY_CMD posts the body on stdin to the URL on stdin's first line", (t) => {
  // The webhook URL carries its token, so it travels on stdin rather than in
  // the command line, where `ps` on the Flint would show it.
  assert.ok(!RELAY_CMD.includes("http"), "no URL baked into the command");
  const dir = mkdtempSync(join(tmpdir(), "fake-curl-"));
  writeFileSync(join(dir, "curl"), '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\necho "BODY:$(cat)"\n');
  chmodSync(join(dir, "curl"), 0o755);
  let out;
  try {
    out = execFileSync("sh", ["-c", RELAY_CMD], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      input: 'https://discord.com/api/webhooks/1/tok\n{"embeds":[{"description":"failover"}]}',
      encoding: "utf8",
    });
  } catch (err) {
    if (err.code === "ENOENT") return t.skip("no POSIX sh on this machine");
    throw err;
  }
  assert.match(out, /^ARG:https:\/\/discord\.com\/api\/webhooks\/1\/tok$/m);
  assert.match(out, /^BODY:\{"embeds":\[\{"description":"failover"\}\]\}$/m);
});
