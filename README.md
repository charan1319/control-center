# Control Center

A self-hosted web dashboard for monitoring and managing multiple Claude Code sessions.

## What It Does

If you run more than one Claude Code session at a time, you know the pain: switching between terminals to check progress, missing permission prompts that block work, losing track of which session is doing what. It gets worse when you step away from your desk.

Control Center gives you a single dashboard where every Claude Code session on your machine appears automatically with real-time status. You can grant permissions with one click from your phone, open a full browser terminal into any session, and let safe tools auto-approve so your agents keep moving. Everything runs locally on your machine — no cloud services, no data leaving your network.

It works by hooking into Claude Code's lifecycle events. Sessions register themselves when they start, report tool usage as they work, and surface permission requests the moment they happen. The dashboard updates in real time over WebSocket, so what you see is always current.

## Key Features

- **Real-time session monitoring** — color-coded status cards (active, idle, waiting for permission, stopped) with live tool tracking and transcript previews
- **One-click permission grants** — approve prompts from the dashboard on any device, no terminal switching
- **Auto-approve for safe tools** — configurable allowlist (Read, Glob, Grep, etc.) and Bash pattern matching so read-only operations never block
- **Browser terminal** — full xterm.js terminal connected to each session's tmux pane
- **Mobile-friendly** — installable as a phone app (PWA) with input bar and quick-action buttons (Ctrl+C, Tab, arrow keys)
- **Push notifications** — get notified on your phone when a session needs permission approval
- **Session launcher** — start new Claude Code sessions from the dashboard with project presets and initial prompts
- **AI session summaries** — optional 2-3 sentence status summaries via any OpenAI-compatible API (DeepSeek, OpenAI, etc.)
- **Usage analytics** — sessions per week, tool counts, average duration, AI cost tracking
- **Project grouping** — organize sessions by project with collapsible stopped-session section
- **Works from any device** — access over your local network or remotely via Tailscale

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/charan1319/control-center/main/install.sh | bash
```

Open `http://localhost:7700`. Start a Claude Code session anywhere on your machine — it appears on the dashboard automatically.

Or install manually:

```bash
git clone https://github.com/charan1319/control-center.git
cd control-center
./install.sh
```

## How It Works

Claude Code fires shell hooks on lifecycle events (session start, stop, permission requests, tool use). The hook scripts POST to the Control Center server, which stores everything in SQLite and pushes updates to the browser over WebSocket. Browser terminals connect to tmux panes via node-pty, so you get a real terminal in your browser with full scrollback.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) CLI
- Node.js 20+
- tmux
- jq, curl (used by hook scripts)
- Linux or macOS (WSL works)

## Configuration

Copy `.env.example` to `.env` and edit as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_PORT` | `7700` | Server port |
| `DEEPSEEK_API_KEY` | _(empty)_ | API key for AI summaries (any OpenAI-compatible endpoint) |
| `CC_AI_SUMMARY` | `true` | Set `false` to disable AI summaries |
| `CC_AUTO_APPROVE_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,LS` | Tools auto-approved without prompting |
| `CC_AUTO_APPROVE_BASH_PATTERN` | _(safe commands)_ | Regex for auto-approving Bash commands |

Collects basic usage statistics (session count, uptime) to help improve the tool. Disable with `CC_TELEMETRY=false` in `.env`.

See [SETUP.md](SETUP.md) for the full installation and configuration guide.

## Remote Access

Install [Tailscale](https://tailscale.com) on your server and any device you want to access it from. Then open `http://<tailscale-ip>:7700`. No port forwarding, no DNS configuration, no certificates to manage.

## Documentation

- [SETUP.md](SETUP.md) — full installation and configuration guide