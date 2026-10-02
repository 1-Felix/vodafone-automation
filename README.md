# Vodafone Station Bridge Mode Monitor

The Vodafone Station (CGA6444VF) has a known issue where it randomly reverts from bridge mode back to router mode every few days. This causes double NAT problems if you're running your own router (e.g. GL.iNet Flint) behind it.

This tool automatically detects when bridge mode is lost and re-enables it via the router's API — no browser automation needed. It also continuously records DOCSIS signal levels and the Station's event log, so intermittent outages can be diagnosed with real data.

## How it works

1. Every 5 minutes, checks the router's `DeviceMode` via `/api/v1/login_conf` (no login required)
2. If bridge mode is lost: logs in using the same PBKDF2 auth scheme as the web UI, then sends `POST /api/v1/set_modem_mode` with `LanMode: bridge-static`
3. Waits ~10 minutes for the router to reboot and verifies bridge mode is active again
4. Sends Discord webhook notifications when bridge mode is lost and when it's restored

### Signal collector

On every check (while bridge mode is intact) the monitor also logs in and snapshots:

- `data/levels.jsonl` — one line per check: per-channel downstream/upstream power, SNR, modulation, DOCSIS status, firmware version
- `data/events.jsonl` — the Station's event log (DOCSIS T3/T4 timeouts, reboots, provisioning events), deduplicated across polls — the Station itself only keeps ~1 day of history

Discord alerts fire on state changes: upstream TX power crossing 51 dBmV (Vodafone's "critical" threshold), new T3/T4 ranging timeouts (max 1 alert/hour), DOCSIS going offline/online, and firmware version changes (the prime suspect for bridge-mode resets).

Disable with `COLLECTOR_ENABLED=false`.

### Comparing wall sockets / checking signal health

```bash
node src/levels.mjs   # or: pnpm levels
```

prints a signal snapshot with a verdict. To find the best coax socket: plug the Station into a socket, wait until it's fully online (~3–5 min), run this, note the upstream power; repeat per socket. Lower upstream TX power = less attenuation = better socket.

## Setup

### Prerequisites

- Docker and Docker Compose
- Network access to the Vodafone Station (default: `192.168.100.1`)
- Optional: Discord webhook URL for notifications

### Quick start

```bash
mkdir vodafone-bridge-monitor && cd vodafone-bridge-monitor

# Create your .env file
cat <<EOF > .env
ROUTER_IP=192.168.100.1
ROUTER_USER=admin
ROUTER_PASS=your_router_password
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook
CHECK_INTERVAL_MS=300000
EOF

# Create docker-compose.yml
cat <<EOF > docker-compose.yml
services:
  bridge-monitor:
    image: ghcr.io/1-felix/vodafone-automation:latest
    container_name: vodafone-bridge-monitor
    restart: unless-stopped
    env_file: .env
    network_mode: host
EOF

# Start
docker compose up -d
```

Or clone the repo if you want to build locally:

```bash
git clone https://github.com/1-Felix/vodafone-automation.git
cd vodafone-automation
cp .env.example .env
# Edit .env with your credentials
docker compose up -d --build
```

### Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_IP` | `192.168.100.1` | Router admin IP |
| `ROUTER_USER` | `admin` | Router admin username |
| `ROUTER_PASS` | — | Router admin password (check the sticker on your router) |
| `DISCORD_WEBHOOK_URL` | — | Optional Discord webhook for notifications; fallback for any tier below |
| `DISCORD_WEBHOOK_CRITICAL` | — | Optional `#vf-critical` webhook (outages, failover, bridge lost). Falls back to `DISCORD_WEBHOOK_URL` |
| `DISCORD_WEBHOOK_WARN` | — | Optional `#vf-warn` webhook (balance low, backup broken, poll errors). Falls back to `DISCORD_WEBHOOK_URL` |
| `DISCORD_WEBHOOK_LOG` | — | Optional `#vf-log` webhook (signal telemetry, state toggles, drill OK). Falls back to `DISCORD_WEBHOOK_URL` |
| `CHECK_INTERVAL_MS` | `300000` | Check interval in ms (default: 5 min) |
| `COLLECTOR_ENABLED` | `true` | Set `false` to disable the DOCSIS signal collector |
| `DATA_DIR` | `./data` | Where the collector writes `levels.jsonl` / `events.jsonl` |
| `US_POWER_WARN_DBMV` | `51` | Upstream TX power alert threshold |

### Run without Docker

Requires Node.js 22+:

```bash
node src/index.mjs        # continuous monitoring
node src/index.mjs --once  # single check
```

## LTE failover monitor

Alongside the Station monitor, the container watches the home LAN's LTE failover
path (GL.iNet Spitz Plus with a CallYa prepaid SIM, wired to the Flint as kmwan
member `secondwan`):

- Meters billable LTE bytes from the Flint's `lan5` counters over SSH and prices
  them at 3 ct/MB (`data/lte-usage.jsonl`, `data/lte-sessions.jsonl`).
- Dashboard on the NUC LAN (`:8799`): a readiness verdict up top — *Protected*,
  *At risk*, *Unprotected*, *On backup*, *Offline* or *Stale* — that answers
  "would a cable outage fail over right now?" rather than just "is the cable
  up?". It comes from `assessReadiness()` (`status.readiness`), which folds the
  arm state, backup health ping, LTE guard, credit against the low line and
  reserve floor, and the last monthly drill into one word, and turns *Stale*
  once no tick has landed for two sample intervals plus 5 min. The same verdict
  drives the side rail, tab title and favicon; below it a checklist shows each
  part with its fix button. Also a prepaid-credit gauge showing
  what is left and what this outage has spent, session/day/month/total cost,
  failover history, and an arm/disarm kill switch (armed by default; disarm =
  `ifdown secondwan` on the Flint, resets to armed on reboot). The page lives in
  `src/ui/` as plain `index.html` / `app.css` / `app.js`; `dashboard.mjs` inlines
  the three into one self-contained document at startup — no build step, no CDN,
  so it renders fine while the cable is down.
- Failover detection follows kmwan's tracker (`/proc/gl-kmwan/config`), not
  netifd's `up`: while DOCSIS is offline the Station leases the Flint a
  `192.168.100.x` address from its own DHCP, so `wan` reads up while kmwan keeps
  routing over LTE (2026-10-02: a 13-min outage showed up as four 1-min
  failovers and a false "leak"). A failback only ends the session once the cable
  has stayed online for 2 min (`FAILBACK_SETTLE_MS`), so flaps stay one session.
  Two Flint hooks wake the monitor: `/etc/hotplug.d/iface/99-wanlog` (netifd
  ifup/ifdown) and `/etc/hotplug.d/kmwan/99-wanlog` (kmwan online/offline);
  both are listed in `/etc/sysupgrade.conf`.
- Discord alerts: failover started/ended with cost summary, 30-min running
  updates, arm/disarm, backup-broken (health ping every 10 min), monthly drill.
- Monthly drill (1st, ~04:00): pulls ~2 MB through LTE to verify the path and
  keep the prepaid SIM active (≈ 6 ct/month).
- CallYa balance on the dashboard: tracked locally — sync the real balance once
  (dashboard input; check via MeinVodafone or `*100#` on a phone), then the
  collector decrements it by every metered LTE byte. Discord alert below €3
  (`BALANCE_LOW_EUR`, also drawn as the dashed low line on the gauge and
  returned as `balance.lowEur`). The gauge scales itself to the credit in play —
  a ~5 € top-up fills the column instead of being a sliver of a fixed 15 € scale.
  (USSD from the Spitz itself is impossible: the EG120K
  modem is LTE-only without IMS, so the network times out on `*100#`.)
- Balance reserve floor (`BALANCE_RESERVE_EUR`, default 0.50 €): when the tracked
  balance reaches the floor with the cable healthy, the monitor auto-disarms the
  fallback and takes the Spitz modem offline (`ifdown modem_2_1`) so background
  traffic cannot drain the credit to zero. Recovery is deliberate and manual:
  top up, enter the new balance on the dashboard, then re-arm (re-arming also
  brings the modem back up). If the floor is hit *during* a failover the link is
  left alone and a critical alert fires instead.
- Leak watchdog (`LEAK_ALERT_MB`, default 3 MB/day): background cellular usage
  (bytes metered with no failover session running) above the threshold raises a
  WARN, 5× the threshold a CRITICAL. Lesson from 2026-07-29, when the first €5
  of credit vanished in two days: GL firmware background chatter (a broken
  `get_current_time` retry loop hammering worldtimeapi.org, GoodCloud, kmwan
  probe storms, Spitz DNS advertised to the LAN) can silently out-spend the
  actual failover many times over.
- LTE guard: the fallback is for Felix-PC only — every other device is rejected
  on the LTE uplink while on failover. The NUC keeps just its management path to
  the Spitz (`192.168.8.0/24`), which the monitor's metering and modem kill use
  over SSH and which must never be cut. Since 2026-10-02 the NUC is otherwise off
  the SIM: that day its Cloudflare tunnel served ~36 MB of Immich Frame to the
  internet over LTE in 13 min, while the laptop actually in use got nothing.
  Discord alerts still get out: when the direct webhook call fails, `notify()`
  relays it through the Flint (`relayWebhook`), whose own traffic is not
  guarded. Allowlist lives in
  `/etc/firewall.lte_guard` on the Flint (persistent iptables include). The
  dashboard button opens LTE for all devices for `GUARD_OPEN_MINUTES` (default
  60), then auto-relocks; Flint reboot and collector restart also relock.

Design and runbook: `docs/superpowers/specs/2026-07-27-spitz-plus-callya-failover-design.md`
and `docs/superpowers/plans/2026-07-27-spitz-callya-lte-failover.md`; balance +
guard follow-up: `docs/superpowers/specs/2026-07-27-callya-balance-lte-guard-design.md`
and `docs/superpowers/plans/2026-07-27-callya-balance-lte-guard.md`.

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

Design and runbook: `docs/superpowers/specs/2026-10-02-wan-loss-detector-design.md`
and `docs/superpowers/plans/2026-10-02-wan-loss-detector.md`.

## Tested on

- **Router:** Vodafone Station (Arris CGA6444VF)
- **Firmware:** 19.3B80-3.5.13, 5.0.2MB-R18-RT (RDK-B based)
- **ISP:** Vodafone Germany (cable)

May work on other Vodafone Station models with the same firmware/web interface.

## How the API was reverse-engineered

The router's web UI is a jQuery SPA that talks to a REST API at `/api/v1/`. The auth flow uses PBKDF2 (SHA-256, 1000 iterations, 128-bit key) with a server-provided salt — the same `sjcl.js` scheme the browser uses. Key endpoints:

- `GET /api/v1/login_conf` — device mode and firmware info (no auth)
- `POST /api/v1/session/login` — two-step login (salt exchange, then hashed password)
- `GET /api/v1/set_modem_mode` — current mode + CSRF token (only accessible in router mode)
- `POST /api/v1/set_modem_mode` — switch mode (`LanMode: "bridge-static"` or `"router"`)

## License

MIT
