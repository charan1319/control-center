# Control Center

A self-hosted web dashboard for monitoring and managing multiple Claude Code sessions running in tmux.
Accessible from any device on your Tailscale network.

## Features

- **Live session cards** — real-time status with color-coded borders (green = active, red = waiting for permission, gray = idle)
- **Summary bar** — at-a-glance `N active · M waiting · P idle` count
- **One-click Grant** — approve permission prompts directly from the dashboard without opening the terminal
- **Auto-approve** — configurable list of safe tools/commands that get approved silently (Read, Glob, Grep, safe Bash)
- **Transcript preview** — last 2 lines of what Claude said, shown on each card
- **Session age + tool count** — how long a session has been running and how many tools it has used
- **Browser terminal** — click any session to open a full xterm.js terminal connected to its tmux pane
- **Mobile input bar** — type commands, hit Enter, or use Ctrl+C / Tab / arrow key buttons from your phone
- **Activity log** — chronological feed of all lifecycle events; click any row to open that session's terminal
- **Session launcher** — start new Claude Code sessions from the dashboard with project presets
- **Project grouping** — active sessions organized by project; stopped sessions in a collapsible section
- **Push notifications** — Telegram alerts via OpenClaw when sessions finish or need permission (with 30s inactivity gate)
- **AI summaries** — optional per-card DeepSeek summary of current status (disabled by default; enable via `.env`)
- **Remote access** — works from phone, tablet, or any laptop over Tailscale

## Prerequisites

- Node.js 22+
- tmux
- jq, curl (for hook scripts)
- Build tools for native npm modules:
  - Ubuntu/Debian: `sudo apt install -y build-essential python3`

## Quick Start

```bash
git clone <repo-url> ~/Charan/control-center
cd ~/Charan/control-center
npm install
cp .env.example .env   # then edit .env with your settings
./install.sh           # copies hooks to ~/.claude/hooks/ and wires up settings.json
npm start
```

Open `http://localhost:7700`.

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_PORT` | `7700` | Server port |
| `CC_HOST` | `0.0.0.0` | Bind address |
| `CC_DB_PATH` | `./data/control-center.sqlite` | SQLite database path |
| `OPENCLAW_BIN` | _(empty)_ | Path to `openclaw` CLI; empty disables notifications |
| `TELEGRAM_CHAT_ID` | _(empty)_ | Telegram chat ID for push notifications |
| `DEEPSEEK_API_KEY` | _(empty)_ | DeepSeek API key for AI summaries |
| `CC_AI_SUMMARY` | `true` | Set `false` to disable AI summary without removing the key |
| `CC_AUTO_APPROVE_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,LS` | Tools silently approved without user prompt |

## How It Works

Claude Code fires shell hooks on lifecycle events (SessionStart, Stop, PermissionRequest, PostToolUse).
The hooks POST to the control center's HTTP API. The server stores events in SQLite, broadcasts
real-time updates over WebSocket, and relays terminal I/O between the browser (xterm.js) and tmux (node-pty).

See [CLAUDE.md](CLAUDE.md) for the full architecture, API reference, and developer guide.

## Remote Access (Tailscale)

1. Install Tailscale on the server machine and any client device
2. Sign in with the same account on all devices
3. Access at `http://<tailscale-ip>:7700` — get the IP with `tailscale ip -4`

Tailscale's free tier supports up to 100 devices with no time limit.
