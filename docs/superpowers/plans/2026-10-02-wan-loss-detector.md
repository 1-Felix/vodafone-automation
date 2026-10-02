# WAN Loss Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A procd service on the Flint that forces kmwan onto LTE when the cable WAN loses packets for ~10 s and hands it back only after 2 clean minutes, so gaming and Discord on Felix-PC ride through lossy blackouts and failback flaps.

**Architecture:** One POSIX `sh` script (`flint/wan-loss-guard`) probes three targets once per second over `eth1`, keeps 120 s of probe rounds in a shell variable, and drives kmwan through GL's own `force_dead` / `restore_detect` helpers. The decision logic consists of plain functions that `node --test` exercises by sourcing the script under `sh` with stubbed shell functions; the same scripts also run under the Flint's busybox `ash` over SSH. The NUC monitor needs no change if kmwan's verdict file reflects `force_dead` (checked live in Task 1); otherwise it learns to count a forced member as offline.

**Tech Stack:** POSIX sh (busybox 1.33.2 `ash` on GL 4.9.1 / OpenWrt 21.02), procd, kmwan (`/lib/functions/kmwan.sh`), Node 22 `node:test` for tests, SSH aliases `flint` / `nuc`.

**Spec:** `docs/superpowers/specs/2026-10-02-wan-loss-detector-design.md`

## Global Constraints

- Script must run under busybox 1.33.2 `ash`: no arrays, no `[[ ]]`, `local` is fine, integer `sleep` only, no `od` / `sftp-server` on the Flint (copy files with `ssh flint 'cat > PATH' < FILE`).
- Probe: `ping -c 1 -W 1 -I eth1 <target>` to `9.9.9.9`, `1.0.0.1`, `8.8.4.4`, three in parallel per round; any failure counts as lost.
- Trigger (WATCH → HOLD): last 10 s has ≥ 15 probes sent and `lost * 2 >= sent`, counting only rounds after the last release, and LTE available.
- Release (HOLD → WATCH): last 120 s has ≥ 300 probes sent and `lost * 100 <= sent`; immediately if LTE becomes unavailable; at the latest after 30 min (`max-hold`).
- LTE available = `ubus call network.interface.secondwan status` has `"up": true` AND `/proc/gl-kmwan/config` has the exact line `secondwan:online` (missing line = offline).
- While holding: if the `wan` block in `/proc/gl-kmwan/status` shows `force_dead:false`, run `force_dead wan` again; if the block is absent, do nothing.
- Events: `/root/wan-events.log` line `<iso> wan detector-hold lost=<n>/<sent>` or `<iso> wan detector-release <reason>`; `logger -t wan-loss-guard`; background `curl -m 5` POST of `{"iface":"wan","action":"detector-hold"|"detector-release"}` to `http://192.168.0.37:8799/event`.
- Service: procd, `USE_PROCD=1`, `START=99`, `STOP=10`, respawn; installed as `/usr/bin/wan-loss-guard` and `/etc/init.d/wan-loss-guard`; both plus `/etc/rc.d/S99wan-loss-guard` and `/etc/rc.d/K10wan-loss-guard` in `/etc/sysupgrade.conf`.
- No new npm dependencies. Run tests with `node --test` (what `pnpm test` runs; calling node directly avoids pnpm writing a stray `pnpm-lock.yaml`).
- Commits: plain sentence-case messages like the existing history; **never** a `Co-Authored-By` line or any Claude attribution (user's CLAUDE.md).
- Reach boxes only by SSH alias (`ssh flint`, `ssh nuc`). Do not change the LTE guard allowlist.
- Live changes that move traffic (Task 1, Task 6) only after the user says go.

### Deliberate deviations from the spec (flag in review)

1. Round timestamps and hold timers use seconds since boot (`/proc/uptime`), not epoch seconds, so NTP correcting the clock after boot cannot stretch or freeze the windows. Event log lines still carry wall-clock ISO time.
2. `restore_detect wan` on start runs inside the script, not just in `start_service`: a procd respawn re-executes the command without calling `start_service`. On stop, the script traps SIGTERM and restores. The init script's `service_stopped` restores again as a fallback in case procd escalates to SIGKILL. `stop_service` is not used, because it runs *before* procd kills the process, and a holding guard would simply re-force the cable.
3. A stop during a hold logs `detector-release stopped`, so the event log never shows an unclosed hold.
4. The service refuses to start, logging a reason, if `/lib/functions/kmwan.sh` has no `force_dead` (e.g. after a firmware upgrade), and procd gives up after 5 quick respawns (`respawn 3600 5 5`).

## Review Focus

1. **Script reaches the Flint with CRLF line endings** (this checkout has `core.autocrlf=true`). Expected: busybox runs it. Pinned by `.gitattributes` (`flint/** text eol=lf`) and a test that fails on any `\r` in `flint/` (Task 2, extended in Task 3).
2. **Firmware upgrade ships a `kmwan.sh` without `force_dead`.** Expected: the service says so in `logread` and exits, instead of logging holds that do nothing. Pinned by the "refuses to start" test (Task 3).
3. **Wall clock jumps at boot (NTP).** Expected: windows and the 30-min cap are unaffected. Pinned by `wlg_clock` reading `/proc/uptime` and its test (Task 3).
4. **LTE drops and comes back while the cable stays lossy.** Expected: release at once, then hold again as soon as LTE is back, because loss after the release counts. Pinned by the LTE-drop test (Task 2).
5. **Service stopped or restarted mid-hold.** Expected: the cable is not left forced off and the log closes the hold. Pinned by the `wlg_shutdown` test (Task 3), and checked live with a restart (Task 5).

---

### Task 1: Live check of `force_dead` on the Flint (gate)

Answers the spec's open question and checks the design's premise before any code exists. **Ask the user for a go first:** for ~15 s every device except Felix-PC loses internet (the LTE guard rejects them), Felix-PC's game/voice sessions reconnect twice, and Discord gets one "Failover active" / "Failover ended" pair from the monitor.

**Files:**
- Modify: `docs/superpowers/plans/2026-10-02-wan-loss-detector.md` (append the outcome)

**Interfaces:**
- Produces: the recorded outcome `config reflects force_dead: yes|no`, which decides whether Task 4 runs.

- [ ] **Step 1: Get the user's go-ahead** (see above). Do not continue without it.

- [ ] **Step 2: Force, observe, restore (with a 60 s dead-man restore)**

```bash
ssh flint '. /lib/functions/kmwan.sh
( sleep 60; . /lib/functions/kmwan.sh; restore_detect wan ) </dev/null >/dev/null 2>&1 &
date -Iseconds; force_dead wan; sleep 5
echo "== config"; cat /proc/gl-kmwan/config
echo "== wan block"; sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep -E "online:|force_dead:"
echo "== flint egress"; curl -s -m 5 https://1.0.0.1/cdn-cgi/trace | grep ^ip=
echo "== eth1 probes"; ping -c 3 -W 1 -I eth1 9.9.9.9 | tail -2
echo "== events"; tail -3 /root/wan-events.log
restore_detect wan; sleep 10
echo "== after restore"; cat /proc/gl-kmwan/config
sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep force_dead:
curl -s -m 5 https://1.0.0.1/cdn-cgi/trace | grep ^ip=
tail -3 /root/wan-events.log'
```

Expected while forced: `force_dead:true`, `ip=47.64.…` (the SIM), `3 packets received` on the eth1 probes. After restore: `wan:online`, `force_dead:false`, `ip=149.172.237.20`.

- [ ] **Step 3: Apply the decision rules**

- Egress is not the SIM's IP while forced → **STOP** and report to the user: `force_dead` does not move traffic, so the design does not work.
- eth1 probes get no replies while forced → **STOP** and report: the detector could never see the cable recover.
- Not back to `wan:online` / cable IP after restore → run `ssh flint '. /lib/functions/kmwan.sh; restore_detect wan'`, then **STOP** and report.
- Config shows `wan:offline` or no `wan:` line while forced → `config reflects force_dead: yes`, so **skip Task 4**. If it still says `wan:online`, the answer is `no` and Task 4 is required.
- A `kmwan-offline` line in the event log means the kmwan hotplug class fires on `force_dead`. Record it; nothing depends on it, because the guard posts its own event.

- [ ] **Step 4: Record the outcome** by appending to the end of this plan file:

```markdown
## Task 1 outcome (<date>)

- config reflects force_dead: <yes|no> (<what /proc/gl-kmwan/config showed>)
- wan block while forced: <online:… force_dead:…>
- Flint egress while forced: <ip>; eth1 probes: <n>/3 answered
- kmwan hotplug fired on force_dead: <yes|no>
- after restore_detect: <config line>, <ip>
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-wan-loss-detector.md
git commit -m "Plan: record the live force_dead check"
```

---

### Task 2: Guard decision core (probe-round history and WATCH/HOLD rules)

**Files:**
- Create: `.gitattributes`
- Create: `flint/wan-loss-guard`
- Test: `src/wan-loss-guard.test.mjs`

**Interfaces:**
- Produces (shell, in `flint/wan-loss-guard`):
  - constants `WAN_IFACE=wan`, `WAN_DEV=eth1`, `LTE_IFACE=secondwan`, `TARGETS`, `TRIGGER_SECS=10`, `TRIGGER_MIN_SENT=15`, `RELEASE_SECS=120`, `RELEASE_MIN_SENT=300`, `MAX_HOLD_SECS=1800`, and the path variables `KMWAN_LIB`, `KMWAN_STATUS`, `KMWAN_CONFIG`, `UPTIME`, `EVENT_LOG`, `EVENT_URL`. Tests override the paths after sourcing.
  - state globals `STATE` (`watch` | `hold`), `HOLD_START`, `LAST_RELEASE`, `HIST`
  - `wlg_record <second> <lost> <sent>` appends a round and prunes rounds older than `RELEASE_SECS`.
  - `wlg_window <now> <secs> <since>` sets `W_LOST` / `W_SENT` to the sums over rounds with second > now−secs and > since.
  - `wlg_step <now> <lost> <sent>` records one round and makes the transition. It calls `force_dead`, `restore_detect`, `wlg_lte_ok`, `wlg_wan_forced` and `wlg_event`, whose real versions come in Task 3.
- Produces (JS, in `src/wan-loss-guard.test.mjs`): the helper `sh(body)` (sources the guard, gives `$d` as a temp dir, runs locally or on `WLG_TEST_HOST`), the helper `decide(body)` (`sh` plus the `DECIDE` stubs and `feed`), and `opts` (skip when there is no POSIX sh).

- [ ] **Step 1: Write the test harness and the WATCH tests**

Create `src/wan-loss-guard.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: FAIL. The LF test fails with `ENOENT` for `flint/wan-loss-guard`, and the shell tests fail because `.` cannot find the file (the sh exit status is non-zero).

- [ ] **Step 3: Write the minimal guard (WATCH only) and `.gitattributes`**

Create `.gitattributes`:

```
# Shell scripts for the Flint: busybox ash fails on CRLF.
flint/** text eol=lf
```

Create `flint/wan-loss-guard`:

```sh
#!/bin/sh
# wan-loss-guard: holds kmwan off the cable WAN while it loses packets and
# hands it back after two clean minutes. kmwan alone misses lossy blackouts
# (its probes get just enough answers) and fails back on the first answered
# probe. Design: docs/superpowers/specs/2026-10-02-wan-loss-detector-design.md
#
# Sourcing this file only defines the functions (the tests do that); the loop
# runs when it is executed as wan-loss-guard.

WAN_IFACE=wan
WAN_DEV=eth1
LTE_IFACE=secondwan
TARGETS="9.9.9.9 1.0.0.1 8.8.4.4"   # disjoint from kmwan's own probe targets
TRIGGER_SECS=10       # hold when at least half the probes of the last 10 s were lost
TRIGGER_MIN_SENT=15
RELEASE_SECS=120      # release when at most 1% of the last 2 min were lost
RELEASE_MIN_SENT=300
MAX_HOLD_SECS=1800
KMWAN_LIB=/lib/functions/kmwan.sh
KMWAN_STATUS=/proc/gl-kmwan/status
KMWAN_CONFIG=/proc/gl-kmwan/config
UPTIME=/proc/uptime
EVENT_LOG=/root/wan-events.log
EVENT_URL=http://192.168.0.37:8799/event

STATE=watch       # watch: kmwan decides; hold: wan forced dead
HOLD_START=0
LAST_RELEASE=0
HIST=""           # one "<second> <lost> <sent>" line per probe round, oldest first

# Appends a probe round and drops rounds older than the release window.
wlg_record() { # <second> <lost> <sent>
  local min=$(( $1 - RELEASE_SECS )) keep="" e l s
  while read -r e l s; do
    [ -n "$e" ] && [ "$e" -gt "$min" ] && keep="$keep$e $l $s
"
  done <<EOF
$HIST
EOF
  HIST="$keep$1 $2 $3
"
}

# Sums the rounds newer than both <now>-<secs> and <since> into W_LOST/W_SENT.
wlg_window() { # <now> <secs> <since>
  local from=$(( $1 - $2 )) e l s
  W_LOST=0 W_SENT=0
  while read -r e l s; do
    [ -n "$e" ] && [ "$e" -gt "$from" ] && [ "$e" -gt "$3" ] || continue
    W_LOST=$(( W_LOST + l )) W_SENT=$(( W_SENT + s ))
  done <<EOF
$HIST
EOF
}

# One probe round's verdict: enter or leave the hold.
wlg_step() { # <now> <lost> <sent>
  local now=$1
  wlg_record "$now" "$2" "$3"
  [ "$STATE" = watch ] || return 0
  wlg_window "$now" "$TRIGGER_SECS" "$LAST_RELEASE"
  [ "$W_SENT" -ge "$TRIGGER_MIN_SENT" ] && [ $(( W_LOST * 2 )) -ge "$W_SENT" ] || return 0
  wlg_lte_ok || return 0   # never force the cable off without a working LTE path
  force_dead "$WAN_IFACE"
  STATE=hold HOLD_START=$now
  wlg_event detector-hold "lost=$W_LOST/$W_SENT"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Add the HOLD tests**

Append to `src/wan-loss-guard.test.mjs`:

```js
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
```

- [ ] **Step 6: Run the tests to verify the new ones fail**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: the 5 earlier tests pass. Six of the new ones fail because the output lacks the `restore_detect` / `detector-release` lines (or, in the re-apply test, the second `force_dead`): the guard never leaves HOLD yet. "keeps holding with 4 of 360 lost" and "does not release on fewer than 300 probes" already pass, for the same reason. They pin the release thresholds once Step 7 adds the release, so confirm they still pass after it.

- [ ] **Step 7: Implement the HOLD branch**

Replace `wlg_step` in `flint/wan-loss-guard` with:

```sh
# One probe round's verdict: enter or leave the hold.
wlg_step() { # <now> <lost> <sent>
  local now=$1 reason
  wlg_record "$now" "$2" "$3"
  if [ "$STATE" = watch ]; then
    # Only rounds after the last release count, or a release would re-trigger
    # on the loss that caused the hold.
    wlg_window "$now" "$TRIGGER_SECS" "$LAST_RELEASE"
    [ "$W_SENT" -ge "$TRIGGER_MIN_SENT" ] && [ $(( W_LOST * 2 )) -ge "$W_SENT" ] || return 0
    wlg_lte_ok || return 0   # never force the cable off without a working LTE path
    force_dead "$WAN_IFACE"
    STATE=hold HOLD_START=$now
    wlg_event detector-hold "lost=$W_LOST/$W_SENT"
    return 0
  fi
  wlg_window "$now" "$RELEASE_SECS" 0
  if ! wlg_lte_ok; then
    reason=lte-unavailable   # a lossy cable beats no connection
  elif [ $(( now - HOLD_START )) -ge "$MAX_HOLD_SECS" ]; then
    reason=max-hold          # kmwan re-evaluates; fresh loss holds again
  elif [ "$W_SENT" -ge "$RELEASE_MIN_SENT" ] && [ $(( W_LOST * 100 )) -le "$W_SENT" ]; then
    reason=clean
  else
    # kmwan re-creates wan unforced after a netifd ifdown/ifup (link bounce,
    # the Station's fallback lease). No block at all means wan is down.
    [ "$(wlg_wan_forced)" = false ] && force_dead "$WAN_IFACE"
    return 0
  fi
  restore_detect "$WAN_IFACE"
  STATE=watch LAST_RELEASE=$now
  wlg_event detector-release "$reason"
}
```

- [ ] **Step 8: Run the guard tests, then the whole suite**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: 13 pass, 0 fail.

Run: `node --test`
Expected: 108 pass (95 existing + 13), 0 fail. Name any failure in the report, even an unrelated one.

- [ ] **Step 9: Commit**

```bash
git add .gitattributes flint/wan-loss-guard src/wan-loss-guard.test.mjs
git commit -m "WAN loss guard: hold the cable off on 10 s of loss, release after 2 clean minutes"
```

---

### Task 3: Guard probes, kmwan and LTE reads, events, and the procd service

**Files:**
- Modify: `flint/wan-loss-guard` (append functions and the main guard)
- Create: `flint/wan-loss-guard.init`
- Create: `src/kmwan-status.fixture.mjs`
- Test: `src/wan-loss-guard.test.mjs`

**Interfaces:**
- Consumes: everything Task 2 produces; `sh(body)`, `opts`, `lines` from the test file.
- Produces (shell):
  - `wlg_clock` sets `NOW` to whole seconds since boot from `$UPTIME`.
  - `wlg_lte_ok` exits 0 when LTE can carry traffic.
  - `wlg_wan_forced` prints `true` / `false` / nothing.
  - `wlg_probe` prints the number of silent targets.
  - `wlg_event <action> <detail>` logs and posts the event.
  - `wlg_shutdown` restores, closes an open hold in the log, and exits 0.
  - `wlg_main` runs the loop.
- Produces (JS): `src/kmwan-status.fixture.mjs` exports `KMWAN_STATUS_HEADER`, `KMWAN_WAN_BLOCK`, `KMWAN_LTE_BLOCK` (strings). Task 4 uses them too.

- [ ] **Step 1: Create the status fixture**

Create `src/kmwan-status.fixture.mjs`:

```js
// /proc/gl-kmwan/status as captured on the Flint on 2026-10-02 (GL 4.9.1): a
// header row, then one block per member, each ending in a blank line. The
// numeric columns run together, so only a block's first field and its flag
// lines mean anything.
export const KMWAN_STATUS_HEADER =
  "Interface       Netdev           Ifindex   State          TrackMode       TX packets      TX stamp        RX packets   RX stamp        \n";

export const KMWAN_WAN_BLOCK = [
  "wan             eth1             3         ACTIVE         force           1701            29193095640381672732         2919310458935646",
  "Track method\tip Info",
  "ping        \t1.1.1.1",
  "ping        \t8.8.8.8",
  "ping        \t208.67.222.222",
  "ping        \t208.67.220.220",
  "online:true     state_sync:1",
  "probe_enable:true",
  "force_dead:false",
  "",
  "",
].join("\n");

export const KMWAN_LTE_BLOCK = [
  "secondwan       lan5             7         IDEL           passive         0               0               0            0               ",
  "Track method\tip Info",
  "ping        \t1.1.1.1",
  "ping        \t8.8.8.8",
  "ping        \t208.67.222.222",
  "ping        \t208.67.220.220",
  "online:true     state_sync:1",
  "probe_enable:true",
  "force_dead:false",
  "",
  "",
].join("\n");
```

- [ ] **Step 2: Write the failing tests**

In `src/wan-loss-guard.test.mjs`, add to the imports:

```js
import { KMWAN_LTE_BLOCK, KMWAN_STATUS_HEADER, KMWAN_WAN_BLOCK } from "./kmwan-status.fixture.mjs";
```

Change the LF test's list to `["wan-loss-guard", "wan-loss-guard.init"]`.

Append:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: the 13 Task-2 tests pass apart from the LF test (`ENOENT` for `wan-loss-guard.init`). The 7 new tests fail: the `wlg_*` functions are not defined, so output is empty or carries "not found" errors.

- [ ] **Step 4: Append the I/O functions and the main guard to `flint/wan-loss-guard`**

```sh
# Seconds since boot: NTP fixing the wall clock after boot must not stretch or
# freeze the windows.
wlg_clock() {
  local rest
  read -r NOW rest < "$UPTIME"
  NOW=${NOW%.*}
}

# LTE can carry traffic: netifd has secondwan up (it is down while disarmed on
# the dashboard) and kmwan lists it online. A missing line means offline, as
# in GL's own kmwan.lua.
wlg_lte_ok() {
  ubus call "network.interface.$LTE_IFACE" status 2>/dev/null | grep -q '"up": true' &&
    grep -qx "$LTE_IFACE:online" "$KMWAN_CONFIG" 2>/dev/null
}

# Prints the force_dead flag (true/false) of wan's block in kmwan's status
# table, or nothing when kmwan has no block for it (netifd has wan down).
wlg_wan_forced() {
  awk -v want="$WAN_IFACE" '
    NF == 0 { cur = ""; next }
    $1 == "Interface" { next }
    cur == "" { cur = $1 }
    cur == want && $1 ~ /^force_dead:/ { sub(/^force_dead:/, "", $1); print $1; exit }
  ' "$KMWAN_STATUS" 2>/dev/null
}

# Pings every target once over the cable, in parallel, and prints how many
# stayed silent. Any failure counts: timeout, unreachable, eth1 missing.
# Bound to eth1, the probes keep testing the cable while kmwan routes
# everything else over LTE.
wlg_probe() {
  local pids="" lost=0 t p
  for t in $TARGETS; do
    ping -c 1 -W 1 -I "$WAN_DEV" "$t" >/dev/null 2>&1 &
    pids="$pids $!"
  done
  for p in $pids; do
    wait "$p" || lost=$(( lost + 1 ))
  done
  echo "$lost"
}

# Logs a transition the way the hotplug hooks do and wakes the NUC monitor.
wlg_event() { # <action> <detail>
  echo "$(date -Iseconds) $WAN_IFACE $1 $2" >> "$EVENT_LOG"
  logger -t wan-loss-guard "$WAN_IFACE $1 $2"
  ( curl -m 5 -s -X POST "$EVENT_URL" \
      -H "Content-Type: application/json" \
      -d "{\"iface\":\"$WAN_IFACE\",\"action\":\"$1\"}" >/dev/null 2>&1 & )
}

# SIGTERM from procd: hand the cable back to kmwan before exiting.
wlg_shutdown() {
  restore_detect "$WAN_IFACE"
  [ "$STATE" = hold ] && wlg_event detector-release stopped
  exit 0
}

wlg_main() {
  . "$KMWAN_LIB"
  if ! type force_dead >/dev/null 2>&1; then
    logger -t wan-loss-guard "$KMWAN_LIB has no force_dead; not starting"
    exit 1
  fi
  trap wlg_shutdown INT TERM
  # A crash or a kill -9 may have left wan forced; start from kmwan's own view.
  restore_detect "$WAN_IFACE"
  local sent start lost
  set -- $TARGETS
  sent=$#
  while :; do
    wlg_clock; start=$NOW
    lost=$(wlg_probe)
    wlg_clock
    wlg_step "$NOW" "$lost" "$sent"
    # Replies take milliseconds; a round with timeouts already took a second.
    [ "$NOW" = "$start" ] && sleep 1
  done
}

case "$0" in
  *wan-loss-guard) wlg_main ;;
esac
```

- [ ] **Step 5: Create `flint/wan-loss-guard.init`**

```sh
#!/bin/sh /etc/rc.common
# Cable loss detector for kmwan, see /usr/bin/wan-loss-guard.

START=99
STOP=10
USE_PROCD=1

start_service() {
	procd_open_instance
	procd_set_param command /usr/bin/wan-loss-guard
	procd_set_param respawn 3600 5 5
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}

# The guard restores kmwan's detection itself on SIGTERM; this covers procd
# escalating to SIGKILL.
service_stopped() {
	( . /lib/functions/kmwan.sh; restore_detect wan )
}
```

- [ ] **Step 6: Run the guard tests, then the whole suite**

Run: `node --test src/wan-loss-guard.test.mjs`
Expected: 20 pass, 0 fail.

Run: `node --test`
Expected: 115 pass, 0 fail.

Run: `git status --short` and confirm no `pnpm-lock.yaml` appeared.

- [ ] **Step 7: Commit**

```bash
git add flint/wan-loss-guard flint/wan-loss-guard.init src/kmwan-status.fixture.mjs src/wan-loss-guard.test.mjs
git commit -m "WAN loss guard: probes over eth1, kmwan and LTE checks, events and the procd service"
```

---

### Task 4: Monitor counts a member held by `force_dead` as offline (only if Task 1 recorded "no")

**Skip this task entirely** if Task 1 recorded `config reflects force_dead: yes`. In that case the monitor already sees a hold as `LTE_ACTIVE` through `wan:offline`, or through a missing `wan:` line.

**Files:**
- Modify: `src/flint.mjs` (`parseKmwanStatus`, `getKmwanStatus`, new `KMWAN_CMD`)
- Test: `src/flint.test.mjs`

**Interfaces:**
- Consumes: `KMWAN_STATUS_HEADER`, `KMWAN_WAN_BLOCK`, `KMWAN_LTE_BLOCK` from `src/kmwan-status.fixture.mjs` (Task 3).
- Produces: `parseKmwanStatus(text)` with the unchanged return shape `{ [member]: "online" | "offline" } | null`. It now also accepts `<config>@@status<status table>` and reports a member whose block has `force_dead:true` as `"offline"`. Also `export const KMWAN_CMD` (string). Callers (`lte-monitor.mjs`) are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `src/flint.test.mjs`:

```js
import { KMWAN_LTE_BLOCK, KMWAN_STATUS_HEADER, KMWAN_WAN_BLOCK } from "./kmwan-status.fixture.mjs";
```

Append after the existing `parseKmwanStatus` tests:

```js
test("parseKmwanStatus counts a member held by force_dead as offline", () => {
  // The wan-loss-guard holds the cable with force_dead, and kmwan keeps
  // "wan:online" in its verdict file while it does.
  const held = KMWAN_STATUS_HEADER + KMWAN_WAN_BLOCK.replace("force_dead:false", "force_dead:true") + KMWAN_LTE_BLOCK;
  assert.deepEqual(parseKmwanStatus(`wan:online\nsecondwan:online\n@@status\n${held}`), { wan: "offline", secondwan: "online" });
});

test("parseKmwanStatus ignores the status table's own name:value lines", () => {
  const live = KMWAN_STATUS_HEADER + KMWAN_WAN_BLOCK + KMWAN_LTE_BLOCK;
  assert.deepEqual(parseKmwanStatus(`wan:online\nsecondwan:online\n@@status\n${live}`), { wan: "online", secondwan: "online" });
  assert.equal(parseKmwanStatus(`@@status\n`), null, "kmwan not running");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/flint.test.mjs`
Expected: both new tests FAIL. The first returns `wan: "online"`. The second returns extra keys such as `probe_enable` and `force_dead`, because the status table is parsed as verdicts.

- [ ] **Step 3: Implement**

In `src/flint.mjs`, replace `parseKmwanStatus` and `getKmwanStatus` with:

```js
// kmwan's tracker verdict per member ("wan:online"), which is what decides
// where traffic goes. netifd's `up` only means wan holds a lease, and while
// DOCSIS is offline the Station leases 192.168.100.x from its own DHCP.
// kmwan drops a member's line on ifdown, which GL reads as offline.
// The wan-loss-guard on the Flint holds the cable with force_dead, which
// leaves the verdict at online, so a forced member counts as offline here.
export const KMWAN_CMD = "cat /proc/gl-kmwan/config 2>/dev/null; echo @@status; cat /proc/gl-kmwan/status 2>/dev/null; true";

export function parseKmwanStatus(text) {
  const [config, table = ""] = (text ?? "").split("@@status");
  const status = {};
  for (const [, name, state] of config.matchAll(/^([\w-]+):(\w+)\s*$/gm)) status[name] = state;
  if (!Object.keys(status).length) return null;
  for (const block of table.split(/\n\s*\n/)) {
    const rows = block.split("\n").filter((l) => l.trim() && !l.startsWith("Interface"));
    const name = rows[0]?.split(/\s+/)[0];
    if (name in status && rows.some((l) => l.trim() === "force_dead:true")) status[name] = "offline";
  }
  return status;
}

export async function getKmwanStatus() {
  return parseKmwanStatus(await flintSsh(KMWAN_CMD));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/flint.test.mjs`
Expected: all pass, including the two existing `parseKmwanStatus` tests, which pass config-only text.

Run: `node --test`
Expected: 117 pass, 0 fail.

- [ ] **Step 5: Live-check the command on the Flint**

Run: `ssh flint 'cat /proc/gl-kmwan/config 2>/dev/null; echo @@status; cat /proc/gl-kmwan/status 2>/dev/null; true' | node -e "import('./src/flint.mjs').then(m => { let s=''; process.stdin.on('data', d => s += d).on('end', () => console.log(m.parseKmwanStatus(s))); })"`
Expected: `{ wan: 'online', secondwan: 'online' }`

- [ ] **Step 6: Commit**

```bash
git add src/flint.mjs src/flint.test.mjs
git commit -m "Count a kmwan member held by force_dead as offline"
```

---

### Task 5: Verify under busybox, install on the Flint, document

**Files:**
- Modify: `README.md` (new subsection before "Design and runbook:")
- Flint: `/usr/bin/wan-loss-guard`, `/etc/init.d/wan-loss-guard`, `/etc/sysupgrade.conf`

**Interfaces:**
- Consumes: `flint/wan-loss-guard`, `flint/wan-loss-guard.init`, `src/wan-loss-guard.test.mjs` (`WLG_TEST_HOST`).

- [ ] **Step 1: Run the shell tests under the Flint's busybox ash**

Run: `WLG_TEST_HOST=flint node --test src/wan-loss-guard.test.mjs`
Expected: 20 pass, 0 fail. The LF test reads the local file; every other test runs on the Flint.
Then: `ssh flint 'rm -f /tmp/wan-loss-guard'`

- [ ] **Step 2: Confirm LF in git and nothing installed yet**

Run: `git ls-files --eol flint/`
Expected: both files show `i/lf` and `attr/text eol=lf`.

Run: `ssh flint 'ls /usr/bin/wan-loss-guard /etc/init.d/wan-loss-guard 2>&1; grep -c wan-loss-guard /etc/sysupgrade.conf'`
Expected: both "No such file", count `0`.

- [ ] **Step 3: Copy both files**

```bash
ssh flint 'cat > /usr/bin/wan-loss-guard && chmod 755 /usr/bin/wan-loss-guard' < flint/wan-loss-guard
ssh flint 'cat > /etc/init.d/wan-loss-guard && chmod 755 /etc/init.d/wan-loss-guard' < flint/wan-loss-guard.init
```

- [ ] **Step 4: Enable, start, and check the service**

```bash
ssh flint "/etc/init.d/wan-loss-guard enable && /etc/init.d/wan-loss-guard start && sleep 3 && ubus call service list '{\"name\":\"wan-loss-guard\"}' && ls -l /etc/rc.d/ | grep wan-loss-guard && logread -e wan-loss-guard | tail -5 && sed -n '/^wan /,/^\$/p' /proc/gl-kmwan/status | grep force_dead"
```

Expected: one instance with `"running": true`, links `S99wan-loss-guard` and `K10wan-loss-guard`, no "not starting" line in logread, and `force_dead:false`.

- [ ] **Step 5: Soak 3 min on the healthy line**

Run: `ssh flint 'sleep 180; grep -c detector /root/wan-events.log; sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep force_dead'` (Bash timeout ≥ 240 s)
Expected: `0` detector lines, `force_dead:false`. On a healthy line any hold is a bug: stop the service (`/etc/init.d/wan-loss-guard stop`) and investigate before going on.

- [ ] **Step 6: Restart check**

Run: `ssh flint "/etc/init.d/wan-loss-guard restart && sleep 2 && ubus call service list '{\"name\":\"wan-loss-guard\"}' | grep -c '\"running\": true'"`
Expected: `1`.

- [ ] **Step 7: Keep the files across firmware upgrades**

```bash
ssh flint 'for f in /usr/bin/wan-loss-guard /etc/init.d/wan-loss-guard /etc/rc.d/S99wan-loss-guard /etc/rc.d/K10wan-loss-guard; do grep -qx "$f" /etc/sysupgrade.conf || echo "$f" >> /etc/sysupgrade.conf; done; sysupgrade -l | grep wan-loss-guard'
```

Expected: the four paths.

- [ ] **Step 8: Document in the README**

In `README.md`, insert directly before the line `Design and runbook: \`docs/superpowers/specs/2026-07-27-spitz-plus-callya-failover-design.md\``:

````markdown
### Cable loss detector (Flint)

kmwan misses lossy blackouts, because its probes get just enough answers to
call the cable online, and it fails back on the first answered probe.
`flint/wan-loss-guard` runs on the Flint as a procd service and covers both:

- Once a second it pings 9.9.9.9, 1.0.0.1 and 8.8.4.4 over `eth1`. kmwan
  probes different targets, so the two views are independent.
- When the last 10 s hold at least 15 probes and half of them were lost, it
  runs `force_dead wan` and kmwan sends everything over LTE. It never does this
  without a working LTE path: `secondwan` up in netifd and `secondwan:online`
  in `/proc/gl-kmwan/config`.
- It hands back with `restore_detect wan` after 2 min with ≥ 300 probes and
  ≤ 1 % lost, at once if LTE goes away, and after 30 min at the latest.
- Each transition goes to `/root/wan-events.log` (`detector-hold lost=n/sent`,
  `detector-release clean|lte-unavailable|max-hold|stopped`) and to syslog
  (`logread -e wan-loss-guard`), and wakes the monitor via `:8799/event`. The
  monitor shows a hold as a normal failover.

Install from the repo root:

```bash
ssh flint 'cat > /usr/bin/wan-loss-guard && chmod 755 /usr/bin/wan-loss-guard' < flint/wan-loss-guard
ssh flint 'cat > /etc/init.d/wan-loss-guard && chmod 755 /etc/init.d/wan-loss-guard' < flint/wan-loss-guard.init
ssh flint '/etc/init.d/wan-loss-guard enable && /etc/init.d/wan-loss-guard start'
```

Both files and the `S99`/`K10` links are listed in `/etc/sysupgrade.conf`.
After a firmware upgrade, check `sysupgrade -l | grep wan-loss-guard` and
`logread -e wan-loss-guard`. If GL ever drops `force_dead` from
`/lib/functions/kmwan.sh`, the service refuses to start and logs why.
Rollback: `/etc/init.d/wan-loss-guard stop && /etc/init.d/wan-loss-guard disable`.
Stopping hands control back to kmwan. The shell tests also run under the
Flint's busybox: `WLG_TEST_HOST=flint node --test src/wan-loss-guard.test.mjs`.

````

Then extend the "Design and runbook" paragraph's last sentence with: `; cable loss detector: \`docs/superpowers/specs/2026-10-02-wan-loss-detector-design.md\` and \`docs/superpowers/plans/2026-10-02-wan-loss-detector.md\``.

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "README: the cable loss detector on the Flint"
```

---

### Task 6: Deploy, live acceptance, memory

**Files:**
- Modify: `docs/superpowers/plans/2026-10-02-wan-loss-detector.md` (append the acceptance outcome)
- Memory: `C:\Users\felix\.claude\projects\C--Users-felix-Documents-Github-vodafone-automation\memory\lte-fallback-priorities.md`, `MEMORY.md`

- [ ] **Step 1: Push**

Run: `git push origin main`
Then: `gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId')`
Expected: "Publish Docker Image" succeeds.

- [ ] **Step 2: Deploy the monitor (only if Task 4 ran)**

```bash
ssh nuc 'cd ~/dev/docker-compose-files/vodafone-automation && docker compose pull && docker compose up -d'
ssh nuc 'curl -s localhost:8799/api/status' | grep -o '"connState":"[A-Z_]*"'
```

Expected: `"connState":"CABLE_OK"`. If Task 4 was skipped, the image only carries docs and tests, and Watchtower picks it up at the next :04 with nothing to do now.

- [ ] **Step 3: Get the user's go-ahead for the acceptance run** (~6 min, best with Felix-PC idle). While held, every device except Felix-PC loses internet, and Discord gets two "Failover active" / "Failover ended" pairs (steps 5–7 and 9) plus "LTE disarmed/armed" from step 8. Do not continue without it.

- [ ] **Step 4: Fake a lossy line for the detector only** (kmwan's own targets keep answering, and a dead-man removes the rules after 10 min)

```bash
ssh flint 'for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -I INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done
( sleep 600; for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -D INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done ) </dev/null >/dev/null 2>&1 &
date -Iseconds'
```

- [ ] **Step 5: Check the hold (acceptance 2–4)**

```bash
ssh flint 'sleep 15; tail -3 /root/wan-events.log; sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep force_dead; curl -s -m 5 https://1.0.0.1/cdn-cgi/trace | grep ^ip=; iptables -L INPUT -v -n | grep -c "icmptype 0"; iptables -L INPUT -v -n | grep "icmptype 0" | head -1; sleep 5; iptables -L INPUT -v -n | grep "icmptype 0" | head -1'
ssh nuc 'curl -s localhost:8799/api/status' | grep -o '"connState":"[A-Z_]*"'
```

Expected:
- a `wan detector-hold lost=n/sent` line;
- `force_dead:true`;
- `ip=47.64.…`;
- 3 DROP rules, whose packet counter grows between the two reads (the probes still leave via `eth1` and their replies arrive there);
- `"connState":"LTE_ACTIVE"`, and the user confirms "Failover active" in Discord.

- [ ] **Step 6: Clear the fault and watch the release (acceptance 5)**

```bash
ssh flint 'for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -D INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done; date -Iseconds; sleep 130; tail -2 /root/wan-events.log; sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep force_dead; curl -s -m 5 https://1.0.0.1/cdn-cgi/trace | grep ^ip='
```

Expected: `wan detector-release clean` about 2 min after the removal, `force_dead:false`, `ip=149.172.237.20`.

- [ ] **Step 7: Monitor closes the failover**

Run: `ssh nuc 'sleep 150; curl -s localhost:8799/api/status' | grep -o '"connState":"[A-Z_]*"'`
Expected: `"connState":"CABLE_OK"`, and the user confirms "Failover ended" in Discord.

- [ ] **Step 8: No hold without LTE (acceptance 6)**

```bash
ssh nuc 'curl -s -X POST localhost:8799/api/toggle'
ssh flint 'n=$(grep -c detector-hold /root/wan-events.log); for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -I INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done; sleep 25; echo "new holds: $(( $(grep -c detector-hold /root/wan-events.log) - n ))"; for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -D INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done; iptables -L INPUT -n | grep -c "icmptype 0"'
ssh nuc 'curl -s -X POST localhost:8799/api/toggle'
ssh flint 'ubus call network.interface.secondwan status | grep "\"up\""'
```

Expected:
- first toggle returns `{"armed":false}`;
- `new holds: 0`;
- `0` DROP rules left;
- second toggle returns `{"armed":true}`;
- `"up": true`.

- [ ] **Step 9: Stopping mid-hold hands the cable back** (added after the final review: the SIGTERM path was only unit-tested)

```bash
ssh flint 'n=0; until grep -qx secondwan:online /proc/gl-kmwan/config || [ $n -ge 60 ]; do sleep 1; n=$((n + 1)); done
for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -I INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done
( sleep 600; for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -D INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done ) </dev/null >/dev/null 2>&1 &
sleep 15; tail -1 /root/wan-events.log
/etc/init.d/wan-loss-guard stop; sleep 3
tail -1 /root/wan-events.log; sed -n "/^wan /,/^\$/p" /proc/gl-kmwan/status | grep force_dead; pgrep -f /usr/bin/wan-loss-guard || echo stopped
for t in 9.9.9.9 1.0.0.1 8.8.4.4; do iptables -D INPUT -i eth1 -p icmp --icmp-type echo-reply -s $t -j DROP; done
/etc/init.d/wan-loss-guard start; sleep 2; pgrep -f /usr/bin/wan-loss-guard; iptables -L INPUT -n | grep -c "icmptype 0"'
```

Expected:
- `wan detector-hold lost=n/sent` before the stop;
- after the stop: `wan detector-release stopped`, `force_dead:false`, `stopped`;
- after the start: a pid, and `0` DROP rules left.

- [ ] **Step 10: Record the acceptance outcome** by appending to this plan:

```markdown
## Acceptance outcome (<date>)

- hold after <n> s (`lost=<n>/<sent>`), Flint egress <ip>, probes on eth1: <yes|no>
- monitor: <connState>, Discord "Failover active": <yes|no>
- release `clean` <n> s after clearing, egress <ip>; "Failover ended": <yes|no>
- disarmed: new holds <n>; re-armed: <yes|no>
- stopped mid-hold: `detector-release stopped` <yes|no>, `force_dead:false` <yes|no>, restarted <yes|no>
```

Commit and push:

```bash
git add docs/superpowers/plans/2026-10-02-wan-loss-detector.md
git commit -m "Plan: record the WAN loss detector acceptance run"
git push origin main
```

- [ ] **Step 11: Update memory**

In `lte-fallback-priorities.md`, replace the "Still open (2026-10-02)" line with one stating that the detector has been live since `<date>`. Include the thresholds (10 s / ≥ 27 probes / ½ lost → hold; 120 s / ≥ 300 / ≤ 1 % → release; 30-min cap) and where it lives (`/usr/bin/wan-loss-guard`, procd, sysupgrade.conf). Add the Task 1 finding: whether `/proc/gl-kmwan/config` reflects `force_dead`, and whether kmwan hotplug fires. Add the rollback (`/etc/init.d/wan-loss-guard stop && … disable`). Update its `MEMORY.md` index line to mention the detector.

## Task 1 outcome (2026-10-02)

- config reflects force_dead: yes (`/proc/gl-kmwan/config` showed `wan:offline` 5 s after `force_dead wan`), so Task 4 is skipped
- wan block while forced: `online:false`, `force_dead:true`
- Flint egress while forced: `ip=47.64.112.154` (SIM); eth1 probes: 3/3 answered (14–28 ms)
- kmwan hotplug fired on force_dead: yes (`kmwan-offline` at 19:22:29, `kmwan-online` at 19:22:37 after `restore_detect`)
- after restore_detect: `wan:online`, `force_dead:false`, `ip=149.172.237.20`
