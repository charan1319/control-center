# Control Center — Agent Reference

This file is the authoritative guide for AI agents working in this repo.
**Read it fully before making changes.**

---

## Documentation Map

| File | Purpose | When to update |
|------|---------|----------------|
| `CLAUDE.md` | Architecture, API reference, schema, conventions (this file) | When adding endpoints, changing schema, or changing how things work |
| `DEVELOPMENT.md` | Progress log, todos, next steps, architecture decisions | After every session — mark completed items, add new todos, log decisions |
| `SETUP.md` | Step-by-step install and configuration guide | When adding new env vars, setup steps, or dependencies |
| `README.md` | User-facing overview and feature list | When features are added or removed |

### IMPORTANT — Keep docs current

**After completing any non-trivial change, you must update the relevant docs above.**
Specifically:
- New feature added → update `DEVELOPMENT.md` (mark todo done or add to "What's working"), update `README.md` features list
- New API endpoint → update the endpoints table in `CLAUDE.md`
- New env var → update config tables in `CLAUDE.md` and `SETUP.md`
- New dependency or setup step → update `SETUP.md`
- Architecture decision made → add a rationale entry to `DEVELOPMENT.md`
- Todo completed → strike it off in `DEVELOPMENT.md`

Outdated docs are worse than no docs. If you change something, update the docs in the same commit.

---

## What This Is

A self-hosted Node.js/Fastify web dashboard that monitors, controls, and provides browser terminals
for multiple Claude Code sessions running in tmux. Accessible remotely over Tailscale.

**Running instance:** `http://localhost:7700` (or `http://<tailscale-ip>:7700` remotely)
**Start server:** `npm start` (from this directory, inside a tmux pane)
**Run tests:** `npm test` — 84 tests, all must pass before committing
**Dev (auto-reload):** `npm run dev`

---

## Architecture

```
Claude Code session (tmux pane)
    │
    │  lifecycle events (SessionStart, Stop, PermissionRequest, PostToolUse)
    ▼
~/.claude/hooks/cc-report.sh       (all events)
~/.claude/hooks/cc-heartbeat.sh    (PostToolUse heartbeats only)
    │
    │  HTTP POST /api/hooks
    ▼
server.js  (Fastify, port 7700)
    ├── SQLite  data/control-center.sqlite   (sessions, events, heartbeats)
    ├── WS /ws/events          →  browser dashboard  (real-time push)
    ├── WS /ws/terminal/:id    →  xterm.js  ↔  node-pty  ↔  tmux
    └── notifier.js  →  openclaw message send  →  Telegram
```

---

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Fastify server: all REST routes, WebSocket handlers, hook ingestion, auto-approve logic, transcript helpers, AI summary |
| `db.js` | SQLite schema, migrations, all prepared statements |
| `pty-manager.js` | node-pty ↔ tmux bridge: attach/detach, scrollback replay, resize |
| `notifier.js` | OpenClaw → Telegram notifications (Stop + PermissionRequest events) |
| `config.js` | Maps env vars → config object; ensures data/ directory exists |
| `public/app.js` | Browser dashboard — vanilla JS, no framework |
| `public/style.css` | Catppuccin Mocha dark theme |
| `public/index.html` | Dashboard HTML shell |
| `hooks/cc-report.sh` | Hook script for SessionStart/Stop/PermissionRequest/Notification |
| `hooks/cc-heartbeat.sh` | Hook script for PostToolUse heartbeats |
| `data/projects.json` | Machine-local project presets (gitignored; read on every request) |
| `.env` | Machine-local env config (gitignored) |
| `test/` | Node.js built-in test runner, one file per module |

---

## Database Schema

**sessions**
```sql
session_id   TEXT PRIMARY KEY
cwd          TEXT
model        TEXT
transcript   TEXT    -- absolute path to Claude Code's JSONL transcript file
tmux_target  TEXT    -- tmux session name (e.g. "cc-0"), null if not linked
status       TEXT    -- 'active' | 'waiting_permission' | 'stopped'
label        TEXT    -- human-readable name
project      TEXT    -- project group name
created_at   TEXT    -- datetime('now') UTC
updated_at   TEXT    -- datetime('now') UTC
```

**events** — one row per lifecycle event (SessionStart, Stop, PermissionRequest, Notification)
```sql
id           INTEGER PRIMARY KEY AUTOINCREMENT
session_id   TEXT
event        TEXT
tool_name    TEXT
tool_input   TEXT    -- JSON string
raw          TEXT    -- full hook payload JSON
created_at   TEXT
```

**heartbeats** — one row per session (upserted on every PostToolUse)
```sql
session_id   TEXT PRIMARY KEY
tool_name    TEXT    -- most recent tool
last_seen    TEXT    -- datetime('now') UTC
```

`getSession` and `getAllSessions` JOIN heartbeats and also return:
- `last_tool` — from heartbeats
- `last_heartbeat` — from heartbeats
- `tool_count` — COUNT of rows in events for this session

---

## All API Endpoints

### Sessions

| Method | Path | Body / Notes |
|--------|------|--------------|
| `GET` | `/api/sessions` | All sessions (includes joined heartbeat fields + tool_count) |
| `GET` | `/api/sessions/:id` | Single session |
| `PATCH` | `/api/sessions/:id` | `{label?, tmux_target?, project?}` — update any combination |
| `POST` | `/api/sessions/launch` | `{label?, cwd?, initialPrompt?, project?}` — creates tmux session + starts claude |
| `POST` | `/api/sessions/:id/input` | `{text}` — sends text + newline to session's tmux pane via load-buffer/paste-buffer |
| `POST` | `/api/sessions/:id/kill` | Kills tmux session + sets status = 'stopped' |
| `GET` | `/api/sessions/:id/events` | `?limit=50&offset=0` — paginated session events |
| `GET` | `/api/sessions/:id/preview` | Last assistant text block from transcript JSONL (`{text}`) |
| `GET` | `/api/sessions/:id/summary` | AI-generated 2-3 sentence status summary via DeepSeek (`{summary}`), 90s server cache |

### Events, Projects, Info

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/events` | `?limit=100` — recent events across all sessions |
| `GET` | `/api/projects` | Array of `{name, cwd}` from data/projects.json |
| `PUT` | `/api/projects` | Replaces data/projects.json entirely |
| `GET` | `/api/tmux-sessions` | Live tmux session list from pty-manager |
| `GET` | `/api/info` | `{serverCwd, aiSummaryEnabled}` |

### Hook ingest

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/hooks` | Called by hook scripts. Body fields: `event`, `session_id`, `cwd`, `transcript_path`, `tool_name`, `tool_input`, `tmux_session`, `model`, `timestamp` |

### WebSockets

| Path | Protocol |
|------|----------|
| `/ws/events` | Server → client: `{type:'init', sessions, recentEvents}` on connect, then `{type:'session_update', session}` and `{type:'event', ...}` on changes |
| `/ws/terminal/:sessionId` | Bidirectional: client sends `{type:'input',data}` or `{type:'resize',cols,rows}`; server sends `{type:'output',data}` |

---

## Hook Events

Hook scripts are deployed to `~/.claude/hooks/` and registered in `~/.claude/settings.json`.

| Event | Script | What It Does |
|-------|--------|--------------|
| `SessionStart` | cc-report.sh | Registers/upserts session; auto-links tmux target by name (if `$TMUX` set) or CWD match; applies pending labels from `/launch` |
| `Stop` | cc-report.sh | Marks session stopped; sends Telegram notification if idle 30s+ |
| `PermissionRequest` | cc-report.sh | Marks session waiting_permission (or auto-approves if tool is in safe list); sends Telegram if idle 30s+ |
| `Notification` | cc-report.sh | Logged only |
| `PostToolUse` (Bash\|Write\|Edit\|MultiEdit) | cc-heartbeat.sh | Upserts heartbeat; sets status → active (unless stopped) |

The hook scripts report `tmux_session` (the tmux session name from `$TMUX`) so auto-linking is unambiguous even when multiple sessions share a CWD.

---

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_PORT` | `7700` | Server port |
| `CC_HOST` | `0.0.0.0` | Bind address |
| `CC_DB_PATH` | `./data/control-center.sqlite` | SQLite path |
| `OPENCLAW_BIN` | _(empty)_ | Path to `openclaw` CLI binary; empty = notifications disabled |
| `TELEGRAM_CHAT_ID` | _(empty)_ | Telegram chat ID for notifications |
| `DEEPSEEK_API_KEY` | _(empty)_ | DeepSeek API key for AI summaries |
| `CC_AI_SUMMARY` | `true` | Set to `false` to disable AI summary polling without removing the key |
| `CC_AUTO_APPROVE_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,LS` | Comma-separated tool names auto-approved without user prompt |
| `CC_AUTO_APPROVE_BASH_PATTERN` | (safe read-only commands regex) | Regex matched against Bash command string for auto-approval |

---

## Frontend Architecture (public/app.js)

Single-file vanilla JS, no build step. Key patterns:

- **State:** `sessions[]`, `recentEvents[]`, `selectedSessionId`, `serverInfo`, `previewCache` (Map), `summaryCache` (Map)
- **Real-time:** WebSocket `/ws/events` — on `init` receives all sessions; on `session_update` patches the sessions array; on `event` appends to recentEvents and updates status
- **Rendering:** `renderSessions()` and `renderEvents()` do full innerHTML replacement — called on every WebSocket message and every 15s for age updates
- **Session card status classes:** `active` (green border glow), `idle` (gray border), `waiting` (red border pulse animation), `stopped` (dimmed, in collapsible section)
- **Terminal:** xterm.js + FitAddon + WebLinksAddon loaded from CDN. Connected via `/ws/terminal/:id`. Input bar below terminal works on both desktop and mobile.
- **Async data:** `refreshPreviews()` every 20s (fetches last assistant text per active session), `refreshSummaries()` every 90s (fetches AI summaries if enabled)
- **Mobile:** Input bar with Ctrl+C / Tab / ↑↓ buttons; tap-to-focus keyboard; 40px touch targets; `55dvh` terminal height

### Adding a new card field
1. Add to the SQL query in `db.js` (getSession + getAllSessions)
2. Use the field in `renderSessionCard()` in `app.js`
3. Add CSS in `style.css`

### Adding a new API endpoint
1. Add route in `server.js` following existing patterns
2. Add tests in `test/server.test.js`

---

## Status Logic

Status is determined client-side in `getStatusClass(session)`:
- `waiting` — `session.status === 'waiting_permission'`
- `stopped` — `session.status === 'stopped'`
- `active` — status is 'active' AND `last_heartbeat` was within 120 seconds
- `idle` — status is 'active' BUT `last_heartbeat` was more than 120 seconds ago

The 120s threshold means a session naturally transitions from `active` to `idle` without any server event.

---

## Auto-Approve Permissions

On `PermissionRequest` events, `server.js` calls `shouldAutoApprove(payload)`:
1. If `payload.tool_name` is in `config.autoApproveTools` → auto-approve
2. If `payload.tool_name === 'Bash'` and the command matches `config.autoApproveBashPattern` → auto-approve

Auto-approval sends `1\n` to the tmux pane (selects option 1 = "Yes, do it") via `tmux load-buffer` + `paste-buffer`. The session never enters `waiting_permission` status and no notification is sent.

---

## AI Summary

`GET /api/sessions/:id/summary` — reads the last 32KB of the transcript JSONL, extracts the last 20 user/assistant turns, sends to `deepseek-chat` with a status-summary prompt. Returns `{summary: string|null}`. Results cached 90s in memory. Disabled entirely when `CC_AI_SUMMARY=false` or `DEEPSEEK_API_KEY` is unset.

---

## Notifications

`notifier.js` is called for `Stop` and `PermissionRequest` events only when the session has been idle for 30+ seconds (guards against pinging when the user is actively watching). Uses `execFileSync(openclawBin, ['message', 'send', ...])`. Auto-approved permissions never trigger notifications.

---

## Project Presets

`data/projects.json` (gitignored) — array of `{name: string, cwd: string}`. Read on every request to `/api/projects`, no restart needed. The New Session modal populates its CWD dropdown from this file and auto-assigns the `project` field based on selected preset.

Machine-local default:
```json
[
  { "name": "Deep Discovery",  "cwd": "/home/zapperz/Charan/deep-discovery" },
  { "name": "Stim Analysis",   "cwd": "/home/zapperz/lab3/scripts/stim_expt_analysis" },
  { "name": "Control Center",  "cwd": "/home/zapperz/Charan/control-center" }
]
```

---

## Testing

```bash
npm test   # runs test/*.test.js with Node.js built-in test runner
```

Tests use `buildServer()` (exported from server.js) to spin up a full in-memory server against a temp SQLite DB. No mocking. All 84 tests must pass before committing.

---

## Known Limitations / Future Work

- **No auth** — API is open; fine for Tailscale-only, but add auth before any public exposure
- **No auto-start** — server is started manually (`npm start` in a tmux pane); could add a systemd user service
- **Session accumulation** — stopped sessions accumulate in the DB with no automatic cleanup
- **Transcript preview efficiency** — `notifier.js` uses `readFileSync` (reads entire file); `server.js` uses the tail-read approach for efficiency; they could be unified
- **Terminal on mobile** — the input bar works well; xterm.js itself is not touch-native, but the tap-to-type and input bar make it usable
