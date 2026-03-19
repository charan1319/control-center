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
  );`);

// Safe migration — ALTER TABLE is ignored if the column already exists
try { db.exec(`ALTER TABLE sessions ADD COLUMN project TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN auto_approve INTEGER DEFAULT 1`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN pending_tool TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN pending_tool_input TEXT`); } catch { /* already exists */ }

db.exec(`

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

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stats (
    key   TEXT PRIMARY KEY,
    value REAL NOT NULL DEFAULT 0
  );
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
      project = COALESCE(@project, project),
      auto_approve = COALESCE(@auto_approve, auto_approve),
      updated_at = datetime('now')
    WHERE session_id = @session_id
  `),

  getSession: db.prepare(`
    SELECT s.*, h.tool_name AS last_tool, h.last_seen AS last_heartbeat,
      (SELECT COUNT(*) FROM events WHERE events.session_id = s.session_id) AS tool_count
    FROM sessions s
    LEFT JOIN heartbeats h ON s.session_id = h.session_id
    WHERE s.session_id = @session_id
  `),

  getAllSessions: db.prepare(`
    SELECT s.*, h.tool_name AS last_tool, h.last_seen AS last_heartbeat,
      (SELECT COUNT(*) FROM events WHERE events.session_id = s.session_id) AS tool_count
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

  // Insert session only if it doesn't already exist. If it does exist, only
  // set 'active' if the session isn't 'stopped' or 'waiting_permission'.
  // A heartbeat means a tool completed, but it may be a previous tool's heartbeat
  // arriving after a PermissionRequest for the next tool — don't clobber that.
  ensureSession: db.prepare(`
    INSERT INTO sessions (session_id, status, updated_at)
    VALUES (@session_id, 'active', datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      status = CASE
        WHEN sessions.status IN ('stopped', 'waiting_permission') THEN sessions.status
        ELSE 'active'
      END,
      updated_at = datetime('now')
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

export function updateSession(session_id, { label, tmux_target, project, auto_approve }) {
  return stmts.updateSession.run({
    session_id,
    label: label ?? null,
    tmux_target: tmux_target ?? null,
    project: project ?? null,
    auto_approve: auto_approve ?? null,
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

export function ensureSession(session_id) {
  return stmts.ensureSession.run({ session_id });
}

const setPendingStmt = db.prepare(`
  UPDATE sessions SET pending_tool = @tool, pending_tool_input = @input, updated_at = datetime('now')
  WHERE session_id = @session_id
`);
export function setPendingPermission(session_id, tool, input) {
  setPendingStmt.run({ session_id, tool: tool || null, input: input ? (typeof input === 'string' ? input : JSON.stringify(input)) : null });
}

const clearPendingStmt = db.prepare(`
  UPDATE sessions SET pending_tool = NULL, pending_tool_input = NULL, updated_at = datetime('now')
  WHERE session_id = @session_id
`);
export function clearPendingPermission(session_id) {
  clearPendingStmt.run({ session_id });
}

const cleanupStmt = db.prepare(`
  DELETE FROM sessions WHERE status = 'stopped' AND updated_at < datetime('now', @offset)
`);
export function deleteStoppedSessionsOlderThan(days) {
  return cleanupStmt.run({ offset: `-${days} days` });
}

// ── Push subscriptions ──────────────────────────
const pushStmts = {
  upsert: db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth)
    VALUES (@endpoint, @p256dh, @auth)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = @p256dh, auth = @auth
  `),
  getAll: db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`),
  delete: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = @endpoint`),
};

export function upsertPushSubscription({ endpoint, p256dh, auth }) {
  return pushStmts.upsert.run({ endpoint, p256dh, auth });
}
export function getAllPushSubscriptions() {
  return pushStmts.getAll.all();
}
export function deletePushSubscription(endpoint) {
  return pushStmts.delete.run({ endpoint });
}

// ── Usage stats ──────────────────────────────────
// DeepSeek pricing (deepseek-chat, as of 2025): $0.27/M input, $1.10/M output
const DEEPSEEK_COST_INPUT_PER_M = 0.27;
const DEEPSEEK_COST_OUTPUT_PER_M = 1.10;

const statsStmts = {
  increment: db.prepare(`
    INSERT INTO stats (key, value) VALUES (@key, @delta)
    ON CONFLICT(key) DO UPDATE SET value = value + @delta
  `),
  getAll: db.prepare(`SELECT key, value FROM stats`),
  totalSessions: db.prepare(`SELECT COUNT(*) as n FROM sessions`),
  sessionsThisWeek: db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE created_at > datetime('now', '-7 days')`),
  totalEvents: db.prepare(`SELECT COUNT(*) as n FROM events`),
  mostUsedTool: db.prepare(`
    SELECT tool_name, COUNT(*) as n FROM events
    WHERE tool_name IS NOT NULL AND tool_name != ''
    GROUP BY tool_name ORDER BY n DESC LIMIT 1
  `),
  avgDuration: db.prepare(`
    SELECT AVG((julianday(updated_at) - julianday(created_at)) * 1440) as avg_min
    FROM sessions WHERE status = 'stopped'
  `),
};

export function incrementStat(key, delta = 1) {
  statsStmts.increment.run({ key, delta });
}

export function getStats() {
  const allStats = Object.fromEntries(statsStmts.getAll.all().map(r => [r.key, r.value]));
  const promptTokens = allStats['ai_prompt_tokens'] ?? 0;
  const completionTokens = allStats['ai_completion_tokens'] ?? 0;
  const costUsd = (promptTokens * DEEPSEEK_COST_INPUT_PER_M + completionTokens * DEEPSEEK_COST_OUTPUT_PER_M) / 1_000_000;
  const avgRow = statsStmts.avgDuration.get();
  return {
    totalSessions: statsStmts.totalSessions.get().n,
    sessionsThisWeek: statsStmts.sessionsThisWeek.get().n,
    totalEvents: statsStmts.totalEvents.get().n,
    mostUsedTool: statsStmts.mostUsedTool.get()?.tool_name ?? null,
    avgDurationMinutes: avgRow?.avg_min ? Math.round(avgRow.avg_min) : null,
    aiSummaryCalls: Math.round(allStats['ai_summary_calls'] ?? 0),
    aiCostUsd: costUsd,
  };
}

// ── Shutdown ──────────────────────────────────────
export function close() {
  db.close();
}

export default db;
