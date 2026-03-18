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
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `),

  getRecentEvents: db.prepare(`
    SELECT e.*, s.label, s.cwd AS session_cwd
    FROM events e
    LEFT JOIN sessions s ON e.session_id = s.session_id
    ORDER BY e.created_at DESC, e.id DESC
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
