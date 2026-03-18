# Control Center

A web dashboard for monitoring and managing multiple Claude Code sessions running in tmux.

## Features

- **Live session monitoring** — see all Claude Code sessions at a glance with real-time status (active, idle, waiting for permission, stopped)
- **Browser terminal** — click any session to connect to its tmux pane via xterm.js, from any device
- **Activity log** — chronological feed of all lifecycle events across sessions
- **Session launcher** — start new Claude Code sessions from the dashboard
- **Push notifications** — optional alerts via OpenClaw when sessions finish or need permission
- **Remote access** — works from your phone or laptop over Tailscale

## Prerequisites

- Node.js 22+
- tmux
- jq, curl (for hook scripts)
- Build tools: `make`, `gcc`/`g++`, `python3` (for native npm modules)
  - Ubuntu/Debian: `sudo apt install -y build-essential python3`
  - macOS: `xcode-select --install`

## Quick Start

```bash
git clone <repo-url> ~/control-center
cd ~/control-center
./install.sh
```

The install script will:
1. Check prerequisites
2. Run `npm install` (compiles native modules)
3. Copy hook scripts to `~/.claude/hooks/`
4. Merge hook configuration into `~/.claude/settings.json` (idempotent — safe to re-run)
5. Create `.env` from `.env.example`
6. Optionally set up a systemd user service (Linux)

## Manual Start

```bash
cd ~/control-center
npm start
# Open http://localhost:7700
```

Note: `npm start` uses `node --env-file=.env server.js` to load your configuration.
If running without npm, pass the flag manually: `node --env-file=.env server.js`

## Push Notifications (Optional)

To get alerts on your phone when sessions finish or need permission:

1. Ensure OpenClaw is running locally
2. Enable the HTTP endpoint in OpenClaw config:
   ```javascript
   { gateway: { http: { endpoints: { responses: { enabled: true } } } } }
   ```
3. Edit `.env` and set `OPENCLAW_TOKEN` to your gateway auth token

## Remote Access

1. Install [Tailscale](https://tailscale.com) on both the lab machine and your phone/laptop
2. `tailscale up` on both devices
3. Access the dashboard at `http://<tailscale-ip>:7700`

## How It Works

Claude Code hooks fire shell scripts on lifecycle events. Those scripts POST to the control center's HTTP API on localhost. The control center stores events in SQLite, broadcasts them over WebSocket to the dashboard, and optionally pings OpenClaw for push notifications.

The terminal relay uses node-pty to bridge tmux sessions to xterm.js in the browser via WebSocket.

## Configuration

All settings are in `.env` (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_PORT` | `7700` | Server port |
| `CC_HOST` | `0.0.0.0` | Bind address |
| `CC_DB_PATH` | `./data/control-center.sqlite` | SQLite database path |
| `OPENCLAW_URL` | `http://127.0.0.1:18789/v1/responses` | OpenClaw API endpoint |
| `OPENCLAW_TOKEN` | _(empty)_ | OpenClaw auth token (empty = notifications disabled) |
| `OPENCLAW_AGENT` | `main` | OpenClaw agent ID |
