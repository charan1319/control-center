# Control Center — Handoff Document
_Generated end of session, 2026-03-18_

---

## What This Is

A self-hosted Node.js/Fastify web dashboard that monitors, launches, and controls Claude Code sessions running in tmux on the lab PC. Accessible from any device on the Tailscale network at `http://<lab-tailscale-ip>:7700`.

**Repo (after migration):** `/home/zapperz/Charan/control-center`
**Server start:** `cd /home/zapperz/Charan/control-center && npm start`
**Test suite:** `/home/zapperz/.nvm/versions/node/v22.22.1/bin/node --test` (84 tests, all pass)

---

## Immediate Next Step: Repo Migration

The repos need to move from Windows NTFS to WSL native filesystem for performance. Run this after ending the session:

```bash
mkdir -p /home/zapperz/Charan

# Copy repos (node_modules excluded — will rebuild faster on native FS)
rsync -a --exclude=node_modules/ /mnt/c/Users/zapperz/control-center/ /home/zapperz/Charan/control-center/
rsync -a --exclude=node_modules/ /mnt/c/Users/zapperz/Code/deep-discovery/ /home/zapperz/Charan/deep-discovery/

# Rebuild deps at new location
cd /home/zapperz/Charan/control-center && npm install

# Start server from new location
npm start
```

Once verified working:
```bash
rm -rf /mnt/c/Users/zapperz/control-center
rm -rf /mnt/c/Users/zapperz/Code/deep-discovery
```

### Post-Migration Checklist
- [ ] Server starts and dashboard loads at `http://localhost:7700`
- [ ] `node --test` passes all 84 tests from new location
- [ ] Open a new Claude Code session in `/home/zapperz/Charan/control-center` — it should appear in the dashboard (SessionStart hook fires)
- [ ] Telegram notification arrives when a session stops (tests the 30s inactivity gate + OpenClaw path)
- [ ] New Session modal shows the three project presets in the dropdown
- [ ] Terminal opens, resizes correctly, and mouse wheel scrolls the viewport (not history)
- [ ] Kill button works on a test session
- [ ] Deep Discovery: run whatever setup it needs after rsync (`npm install`, `pip install`, etc.)

---

## Architecture

```
Claude Code (tmux pane)
    ↓ PostToolUse/Stop/PermissionRequest/etc.
~/.claude/hooks/cc-report.sh  (or cc-heartbeat.sh)
    ↓ HTTP POST
http://127.0.0.1:7700/api/hooks
    ↓
server.js (Fastify)
    ├── SQLite (data/control-center.sqlite) — sessions, events, heartbeats
    ├── WebSocket /ws/events → browser dashboard (real-time updates)
    ├── WebSocket /ws/terminal/:id → xterm.js via node-pty ↔ tmux
    └── notifier.js → openclaw message send → Telegram
```

### Key Files
| File | Purpose |
|------|---------|
| `server.js` | Fastify server, all API routes, WebSocket handlers |
| `db.js` | SQLite schema + prepared statements |
| `pty-manager.js` | node-pty ↔ tmux bridge |
| `notifier.js` | OpenClaw Telegram notifications |
| `config.js` | Env var → config object |
| `public/app.js` | Browser dashboard (vanilla JS, ~550 lines) |
| `public/style.css` | Catppuccin Mocha theme |
| `public/index.html` | Dashboard HTML shell |
| `data/projects.json` | Machine-local project presets (gitignored) |
| `.env` | Machine-local config (gitignored) |
| `~/.claude/hooks/cc-report.sh` | Reports SessionStart/Stop/PermissionRequest/Notification |
| `~/.claude/hooks/cc-heartbeat.sh` | Lightweight heartbeat on every PostToolUse |

### API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | All sessions |
| GET | `/api/sessions/:id` | Single session |
| PATCH | `/api/sessions/:id` | Update label / project / tmux_target |
| POST | `/api/sessions/launch` | Launch new Claude Code session in tmux |
| POST | `/api/sessions/:id/input` | Send text into session's tmux pane |
| POST | `/api/sessions/:id/kill` | Kill tmux session + mark stopped |
| GET | `/api/events` | Recent events |
| GET | `/api/projects` | Project presets from data/projects.json |
| PUT | `/api/projects` | Save project presets |
| GET | `/api/tmux-sessions` | Raw tmux session list |
| WS | `/ws/events` | Dashboard real-time event stream |
| WS | `/ws/terminal/:id` | Terminal relay (xterm.js ↔ tmux) |

---

## Features Implemented This Session

### Dashboard UI
- **Session cards** grouped by project with collapse-able project headings
- **Project assignment**: set on new session launch or via the Edit button on each card
- **Kill button** (red): kills the tmux session and marks it stopped
- **Edit button**: modal with Label + Project fields, project autocomplete from existing sessions
- **New Session modal**: Label, Project (optional), Working Directory (dropdown of presets + custom), Initial Prompt
- **Project presets**: stored in `data/projects.json`, served via `/api/projects`, dropdown auto-populates

### Terminal
- **Taller**: 600px desktop / 340px mobile (was 400px)
- **Glitch fix**: double `requestAnimationFrame` before initial fit; `proposeDimensions()` + explicit send on WebSocket open (bypasses xterm's "only fire if changed" guard)
- **Scroll fix**: `wheel` event interceptor on terminal container calls `term.scrollLines()` directly — prevents mouse wheel from sending cursor-up/down key presses into Claude Code's input

### Notifications (OpenClaw → Telegram)
- **30-second inactivity gate**: Stop and PermissionRequest notifications are suppressed if a heartbeat was seen within the last 30s (user is actively watching)
- **Rich Stop messages**: reads the session's transcript JSONL, extracts the last assistant text block, appends up to 300 chars to the notification
- **Format**: `✅ Session abc12345 finished in /path\n💬 <last output>…`

---

## OpenClaw Setup

**What it is:** Self-hosted AI gateway at `http://localhost:18789`. Provides an agent (via Telegram) that can answer questions, run bash commands, and call the control center API.

**Config:** `~/.openclaw/openclaw.json`
**Service:** `~/.config/systemd/user/openclaw-gateway.service` (runs on login)
**Restart service:** `systemctl --user restart openclaw-gateway`

**Provider:** DeepSeek (`deepseek-chat` model) via OpenAI-compatible API
**API key location:** In the systemd service file as `Environment=DEEPSEEK_API_KEY=...` and in `.env` as `DEEPSEEK_API_KEY=...`

**Telegram:** Paired and working. The lab PC sends proactive messages via `openclaw message send --channel telegram --target 8778592568 --message "..."`.

### OpenClaw Skill
A skill was created at `~/.openclaw/skills/control-center-api/SKILL.md` that gives the OpenClaw agent full knowledge of the control center API. The agent auto-triggers on phrases like "list sessions", "launch session", "send to Claude", "what's running". Also available as `/control-center-api` slash command in the Telegram chat.

### What You Can Do via Telegram
- Ask "what sessions are running?" → agent calls `/api/sessions` and summarizes
- "Launch a new session for deep-discovery and run the tests" → agent calls `/api/sessions/launch`
- "Send 'fix the auth bug' to the control-center session" → agent calls `/api/sessions/:id/input`
- "Grant permission to the waiting session" → agent sends Enter to the session
- Receive automatic Stop/PermissionRequest notifications when you've been away 30+ seconds

---

## Project Presets (data/projects.json)
```json
[
  { "name": "Deep Discovery", "cwd": "/home/zapperz/Charan/deep-discovery" },
  { "name": "Stim Analysis",  "cwd": "/home/zapperz/lab3/scripts/stim_expt_analysis" },
  { "name": "Control Center", "cwd": "/home/zapperz/Charan/control-center" }
]
```
Edit this file directly to add/remove presets. No server restart needed — it's read on every request.

---

## Environment (.env)
```
CC_PORT=7700
CC_HOST=0.0.0.0
CC_DB_PATH=./data/control-center.sqlite
OPENCLAW_BIN=/home/zapperz/.nvm/versions/node/v22.22.1/bin/openclaw
TELEGRAM_CHAT_ID=8778592568
DEEPSEEK_API_KEY=sk-...  (DeepSeek key)
```

---

## Claude Code Hooks (~/.claude/settings.json)
Five hooks configured globally:
- `SessionStart` → `cc-report.sh` (registers session in dashboard)
- `Stop` → `cc-report.sh` (marks stopped + triggers notification if idle 30s+)
- `PermissionRequest` → `cc-report.sh` (marks waiting + triggers notification if idle 30s+)
- `Notification` → `cc-report.sh` (logged, not notified)
- `PostToolUse` (Bash|Write|Edit|MultiEdit) → `cc-heartbeat.sh` (updates last-active time)

---

## Known Remaining Work / Future Ideas
- [ ] **Auth**: No authentication on the control center HTTP API — fine for Tailscale-only access, but worth adding if ever exposed more broadly
- [ ] **Auto-start**: No systemd service for the control center itself — currently started manually with `npm start`. Consider `~/.config/systemd/user/control-center.service`
- [ ] **Session cleanup**: Old stopped sessions accumulate in the DB — no automatic archiving or deletion yet
- [ ] **Deep Discovery setup**: After rsync, determine what `npm install` / env setup is needed for that repo
- [ ] **Tailscale hostname**: The OpenClaw TOOLS.md says "check with `tailscale status`" — could hardcode the stable MagicDNS hostname once confirmed
- [ ] **Two-way Telegram → session flow**: Works via OpenClaw agent calling the API, but could be made smoother with a more structured conversation pattern
- [ ] **Terminal resize on panel show/hide**: The double-rAF fix covers the common case; extremely slow machines could still glitch — a `ResizeObserver` on `terminalContainer` would be the belt-and-suspenders fix

---

## Tailscale Remote Access
The lab PC is on Tailscale. From Mac:
- Dashboard: `http://<lab-tailscale-ip>:7700`
- Get the IP from the lab PC: `tailscale ip -4`
