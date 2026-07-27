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
| `DISCORD_WEBHOOK_URL` | — | Optional Discord webhook for notifications |
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
- Dashboard on the NUC LAN (`:8799`): connectivity badge, session/day/month/total
  cost, failover history, and an arm/disarm kill switch (armed by default;
  disarm = `ifdown secondwan` on the Flint, resets to armed on reboot).
- Discord alerts: failover started/ended with cost summary, 30-min running
  updates, arm/disarm, backup-broken (health ping every 10 min), monthly drill.
- Monthly drill (1st, ~04:00): pulls ~2 MB through LTE to verify the path and
  keep the prepaid SIM active (≈ 6 ct/month).
- CallYa balance on the dashboard: tracked locally — sync the real balance once
  (dashboard input; check via MeinVodafone or `*100#` on a phone), then the
  collector decrements it by every metered LTE byte. Discord alert below €10
  (`BALANCE_LOW_EUR`). (USSD from the Spitz itself is impossible: the EG120K
  modem is LTE-only without IMS, so the network times out on `*100#`.)
- LTE guard: only allowlisted devices (NUC, Felix-PC) may forward onto the LTE
  uplink — everything else is rejected while on failover. Allowlist lives in
  `/etc/firewall.lte_guard` on the Flint (persistent iptables include). The
  dashboard button opens LTE for all devices for `GUARD_OPEN_MINUTES` (default
  60), then auto-relocks; Flint reboot and collector restart also relock.

Design and runbook: `docs/superpowers/specs/2026-07-27-spitz-plus-callya-failover-design.md`
and `docs/superpowers/plans/2026-07-27-spitz-callya-lte-failover.md`; balance +
guard follow-up: `docs/superpowers/specs/2026-07-27-callya-balance-lte-guard-design.md`
and `docs/superpowers/plans/2026-07-27-callya-balance-lte-guard.md`.

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
