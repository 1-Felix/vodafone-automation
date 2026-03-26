# Vodafone Station Bridge Mode Monitor

The Vodafone Station (CGA6444VF) has a known issue where it randomly reverts from bridge mode back to router mode every few days. This causes double NAT problems if you're running your own router (e.g. GL.iNet Flint) behind it.

This tool automatically detects when bridge mode is lost and re-enables it via the router's API — no browser automation needed.

## How it works

1. Every 5 minutes, checks the router's `DeviceMode` via `/api/v1/login_conf` (no login required)
2. If bridge mode is lost: logs in using the same PBKDF2 auth scheme as the web UI, then sends `POST /api/v1/set_modem_mode` with `LanMode: bridge-static`
3. Waits ~10 minutes for the router to reboot and verifies bridge mode is active again
4. Sends Discord webhook notifications when bridge mode is lost and when it's restored

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

### Run without Docker

Requires Node.js 22+:

```bash
node src/index.mjs        # continuous monitoring
node src/index.mjs --once  # single check
```

## Tested on

- **Router:** Vodafone Station (Arris CGA6444VF)
- **Firmware:** 19.3B80-3.5.13
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
