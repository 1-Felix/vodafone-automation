import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FLINT_DIR = fileURLToPath(new URL("../flint/", import.meta.url)).replaceAll("\\", "/");
const GUARD = `${FLINT_DIR}wan-loss-guard`;
// WLG_TEST_HOST=flint runs every script under the Flint's busybox ash instead
// of the local sh.
const HOST = process.env.WLG_TEST_HOST;
const HAS_SH = Boolean(HOST) || !spawnSync("sh", ["-c", "true"]).error;
const opts = { skip: HAS_SH ? false : "no POSIX sh on this machine" };

let remoteGuard;
function guardPath() {
  if (!HOST) return GUARD;
  if (!remoteGuard) {
    execFileSync("ssh", [HOST, "cat > /tmp/wan-loss-guard"], { input: readFileSync(GUARD) });
    remoteGuard = "/tmp/wan-loss-guard";
  }
  return remoteGuard;
}

// Runs `body` with the guard sourced (its loop only starts when executed as
// wan-loss-guard, so sourcing just defines the functions) and `$d` as a
// scratch directory. The timeout turns an accidentally started loop into a
// failure instead of a hang.
function sh(body) {
  const script = `. '${guardPath()}'\nd=$(mktemp -d)\ntrap 'rm -rf "$d"' EXIT\n${body}\n`;
  const [cmd, args] = HOST ? ["ssh", [HOST, "sh -s"]] : ["sh", ["-s"]];
  return execFileSync(cmd, args, { input: script, encoding: "utf8", timeout: 60_000 });
}

// Decision tests: kmwan, the LTE check and the event side effects are shell
// functions that print what they were asked to do.
const DECIDE = `
LTE=1
FORCED=true
force_dead() { echo "force_dead $1"; }
restore_detect() { echo "restore_detect $1"; }
wlg_lte_ok() { [ "$LTE" = 1 ]; }
wlg_wan_forced() { echo "$FORCED"; }
wlg_event() { echo "event $1 $2"; }
# feed <from> <to> <lost> [step]: one 3-probe round every <step> s (default 1)
feed() {
  _t=$1 _s=1
  [ -n "$4" ] && _s=$4
  while [ "$_t" -le "$2" ]; do wlg_step "$_t" "$3" 3; _t=$((_t + _s)); done
}
`;
const decide = (body) => sh(DECIDE + body);
const lines = (...l) => [...l, ""].join("\n");

test("the Flint scripts have LF line endings (busybox chokes on CRLF)", () => {
  for (const name of ["wan-loss-guard"]) {
    assert.ok(!readFileSync(`${FLINT_DIR}${name}`, "utf8").includes("\r"), `${name} has CRLF`);
  }
});

test("holds once 15 of 30 probes in the last 10 s are lost", opts, () => {
  const out = decide(`feed 1 5 0; feed 6 10 3; echo "state=$STATE"`);
  assert.equal(out, lines("force_dead wan", "event detector-hold lost=15/30", "state=hold"));
});

test("does not hold at 14 of 30 lost", opts, () => {
  const out = decide(`feed 1 5 0; feed 6 9 3; wlg_step 10 2 3; echo "state=$STATE"`);
  assert.equal(out, lines("state=watch"));
});

test("needs at least 15 probes in the window before it holds", opts, () => {
  const out = decide(`feed 1 4 3; echo "state=$STATE"; wlg_step 5 3 3; echo "state=$STATE"`);
  assert.equal(out, lines("state=watch", "force_dead wan", "event detector-hold lost=15/15", "state=hold"));
});

test("never holds while LTE is unavailable", opts, () => {
  const out = decide(`LTE=0; feed 1 30 3; echo "state=$STATE"`);
  assert.equal(out, lines("state=watch"));
});

test("loss from before a release does not count toward the next hold", opts, () => {
  const out = decide(`feed 1 5 3; LTE=0; wlg_step 6 3 3; LTE=1; wlg_step 7 3 3; echo "state=$STATE"; feed 8 11 3; echo "state=$STATE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "restore_detect wan", "event detector-release lte-unavailable",
    "state=watch",
    "force_dead wan", "event detector-hold lost=15/15",
    "state=hold",
  ));
});

test("a relapse inside the 2-min window keeps the hold", opts, () => {
  // Without the relapse the hold would end at t=125, once the loss of t=1..5
  // left the window. With it, it ends at t=221: 3 of 360 lost, within 1%.
  const out = decide(`feed 1 5 3; feed 6 100 0; feed 101 102 3; feed 103 130 0; echo "state=$STATE"; feed 131 230 0; echo "state=$STATE released=$LAST_RELEASE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "state=hold",
    "restore_detect wan", "event detector-release clean",
    "state=watch released=221",
  ));
});

test("releases after 2 min with 3 of 360 lost", opts, () => {
  const out = decide(`feed 1 5 3; feed 6 49 0; wlg_step 50 3 3; feed 51 125 0; echo "state=$STATE released=$LAST_RELEASE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "restore_detect wan", "event detector-release clean",
    "state=watch released=125",
  ));
});

test("keeps holding with 4 of 360 lost", opts, () => {
  const out = decide(`feed 1 5 3; feed 6 49 0; wlg_step 50 3 3; wlg_step 51 1 3; feed 52 125 0; echo "state=$STATE"`);
  assert.equal(out, lines("force_dead wan", "event detector-hold lost=15/15", "state=hold"));
});

test("does not release on fewer than 300 probes, however clean", opts, () => {
  // One round every 2 s: a clean window of only 180 probes.
  const out = decide(`feed 1 5 3; feed 6 400 0 2; echo "state=$STATE"`);
  assert.equal(out, lines("force_dead wan", "event detector-hold lost=15/15", "state=hold"));
});

test("releases at once when LTE goes away and holds again when it is back", opts, () => {
  const out = decide(`feed 1 5 3; LTE=0; wlg_step 6 3 3; feed 7 30 3; echo "state=$STATE"; LTE=1; wlg_step 31 3 3; echo "state=$STATE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "restore_detect wan", "event detector-release lte-unavailable",
    "state=watch",
    "force_dead wan", "event detector-hold lost=30/30",
    "state=hold",
  ));
});

test("releases after 30 min and holds again only on fresh loss", opts, () => {
  const out = decide(`feed 1 5 3; wlg_step 1804 3 3; echo "state=$STATE"; wlg_step 1805 3 3; feed 1806 1809 3; echo "state=$STATE"; wlg_step 1810 3 3; echo "state=$STATE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "state=hold",
    "restore_detect wan", "event detector-release max-hold",
    "state=watch",
    "force_dead wan", "event detector-hold lost=15/15",
    "state=hold",
  ));
});

test("re-applies force_dead when kmwan re-creates wan unforced", opts, () => {
  // No block at all (FORCED empty) means netifd has wan down: nothing to force.
  const out = decide(`feed 1 5 3; echo @6; FORCED=false; wlg_step 6 3 3; echo @7; FORCED=; wlg_step 7 3 3; echo @8; FORCED=true; wlg_step 8 3 3`);
  assert.equal(out, lines("force_dead wan", "event detector-hold lost=15/15", "@6", "force_dead wan", "@7", "@8"));
});
