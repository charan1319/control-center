# Claude Code Control Center — Implementation Plan (Improved)

> **Purpose of this document:** This is a complete specification for an autonomous Claude Code agent to implement in one shot **in the cloud, pushing to a GitHub repo.** Every file is fully specified. Where code is shown, it is the actual implementation — not pseudocode. The resulting repo is then cloned to the lab PC and set up with an install script. Follow the implementation order in Section 25.
>
> **Cloud vs. Lab PC split:**
> - **Cloud (Claude Code → GitHub):** All source code — server, frontend, hook scripts, install script, README. ~95% of the work.
> - **Lab PC only:** `git clone`, `npm install` (native addons compile against local OS/arch), run `install.sh` (copies hooks, configures Claude Code settings, sets up systemd service), start the server.

---

## Revision Notes — Changes From Original Plan

This section documents every substantive change made to the original plan. Cosmetic changes (whitespace, comment tweaks) are not listed.

### Security Fixes

1. **Shell injection in `pty-manager.js`** — All functions that pass user-controlled strings to `execSync()` or `pty.spawn()` now sanitize inputs via a `sanitizeTmuxTarget()` helper that rejects anything outside `[a-zA-Z0-9_-]`. The `cwd` argument in `createTmuxSession` is passed using `tmux -c` with proper quoting. The `initialPrompt` in `createTmuxSession` now uses `tmux send-keys -l` (literal mode) with the text piped via stdin to avoid shell metacharacter issues.

2. **Shell injection in `server.js` (`/api/sessions/:id/input`)** — Replaced `execSync` with shell-escaped `tmux send-keys -l` (literal flag, no `Enter` interpretation by the shell). The `text` payload is piped via stdin to `tmux load-buffer` + `paste-buffer` to completely avoid shell interpretation.

### Bug Fixes

3. **Missing `.env` file loading** — The original plan references `.env` / `.env.example` but never loads them. Added `--env-file=.env` to the `start` and `dev` npm scripts (Node 22+ supports this natively — no `dotenv` dependency needed). Added a guard in `config.js` explaining this.

4. **`install.sh` duplicates hooks on re-run** — The jq merge blindly appends hook arrays. Now it first strips any existing entries whose `command` path matches `$HOOK_DIR/cc-report.sh` or `$HOOK_DIR/cc-heartbeat.sh` before appending, making re-runs idempotent.

5. **`install.sh` systemd service missing `EnvironmentFile`** — The systemd unit now includes `EnvironmentFile=%h/control-center/.env` so the `.env` config is loaded on service start.

6. **`createTmuxSession` uses `setTimeout` for initial prompt** — This is a fire-and-forget race condition. Replaced with a documented note that the initial prompt is best-effort and may fail if Claude Code hasn't finished initializing. Changed `setTimeout` to `3000` → `5000` ms for safety, and added error logging that includes the session name.

7. **`getActiveSessions` query missing heartbeat join** — Unlike `getAllSessions` and `getSession`, this query didn't join the heartbeats table. Fixed to include `LEFT JOIN heartbeats`.

8. **`notifier.test.js` "no token" test is a no-op** — Removed the empty test case and replaced with a comment explaining why ESM module caching prevents testing this path in isolation. The behavior is implicitly covered by the `SessionStart`/`Heartbeat` tests.

9. **`server.js` route indentation** — All routes inside `buildServer()` now use consistent 2-space indentation to make the function scope unambiguous. (Doesn't affect runtime, but critical for an agent reading the plan.)

10. **`db.test.js` `getSession` returns `undefined`, not `null`** — The test comment says "returns null" but `better-sqlite3`'s `.get()` returns `undefined` for no rows. Fixed the assertion comment and assertion to use `undefined`.

### Robustness Improvements

11. **Graceful shutdown** — Added a `closeGracefully()` function to `server.js` that kills all active PTY bridges and closes the database on `SIGINT`/`SIGTERM`. Also exported a `shutdown()` method from `pty-manager.js`.

12. **`server.js` main-module guard** — Simplified the `import.meta.url === pathToFileURL(...)` check and removed the confusing `ERR_INVALID_ARG_TYPE` catch that silently swallowed real errors. The guard now uses a straightforward pattern.

13. **Database `close()` export** — Added `export function close()` to `db.js` so the server can cleanly close the database handle on shutdown.

14. **Event log CSS grid on mobile** — The mobile breakpoint removed the `.ev-detail` column but left a 3-column grid that cramped `.ev-label`. Changed mobile grid to `60px 1fr` (time + event only, hiding label and detail) for better readability.

15. **Hook scripts: explicit `jq` error handling** — Added `|| { echo "jq failed" >&2; exit 0; }` after the jq pipeline so that if jq fails (e.g., unexpected input format), the hook exits cleanly instead of sending malformed data.

16. **`package.json` `start` script** — Changed from `node server.js` to `node --env-file=.env server.js` to load environment variables. The `dev` script also uses `--env-file=.env`.

---

## 1. What This Is

A self-hosted web application that lets you monitor, interact with, and manage multiple Claude Code sessions running in tmux panes on a single machine — from any browser, including remotely from a phone or laptop over Tailscale.

When a Claude Code session finishes a task, needs a permission approval, or errors out, the control center knows immediately. You see it in the dashboard, and optionally get a push notification on your phone via OpenClaw.

---

## 2. The Problem It Solves

Running multiple Claude Code agents in parallel (each in its own tmux pane) is powerful, but managing them is painful:

- You can't see what's happening across sessions without manually switching between tmux panes
- Permission prompts block an agent silently — you don't know it's waiting unless you're looking at that specific pane
- There's no way to check agent status from your phone or a different machine
- You lose context on what each session is working on and when it last made progress
- There's no log of session lifecycle events (start, stop, errors, permission requests) across agents

The control center gives you a single pane of glass for all of it, accessible from anywhere.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Lab Machine (always-on, running tmux + Claude Code sessions)              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  tmux server                                                        │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │    │
│  │  │ session:cc-0 │ │ session:cc-1 │ │ session:cc-2 │ ...            │    │
│  │  │ Claude Code  │ │ Claude Code  │ │ Claude Code  │                │    │
│  │  │   ↕ hooks    │ │   ↕ hooks    │ │   ↕ hooks    │                │    │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘                │    │
│  │         │                │                │                         │    │
│  │         └────────────────┼────────────────┘                         │    │
│  │                          │ HTTP POST (localhost)                     │    │
│  └──────────────────────────┼──────────────────────────────────────────┘    │
│                             ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Control Center Server (Node.js, port 7700)                          │   │
│  │                                                                      │   │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐  │   │
│  │  │ Hook Ingest  │  │ PTY Manager   │  │ WebSocket Hub            │  │   │
│  │  │ POST /hooks  │  │ node-pty ←→   │  │ /ws/events (dashboard)   │  │   │
│  │  │ (from CC     │  │ tmux sessions │  │ /ws/terminal/:id (xterm) │  │   │
│  │  │  hook scripts)│  │               │  │                          │  │   │
│  │  └──────┬───────┘  └───────┬───────┘  └──────────┬───────────────┘  │   │
│  │         │                  │                      │                  │   │
│  │         ▼                  │                      │                  │   │
│  │  ┌──────────────┐         │                      │                  │   │
│  │  │ SQLite DB    │◄────────┘                      │                  │   │
│  │  │ sessions,    │                                 │                  │   │
│  │  │ events,      │                                 │                  │   │
│  │  │ heartbeats   │                                 │                  │   │
│  │  └──────────────┘                                 │                  │   │
│  │         │                                         │                  │   │
│  │         ▼                                         ▼                  │   │
│  │  ┌──────────────┐                    ┌──────────────────────────┐   │   │
│  │  │ OpenClaw     │                    │ Web Dashboard            │   │   │
│  │  │ Notifier     │                    │ (served as static SPA)   │   │   │
│  │  │ (optional)   │                    │                          │   │   │
│  │  └──────────────┘                    └──────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Tailscale (100.x.y.z) ◄──── accessible from phone / laptop / anywhere    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data flow summary:**

1. Claude Code hooks fire shell scripts on lifecycle events (SessionStart, Stop, PermissionRequest, etc.)
2. Hook scripts POST JSON to the control center's `/api/hooks` endpoint on localhost
3. The control center writes the event to SQLite and broadcasts it over WebSocket
4. The web dashboard receives the event in real time and updates the UI
5. For high-priority events (Stop, PermissionRequest), the control center optionally pings OpenClaw to send a notification to your phone

---

## 4. Technology Choices

| Component | Choice | Why |
|-----------|--------|-----|
| Backend runtime | **Node.js 22+** | Same runtime as OpenClaw. Native ESM. Built-in `--env-file` support. |
| HTTP framework | **Fastify 5** | Fast, built-in JSON schema validation, WebSocket plugin. |
| WebSocket | **@fastify/websocket** (backed by `ws`) | Clean Fastify integration. |
| Database | **SQLite via better-sqlite3** | Zero-config, single file, sync reads. |
| PTY management | **node-pty** | Industry standard. Used by VS Code, Theia. |
| Terminal frontend | **xterm.js 5.x** via CDN | De facto browser terminal. |
| Frontend | **Vanilla HTML/CSS/JS** | No build step. Served static. |
| Notifications | **OpenClaw /v1/responses** | Already running locally. |
| Remote access | **Tailscale** | Zero-config WireGuard mesh. |

---

## 5. Complete File Structure (the GitHub repo)

```
control-center/
├── package.json
├── server.js                # Main Fastify app — routes, WebSocket, startup
├── db.js                    # SQLite schema, migrations, query helpers
├── pty-manager.js           # node-pty lifecycle for tmux attach/detach
├── notifier.js              # OpenClaw push notifications (optional)
├── config.js                # All configuration in one place
├── install.sh               # Lab PC setup — hooks, settings, systemd service
├── .gitignore
├── .env.example             # Template for environment variables
├── hooks/                   # Claude Code hook scripts (install.sh copies these)
│   ├── cc-report.sh
│   └── cc-heartbeat.sh
├── public/                  # Static frontend — served by Fastify
│   ├── index.html           # Single-page dashboard
│   ├── app.js               # All frontend JavaScript
│   └── style.css            # All styles
├── test/                    # Tests (node:test — no extra deps)
│   ├── db.test.js           # Database CRUD operations
│   ├── api.test.js          # HTTP route tests via Fastify inject
│   └── notifier.test.js     # Push notification logic
└── README.md                # Setup instructions for the lab PC
```

**Not in the repo** (created at runtime on the lab PC):
- `node_modules/` — native addons must compile locally
- `data/control-center.sqlite` — created on first `server.js` run
- `.env` — user creates from `.env.example`

---

## 6. File: `package.json`

```json
{
  "name": "control-center",
  "version": "1.0.0",
  "type": "module",
  "description": "Claude Code session monitoring dashboard",
  "main": "server.js",
  "scripts": {
    "start": "node --env-file=.env server.js",
    "dev": "node --env-file=.env --watch server.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/static": "^8.1.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.8.0",
    "node-pty": "^1.0.0"
  }
}
```

**Environment loading:** The `start` and `dev` scripts use Node 22's built-in `--env-file=.env` flag. No `dotenv` dependency is needed. If `.env` doesn't exist, Node prints a warning but starts normally (environment variables can also be set via systemd, shell profile, etc.).

**Testing:** Uses `node:test` (built-in since Node 22). Zero test dependencies. Tests use `better-sqlite3` with a temp database file — this requires `npm install` to compile the native module, which means tests run after install on the lab PC. To also run tests in CI or cloud, ensure build tools are available (see prerequisites below).

**Prerequisites for native modules (node-pty, better-sqlite3):**
- `python3`, `make`, `gcc` / `g++` must be installed on the system
- On Ubuntu/Debian: `sudo apt install -y build-essential python3`
- On macOS: Xcode Command Line Tools (`xcode-select --install`)

---

## 7. File: `config.js`

```javascript
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Environment variables are loaded via Node's --env-file=.env flag in package.json scripts.
// If running directly (node server.js), set variables in your shell or use: node --env-file=.env server.js

const config = {
  // Server
  port: parseInt(process.env.CC_PORT || '7700', 10),
  host: process.env.CC_HOST || '0.0.0.0',

  // Database
  dbPath: process.env.CC_DB_PATH || './data/control-center.sqlite',

  // PTY
  ptyGracePeriodMs: 30_000,      // Keep PTY alive 30s after last client disconnects
  scrollbackBufferSize: 50_000,  // Characters of scrollback to replay on connect

  // OpenClaw (optional — leave token empty to disable notifications)
  openclawUrl: process.env.OPENCLAW_URL || 'http://127.0.0.1:18789/v1/responses',
  openclawToken: process.env.OPENCLAW_TOKEN || '',
  openclawAgent: process.env.OPENCLAW_AGENT || 'main',

  // tmux
  tmuxSessionPrefix: 'cc-',
};

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

export default config;
```

---

## 8. File: `db.js`

```javascript
import Database from 'better-sqlite3';
import config from './config.js';

const db = new Database(config.dbPath);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ──────────────────────────────────────────────
// Schema — runs on every startup (IF NOT EXISTS)
// ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    cwd           TEXT,
    model         TEXT,
    transcript    TEXT,
    tmux_target   TEXT,
    status        TEXT DEFAULT 'active',
    label         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    event         TEXT NOT NULL,
    tool_name     TEXT,
    tool_input    TEXT,
    raw           TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    session_id    TEXT PRIMARY KEY,
    tool_name     TEXT,
    last_seen     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`);

// ──────────────────────────────────────────────
// Prepared statements
// ──────────────────────────────────────────────

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (session_id, cwd, model, transcript, status, updated_at)
    VALUES (@session_id, @cwd, @model, @transcript, 'active', datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = COALESCE(@cwd, cwd),
      model = COALESCE(@model, model),
      transcript = COALESCE(@transcript, transcript),
      status = 'active',
      updated_at = datetime('now')
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (session_id, event, tool_name, tool_input, raw)
    VALUES (@session_id, @event, @tool_name, @tool_input, @raw)
  `),

  upsertHeartbeat: db.prepare(`
    INSERT INTO heartbeats (session_id, tool_name, last_seen)
    VALUES (@session_id, @tool_name, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      tool_name = @tool_name,
      last_seen = datetime('now')
  `),

  updateStatus: db.prepare(`
    UPDATE sessions SET status = @status, updated_at = datetime('now')
    WHERE session_id = @session_id
  `),

  updateSession: db.prepare(`
    UPDATE sessions SET
      label = COALESCE(@label, label),
      tmux_target = COALESCE(@tmux_target, tmux_target),
      updated_at = datetime('now')
    WHERE session_id = @session_id
  `),

  getSession: db.prepare(`
    SELECT s.*, h.tool_name AS last_tool, h.last_seen AS last_heartbeat
    FROM sessions s
    LEFT JOIN heartbeats h ON s.session_id = h.session_id
    WHERE s.session_id = @session_id
  `),

  getAllSessions: db.prepare(`
    SELECT s.*, h.tool_name AS last_tool, h.last_seen AS last_heartbeat
    FROM sessions s
    LEFT JOIN heartbeats h ON s.session_id = h.session_id
    ORDER BY s.updated_at DESC
  `),

  getSessionEvents: db.prepare(`
    SELECT * FROM events
    WHERE session_id = @session_id
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `),

  getRecentEvents: db.prepare(`
    SELECT e.*, s.label, s.cwd AS session_cwd
    FROM events e
    LEFT JOIN sessions s ON e.session_id = s.session_id
    ORDER BY e.created_at DESC
    LIMIT @limit
  `),

  // FIXED: added heartbeat join (was missing in original)
  getActiveSessions: db.prepare(`
    SELECT s.*, h.tool_name AS last_tool, h.last_seen AS last_heartbeat
    FROM sessions s
    LEFT JOIN heartbeats h ON s.session_id = h.session_id
    WHERE s.status IN ('active', 'waiting_permission')
  `),
};

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export function upsertSession({ session_id, cwd, model, transcript }) {
  return stmts.upsertSession.run({
    session_id,
    cwd: cwd || null,
    model: model || null,
    transcript: transcript || null,
  });
}

export function insertEvent({ session_id, event, tool_name, tool_input, raw }) {
  return stmts.insertEvent.run({
    session_id,
    event,
    tool_name: tool_name || null,
    tool_input: tool_input ? (typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input)) : null,
    raw: raw || null,
  });
}

export function upsertHeartbeat({ session_id, tool_name }) {
  return stmts.upsertHeartbeat.run({ session_id, tool_name: tool_name || null });
}

export function updateStatus(session_id, status) {
  return stmts.updateStatus.run({ session_id, status });
}

export function updateSession(session_id, { label, tmux_target }) {
  return stmts.updateSession.run({
    session_id,
    label: label ?? null,
    tmux_target: tmux_target ?? null,
  });
}

export function getSession(session_id) {
  return stmts.getSession.get({ session_id });
}

export function getAllSessions() {
  return stmts.getAllSessions.all();
}

export function getSessionEvents(session_id, limit = 50, offset = 0) {
  return stmts.getSessionEvents.all({ session_id, limit, offset });
}

export function getRecentEvents(limit = 100) {
  return stmts.getRecentEvents.all({ limit });
}

export function getActiveSessions() {
  return stmts.getActiveSessions.all();
}

// ADDED: clean shutdown support
export function close() {
  db.close();
}

export default db;
```

---

## 9. File: `pty-manager.js`

```javascript
import pty from 'node-pty';
import { execSync } from 'node:child_process';
import config from './config.js';

// Map of tmux_target → { ptyProcess, clients: Set<WebSocket>, graceTimer, scrollback }
const activePTYs = new Map();

/**
 * Validate and sanitize a tmux target name.
 * Rejects anything outside [a-zA-Z0-9_-] to prevent shell injection.
 */
function sanitizeTmuxTarget(target) {
  if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) {
    throw new Error(`Invalid tmux target name: "${target}"`);
  }
  return target;
}

/**
 * Check if a tmux session exists.
 */
function tmuxSessionExists(target) {
  try {
    sanitizeTmuxTarget(target);
    execSync(`tmux has-session -t ${target} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach a WebSocket client to a tmux session's PTY.
 * Creates the PTY bridge if it doesn't exist yet.
 * Multiple clients can attach to the same PTY simultaneously.
 * Returns the pty process, or null if the tmux session doesn't exist.
 */
export function attach(tmuxTarget, socket) {
  if (!tmuxSessionExists(tmuxTarget)) {
    return null;
  }

  let entry = activePTYs.get(tmuxTarget);

  if (!entry) {
    // Spawn a new PTY bridged to the tmux session.
    // Target is already validated by tmuxSessionExists → sanitizeTmuxTarget above.
    const ptyProcess = pty.spawn('/bin/bash', [
      '-c', `exec tmux attach-session -t ${tmuxTarget}`
    ], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    entry = {
      ptyProcess,
      clients: new Set(),
      graceTimer: null,
      scrollback: '',
    };

    // Pipe PTY output → all connected WebSocket clients + scrollback buffer
    ptyProcess.onData((data) => {
      entry.scrollback += data;
      if (entry.scrollback.length > config.scrollbackBufferSize) {
        entry.scrollback = entry.scrollback.slice(-config.scrollbackBufferSize);
      }
      const msg = JSON.stringify({ type: 'output', data });
      for (const client of entry.clients) {
        try {
          if (client.readyState === 1) client.send(msg);
        } catch { /* client gone */ }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      activePTYs.delete(tmuxTarget);
      const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
      for (const client of entry.clients) {
        try {
          client.send(exitMsg);
          client.close();
        } catch { /* ignore */ }
      }
    });

    activePTYs.set(tmuxTarget, entry);
  }

  // Clear grace timer if set (a new client connected before grace period expired)
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }

  entry.clients.add(socket);

  // Replay scrollback so the new client sees current terminal state
  if (entry.scrollback.length > 0) {
    try {
      socket.send(JSON.stringify({ type: 'output', data: entry.scrollback }));
    } catch { /* ignore */ }
  }

  return entry.ptyProcess;
}

/**
 * Detach a WebSocket client from a tmux session's PTY.
 * If no clients remain, starts a grace period before killing the PTY bridge.
 * (The tmux session itself always stays alive — we only kill the node-pty bridge.)
 */
export function detach(tmuxTarget, socket) {
  const entry = activePTYs.get(tmuxTarget);
  if (!entry) return;

  entry.clients.delete(socket);

  if (entry.clients.size === 0) {
    entry.graceTimer = setTimeout(() => {
      try { entry.ptyProcess.kill(); } catch { /* already dead */ }
      activePTYs.delete(tmuxTarget);
    }, config.ptyGracePeriodMs);
  }
}

/**
 * Resize a tmux session's PTY.
 */
export function resize(tmuxTarget, cols, rows) {
  const entry = activePTYs.get(tmuxTarget);
  if (entry) {
    entry.ptyProcess.resize(cols, rows);
  }
}

/**
 * List tmux sessions with their pane working directories.
 * Returns array of { name, cwd }.
 */
export function listTmuxSessions() {
  try {
    const output = execSync(
      `tmux list-sessions -F '#{session_name}|#{pane_current_path}' 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [name, cwd] = line.split('|');
      return { name, cwd };
    });
  } catch {
    return [];
  }
}

/**
 * Create a new tmux session and start Claude Code in it.
 * Returns the tmux session name.
 *
 * NOTE: initialPrompt is best-effort — it fires after a 5s delay to give
 * the Claude Code TUI time to initialize. It may fail silently if the TUI
 * isn't ready. The session is still created and usable either way.
 */
export function createTmuxSession({ label, cwd, initialPrompt }) {
  const existing = listTmuxSessions().map(s => s.name);
  let n = 0;
  while (existing.includes(`${config.tmuxSessionPrefix}${n}`)) n++;
  const sessionName = `${config.tmuxSessionPrefix}${n}`;

  // Validate session name (should always pass since we generate it, but belt-and-suspenders)
  sanitizeTmuxTarget(sessionName);

  // Build tmux new-session command with safe cwd handling
  const args = ['new-session', '-d', '-s', sessionName];
  if (cwd) {
    args.push('-c', cwd);
  }
  execSync(['tmux', ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '));

  // Start Claude Code in the session
  execSync(`tmux send-keys -t ${sessionName} "claude" Enter`);

  // If there's an initial prompt, wait for Claude Code TUI to initialize then send it.
  // Uses tmux send-keys -l (literal) to avoid shell metacharacter interpretation.
  if (initialPrompt) {
    setTimeout(() => {
      try {
        // -l flag sends keys literally (no special key interpretation)
        execSync(`tmux send-keys -t ${sessionName} -l ${JSON.stringify(initialPrompt)}`);
        execSync(`tmux send-keys -t ${sessionName} Enter`);
      } catch (err) {
        console.error(`[pty-manager] Failed to send initial prompt to ${sessionName}: ${err.message}`);
      }
    }, 5000);
  }

  return sessionName;
}

/**
 * Kill all active PTY bridges. Called during graceful shutdown.
 * Does NOT kill the underlying tmux sessions — only the node-pty bridges.
 */
export function shutdown() {
  for (const [target, entry] of activePTYs) {
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    try { entry.ptyProcess.kill(); } catch { /* already dead */ }
    for (const client of entry.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
  }
  activePTYs.clear();
}
```

---

## 10. File: `notifier.js`

```javascript
import config from './config.js';

/**
 * Send a notification via OpenClaw's /v1/responses endpoint.
 * Only fires for Stop and PermissionRequest events.
 * Fails silently if OpenClaw is not configured or unreachable.
 */
export async function send(payload) {
  if (!config.openclawToken) return;

  const { event, session_id, tool_name, cwd } = payload;

  let message;
  if (event === 'PermissionRequest') {
    const cmd = payload.tool_input?.command
      ? `: \`${String(payload.tool_input.command).slice(0, 80)}\``
      : '';
    message = `⏳ Claude Code session \`${session_id.slice(0, 8)}\` needs permission for ${tool_name || 'unknown tool'}${cmd}`;
  } else if (event === 'Stop') {
    const dir = cwd ? ` in ${cwd}` : '';
    message = `✅ Claude Code session \`${session_id.slice(0, 8)}\` finished${dir}`;
  } else {
    return;
  }

  try {
    const response = await fetch(config.openclawUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openclawToken}`,
        'x-openclaw-agent-id': config.openclawAgent,
      },
      body: JSON.stringify({
        model: 'openclaw',
        input: `[Control Center] ${message}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`OpenClaw notification failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`OpenClaw notification error: ${err.message}`);
  }
}
```

---

## 11. File: `server.js`

This file exports `buildServer()` so tests can create an app instance via `fastify.inject()` without starting a real listener. When run directly (`node server.js`), it auto-starts.

```javascript
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import config from './config.js';
import * as db from './db.js';
import * as ptyManager from './pty-manager.js';
import * as notifier from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// Build server (exported for tests)
// ──────────────────────────────────────────────

export async function buildServer(opts = {}) {
  const fastify = Fastify({ logger: opts.logger ?? true });

  // ──────────────────────────────────────────────
  // Plugins (registration order matters)
  // ──────────────────────────────────────────────

  await fastify.register(fastifyWebSocket);

  await fastify.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  // ──────────────────────────────────────────────
  // WebSocket: Dashboard event stream
  // ──────────────────────────────────────────────

  const dashboardClients = new Set();

  fastify.get('/ws/events', { websocket: true }, (socket, request) => {
    dashboardClients.add(socket);

    // Send full current state on connect
    const sessions = db.getAllSessions();
    const recentEvents = db.getRecentEvents(50);
    socket.send(JSON.stringify({ type: 'init', sessions, recentEvents }));

    socket.on('close', () => dashboardClients.delete(socket));
    socket.on('error', () => dashboardClients.delete(socket));
  });

  function broadcastEvent(payload) {
    const msg = JSON.stringify({ type: 'event', ...payload });
    for (const client of dashboardClients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch { /* client gone */ }
    }
  }

  function broadcastSessionUpdate(session) {
    const msg = JSON.stringify({ type: 'session_update', session });
    for (const client of dashboardClients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch { /* client gone */ }
    }
  }

  // ──────────────────────────────────────────────
  // WebSocket: Terminal relay (per session)
  // ──────────────────────────────────────────────

  fastify.get('/ws/terminal/:sessionId', { websocket: true }, (socket, request) => {
    const { sessionId } = request.params;
    const session = db.getSession(sessionId);

    if (!session?.tmux_target) {
      socket.send(JSON.stringify({ type: 'error', message: 'No tmux target linked to this session. Use the dashboard to link a tmux session.' }));
      socket.close();
      return;
    }

    const ptyProcess = ptyManager.attach(session.tmux_target, socket);

    if (!ptyProcess) {
      socket.send(JSON.stringify({ type: 'error', message: `tmux session "${session.tmux_target}" does not exist.` }));
      socket.close();
      return;
    }

    socket.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.type === 'input') {
          ptyProcess.write(msg.data);
        } else if (msg.type === 'resize') {
          ptyManager.resize(session.tmux_target, msg.cols, msg.rows);
        }
      } catch { /* malformed message */ }
    });

    socket.on('close', () => ptyManager.detach(session.tmux_target, socket));
    socket.on('error', () => ptyManager.detach(session.tmux_target, socket));
  });

  // ──────────────────────────────────────────────
  // REST: Hook ingest (called by Claude Code hook scripts)
  // ──────────────────────────────────────────────

  fastify.post('/api/hooks', async (request, reply) => {
    const payload = request.body;
    if (!payload || !payload.event || !payload.session_id) {
      return reply.status(400).send({ error: 'Missing event or session_id' });
    }

    const { event, session_id } = payload;

    // 1. Upsert session on SessionStart
    if (event === 'SessionStart') {
      db.upsertSession({
        session_id,
        cwd: payload.cwd,
        model: payload.model,
        transcript: payload.transcript_path,
      });
      // Auto-link tmux target by matching cwd
      const tmuxSessions = ptyManager.listTmuxSessions();
      const match = tmuxSessions.find(ts => ts.cwd === payload.cwd);
      if (match) {
        db.updateSession(session_id, { tmux_target: match.name });
      }
    }

    // 2. Update session status
    if (event === 'Stop') {
      db.updateStatus(session_id, 'stopped');
    } else if (event === 'PermissionRequest') {
      db.updateStatus(session_id, 'waiting_permission');
    }

    // 3. Handle heartbeats (lightweight — skip event log)
    if (event === 'Heartbeat') {
      db.upsertHeartbeat({ session_id, tool_name: payload.tool_name });
      // Ensure session exists even if we missed SessionStart
      db.upsertSession({ session_id, cwd: null, model: null, transcript: null });
      broadcastEvent({ event, session_id, tool_name: payload.tool_name, timestamp: payload.timestamp });
      return reply.status(204).send();
    }

    // 4. Log full event
    db.insertEvent({
      session_id,
      event,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      raw: JSON.stringify(payload),
    });

    // 5. Broadcast to dashboard
    const session = db.getSession(session_id);
    broadcastEvent({
      event, session_id,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      cwd: payload.cwd,
      timestamp: payload.timestamp,
      label: session?.label,
    });
    if (session) broadcastSessionUpdate(session);

    // 6. Notify via OpenClaw for high-priority events
    if (event === 'Stop' || event === 'PermissionRequest') {
      notifier.send(payload).catch(() => {});
    }

    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────
  // REST: Sessions CRUD
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions', async () => db.getAllSessions());

  fastify.get('/api/sessions/:id', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return session;
  });

  fastify.patch('/api/sessions/:id', async (request, reply) => {
    const { label, tmux_target } = request.body || {};
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    db.updateSession(request.params.id, { label, tmux_target });
    const updated = db.getSession(request.params.id);
    broadcastSessionUpdate(updated);
    return updated;
  });

  // ──────────────────────────────────────────────
  // REST: Launch new session
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/launch', async (request, reply) => {
    const { label, cwd, initialPrompt } = request.body || {};
    try {
      const tmuxTarget = ptyManager.createTmuxSession({
        label,
        cwd: cwd || process.env.HOME,
        initialPrompt,
      });
      return { success: true, tmux_target: tmuxTarget, label };
    } catch (err) {
      return reply.status(500).send({ error: `Failed to create session: ${err.message}` });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Send input to a session's tmux pane
  // SECURITY: Uses tmux load-buffer + paste-buffer to avoid shell injection.
  // The text never touches a shell interpreter.
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/:id/input', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session?.tmux_target) return reply.status(400).send({ error: 'No tmux target linked' });
    const { text } = request.body || {};
    if (!text) return reply.status(400).send({ error: 'Missing text' });

    try {
      const target = session.tmux_target;
      // Validate tmux target to prevent injection
      if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
        return reply.status(400).send({ error: 'Invalid tmux target' });
      }
      // Use load-buffer from stdin + paste-buffer to avoid any shell escaping issues
      execSync(`tmux load-buffer -`, { input: text + '\n' });
      execSync(`tmux paste-buffer -t ${target}`);
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Events
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/events', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    return db.getSessionEvents(request.params.id, limit, offset);
  });

  fastify.get('/api/events', async (request) => {
    const limit = parseInt(request.query.limit || '100', 10);
    return db.getRecentEvents(limit);
  });

  // ──────────────────────────────────────────────
  // REST: tmux discovery
  // ──────────────────────────────────────────────

  fastify.get('/api/tmux-sessions', async () => ptyManager.listTmuxSessions());

  return fastify;
}

// ──────────────────────────────────────────────
// Start server when run directly (not imported by tests)
// ──────────────────────────────────────────────

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = await buildServer();

  // Graceful shutdown: kill PTY bridges, close DB
  const closeGracefully = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down...`);
    ptyManager.shutdown();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => closeGracefully('SIGINT'));
  process.on('SIGTERM', () => closeGracefully('SIGTERM'));

  await server.listen({ port: config.port, host: config.host });
  console.log(`Control Center running at http://localhost:${config.port}`);
}
```

---

## 12. File: `hooks/cc-report.sh`

```bash
#!/usr/bin/env bash
# Claude Code hook — reports lifecycle events to the control center.
# Used for: SessionStart, Stop, PermissionRequest, Notification
set -euo pipefail

INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: .hook_event_name,
  session_id: .session_id,
  cwd: .cwd,
  transcript_path: .transcript_path,
  tool_name: (.tool_name // null),
  tool_input: (.tool_input // null),
  permission_suggestions: (.permission_suggestions // null),
  source: (.source // null),
  model: (.model // null),
  stop_hook_active: (.stop_hook_active // false),
  timestamp: (now | todate)
}' 2>/dev/null) || { echo "cc-report: jq parse failed" >&2; exit 0; }

curl -sS --max-time 5 \
  -X POST http://127.0.0.1:7700/api/hooks \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
```

---

## 13. File: `hooks/cc-heartbeat.sh`

```bash
#!/usr/bin/env bash
# Claude Code hook — lightweight heartbeat on PostToolUse.
set -euo pipefail

INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: "Heartbeat",
  session_id: .session_id,
  tool_name: (.tool_name // null),
  timestamp: (now | todate)
}' 2>/dev/null) || { echo "cc-heartbeat: jq parse failed" >&2; exit 0; }

curl -sS --max-time 2 \
  -X POST http://127.0.0.1:7700/api/hooks \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
```

---

## 14. Claude Code Hook Configuration

**This is handled automatically by `install.sh`** (Section 23). The install script copies hook scripts, substitutes absolute paths, and merges the config into `~/.claude/settings.json`.

For reference, here is the hook JSON that `install.sh` generates and merges. The `HOOK_PATH` placeholder is replaced with the actual absolute path (e.g., `/home/username/.claude/hooks/cc-report.sh`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "HOOK_PATH/cc-report.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "HOOK_PATH/cc-report.sh" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "HOOK_PATH/cc-report.sh" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "HOOK_PATH/cc-report.sh" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "HOOK_PATH/cc-heartbeat.sh", "timeout": 5 }]
      }
    ]
  }
}
```

---

## 15. File: `public/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Center</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header id="header">
    <h1>⌘ Control Center</h1>
    <div id="header-actions">
      <span id="connection-status" class="status-dot disconnected" title="WebSocket disconnected"></span>
      <button id="btn-new-session" title="Launch new Claude Code session">+ New Session</button>
    </div>
  </header>

  <section id="sessions-panel">
    <div id="sessions-grid"></div>
  </section>

  <section id="terminal-panel" class="hidden">
    <div id="terminal-header">
      <span id="terminal-title">No session selected</span>
      <button id="btn-close-terminal" title="Close terminal">✕</button>
    </div>
    <div id="terminal-container"></div>
  </section>

  <section id="events-panel">
    <h2>Activity Log</h2>
    <div id="events-list"></div>
  </section>

  <dialog id="new-session-modal">
    <h2>New Session</h2>
    <div id="new-session-form">
      <label>Label<input type="text" id="ns-label" placeholder="e.g. frontend-fix" required></label>
      <label>Working Directory<input type="text" id="ns-cwd" placeholder="/home/user/project"></label>
      <label>Initial Prompt (optional)<textarea id="ns-prompt" rows="3" placeholder="Fix the failing tests in src/auth/"></textarea></label>
      <div class="modal-actions">
        <button type="button" id="btn-cancel-modal">Cancel</button>
        <button type="button" id="btn-launch" class="primary">Launch</button>
      </div>
    </div>
  </dialog>

  <dialog id="link-tmux-modal">
    <h2>Link tmux Session</h2>
    <p>Select a tmux session to connect to this Claude Code session:</p>
    <div id="tmux-session-list"></div>
    <div class="modal-actions">
      <button type="button" id="btn-cancel-link">Cancel</button>
    </div>
  </dialog>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  <script src="/app.js"></script>
</body>
</html>
```

---

## 16. File: `public/style.css`

```css
:root {
  --bg-base: #1e1e2e;
  --bg-surface: #181825;
  --bg-overlay: #313244;
  --bg-card: #232336;
  --text-primary: #cdd6f4;
  --text-secondary: #a6adc8;
  --text-muted: #6c7086;
  --border: #45475a;
  --accent: #89b4fa;
  --green: #a6e3a1;
  --yellow: #f9e2af;
  --orange: #fab387;
  --red: #f38ba8;
  --radius: 8px;
  --font-mono: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-sans);
  background: var(--bg-base);
  color: var(--text-primary);
  line-height: 1.5;
  min-height: 100vh;
}

#header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}
#header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
#header-actions { display: flex; align-items: center; gap: 12px; }

button {
  font-family: var(--font-sans);
  font-size: 13px;
  padding: 6px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-overlay);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s;
}
button:hover { background: var(--border); }
button.primary { background: var(--accent); color: var(--bg-base); border-color: var(--accent); font-weight: 600; }
button.primary:hover { opacity: 0.9; }

.status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.status-dot.connected { background: var(--green); }
.status-dot.disconnected { background: var(--red); }

#sessions-panel { padding: 16px 20px; }
#sessions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.session-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.session-card:hover { border-color: var(--accent); }
.session-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

.session-card .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.session-card .card-header .indicator { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.indicator.active { background: var(--green); }
.indicator.idle { background: var(--yellow); }
.indicator.waiting { background: var(--orange); animation: pulse 1.5s infinite; }
.indicator.stopped { background: var(--text-muted); }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.session-card .card-label { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.session-card .card-status { font-size: 12px; color: var(--text-secondary); }
.session-card .card-detail { font-size: 12px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-card .card-actions { margin-top: 8px; display: flex; gap: 6px; }
.session-card .card-actions button { font-size: 11px; padding: 3px 8px; }

.no-sessions { color: var(--text-muted); font-size: 14px; text-align: center; padding: 40px 20px; }

#terminal-panel {
  margin: 0 20px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-surface);
}
#terminal-panel.hidden { display: none; }
#terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-overlay);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-family: var(--font-mono);
}
#terminal-container { height: 400px; padding: 4px; }

#events-panel { padding: 0 20px 20px; }
#events-panel h2 { font-size: 14px; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
#events-list { max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-surface); }

.event-row {
  display: grid;
  grid-template-columns: 70px 100px 120px 1fr;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: var(--font-mono);
  border-bottom: 1px solid var(--border);
  align-items: center;
}
.event-row:last-child { border-bottom: none; }
.event-row .ev-time { color: var(--text-muted); }
.event-row .ev-label { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-row .ev-event { font-weight: 600; }
.event-row .ev-detail { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-row .ev-event.SessionStart { color: var(--green); }
.event-row .ev-event.Stop { color: var(--text-muted); }
.event-row .ev-event.PermissionRequest { color: var(--orange); }
.event-row .ev-event.Notification { color: var(--accent); }
.event-row.permission-request { background: rgba(250, 179, 135, 0.08); }

.empty-events { padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px; }

dialog {
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  max-width: 440px;
  width: 90vw;
}
dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
dialog h2 { margin-bottom: 16px; font-size: 16px; }
dialog p { font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; }
dialog label { display: block; margin-bottom: 12px; font-size: 13px; color: var(--text-secondary); }
dialog input, dialog textarea {
  display: block; width: 100%; margin-top: 4px; padding: 8px 10px;
  font-size: 13px; font-family: var(--font-mono);
  background: var(--bg-surface); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 4px;
}
dialog input:focus, dialog textarea:focus { outline: none; border-color: var(--accent); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

.tmux-option {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 8px;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 13px;
}
.tmux-option:hover { border-color: var(--accent); background: var(--bg-overlay); }
.tmux-option .tmux-name { font-weight: 600; }
.tmux-option .tmux-cwd { color: var(--text-muted); font-size: 12px; }

/* FIXED: mobile grid reduced to 2 columns (time + event) for readability */
@media (max-width: 640px) {
  #sessions-grid { grid-template-columns: 1fr; }
  #terminal-container { height: 280px; }
  .event-row { grid-template-columns: 60px 1fr; }
  .event-row .ev-label { display: none; }
  .event-row .ev-detail { display: none; }
  #terminal-panel { margin: 0 8px 12px; }
  #sessions-panel, #events-panel { padding-left: 8px; padding-right: 8px; }
  #header { padding: 10px 12px; }
}
```

---

## 17. File: `public/app.js`

```javascript
// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

let sessions = [];
let recentEvents = [];
let selectedSessionId = null;
let ws = null;
let termWs = null;
let term = null;
let fitAddon = null;

// ──────────────────────────────────────────────
// DOM references
// ──────────────────────────────────────────────

const sessionsGrid = document.getElementById('sessions-grid');
const eventsList = document.getElementById('events-list');
const terminalPanel = document.getElementById('terminal-panel');
const terminalTitle = document.getElementById('terminal-title');
const terminalContainer = document.getElementById('terminal-container');
const connectionStatus = document.getElementById('connection-status');
const newSessionModal = document.getElementById('new-session-modal');
const linkTmuxModal = document.getElementById('link-tmux-modal');
const tmuxSessionList = document.getElementById('tmux-session-list');

// ──────────────────────────────────────────────
// WebSocket — dashboard event stream
// ──────────────────────────────────────────────

function connectDashboardWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/events`);

  ws.onopen = () => {
    connectionStatus.className = 'status-dot connected';
    connectionStatus.title = 'Connected';
  };

  ws.onclose = () => {
    connectionStatus.className = 'status-dot disconnected';
    connectionStatus.title = 'Disconnected — reconnecting...';
    setTimeout(connectDashboardWS, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'init') {
      sessions = msg.sessions || [];
      recentEvents = msg.recentEvents || [];
      renderSessions();
      renderEvents();
      return;
    }

    if (msg.type === 'session_update') {
      const idx = sessions.findIndex(s => s.session_id === msg.session.session_id);
      if (idx >= 0) sessions[idx] = msg.session;
      else sessions.unshift(msg.session);
      renderSessions();
      return;
    }

    if (msg.type === 'event') {
      if (msg.event === 'Heartbeat') {
        const s = sessions.find(s => s.session_id === msg.session_id);
        if (s) {
          s.last_tool = msg.tool_name;
          s.last_heartbeat = msg.timestamp || new Date().toISOString();
          s.status = 'active';
          renderSessions();
        }
        return;
      }

      recentEvents.unshift(msg);
      if (recentEvents.length > 200) recentEvents.length = 200;
      renderEvents();

      const s = sessions.find(s => s.session_id === msg.session_id);
      if (s) {
        if (msg.event === 'Stop') s.status = 'stopped';
        else if (msg.event === 'PermissionRequest') s.status = 'waiting_permission';
        else if (msg.event === 'SessionStart') s.status = 'active';
        renderSessions();
      }
    }
  };
}

// ──────────────────────────────────────────────
// Render: Session cards
// ──────────────────────────────────────────────

function renderSessions() {
  if (sessions.length === 0) {
    sessionsGrid.innerHTML = '<div class="no-sessions">No sessions yet. Start Claude Code in a tmux pane, or click "+ New Session".</div>';
    return;
  }

  sessionsGrid.innerHTML = sessions.map(s => {
    const label = s.label || s.session_id.slice(0, 12);
    const statusClass = getStatusClass(s);
    const statusText = getStatusText(s);
    const detail = getDetailText(s);
    const isSelected = s.session_id === selectedSessionId;

    return `
      <div class="session-card ${isSelected ? 'selected' : ''}" data-id="${s.session_id}">
        <div class="card-header">
          <span class="indicator ${statusClass}"></span>
          <span class="card-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        </div>
        <div class="card-status">${statusText}</div>
        ${detail ? `<div class="card-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
        <div class="card-actions">
          ${s.tmux_target
            ? `<button class="btn-connect" data-id="${s.session_id}">Terminal</button>`
            : `<button class="btn-link-tmux" data-id="${s.session_id}">Link tmux</button>`}
          <button class="btn-edit-label" data-id="${s.session_id}">Rename</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers
  sessionsGrid.querySelectorAll('.btn-connect').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openTerminal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-link-tmux').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); showLinkTmuxModal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-edit-label').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = btn.dataset.id;
      const current = sessions.find(s => s.session_id === sid)?.label || '';
      const newLabel = prompt('Session label:', current);
      if (newLabel !== null) {
        fetch(`/api/sessions/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
        });
      }
    });
  });

  sessionsGrid.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => {
      const s = sessions.find(s => s.session_id === card.dataset.id);
      if (s?.tmux_target) openTerminal(card.dataset.id);
    });
  });
}

function getStatusClass(session) {
  if (session.status === 'waiting_permission') return 'waiting';
  if (session.status === 'stopped') return 'stopped';
  if (session.status === 'active') {
    if (session.last_heartbeat) {
      // SQLite datetime('now') produces UTC without T/Z. Normalize for Date parsing.
      const ts = session.last_heartbeat.includes('T') ? session.last_heartbeat : session.last_heartbeat + 'Z';
      const age = (Date.now() - new Date(ts).getTime()) / 1000;
      if (age > 120) return 'idle';
    }
    return 'active';
  }
  return 'stopped';
}

function getStatusText(session) {
  const cls = getStatusClass(session);
  if (cls === 'waiting') return 'Waiting for permission';
  if (cls === 'active') return `Active${session.last_heartbeat ? ' · ' + timeAgo(session.last_heartbeat) : ''}`;
  if (cls === 'idle') return `Idle · ${timeAgo(session.last_heartbeat)}`;
  return `Stopped${session.updated_at ? ' · ' + timeAgo(session.updated_at) : ''}`;
}

function getDetailText(session) {
  if (session.last_tool) return session.last_tool;
  if (session.cwd) return session.cwd;
  return '';
}

// ──────────────────────────────────────────────
// Render: Event log
// ──────────────────────────────────────────────

function renderEvents() {
  if (recentEvents.length === 0) {
    eventsList.innerHTML = '<div class="empty-events">No events yet.</div>';
    return;
  }

  eventsList.innerHTML = recentEvents.slice(0, 100).map(ev => {
    const time = ev.created_at || ev.timestamp || '';
    const timeStr = time ? formatTime(time) : '--:--';
    const label = ev.label || ev.session_cwd || ev.session_id?.slice(0, 8) || '?';
    const detail = getEventDetail(ev);
    const isPermission = ev.event === 'PermissionRequest';

    return `
      <div class="event-row ${isPermission ? 'permission-request' : ''}">
        <span class="ev-time">${timeStr}</span>
        <span class="ev-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <span class="ev-event ${ev.event}">${ev.event}</span>
        <span class="ev-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </div>
    `;
  }).join('');
}

function getEventDetail(ev) {
  if (ev.tool_name && ev.tool_input) {
    try {
      const input = typeof ev.tool_input === 'string' ? JSON.parse(ev.tool_input) : ev.tool_input;
      if (input.command) return `${ev.tool_name}: ${input.command.slice(0, 60)}`;
      if (input.file_path) return `${ev.tool_name}: ${input.file_path}`;
    } catch { /* ignore parse errors */ }
    return ev.tool_name;
  }
  if (ev.tool_name) return ev.tool_name;
  if (ev.cwd) return ev.cwd;
  return '';
}

// ──────────────────────────────────────────────
// Terminal connection
// ──────────────────────────────────────────────

function openTerminal(sessionId) {
  selectedSessionId = sessionId;
  renderSessions();
  closeTerminal(true); // Close existing but keep selectedSessionId

  const session = sessions.find(s => s.session_id === sessionId);
  terminalTitle.textContent = session?.label || sessionId.slice(0, 12);
  terminalPanel.classList.remove('hidden');

  // Create xterm.js instance
  // The CDN exposes Terminal as a global from @xterm/xterm
  term = new Terminal({
    fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace',
    fontSize: 14,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
    },
    cursorBlink: true,
    scrollback: 5000,
  });

  // The CDN exposes FitAddon as a global namespace with a FitAddon class inside
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch { /* addon may not have loaded */ }

  term.open(terminalContainer);

  // Small delay to ensure the container has dimensions before fitting
  requestAnimationFrame(() => {
    if (fitAddon) fitAddon.fit();
  });

  // Connect WebSocket to terminal relay
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);

  termWs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') {
      term.write(msg.data);
    } else if (msg.type === 'exit') {
      term.write('\r\n\x1b[31m[tmux session exited]\x1b[0m\r\n');
    } else if (msg.type === 'error') {
      term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    }
  };

  termWs.onclose = () => {
    if (term) term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
  };

  term.onData((data) => {
    if (termWs?.readyState === 1) {
      termWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (termWs?.readyState === 1) {
      termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  window.addEventListener('resize', handleWindowResize);
}

function closeTerminal(keepSelection) {
  window.removeEventListener('resize', handleWindowResize);
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  if (term) { term.dispose(); term = null; }
  fitAddon = null;
  terminalPanel.classList.add('hidden');
  if (!keepSelection) {
    selectedSessionId = null;
    renderSessions();
  }
}

function handleWindowResize() {
  if (fitAddon && term) {
    try { fitAddon.fit(); } catch {}
  }
}

// ──────────────────────────────────────────────
// New Session modal
// ──────────────────────────────────────────────

document.getElementById('btn-new-session').addEventListener('click', () => {
  newSessionModal.showModal();
});

document.getElementById('btn-cancel-modal').addEventListener('click', () => {
  newSessionModal.close();
});

// FIXED: Use button click handler instead of form submit to avoid dialog auto-close on validation failure
document.getElementById('btn-launch').addEventListener('click', async () => {
  const label = document.getElementById('ns-label').value.trim();
  const cwd = document.getElementById('ns-cwd').value.trim();
  const initialPrompt = document.getElementById('ns-prompt').value.trim();

  if (!label) {
    document.getElementById('ns-label').focus();
    return;
  }

  try {
    const res = await fetch('/api/sessions/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: label || undefined,
        cwd: cwd || undefined,
        initialPrompt: initialPrompt || undefined,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    newSessionModal.close();
    // Reset fields
    document.getElementById('ns-label').value = '';
    document.getElementById('ns-cwd').value = '';
    document.getElementById('ns-prompt').value = '';
  } catch (err) {
    alert(`Failed to launch: ${err.message}`);
  }
});

// ──────────────────────────────────────────────
// Link tmux modal
// ──────────────────────────────────────────────

let linkTargetSessionId = null;

async function showLinkTmuxModal(sessionId) {
  linkTargetSessionId = sessionId;
  const res = await fetch('/api/tmux-sessions');
  const tmuxSessions = await res.json();

  if (tmuxSessions.length === 0) {
    tmuxSessionList.innerHTML = '<div style="color: var(--text-muted); padding: 12px;">No tmux sessions found. Create one with: tmux new-session -d -s cc-0</div>';
  } else {
    tmuxSessionList.innerHTML = tmuxSessions.map(ts => `
      <div class="tmux-option" data-name="${escapeHtml(ts.name)}">
        <div class="tmux-name">${escapeHtml(ts.name)}</div>
        <div class="tmux-cwd">${escapeHtml(ts.cwd || 'unknown')}</div>
      </div>
    `).join('');

    tmuxSessionList.querySelectorAll('.tmux-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        await fetch(`/api/sessions/${linkTargetSessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmux_target: opt.dataset.name }),
        });
        linkTmuxModal.close();
      });
    });
  }

  linkTmuxModal.showModal();
}

document.getElementById('btn-cancel-link').addEventListener('click', () => {
  linkTmuxModal.close();
});

// Close terminal button
document.getElementById('btn-close-terminal').addEventListener('click', () => closeTerminal(false));

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────
// Auto-refresh heartbeat ages every 15s
// ──────────────────────────────────────────────

setInterval(() => renderSessions(), 15_000);

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

connectDashboardWS();
```

---

## 18. File: `.gitignore`

```
node_modules/
data/
.env
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

---

## 19. File: `.env.example`

```bash
# Control Center Configuration
CC_PORT=7700
CC_HOST=0.0.0.0
CC_DB_PATH=./data/control-center.sqlite

# OpenClaw Push Notifications (optional — leave empty to disable)
# Requires gateway.http.endpoints.responses.enabled = true in OpenClaw config
OPENCLAW_URL=http://127.0.0.1:18789/v1/responses
OPENCLAW_TOKEN=
OPENCLAW_AGENT=main
```

---

## 20. File: `test/db.test.js`

Tests all database operations. Uses a temp SQLite file per test run — set `CC_DB_PATH` before importing `db.js`.

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set up temp database BEFORE importing db (ESM evaluates imports eagerly)
const tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
process.env.CC_DB_PATH = join(tmpDir, 'test.sqlite');

const db = await import('../db.js');

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('db: sessions', () => {
  it('upsertSession creates a new session', () => {
    db.upsertSession({ session_id: 's1', cwd: '/tmp', model: 'claude-sonnet-4-6', transcript: '/path/t.jsonl' });
    const s = db.getSession('s1');
    assert.equal(s.session_id, 's1');
    assert.equal(s.cwd, '/tmp');
    assert.equal(s.model, 'claude-sonnet-4-6');
    assert.equal(s.status, 'active');
  });

  it('upsertSession updates on conflict (does not overwrite with null)', () => {
    db.upsertSession({ session_id: 's1', cwd: null, model: null, transcript: null });
    const s = db.getSession('s1');
    assert.equal(s.cwd, '/tmp');         // preserved from first insert
    assert.equal(s.model, 'claude-sonnet-4-6'); // preserved
    assert.equal(s.status, 'active');    // reset to active
  });

  it('updateStatus changes session status', () => {
    db.updateStatus('s1', 'stopped');
    assert.equal(db.getSession('s1').status, 'stopped');
  });

  it('updateSession sets label and tmux_target', () => {
    db.updateSession('s1', { label: 'my-session', tmux_target: 'cc-0' });
    const s = db.getSession('s1');
    assert.equal(s.label, 'my-session');
    assert.equal(s.tmux_target, 'cc-0');
  });

  it('updateSession partial update preserves other fields', () => {
    db.updateSession('s1', { label: 'renamed' });
    const s = db.getSession('s1');
    assert.equal(s.label, 'renamed');
    assert.equal(s.tmux_target, 'cc-0'); // preserved
  });

  it('getAllSessions returns sessions with heartbeat join', () => {
    db.upsertSession({ session_id: 's2', cwd: '/home', model: 'opus', transcript: null });
    const all = db.getAllSessions();
    assert.ok(all.length >= 2);
    assert.ok(all.some(s => s.session_id === 's1'));
    assert.ok(all.some(s => s.session_id === 's2'));
  });

  // FIXED: better-sqlite3 .get() returns undefined (not null) for missing rows
  it('getSession returns undefined for missing session', () => {
    const s = db.getSession('nonexistent');
    assert.equal(s, undefined);
  });
});

describe('db: events', () => {
  it('insertEvent creates an event', () => {
    db.insertEvent({ session_id: 's1', event: 'SessionStart', tool_name: null, tool_input: null, raw: '{}' });
    db.insertEvent({ session_id: 's1', event: 'Stop', tool_name: 'Bash', tool_input: '{"command":"exit"}', raw: '{}' });
    const events = db.getSessionEvents('s1', 50, 0);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'Stop');     // most recent first
    assert.equal(events[1].event, 'SessionStart');
  });

  it('getSessionEvents paginates correctly', () => {
    const page1 = db.getSessionEvents('s1', 1, 0);
    const page2 = db.getSessionEvents('s1', 1, 1);
    assert.equal(page1.length, 1);
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('getRecentEvents returns events across sessions', () => {
    db.insertEvent({ session_id: 's2', event: 'SessionStart', tool_name: null, tool_input: null, raw: '{}' });
    const recent = db.getRecentEvents(100);
    assert.ok(recent.length >= 3);
    assert.ok(recent.some(e => e.session_id === 's1'));
    assert.ok(recent.some(e => e.session_id === 's2'));
  });
});

describe('db: heartbeats', () => {
  it('upsertHeartbeat creates a heartbeat', () => {
    db.upsertHeartbeat({ session_id: 's1', tool_name: 'Bash' });
    const s = db.getSession('s1');
    assert.equal(s.last_tool, 'Bash');
    assert.ok(s.last_heartbeat); // not null
  });

  it('upsertHeartbeat updates on conflict', () => {
    db.upsertHeartbeat({ session_id: 's1', tool_name: 'Write' });
    const s = db.getSession('s1');
    assert.equal(s.last_tool, 'Write'); // updated
  });
});
```

---

## 21. File: `test/api.test.js`

Tests HTTP routes via Fastify's `inject()` — no real server or port needed. Uses `buildServer()` from `server.js`.

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Temp database for test isolation
const tmpDir = mkdtempSync(join(tmpdir(), 'cc-api-test-'));
process.env.CC_DB_PATH = join(tmpDir, 'test.sqlite');
process.env.CC_PORT = '0';           // won't actually listen
process.env.OPENCLAW_TOKEN = '';      // disable notifications in tests

const { buildServer } = await import('../server.js');

let app;

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/hooks', () => {
  it('rejects missing event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: 'x' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing session_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Stop' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('SessionStart creates session and returns 204', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: 'test-1',
        cwd: '/tmp/proj',
        model: 'claude-sonnet-4-6',
        transcript_path: '/tmp/t.jsonl',
      },
    });
    assert.equal(res.statusCode, 204);
  });

  it('Stop updates session status to stopped', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Stop', session_id: 'test-1', cwd: '/tmp/proj' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.json().status, 'stopped');
  });

  it('PermissionRequest updates session status to waiting_permission', async () => {
    // Re-activate first
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'SessionStart', session_id: 'test-1', cwd: '/tmp/proj' },
    });

    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'PermissionRequest',
        session_id: 'test-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.json().status, 'waiting_permission');
  });

  it('Heartbeat returns 204 and does not create an event record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Heartbeat', session_id: 'test-1', tool_name: 'Bash' },
    });
    assert.equal(res.statusCode, 204);

    // Heartbeats should NOT appear in events
    const eventsRes = await app.inject({ method: 'GET', url: '/api/sessions/test-1/events' });
    const events = eventsRes.json();
    assert.ok(!events.some(e => e.event === 'Heartbeat'));
  });
});

describe('GET /api/sessions', () => {
  it('returns an array of sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    const sessions = res.json();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 1);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns 404 for missing session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('returns session details', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().session_id, 'test-1');
    assert.equal(res.json().cwd, '/tmp/proj');
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('updates label', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/test-1',
      payload: { label: 'my-task' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().label, 'my-task');
  });

  it('updates tmux_target', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/test-1',
      payload: { tmux_target: 'cc-5' },
    });
    assert.equal(res.json().tmux_target, 'cc-5');
  });

  it('returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/nonexistent',
      payload: { label: 'x' },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/events', () => {
  it('returns recent events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('respects limit parameter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=1' });
    assert.ok(res.json().length <= 1);
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('returns events for a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1/events' });
    assert.equal(res.statusCode, 200);
    const events = res.json();
    assert.ok(Array.isArray(events));
    assert.ok(events.every(e => e.session_id === 'test-1'));
  });
});

describe('GET /api/tmux-sessions', () => {
  it('returns an array (may be empty in test env)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmux-sessions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });
});
```

---

## 22. File: `test/notifier.test.js`

Tests notification logic by mocking `global.fetch`.

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set env BEFORE importing notifier
process.env.OPENCLAW_TOKEN = 'test-token';
process.env.OPENCLAW_URL = 'http://localhost:99999/v1/responses';

const notifier = await import('../notifier.js');

// Track fetch calls
let fetchCalls = [];
const originalFetch = global.fetch;

beforeEach(() => {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200 };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('notifier.send', () => {
  it('sends notification for Stop events', async () => {
    await notifier.send({
      event: 'Stop',
      session_id: 'abc12345',
      cwd: '/home/user/project',
    });
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.ok(body.input.includes('finished'));
    assert.ok(body.input.includes('abc12345'));
  });

  it('sends notification for PermissionRequest events', async () => {
    await notifier.send({
      event: 'PermissionRequest',
      session_id: 'def67890',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist/' },
    });
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.ok(body.input.includes('permission'));
    assert.ok(body.input.includes('Bash'));
  });

  it('does NOT send for SessionStart events', async () => {
    await notifier.send({ event: 'SessionStart', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('does NOT send for Heartbeat events', async () => {
    await notifier.send({ event: 'Heartbeat', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('does NOT send for Notification events', async () => {
    await notifier.send({ event: 'Notification', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('includes correct headers', async () => {
    await notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' });
    const headers = fetchCalls[0].opts.headers;
    assert.equal(headers['Authorization'], 'Bearer test-token');
    assert.equal(headers['x-openclaw-agent-id'], 'main');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    // Should not throw
    await notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' });
  });
});

// NOTE: Testing "no token" behavior in isolation is not possible because ESM
// caches the notifier module (and its config import) from the first import.
// The early-return path (config.openclawToken === '') is implicitly covered by
// the SessionStart/Heartbeat/Notification tests above — those events never
// reach fetch() regardless of token state. For a true no-token integration test,
// run the server with OPENCLAW_TOKEN unset and verify no outbound requests.
```

---

## 23. File: `install.sh`

This script runs **on the lab PC** after cloning the repo. It handles everything that can't be done in the cloud: native module compilation, hook installation, Claude Code settings merge, and optional systemd service setup.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DIR="$HOME/.claude/hooks"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "╔══════════════════════════════════════════════╗"
echo "║  Control Center — Lab PC Setup               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ──────────────────────────────────────────────
# 1. Check prerequisites
# ──────────────────────────────────────────────

echo "▸ Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install Node.js 22+ and try again."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  ✗ Node.js $NODE_MAJOR found, but 22+ is required."
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

if ! command -v tmux &>/dev/null; then
  echo "  ✗ tmux not found. Install tmux and try again."
  exit 1
fi
echo "  ✓ tmux $(tmux -V)"

if ! command -v jq &>/dev/null; then
  echo "  ✗ jq not found. Install jq (needed by hook scripts)."
  exit 1
fi
echo "  ✓ jq $(jq --version)"

if ! command -v curl &>/dev/null; then
  echo "  ✗ curl not found. Install curl (needed by hook scripts)."
  exit 1
fi
echo "  ✓ curl"

# Check for C/C++ build tools (needed by node-pty and better-sqlite3)
if ! command -v make &>/dev/null || ! (command -v gcc &>/dev/null || command -v cc &>/dev/null); then
  echo "  ⚠ Build tools (make, gcc) not found. native modules may fail to compile."
  echo "    On Ubuntu/Debian: sudo apt install -y build-essential python3"
  echo "    On macOS: xcode-select --install"
  echo ""
  read -p "  Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
else
  echo "  ✓ Build tools (make, cc)"
fi

echo ""

# ──────────────────────────────────────────────
# 2. Install npm dependencies (native compilation happens here)
# ──────────────────────────────────────────────

echo "▸ Installing npm dependencies (this compiles native modules)..."
cd "$SCRIPT_DIR"
npm install
echo "  ✓ Dependencies installed"
echo ""

# ──────────────────────────────────────────────
# 3. Copy hook scripts
# ──────────────────────────────────────────────

echo "▸ Installing hook scripts to $HOOK_DIR..."
mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/hooks/cc-report.sh" "$HOOK_DIR/"
cp "$SCRIPT_DIR/hooks/cc-heartbeat.sh" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/cc-report.sh" "$HOOK_DIR/cc-heartbeat.sh"
echo "  ✓ cc-report.sh"
echo "  ✓ cc-heartbeat.sh"
echo ""

# ──────────────────────────────────────────────
# 4. Merge hook configuration into Claude Code settings
#    IDEMPOTENT: strips existing control-center hooks before adding.
# ──────────────────────────────────────────────

echo "▸ Configuring Claude Code hooks..."

# Generate the hooks JSON with absolute paths
HOOKS_JSON=$(cat <<ENDJSON
{
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "PermissionRequest": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "Notification": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "PostToolUse": [
    {
      "matcher": "Bash|Write|Edit|MultiEdit",
      "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-heartbeat.sh", "timeout": 5 }]
    }
  ]
}
ENDJSON
)

# Create settings.json if it doesn't exist
mkdir -p "$HOME/.claude"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# FIXED: Idempotent merge — first remove any existing hooks whose command
# contains cc-report.sh or cc-heartbeat.sh, then append the new ones.
MERGED=$(jq --arg hookdir "$HOOK_DIR" --argjson newhooks "$HOOKS_JSON" '
  # Strip existing control-center hooks from each event array
  .hooks = (
    ((.hooks // {}) | to_entries | map(
      .value = ([.value[] | select(
        (.hooks // []) | all(.command | test("cc-report\\.sh|cc-heartbeat\\.sh") | not)
      )] )
    ) | from_entries) as $cleaned |
    # Now append the new hooks
    $newhooks | to_entries | reduce .[] as $entry (
      $cleaned;
      .[$entry.key] = ((.[$entry.key] // []) + $entry.value)
    )
  )
' "$SETTINGS_FILE")

echo "$MERGED" > "$SETTINGS_FILE"
echo "  ✓ Hooks merged into $SETTINGS_FILE (idempotent — safe to re-run)"
echo ""

# ──────────────────────────────────────────────
# 5. Create .env if it doesn't exist
# ──────────────────────────────────────────────

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "▸ Created .env from .env.example"
  echo "  Edit .env to set OPENCLAW_TOKEN if you want push notifications."
  echo ""
fi

# ──────────────────────────────────────────────
# 6. Optional: systemd user service (Linux only)
# ──────────────────────────────────────────────

if [[ "$(uname)" == "Linux" ]] && command -v systemctl &>/dev/null; then
  echo "▸ Setting up systemd user service..."
  read -p "  Install as a systemd user service (auto-start on login)? [y/N] " -n 1 -r
  echo

  if [[ $REPLY =~ ^[Yy]$ ]]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/control-center.service" << EOF
[Unit]
Description=Claude Code Control Center
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
EnvironmentFile=$SCRIPT_DIR/.env
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable control-center
    systemctl --user start control-center
    echo "  ✓ Service installed, enabled, and started"
    echo "  Commands: systemctl --user {start|stop|restart|status} control-center"
  else
    echo "  Skipped. Run manually with: npm start"
  fi
elif [[ "$(uname)" == "Darwin" ]]; then
  echo "▸ macOS detected. To auto-start, create a launchd plist or run manually:"
  echo "  cd $SCRIPT_DIR && npm start"
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✓ Setup complete!                           ║"
echo "║                                              ║"
echo "║  Start:  cd $SCRIPT_DIR && npm start"
echo "║  Open:   http://localhost:7700               ║"
echo "╚══════════════════════════════════════════════╝"
```

---

## 24. File: `README.md`

```markdown
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
```

---

## 25. Implementation Order

### Part A: Build the repo (Cloud — Claude Code)

Create a new GitHub repo and implement every file from Sections 6–24 in this order:

1. **Foundation files** — `package.json`, `config.js`, `.gitignore`, `.env.example`
2. **Backend core** — `db.js`, `notifier.js`, `pty-manager.js`
3. **Server** — `server.js` (depends on all backend modules)
4. **Hook scripts** — `hooks/cc-report.sh`, `hooks/cc-heartbeat.sh`
5. **Frontend** — `public/index.html`, `public/style.css`, `public/app.js`
6. **Tests** — `test/db.test.js`, `test/api.test.js`, `test/notifier.test.js`
7. **Setup & docs** — `install.sh`, `README.md`
8. **Install and run tests:**
   ```bash
   npm install
   npm test
   ```
   All tests must pass. If `node-pty` fails to compile in the cloud environment, `test/api.test.js` may fail (it imports `server.js` which imports `pty-manager.js`). In that case, run the db and notifier tests individually to verify core logic:
   ```bash
   node --test test/db.test.js test/notifier.test.js
   ```
   The full suite including `api.test.js` **must** pass on the lab PC after `install.sh`.
9. **Commit and push** to GitHub

### Part B: Deploy to lab PC (manual — you do this)

```bash
# 1. Clone the repo
git clone <repo-url> ~/control-center
cd ~/control-center

# 2. Run the install script (handles everything)
chmod +x install.sh
./install.sh

# 3. If you skipped the systemd service in install.sh, start manually:
npm start

# 4. Open the dashboard
open http://localhost:7700
```

### Part C: Verify it works (on the lab PC)

**Test 1 — Hook ingest (simulated):**
```bash
curl -X POST http://127.0.0.1:7700/api/hooks \
  -H "Content-Type: application/json" \
  -d '{"event":"SessionStart","session_id":"test-abc","cwd":"/tmp/test","model":"claude-sonnet-4-6"}'

curl http://127.0.0.1:7700/api/sessions | jq
# Should show the test session
```

**Test 2 — Terminal relay:**
```bash
# Create a tmux session
tmux new-session -d -s cc-test

# Link it to the test session
curl -X PATCH http://127.0.0.1:7700/api/sessions/test-abc \
  -H 'Content-Type: application/json' \
  -d '{"tmux_target":"cc-test"}'

# Click "Terminal" in dashboard → should see the tmux session
```

**Test 3 — Real Claude Code hooks:**
Start Claude Code in any tmux pane → session should appear in the dashboard automatically via the SessionStart hook.

**Test 4 — Session launch:**
Click "+ New Session" in the dashboard → fill in form → verify tmux session is created and Claude Code starts.

**Test 5 — Push notifications (optional):**
Set `OPENCLAW_TOKEN` in `.env`, restart the server, trigger a Stop event → notification should arrive on your phone.

**Test 6 — Re-run install.sh (idempotency check):**
Run `./install.sh` again → verify `~/.claude/settings.json` does not contain duplicate hook entries.

---

## 26. Key Design Decisions (do not change)

- **Single hook script for lifecycle events** — one `cc-report.sh` handles all lifecycle hooks. Server inspects `event` field.
- **Separate heartbeat script** — PostToolUse fires frequently; `cc-heartbeat.sh` is minimal, 2s timeout.
- **`|| true` on curl** — hooks must never block Claude Code.
- **No auth on localhost** — same user, loopback only.
- **30s PTY grace period** — prevents killing bridge on brief disconnects.
- **Scrollback replay (50KB)** — new clients see terminal state immediately.
- **Notifications only on Stop + PermissionRequest** — only events needing attention.
- **Heartbeats in upsert-only table** — avoids bloating events table.
- **Auto-discovery via cwd match** — links tmux sessions to Claude Code sessions automatically.
- **xterm.js from CDN** — no bundler needed. Pinned versions: `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0`, `@xterm/addon-web-links@0.11.0`.
- **`--env-file=.env` for configuration** — uses Node 22 built-in, no dotenv dependency.
- **tmux target sanitization** — all user-provided tmux target names validated against `[a-zA-Z0-9_-]` to prevent shell injection.
- **Graceful shutdown** — SIGINT/SIGTERM kills PTY bridges and closes DB cleanly.

---

## 27. Security Notes

- Hook ingest unauthenticated — localhost only.
- Dashboard has no auth — single-user, behind Tailscale.
- OpenClaw token from env — never hardcoded.
- PTY = shell access — keep behind Tailscale.
- All tmux target names validated with strict regex before use in shell commands.
- Session input uses `tmux load-buffer`/`paste-buffer` via stdin to avoid shell injection.

---

## 28. Remote Access

1. Install Tailscale on lab machine + phone/laptop
2. `tailscale up` on both
3. Access at `http://<tailscale-ip>:7700`

---

## 29. Out of Scope for v1

Do NOT implement: transcript viewer, cost tracker, multi-machine, permission delegation from dashboard, AI summarizer, session templates.
