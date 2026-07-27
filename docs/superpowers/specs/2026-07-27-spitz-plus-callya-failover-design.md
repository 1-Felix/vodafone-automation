# Spitz Plus + CallYa LTE Failover — Design

Date: 2026-07-27
Status: approved in brainstorming, pending spec review

## Goal

Replace the USB-phone-tethering stopgap with a permanent, automatic LTE failover for
the home LAN, using a GL.iNet Spitz Plus (GL-X2000) and a Vodafone CallYa Classic
prepaid SIM — with full cost visibility and a manual opt-out (kill switch), since the
SIM is billed pay-per-use at 3 ct/MB.

## Context

- Main line: Vodafone cable, Station CGA6444VF in bridge mode → Flint (GL-MT6000,
  `ssh flint`), WAN = eth1. Upstream signal at physical limit; outages of 2+ h/day on
  bad days (see memory/vodafone-station-investigation).
- Flint kmwan is already in failover mode with ping tracking; a USB-tethering member
  (metric 30) was configured and tested 2026-07-16 (~12 s failover).
- Monitoring: `vodafone-bridge-monitor` container on the NUC (`ssh nuc`,
  `~/dev/docker-compose-files/vodafone-automation/`), JSONL data in `./data/`,
  Discord alerts via `src/notify.mjs`.
- SIM status: CallYa Classic activated, identified, credit loaded.
- CallYa Classic: no base fee, data 3 ct/MB (≈ €30/GB), 5G-capable. Dayflats
  (10 GB/€4.99, unlimited/€6.99 per 24 h via SMS to 80808) exist but are deliberately
  NOT part of this design — user chose pure pay-per-use plus visibility + kill switch.

## Decisions (brainstorming outcomes)

1. Role: home failover only. Spitz permanently wired to the Flint, Wi-Fi off.
2. Approach: Spitz as second Ethernet WAN (`wan2`) on the Flint; dashboard and
   metering integrated into the existing collector container (no second service).
3. Billing: pure pay-per-use. No data options. Cost transparency via dashboard,
   Discord notifications, and a kill switch (armed by default).
4. Dashboard: self-hosted web app served by the collector on the NUC LAN, no auth
   (accepted: anyone on the LAN can toggle the fallback).

## Post-approval discovery updates (2026-07-27, live Flint inspection)

Read-only discovery on the Flint after spec approval changed four implementation
details (semantics of the approved design are unchanged; "wan2" below reads as
"secondwan"):

- GL firmware pre-seeds a `kmwan.secondwan` member (metric 15, between wan=10 and
  tethering=30). We use interface name `secondwan` on port `lan5` instead of a
  hand-made `wan2` with metric 20.
- kmwan active tracking pings 4 targets and would cost ~€10/month over LTE, not
  ~3 ct. Therefore `kmwan.secondwan.track_mode='passive'` (like GL's modem member),
  and the collector performs its own health ping through the Spitz every 10 min via
  SSH (~1 MB ≈ 3 ct/month). "Backup broken" detection moves from kmwan tracking to
  this health ping.
- Flint LAN is 192.168.0.0/24, so the Spitz keeps its default 192.168.8.0/24 —
  no subnet change needed.
- `/etc/hotplug.d/iface/99-wanlog` is missing/empty on the Flint (lost since
  2026-07-16); the runbook recreates it including the POST extension.
  NUC = 192.168.0.37, dashboard port 8799.

## Architecture

```
Vodafone cable ──> Station (bridge) ──> Flint eth1 (wan, metric 10*)
Vodafone LTE  ──> Spitz Plus [LAN port] ──> Flint LAN 5 → wan2 (metric 20)
Phone (manual) ──> USB tethering (metric 30)
                                Flint kmwan failover: wan → wan2 → tethering
NUC collector ──SSH──> Flint (state, byte counters, ifup/ifdown wan2)
Flint hotplug ──HTTP POST──> NUC collector (wan/wan2 up/down events)
```

\* exact existing metric to be confirmed on the Flint; wan2 slots between wan and
tethering.

### Spitz Plus configuration

- SIM in slot 1. SIM PIN disabled beforehand via a phone (removes the
  blocked-at-PIN-prompt failure mode after power loss).
- APN auto-detect (`web.vodafone.de`); verify LTE attach, note band/RSRP, choose
  placement with best signal.
- Wi-Fi radios off, GoodCloud off, auto-firmware-upgrade off (updates over LTE cost
  money; update manually during healthy-cable periods).
- LAN subnet 192.168.9.0/24 (default 192.168.8.0/24 collides with GL.iNet defaults
  on the Flint side; confirm Flint's actual LAN subnet and pick a non-overlapping one).
- Router mode with NAT (double NAT on the backup path accepted; CallYa is CGNAT,
  no inbound anyway). IPv4 only.
- Spitz admin UI reachable from the LAN at its LAN IP (192.168.9.1) via the Flint's
  masqueraded wan2 — no extra routes needed.

### Flint configuration

- Take LAN 5 out of `br-lan`; new interface `wan2`, proto DHCP (from Spitz),
  firewall zone `wan`, kmwan failover member with metric 20.
- kmwan ping tracking on wan2 with ~600 s interval: ≈ 0.9 MB / ≈ 3 ct per month.
  Purpose is not fast failover (that is triggered by the cable member going down)
  but detecting a dead LTE backup so we can alert.
- Extend `/etc/hotplug.d/iface/99-wanlog` to also POST `{iface, action, ts}` to the
  collector endpoint on the NUC for wan and wan2 (keep the existing local log line).

### Kill switch semantics

- Disarm = `ifdown wan2` on the Flint (via SSH from the collector). kmwan then has
  no LTE member; tethering only exists when a phone is plugged in.
- Arm = `ifup wan2`.
- Not persisted across Flint reboots by design: a reboot returns to armed, which
  satisfies "on by default" with zero extra code.

## NUC software (collector extension)

### Detection

- Edge-triggered: hotplug POSTs from the Flint.
- Polling backup: the existing 5-min collector cycle additionally reads
  `ubus call network.interface.wan status` / `...wan2 status` over SSH, so a lost
  POST self-heals within 5 min.
- Connectivity state machine: `CABLE_OK`, `LTE_ACTIVE` (wan down, wan2 carrying
  traffic), `ALL_DOWN` (wan down and wan2 down or disarmed).
- Armed/disarmed is an independent flag (derived from wan2 interface up/down),
  shown alongside the connectivity badge; it is not a connectivity state itself.

### Metering & cost

- Source of truth: Flint `wan2` device rx+tx byte counters (`/sys/class/net/…/statistics`
  or `ubus call network.device status`) over SSH.
- Sampling: every 60 s while `LTE_ACTIVE`, every 10 min otherwise.
- Monotonic delta logic with counter-reset detection (reboot/ifdown → device counter
  reset; never emit negative deltas).
- Persisted to `data/lte-usage.jsonl`; failover sessions (start, end, bytes, cost) to
  `data/lte-sessions.jsonl`.
- Cost = bytes / 1,000,000 × €0.03 (report as estimate; Vodafone session rounding
  adds pennies). Aggregations: current session, today, calendar month,
  total since install.
- Known undercount: Spitz's own housekeeping traffic (NTP/DNS) bypasses the Flint.
  Minimized by config; optionally cross-check against the Spitz UI counter.

### Dashboard

- Served by the collector container: plain Node `http` server, single HTML page,
  ~10 s polling (or SSE), zero new dependencies — matches repo style.
- Shows: state badge, armed/disarmed toggle button, current session MB + €,
  today / month / total, history table of failover sessions (start, duration, MB, €).
- Toggle button: POST → collector runs `ifdown|ifup wan2` on the Flint via SSH.
- Exposed on a NUC LAN port via docker-compose; no auth (LAN-only, accepted).

### Discord notifications (via existing notify.mjs)

- Failover started / ended (duration, MB, € per session).
- Running update every 30 min while LTE is active.
- Arm/disarm events (source: dashboard button or detected external change).
- Backup-broken alert when kmwan tracking marks wan2 down while cable is fine
  (rate-limited).
- Monthly drill report.

### Monthly keep-alive drill

- Cron in the collector: 1st of month, 04:00. Via SSH on the Flint, download ~2 MB
  bound to the wan2 device (curl `--interface`; mwan3/kmwan per-interface rules make
  the reply path work). Verify success, measure throughput, Discord-report
  (≈ 6 ct/month).
- Purpose: proves the failover path monthly and generates chargeable activity so
  Vodafone never deactivates the idle prepaid SIM.
- If wan2 is disarmed at drill time, the drill does not arm it; it reports
  "drill skipped — fallback disarmed" to Discord instead.

### Config additions (.env)

- `FLINT_SSH` (host alias, default `flint`), `LTE_COST_PER_MB` (default 0.03),
  `DASHBOARD_PORT`, existing Discord webhook reused.

## Error handling

- SSH to Flint fails: keep last known state, alert after N consecutive failures
  (reuse collector's error-alert pattern; don't spam during full outages —
  NUC→Flint is LAN-local and should survive WAN loss).
- Lost hotplug POST: healed by 5-min polling.
- Counter reset mid-session: delta clamps to ≥ 0; session continues.
- Collector restart mid-failover: state rebuilt from polling on startup; session
  continuity restored from last JSONL entries.
- Spitz unreachable/LTE dead: kmwan tracking → backup-broken Discord alert.

## Testing

- Unit (`node --test`, existing pattern): counter-delta/reset logic, cost
  aggregation, state machine transitions, session assembly.
- Acceptance (live):
  1. `ifdown wan` on Flint → traffic flows via LTE within ~15 s, Discord "failover
     started", dashboard shows LTE_ACTIVE with counting MB/€.
  2. `ifup wan` → failback, Discord "failover ended" with session cost.
  3. Disarm via dashboard → `ifdown wan` → NO failover (ALL_DOWN), re-arm restores.
  4. Reboot Flint → wan2 comes back armed.
  5. Pull Spitz power → backup-broken alert within ~20 min (2 × tracking interval).
- Each live test costs a few cents to a few euros of LTE data at most; run during a
  healthy-cable window.

## Out of scope (possible later)

- Automated Dayflat booking via Spitz SMS API when a long outage is detected.
- CallYa balance display (USSD/SMS query via Spitz).
- Home Assistant integration (MQTT sensors).
- Traffic shaping / blocking bulk traffic while on LTE.
