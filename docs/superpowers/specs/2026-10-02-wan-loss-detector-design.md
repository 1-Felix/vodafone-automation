# WAN Loss Detector — Design

Date: 2026-10-02
Status: approved in brainstorming
Follow-up to: the 2026-10-02 outage analysis (commits `c46effc`, `16c6d08`) and
`2026-07-27-spitz-plus-callya-failover-design.md`.

## Goal

Keep gaming and Discord on Felix-PC usable through cable trouble by covering the two
cases where kmwan's own tracking fails:

1. **Lossy blackouts are never failed over.** When the line degrades without the
   link dropping, kmwan's probes get just enough answers to call the cable online.
   2026-10-02 00:30–00:32: ~2.5 min dead (674 DNS timeouts), and kmwan only gave
   two 3-second offline verdicts. 2026-09-28 22:24: no verdict at all.
2. **Failback is premature and flaps.** kmwan returns to the cable on the first
   answered probe. 2026-10-02 11:23:02–11:23:30: four online/offline flips while
   the modem was still re-ranging, so about a minute of bad connectivity.

A small detector service on the Flint watches packet loss on the cable itself. It
forces kmwan onto LTE when the line is bad and hands control back only after the
cable has stayed clean.

## Context (as deployed 2026-10-02)

- Flint GL-MT6000, GL 4.9.1 (OpenWrt 21.02, busybox 1.33.2 `ash`). The cable WAN is
  `wan` on `eth1` (kmwan member, metric 10, `track_mode=force`, probes 1.1.1.1,
  8.8.8.8, 208.67.222.222, 208.67.220.220). LTE is `secondwan` on `lan5` (Spitz
  Plus, metric 15, `track_mode=passive`). Global `level=medium`,
  `sensitivity=3000`.
- kmwan's verdict per member is in `/proc/gl-kmwan/config` (`wan:online`). The
  per-member blocks in `/proc/gl-kmwan/status` carry `force_dead:true|false`. Its
  column table is not parseable: values run together.
- `/lib/functions/kmwan.sh` provides `force_dead <iface>` (op 7) and
  `restore_detect <iface>` (op 8). Nothing in GL's own code calls either, so they
  are free for us to use.
- The LTE guard admits only Felix-PC on LTE. The NUC keeps only its management path
  to the Spitz, and its Discord alerts are relayed through the Flint.
- The monitor follows kmwan's verdict, holds a failback for 2 min
  (`FAILBACK_SETTLE_MS`), and is woken by `/etc/hotplug.d/iface/99-wanlog` and
  `/etc/hotplug.d/kmwan/99-wanlog` POSTing to `:8799/event`.
- Baseline on a healthy stretch (2026-10-02, 10 min, 1/s each to 1.1.1.1, 8.8.8.8,
  9.9.9.9 via `eth1`): 0 of 1,800 lost, average 13–15 ms, max 39 ms.
- busybox `ping` accepts integer `-i` only, so there are no sub-second intervals.
- Every switch changes the public IP (cable 149.172.237.20 ↔ LTE 47.64.x), so every
  switch forces game and voice sessions to reconnect.

## Decisions (brainstorming outcomes)

1. **Approach: a detector service on the Flint.** Rejected: running it in the NUC
   monitor (the failover decision would depend on the NUC plus per-second SSH), and
   tuning kmwan alone (its knobs only set the detection window, not its recovery
   rule).
2. **Trigger after ~10 s:** at least half the probes lost over the last 10 s.
   Shorter would turn freezes a game survives into forced reconnects; longer leaves
   most games already dropped.
3. **Failback after 2 clean minutes**, chosen by the user over 5 and 10 min as the
   cheaper option. Matches the monitor's settle window.
4. **"Clean" means at most 1% probe loss over those 2 minutes.** The healthy
   baseline loses nothing, so any real loss is a symptom; one stray drop must not
   block the failback.
5. **Probe targets 9.9.9.9, 1.0.0.1, 8.8.4.4**, deliberately disjoint from kmwan's.
   This gives an independent view and lets the acceptance test fake a dead line for
   the detector alone.

## Detector behaviour

### Probing

Every iteration sends three one-shot pings in parallel:
`ping -c 1 -W 1 -I eth1 <target>` to each target, then `wait`. Each iteration
appends a record `<epoch-seconds> <lost 0–3> <sent 3>` to an in-memory history and
prunes records older than 120 s.

Pacing: if the pings returned within the same epoch second, `sleep 1`; if they ran
into the 1-s timeout, start the next iteration at once. That gives about one
iteration (3 probes) per second, healthy or lossy. Windows are selected by
timestamp, never by record count.

Any probe failure counts as lost: timeout, unreachable, or `eth1` missing while the
link is down. Probes are bound to `eth1` with `-I`, so they keep testing the cable
while kmwan routes everything else over LTE. That must hold during `force_dead`
(acceptance check 3).

### States

- **WATCH** (kmwan in charge): enter **HOLD** when all of these hold:
  - the last 10 s window has ≥ 27 probes sent (9 rounds, so a total blackout
    holds after ~9 s; raised from 15 on 2026-10-02 at the user's request) and
    ≥ 50% of them lost
    (`lost * 2 >= sent`, integer arithmetic);
  - only samples taken *after* the last release count (otherwise a release would
    re-trigger on stale loss);
  - LTE is available (see Safety 1).

  On entering HOLD: `force_dead wan`, record the hold start, log, notify.
- **HOLD** (traffic forced to LTE): return to **WATCH** when the last 120 s window
  has ≥ 300 probes sent and ≤ 1% of them lost (`lost * 100 <= sent`, so at most
  3 of a full window of ~360). On returning: `restore_detect wan`,
  record the release time, log, notify.
  - A relapse puts loss back into the 120-s window, so the hold continues; there is
    no separate timer to reset.
  - While holding, every iteration checks the `wan` block in `/proc/gl-kmwan/status`.
    If the block exists with `force_dead:false`, apply `force_dead wan` again. kmwan
    re-creates the node after a netifd ifdown/ifup (link bounce, the Station's
    192.168.100.x fallback lease) and the new node starts unforced. If the block is
    absent (wan down), there is nothing to force.
- **Hard drops:** kmwan still fails over in ~2 s by itself. The detector sees the
  same loss and enters HOLD ~10 s later. Traffic is already on LTE, so there is no
  extra switch, but failback now waits for 2 clean minutes instead of kmwan's first
  answered probe.

### Safety rules

1. **Never force the cable off without a working LTE path.** LTE is available when
   `ubus call network.interface.secondwan status` reports `up: true` (false when
   disarmed via the dashboard) AND `/proc/gl-kmwan/config` lists
   `secondwan:online`. A missing line counts as offline, as in GL's own
   `kmwan.lua`. Without LTE, WATCH never enters HOLD. If LTE becomes
   unavailable during HOLD, release immediately: a lossy cable beats no connection.
2. **Reset on start and stop.** The service runs `restore_detect wan` when it starts
   and when it stops, so a crash (procd respawns it), restart or manual stop never
   leaves the cable forced off. A Flint reboot resets kmwan anyway.
3. **Hard cap of 30 min per hold.** Then release, which hands control back to kmwan
   for re-evaluation. On a dead line kmwan keeps traffic on LTE, so nothing
   switches. On a still-lossy line the detector re-holds once a fresh 10 s of loss
   has been sampled.

### Events

On each transition:

- append to `/root/wan-events.log`: `<iso> wan detector-hold lost=<n>/<sent>` or
  `<iso> wan detector-release <reason>`, where reason is `clean`, `lte-unavailable`
  or `max-hold`;
- `logger -t wan-loss-guard` with the same text;
- POST `{"iface":"wan","action":"detector-hold"|"detector-release"}` to
  `http://192.168.0.37:8799/event` in the background with `curl -m 5`, exactly like
  the hotplug hooks. The monitor schedules a tick 2 s later.

## Monitor integration

A hold must show up as `LTE_ACTIVE` so sessions, metering attribution and Discord
alerts work unchanged ("Failover active" / "Failover ended after N min — X MB").

- **Implementation step 1 is a live check:** does `force_dead wan` turn `wan:online`
  into `wan:offline` in `/proc/gl-kmwan/config`, and does it fire the kmwan hotplug
  class? GL never uses it, so this is unknown.
- If `/proc/gl-kmwan/config` does not reflect it, `getKmwanStatus()` also reads the
  `force_dead` flag of the `wan` block in `/proc/gl-kmwan/status`, and the monitor
  treats `force_dead:true` as offline. That is a test-first change in
  `src/flint.mjs` with a parser unit test.
- The monitor's own 2-min settle stays. After a detector release it only delays the
  "ended" message; the session's end time is still the failback moment.

## Files and deployment

Repo (new `flint/` directory):

- `flint/wan-loss-guard`: POSIX `sh` script runnable under busybox `ash`.
  Thresholds and targets are constants at the top. The window sums and the WATCH/
  HOLD transition rules are small functions the tests can source without starting
  the loop. A `main` guard runs the loop only when executed directly.
- `flint/wan-loss-guard.init`: procd service (`USE_PROCD=1`, `START=99`, `STOP=10`,
  respawn). `start_service` and `stop_service` run `restore_detect wan`.

Flint:

- `/usr/bin/wan-loss-guard` and `/etc/init.d/wan-loss-guard`, then
  `/etc/init.d/wan-loss-guard enable` and `start`.
- Append `/usr/bin/wan-loss-guard`, `/etc/init.d/wan-loss-guard` and the `enable`
  symlinks (`/etc/rc.d/S99wan-loss-guard`, `/etc/rc.d/K10wan-loss-guard`) to
  `/etc/sysupgrade.conf`, then confirm with `sysupgrade -l`.
- Rollback: `/etc/init.d/wan-loss-guard stop` (back to plain kmwan) and `disable`.

The README gets a section on the detector: what it does, thresholds, install,
rollback, and the post-firmware-upgrade check.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Probe fails for any reason | Counts as lost |
| LTE down or disarmed | Never enter HOLD; release at once if holding |
| kmwan re-creates `wan` unforced during HOLD | Re-apply `force_dead wan` on the next iteration |
| `wan` block absent (netifd down) | Nothing to force; keep sampling |
| Script crash | procd respawns it; start runs `restore_detect wan` |
| Hold reaches 30 min | Release (`max-hold`); re-hold only on fresh loss |
| Monitor unreachable for the POST | Ignored (background `curl -m 5`); the event log line remains |

## Testing

Unit tests in `src/wan-loss-guard.test.mjs` source `flint/wan-loss-guard` under
`sh` with stubbed `ping`, `ubus` and kmwan functions, following the
`GUARD_STATE_CMD` / `RELAY_CMD` tests in `src/flint.test.mjs` (skip when no POSIX
`sh`). They cover:

- triggers at 15 of 30 lost in 10 s, not at 14 of 30;
- does not trigger with fewer than 27 probes in the window;
- ignores samples from before the last release;
- holds through a relapse inside the 120-s window;
- releases after 120 s with ≤ 3 of ≥ 300 lost, not with 4;
- never holds without LTE; releases when LTE becomes unavailable;
- releases at the 30-min cap;
- re-applies `force_dead` when the `wan` block shows `force_dead:false`;
- parses `force_dead` from a real `/proc/gl-kmwan/status` sample.

The same test functions are also run once on the Flint itself (busybox `ash`)
before installation.

Live acceptance, about 5 min, only with the user's go-ahead, best with the PC idle.
Every device except Felix-PC loses internet while held, because the guard rejects
them on LTE.

1. Block ICMP echo replies from only 9.9.9.9, 1.0.0.1 and 8.8.4.4 on the Flint
   (`iptables -I INPUT -i eth1 -p icmp --icmp-type echo-reply -s <target> -j DROP`).
   kmwan's own targets keep answering, so this is exactly the case kmwan misses.
2. Within ~10 s: `detector-hold` in the event log, `force_dead:true` for `wan`, and
   the Flint's own `curl https://1.0.0.1/cdn-cgi/trace` reports the SIM's IP.
3. Detector probes still leave via `eth1` (counter or tcpdump on `eth1`).
4. Monitor: `/api/status` shows `LTE_ACTIVE`, and Discord shows "Failover active".
5. Remove the DROP rules. About 2 min later: `detector-release clean`, traffic back
   on the cable, and "Failover ended" (after the monitor's settle).
6. Disarm LTE on the dashboard, re-add the DROP rules: no hold. Remove them,
   re-arm.

Record the outcome of the step-1 monitor check (whether `/proc/gl-kmwan/config`
reflects `force_dead`) in the plan.

## Out of scope

- A fixed-exit tunnel (VPS + WireGuard) to keep the public IP across switches.
- A line-fault report for Vodafone / Kabelhilfe (offered, deferred by the user).
- Changing kmwan's own `level` / `sensitivity`.
- IPv6 (disabled on both WANs) and the `tethering` member.
- Using the detector to judge LTE quality.
