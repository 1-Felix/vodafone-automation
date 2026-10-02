import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KMWAN_LTE_BLOCK, KMWAN_STATUS_HEADER, KMWAN_WAN_BLOCK } from "./kmwan-status.fixture.mjs";

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
ARMED=1   # the cable has answered since start; see the arming test
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
  for (const name of ["wan-loss-guard", "wan-loss-guard.init"]) {
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
    "restore_detect wan", "event detector-release lte-unavailable lost=18/18",
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
    "restore_detect wan", "event detector-release clean lost=3/360",
    "state=watch released=221",
  ));
});

test("releases after 2 min with 3 of 360 lost", opts, () => {
  const out = decide(`feed 1 5 3; feed 6 49 0; wlg_step 50 3 3; feed 51 125 0; echo "state=$STATE released=$LAST_RELEASE"`);
  assert.equal(out, lines(
    "force_dead wan", "event detector-hold lost=15/15",
    "restore_detect wan", "event detector-release clean lost=3/360",
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
    "restore_detect wan", "event detector-release lte-unavailable lost=18/18",
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
    "restore_detect wan", "event detector-release max-hold lost=6/6",
    "state=watch",
    "force_dead wan", "event detector-hold lost=15/15",
    "state=hold",
  ));
});

test("after a start it holds only once the cable has answered", opts, () => {
  // At boot eth1 may not have its lease yet. Rounds before the first answer
  // do not count, or the house would stay on LTE for 2 min after the cable is up.
  const out = decide(`ARMED=0; feed 1 10 3; echo "state=$STATE"; wlg_step 11 2 3; feed 12 14 3; echo "state=$STATE"; wlg_step 15 3 3; echo "state=$STATE"`);
  assert.equal(out, lines("state=watch", "state=watch", "force_dead wan", "event detector-hold lost=14/15", "state=hold"));
});

test("re-applies force_dead when kmwan re-creates wan unforced", opts, () => {
  // No block at all (FORCED empty) means netifd has wan down: nothing to force.
  const out = decide(`feed 1 5 3; echo @6; FORCED=false; wlg_step 6 3 3; echo @7; FORCED=; wlg_step 7 3 3; echo @8; FORCED=true; wlg_step 8 3 3`);
  assert.equal(out, lines("force_dead wan", "event detector-hold lost=15/15", "@6", "force_dead wan", "@7", "@8"));
});

const fixture = (name, text) => `cat > "$d/${name}" <<'EOF'\n${text}EOF`;

test("reads wan's force_dead flag from kmwan's status table", opts, () => {
  const out = sh([
    fixture("live", KMWAN_STATUS_HEADER + KMWAN_WAN_BLOCK + KMWAN_LTE_BLOCK),
    fixture("held", KMWAN_STATUS_HEADER + KMWAN_WAN_BLOCK.replace("force_dead:false", "force_dead:true") + KMWAN_LTE_BLOCK),
    fixture("lteheld", KMWAN_STATUS_HEADER + KMWAN_WAN_BLOCK + KMWAN_LTE_BLOCK.replace("force_dead:false", "force_dead:true")),
    fixture("down", KMWAN_STATUS_HEADER + KMWAN_LTE_BLOCK),
    `for f in live held lteheld down; do KMWAN_STATUS="$d/$f"; echo "$f=$(wlg_wan_forced)"; done`,
  ].join("\n"));
  assert.equal(out, lines("live=false", "held=true", "lteheld=false", "down="));
});

test("LTE counts as available only when netifd has secondwan up and kmwan lists it online", opts, () => {
  const out = sh(`
KMWAN_CONFIG="$d/config"
UP=true
ubus() { [ "$*" = "call network.interface.secondwan status" ] && printf '{\\n\\t"up": %s,\\n\\t"pending": false\\n}\\n' "$UP"; }
check() { if wlg_lte_ok; then echo "$1=yes"; else echo "$1=no"; fi; }
printf 'wan:online\\nsecondwan:online\\n' > "$KMWAN_CONFIG"; check armed
UP=false; check disarmed
UP=true; printf 'wan:online\\nsecondwan:offline\\n' > "$KMWAN_CONFIG"; check offline
printf 'wan:online\\n' > "$KMWAN_CONFIG"; check dropped
rm "$KMWAN_CONFIG"; check nokmwan
`);
  assert.equal(out, lines("armed=yes", "disarmed=no", "offline=no", "dropped=no", "nokmwan=no"));
});

test("probes every target once over eth1 and counts every failure as lost", opts, () => {
  // 1.0.0.1 times out (exit 1); 8.8.4.4 fails the way a missing eth1 does (exit 2).
  const out = sh(`
ping() { echo "$*" >> "$d/calls"; case "$7" in 9.9.9.9) return 0 ;; 1.0.0.1) return 1 ;; *) return 2 ;; esac; }
echo "lost=$(wlg_probe)"
cat "$d/calls"
`);
  const [first, ...calls] = out.trim().split("\n");
  assert.equal(first, "lost=2");
  assert.deepEqual(calls.sort(), [
    "-c 1 -W 1 -I eth1 1.0.0.1",
    "-c 1 -W 1 -I eth1 8.8.4.4",
    "-c 1 -W 1 -I eth1 9.9.9.9",
  ]);
});

test("logs a transition and wakes the monitor the way the hotplug hooks do", opts, () => {
  const out = sh(`
EVENT_LOG="$d/events.log"
logger() { echo "logger $*" >> "$d/side"; }
curl() { echo "curl $*" >> "$d/side"; }
wlg_event detector-hold lost=27/30
n=0
while [ "$(grep -c '^curl' "$d/side" 2>/dev/null)" != 1 ] && [ $n -lt 10 ]; do sleep 1; n=$((n + 1)); done
cat "$EVENT_LOG" "$d/side"
`);
  const [logLine, ...side] = out.trim().split("\n");
  assert.match(logLine, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:?\d\d wan detector-hold lost=27\/30$/);
  assert.ok(side.includes("logger -t wan-loss-guard wan detector-hold lost=27/30"), side.join("\n"));
  assert.ok(
    side.includes('curl -m 5 -s -X POST http://192.168.0.37:8799/event -H Content-Type: application/json -d {"iface":"wan","action":"detector-hold"}'),
    side.join("\n"),
  );
});

test("stopping hands the cable back to kmwan and closes an open hold in the log", opts, () => {
  const out = sh(`
restore_detect() { echo "restore_detect $1"; }
wlg_event() { echo "event $1 $2"; }
(STATE=hold; wlg_shutdown); echo "exit=$?"
(STATE=watch; wlg_shutdown); echo "exit=$?"
`);
  assert.equal(out, lines("restore_detect wan", "event detector-release stopped", "exit=0", "restore_detect wan", "exit=0"));
});

test("refuses to start when kmwan.sh has no force_dead (e.g. after a firmware upgrade)", opts, () => {
  const out = sh(`
KMWAN_LIB="$d/kmwan.sh"; : > "$KMWAN_LIB"
logger() { echo "logger $*"; }
(wlg_main); echo "exit=$?"
`);
  assert.match(out, /^logger -t wan-loss-guard \S+\/kmwan\.sh has no force_dead; not starting\nexit=1\n$/);
});

test("the clock is whole seconds since boot, immune to NTP jumps", opts, () => {
  const out = sh(`UPTIME="$d/uptime"; echo "12345.67 98765.43" > "$UPTIME"; wlg_clock; echo "now=$NOW"`);
  assert.equal(out, lines("now=12345"));
});
