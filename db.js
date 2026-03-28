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
try { db.exec(`ALTER TABLE sessions ADD COLUMN snapshot_hash TEXT`); } catch { /* already exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN pulse_enabled INTEGER DEFAULT 1"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN last_idle_signal TEXT DEFAULT NULL"); } catch { /* already exists */ }

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

  CREATE TABLE IF NOT EXISTS file_edits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    tool_name  TEXT,
    edited_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edits(session_id);
  CREATE INDEX IF NOT EXISTS idx_file_edits_path ON file_edits(file_path);
`);

// ── Todos table ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT NOT NULL,
    title       TEXT NOT NULL,
    details     TEXT DEFAULT '',
    status      TEXT DEFAULT 'pending',
    priority    INTEGER DEFAULT 0,
    session_id  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project);
`);

// ── Pulse tables (shared working memory) ─────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pulses (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_main     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pulses_main ON pulses(project) WHERE is_main = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pulses_name ON pulses(project, name);

  CREATE TABLE IF NOT EXISTS pulse_members (
    pulse_id    TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    PRIMARY KEY (pulse_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pulse_members_session ON pulse_members(session_id);

  CREATE TABLE IF NOT EXISTS pulse_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pulse_id    TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
    session_id  TEXT,
    entry_type  TEXT DEFAULT 'user_note' CHECK(entry_type IN ('briefing','file_change','status','user_note','compaction')),
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pulse_entries_pulse ON pulse_entries(pulse_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pulse_entries_session ON pulse_entries(session_id);
`);

// ── Team tables (agent team orchestration) ───────
db.exec(`
  CREATE TABLE IF NOT EXISTS team_templates (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    roles               TEXT NOT NULL,
    coordinator_prompt  TEXT NOT NULL,
    project             TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_instances (
    id              TEXT PRIMARY KEY,
    template_id     TEXT NOT NULL REFERENCES team_templates(id),
    project         TEXT NOT NULL,
    lead_session_id TEXT REFERENCES sessions(session_id),
    objective       TEXT NOT NULL,
    status          TEXT DEFAULT 'active' CHECK(status IN ('active','completed','failed')),
    summary         TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    completed_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_team_instances_project ON team_instances(project);
  CREATE INDEX IF NOT EXISTS idx_team_instances_lead ON team_instances(lead_session_id);
`);

// ── FTS5 full-text search on events ─────────────
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  tool_name,
  tool_input,
  content='events',
  content_rowid='id'
)`);
try { db.exec(`CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN INSERT INTO events_fts(rowid, tool_name, tool_input) VALUES (new.id, new.tool_name, new.tool_input); END`); } catch { /* trigger may already exist */ }
try { db.exec(`CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN INSERT INTO events_fts(events_fts, rowid, tool_name, tool_input) VALUES ('delete', old.id, old.tool_name, old.tool_input); END`); } catch { /* trigger may already exist */ }

// Backfill FTS index from existing events (only if empty)
const ftsCount = db.prepare('SELECT COUNT(*) as n FROM events_fts').get().n;
if (ftsCount === 0) {
  db.exec(`INSERT INTO events_fts(rowid, tool_name, tool_input)
           SELECT id, tool_name, tool_input FROM events WHERE tool_input IS NOT NULL`);
}

// ──────────────────────────────────────────────
// Prepared statements
// ──────────────────────────────────────────────

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (session_id, cwd, model, transcript, cli_type, status, updated_at)
    VALUES (@session_id, @cwd, @model, @transcript, COALESCE(@cli_type, 'claude'), 'active', datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = COALESCE(@cwd, cwd),
      model = COALESCE(@model, model),
      transcript = COALESCE(@transcript, transcript),
      cli_type = COALESCE(@cli_type, cli_type),
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
      pulse_enabled = COALESCE(@pulse_enabled, pulse_enabled),
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

  insertFileEdit: db.prepare(
    `INSERT INTO file_edits (session_id, file_path, tool_name) VALUES (@session_id, @file_path, @tool_name)`
  ),
  getFilesBySession: db.prepare(
    `SELECT file_path, tool_name, MAX(edited_at) as last_edited
     FROM file_edits WHERE session_id = @session_id
     GROUP BY file_path ORDER BY last_edited DESC LIMIT 20`
  ),
  getActiveFileConflicts: db.prepare(
    `SELECT fe.file_path, GROUP_CONCAT(DISTINCT fe.session_id) as session_ids
     FROM file_edits fe
     JOIN sessions s ON s.session_id = fe.session_id
     WHERE s.status != 'stopped'
       AND s.project = @project
       AND fe.edited_at > datetime('now', '-30 minutes')
     GROUP BY fe.file_path
     HAVING COUNT(DISTINCT fe.session_id) > 1`
  ),

  getSessionsByProject: db.prepare(
    `SELECT s.*, h.tool_name as last_tool, h.last_seen as last_heartbeat
     FROM sessions s
     LEFT JOIN heartbeats h ON h.session_id = s.session_id
     WHERE s.project = @project
     ORDER BY s.updated_at DESC`
  ),
  getRecentFileEditsByProject: db.prepare(
    `SELECT fe.file_path, fe.session_id, fe.tool_name, fe.edited_at
     FROM file_edits fe
     JOIN sessions s ON s.session_id = fe.session_id
     WHERE s.project = @project
       AND fe.edited_at > datetime('now', '-' || @minutes || ' minutes')
     ORDER BY fe.edited_at DESC
     LIMIT 30`
  ),

  updateSnapshotHash: db.prepare(
    'UPDATE sessions SET snapshot_hash = @hash WHERE session_id = @session_id'
  ),

  searchSessions: db.prepare(
    `SELECT DISTINCT s.session_id, s.label, s.project, s.cwd, s.status,
         s.created_at, s.updated_at, s.parent_session_id, s.last_idle_signal,
         h.last_seen as last_heartbeat,
         (SELECT COUNT(*) FROM events WHERE session_id = s.session_id) as tool_count
    FROM sessions s
    LEFT JOIN heartbeats h ON h.session_id = s.session_id
    WHERE (@project IS NULL OR s.project = @project)
      AND (@from_date IS NULL OR s.created_at >= @from_date)
      AND (@to_date IS NULL OR s.created_at <= @to_date)
      AND (
        @q IS NULL
        OR s.label LIKE '%' || @q || '%'
        OR s.session_id IN (
          SELECT DISTINCT e.session_id FROM events e
          JOIN events_fts ef ON ef.rowid = e.id
          WHERE events_fts MATCH @q
        )
      )
    ORDER BY s.updated_at DESC
    LIMIT @limit OFFSET @offset`
  ),

  countSearchSessions: db.prepare(
    `SELECT COUNT(DISTINCT s.session_id) as total
    FROM sessions s
    WHERE (@project IS NULL OR s.project = @project)
      AND (@from_date IS NULL OR s.created_at >= @from_date)
      AND (@to_date IS NULL OR s.created_at <= @to_date)
      AND (
        @q IS NULL
        OR s.label LIKE '%' || @q || '%'
        OR s.session_id IN (
          SELECT DISTINCT e.session_id FROM events e
          JOIN events_fts ef ON ef.rowid = e.id
          WHERE events_fts MATCH @q
        )
      )`
  ),

  // ── Todos ──────────────────────────────────────
  getTodosByProject: db.prepare(
    `SELECT * FROM todos WHERE project = @project ORDER BY
     CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'done' THEN 2 END,
     priority ASC, created_at DESC`
  ),
  insertTodo: db.prepare(
    `INSERT INTO todos (project, title, details, priority) VALUES (@project, @title, @details, @priority)`
  ),
  updateTodo: db.prepare(
    `UPDATE todos SET title=COALESCE(@title,title), details=COALESCE(@details,details),
     status=COALESCE(@status,status), priority=COALESCE(@priority,priority),
     updated_at=datetime('now') WHERE id=@id`
  ),
  deleteTodo: db.prepare(`DELETE FROM todos WHERE id = @id`),
  linkTodoSession: db.prepare(
    `UPDATE todos SET session_id=@session_id, status='in_progress', updated_at=datetime('now') WHERE id=@id`
  ),
  getTodoBySessionId: db.prepare(`SELECT * FROM todos WHERE session_id = @session_id`),
  getTodoById: db.prepare(`SELECT * FROM todos WHERE id = @id`),

  // ── Pulses ──────────────────────────────────────
  getPulse: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM pulse_entries WHERE pulse_id = p.id) AS entry_count FROM pulses p WHERE p.id = @id`),
  getPulsesByProject: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM pulse_entries WHERE pulse_id = p.id) AS entry_count FROM pulses p WHERE p.project = @project ORDER BY p.is_main DESC, p.name ASC`),
  getMainPulse: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM pulse_entries WHERE pulse_id = p.id) AS entry_count FROM pulses p WHERE p.project = @project AND p.is_main = 1`),
  insertPulse: db.prepare(`INSERT INTO pulses (id, project, name, description, is_main) VALUES (@id, @project, @name, @description, @is_main)`),
  insertPulseIgnore: db.prepare(`INSERT OR IGNORE INTO pulses (id, project, name, description, is_main) VALUES (@id, @project, @name, @description, @is_main)`),
  updatePulse: db.prepare(`UPDATE pulses SET name = COALESCE(@name, name), description = COALESCE(@description, description), updated_at = datetime('now') WHERE id = @id`),
  deletePulse: db.prepare(`DELETE FROM pulses WHERE id = @id AND is_main = 0`),

  // ── Pulse entries ───────────────────────────────
  getPulseEntries: db.prepare(
    `SELECT pe.*, s.label AS session_label FROM pulse_entries pe LEFT JOIN sessions s ON pe.session_id = s.session_id
     WHERE pe.pulse_id = @pulse_id AND (@before IS NULL OR pe.created_at < @before)
     ORDER BY pe.created_at DESC LIMIT @limit`
  ),
  getPulseEntriesAsc: db.prepare(
    `SELECT pe.*, s.label AS session_label FROM pulse_entries pe LEFT JOIN sessions s ON pe.session_id = s.session_id
     WHERE pe.pulse_id = @pulse_id ORDER BY pe.created_at ASC`
  ),
  insertPulseEntry: db.prepare(
    `INSERT INTO pulse_entries (pulse_id, session_id, entry_type, content) VALUES (@pulse_id, @session_id, @entry_type, @content)`
  ),
  deletePulseEntry: db.prepare(`DELETE FROM pulse_entries WHERE id = @id`),
  deletePulseEntriesByIds: db.prepare(`DELETE FROM pulse_entries WHERE id IN (SELECT value FROM json_each(@ids))`),
  deleteUserNotesByPulse: db.prepare(`DELETE FROM pulse_entries WHERE pulse_id = @pulse_id AND entry_type = 'user_note'`),
  getPulseEntryCount: db.prepare(`SELECT COUNT(*) AS n FROM pulse_entries WHERE pulse_id = @pulse_id`),
  getOldestUncompactedEntry: db.prepare(
    `SELECT MIN(created_at) AS oldest FROM pulse_entries WHERE pulse_id = @pulse_id AND entry_type != 'compaction'`
  ),

  // ── Pulse members ──────────────────────────────
  getPulseMembers: db.prepare(
    `SELECT pm.session_id, s.label, s.status FROM pulse_members pm LEFT JOIN sessions s ON pm.session_id = s.session_id WHERE pm.pulse_id = @pulse_id`
  ),
  getSessionPulses: db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM pulse_entries WHERE pulse_id = p.id) AS entry_count
     FROM pulses p JOIN pulse_members pm ON p.id = pm.pulse_id WHERE pm.session_id = @session_id`
  ),
  getAllPulseMemberships: db.prepare(
    `SELECT pm.session_id, pm.pulse_id, p.name AS pulse_name, p.is_main FROM pulse_members pm JOIN pulses p ON pm.pulse_id = p.id`
  ),
  addPulseMember: db.prepare(`INSERT OR IGNORE INTO pulse_members (pulse_id, session_id) VALUES (@pulse_id, @session_id)`),
  removePulseMember: db.prepare(`DELETE FROM pulse_members WHERE pulse_id = @pulse_id AND session_id = @session_id`),
  removePulseMembersBySession: db.prepare(`DELETE FROM pulse_members WHERE session_id = @session_id`),

  // ── Session columns for subagent/idle ──────────
  setParentSession: db.prepare(`UPDATE sessions SET parent_session_id = @parent_id, updated_at = datetime('now') WHERE session_id = @id`),
  setLastIdleSignal: db.prepare(`UPDATE sessions SET last_idle_signal = @ts, updated_at = datetime('now') WHERE session_id = @id`),

  // ── Team templates ─────────────────────────────
  getTeamTemplates: db.prepare(`SELECT * FROM team_templates ORDER BY name ASC`),
  getTeamTemplate: db.prepare(`SELECT * FROM team_templates WHERE id = @id`),
  insertTeamTemplate: db.prepare(
    `INSERT INTO team_templates (id, name, description, roles, coordinator_prompt, project) VALUES (@id, @name, @description, @roles, @coordinator_prompt, @project)`
  ),
  insertTeamTemplateIgnore: db.prepare(
    `INSERT OR IGNORE INTO team_templates (id, name, description, roles, coordinator_prompt, project) VALUES (@id, @name, @description, @roles, @coordinator_prompt, @project)`
  ),
  updateTeamTemplate: db.prepare(
    `UPDATE team_templates SET name=COALESCE(@name,name), description=COALESCE(@description,description),
     roles=COALESCE(@roles,roles), coordinator_prompt=COALESCE(@coordinator_prompt,coordinator_prompt),
     project=COALESCE(@project,project), updated_at=datetime('now') WHERE id=@id`
  ),
  deleteTeamTemplate: db.prepare(`DELETE FROM team_templates WHERE id = @id`),
  getTeamInstancesByTemplate: db.prepare(`SELECT COUNT(*) AS n FROM team_instances WHERE template_id = @template_id`),

  // ── Team instances ─────────────────────────────
  getTeamInstances: db.prepare(
    `SELECT * FROM team_instances WHERE (@project IS NULL OR project = @project) ORDER BY created_at DESC`
  ),
  getTeamInstance: db.prepare(`SELECT * FROM team_instances WHERE id = @id`),
  getTeamInstanceByLead: db.prepare(`SELECT * FROM team_instances WHERE lead_session_id = @lead_session_id AND status = 'active'`),
  insertTeamInstance: db.prepare(
    `INSERT INTO team_instances (id, template_id, project, lead_session_id, objective) VALUES (@id, @template_id, @project, @lead_session_id, @objective)`
  ),
  updateTeamInstance: db.prepare(
    `UPDATE team_instances SET lead_session_id=COALESCE(@lead_session_id, lead_session_id),
     status=COALESCE(@status, status), summary=COALESCE(@summary, summary),
     completed_at=COALESCE(@completed_at, completed_at) WHERE id=@id`
  ),
  clearTeamLeadRef: db.prepare(
    `UPDATE team_instances SET lead_session_id = NULL WHERE lead_session_id IN (SELECT session_id FROM sessions WHERE status = 'stopped' AND updated_at < datetime('now', @offset))`
  ),
};

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export function upsertSession({ session_id, cwd, model, transcript, cli_type }) {
  return stmts.upsertSession.run({
    session_id,
    cwd: cwd || null,
    model: model || null,
    transcript: transcript || null,
    cli_type: cli_type || null,
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

export function updateSession(session_id, { label, tmux_target, project, auto_approve, pulse_enabled }) {
  return stmts.updateSession.run({
    session_id,
    label: label ?? null,
    tmux_target: tmux_target ?? null,
    project: project ?? null,
    auto_approve: auto_approve ?? null,
    pulse_enabled: pulse_enabled ?? null,
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

export function insertFileEdit(session_id, file_path, tool_name) {
  return stmts.insertFileEdit.run({ session_id, file_path, tool_name });
}
export function getFilesBySession(session_id) {
  return stmts.getFilesBySession.all({ session_id });
}
export function getActiveFileConflicts(project) {
  return stmts.getActiveFileConflicts.all({ project });
}

export function getSessionsByProject(project) {
  return stmts.getSessionsByProject.all({ project });
}
export function getRecentFileEditsByProject(project, minutes) {
  return stmts.getRecentFileEditsByProject.all({ project, minutes: String(minutes) });
}

export function updateSnapshotHash(session_id, hash) {
  return stmts.updateSnapshotHash.run({ session_id, hash });
}

export function searchSessions({ project, q, from_date, to_date, limit, offset }) {
  const params = {
    project: project || null,
    q: q || null,
    from_date: from_date || null,
    to_date: to_date || null,
    limit: limit || 50,
    offset: offset || 0,
  };
  if (q) params.q = '"' + q.replace(/"/g, '') + '"';
  const sessions = stmts.searchSessions.all(params);
  const { total } = stmts.countSearchSessions.get(params);
  return { sessions, total };
}

// ── Todos ──────────────────────────────────────
export function getTodosByProject(project) {
  return stmts.getTodosByProject.all({ project });
}
export function insertTodo(project, title, details, priority) {
  const result = stmts.insertTodo.run({ project, title, details: details || '', priority: priority || 0 });
  return stmts.getTodoById.get({ id: result.lastInsertRowid });
}
export function updateTodo(id, { title, details, status, priority }) {
  return stmts.updateTodo.run({ id, title: title ?? null, details: details ?? null, status: status ?? null, priority: priority ?? null });
}
export function deleteTodo(id) {
  return stmts.deleteTodo.run({ id });
}
export function linkTodoSession(todoId, session_id) {
  return stmts.linkTodoSession.run({ id: todoId, session_id });
}
export function getTodoBySessionId(session_id) {
  return stmts.getTodoBySessionId.get({ session_id });
}
export function getTodoById(id) {
  return stmts.getTodoById.get({ id });
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
  set: db.prepare(`
    INSERT INTO stats (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = @value
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

export function setStat(key, value) {
  statsStmts.set.run({ key, value });
}

// ── Pulses ──────────────────────────────────────
export function getPulse(id) { return stmts.getPulse.get({ id }); }
export function getPulsesByProject(project) { return stmts.getPulsesByProject.all({ project }); }
export function getMainPulse(project) { return stmts.getMainPulse.get({ project }); }
export function insertPulse({ id, project, name, description, is_main }) {
  return stmts.insertPulse.run({ id, project, name, description: description || '', is_main: is_main || 0 });
}
export function insertPulseIgnore({ id, project, name, description, is_main }) {
  return stmts.insertPulseIgnore.run({ id, project, name, description: description || '', is_main: is_main || 0 });
}
export function updatePulse(id, { name, description }) {
  return stmts.updatePulse.run({ id, name: name ?? null, description: description ?? null });
}
export function deletePulse(id) { return stmts.deletePulse.run({ id }); }

export function getPulseEntries(pulse_id, { limit = 50, before = null } = {}) {
  return stmts.getPulseEntries.all({ pulse_id, limit, before });
}
export function getPulseEntriesAsc(pulse_id) { return stmts.getPulseEntriesAsc.all({ pulse_id }); }
export function insertPulseEntry({ pulse_id, session_id, entry_type, content }) {
  return stmts.insertPulseEntry.run({ pulse_id, session_id: session_id || null, entry_type: entry_type || 'user_note', content });
}
export function deletePulseEntry(id) { return stmts.deletePulseEntry.run({ id }); }
export function deletePulseEntriesByIds(ids) {
  return stmts.deletePulseEntriesByIds.run({ ids: JSON.stringify(ids) });
}
export function deleteUserNotesByPulse(pulse_id) { return stmts.deleteUserNotesByPulse.run({ pulse_id }); }
export function getPulseEntryCount(pulse_id) { return stmts.getPulseEntryCount.get({ pulse_id }).n; }
export function getOldestUncompactedEntry(pulse_id) { return stmts.getOldestUncompactedEntry.get({ pulse_id }).oldest; }

export function getPulseMembers(pulse_id) { return stmts.getPulseMembers.all({ pulse_id }); }
export function getSessionPulses(session_id) { return stmts.getSessionPulses.all({ session_id }); }
export function getAllPulseMemberships() { return stmts.getAllPulseMemberships.all(); }
export function addPulseMember(pulse_id, session_id) { return stmts.addPulseMember.run({ pulse_id, session_id }); }
export function removePulseMember(pulse_id, session_id) { return stmts.removePulseMember.run({ pulse_id, session_id }); }
export function removePulseMembersBySession(session_id) { return stmts.removePulseMembersBySession.run({ session_id }); }

export function setParentSession(id, parent_id) { return stmts.setParentSession.run({ id, parent_id }); }
export function setLastIdleSignal(id, ts) { return stmts.setLastIdleSignal.run({ id, ts }); }

// ── Teams ──────────────────────────────────────
export function getTeamTemplates() { return stmts.getTeamTemplates.all(); }
export function getTeamTemplate(id) { return stmts.getTeamTemplate.get({ id }); }
export function insertTeamTemplate({ id, name, description, roles, coordinator_prompt, project }) {
  return stmts.insertTeamTemplate.run({ id, name, description: description || '', roles: typeof roles === 'string' ? roles : JSON.stringify(roles), coordinator_prompt, project: project || null });
}
export function insertTeamTemplateIgnore({ id, name, description, roles, coordinator_prompt, project }) {
  return stmts.insertTeamTemplateIgnore.run({ id, name, description: description || '', roles: typeof roles === 'string' ? roles : JSON.stringify(roles), coordinator_prompt, project: project || null });
}
export function updateTeamTemplate(id, { name, description, roles, coordinator_prompt, project }) {
  return stmts.updateTeamTemplate.run({ id, name: name ?? null, description: description ?? null, roles: roles ? (typeof roles === 'string' ? roles : JSON.stringify(roles)) : null, coordinator_prompt: coordinator_prompt ?? null, project: project ?? null });
}
export function deleteTeamTemplate(id) { return stmts.deleteTeamTemplate.run({ id }); }
export function getTeamInstancesByTemplate(template_id) { return stmts.getTeamInstancesByTemplate.get({ template_id }).n; }

export function getTeamInstances(project) { return stmts.getTeamInstances.all({ project: project || null }); }
export function getTeamInstance(id) { return stmts.getTeamInstance.get({ id }); }
export function getTeamInstanceByLead(lead_session_id) { return stmts.getTeamInstanceByLead.get({ lead_session_id }); }
export function insertTeamInstance({ id, template_id, project, lead_session_id, objective }) {
  return stmts.insertTeamInstance.run({ id, template_id, project, lead_session_id: lead_session_id || null, objective });
}
export function updateTeamInstance(id, { lead_session_id, status, summary, completed_at }) {
  return stmts.updateTeamInstance.run({ id, lead_session_id: lead_session_id ?? null, status: status ?? null, summary: summary ?? null, completed_at: completed_at ?? null });
}
export function clearTeamLeadRefs(days) { return stmts.clearTeamLeadRef.run({ offset: `-${days} days` }); }

// Transaction helper
export const transaction = db.transaction.bind(db);

// ── Shutdown ──────────────────────────────────────
export function close() {
  db.close();
}

export default db;
