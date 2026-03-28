# Pulse Evolution & Agent Team Orchestration

Implementation plan for two complementary capabilities:
1. **Shared Working Memory** — evolving the Pulse system from a simple status display
   into a multi-document knowledge base that enables cross-session knowledge sharing
2. **Agent Team Orchestration** — launching, monitoring, and presenting results from
   specialized agent teams that perform end-to-end work autonomously

Both capabilities share infrastructure: hook ingestion, session tracking, pulse entries,
and the briefing system.

---

## Context & Motivation

Control Center manages multiple AI coding agent sessions (Claude, Gemini, Codex) across
projects. Currently, sessions are isolated — knowledge gained in one session doesn't flow
to others unless the user manually copies text or relies on the basic Pulse feature
(which only shows active agents, recent file edits, and user notes).

The goal: agents working on the same project should benefit from each other's discoveries,
decisions, and progress without requiring manual copy-paste or handoff documents committed
to the repo.

### What Exists Today

The current Pulse system (`pulse.js`) is a read-only status display:

- **One pulse per project** — auto-generated markdown showing active agents, recent file
  edits (last 30 min), file conflicts, and user-editable notes
- **Storage** — user notes in `data/pulse/{project}.json` (filesystem JSON); everything
  else regenerated on-demand from DB queries
- **Injection** — at session launch, pulse content prepended to initial prompt (truncated
  to 3000 chars / ~750 tokens)
- **UI** — PulsePanel modal accessible from ProjectGroup header; per-session toggle button
- **Limitations** — no agent-contributed content, no mid-session updates, no topic scoping,
  no persistence of generated pulse content, `pulse_enabled` field exists but isn't enforced

### Design Principles

1. **Append-only entries, assembled on read** — no mutable shared document that can have
   write conflicts. The "document" is built from discrete entries stored in SQLite.
   (Exception: the dream cycle replaces old entries with a consolidated summary —
   see Compaction & Dream Cycle section.)
2. **Agent-curated content** — the agent that did the work produces the summary, not an
   external summarizer. This yields higher quality, more relevant knowledge.
3. **Scoped access** — agents see only the pulses they're subscribed to, avoiding context
   noise from unrelated work.
4. **SQLite for all persistence** — better-sqlite3 is synchronous in Node.js, so all writes
   are serialized by the event loop. No locks, no mutexes, no coordination code needed.
5. **Progressive enrichment** — start with automatic file tracking and user-triggered
   briefings, add automation later.

---

## Data Model

### New Tables

**Pulse IDs** are generated with `crypto.randomUUID()` (Node.js built-in, no dependency).
Main pulses use the deterministic ID `main-{sanitized_project}` for easy lookup.
Sanitization uses the same function as current `pulse.js` (line 9):
`project.replace(/[^a-zA-Z0-9_-]/g, '_')` — keeps case, replaces spaces and special
chars with `_`. Example: "My App" → `main-My_App`, "backend-api" → `main-backend-api`.

```sql
-- Named pulse documents (one "Main" per project + user-created topic pulses)
CREATE TABLE IF NOT EXISTS pulses (
  id          TEXT PRIMARY KEY,   -- crypto.randomUUID() or 'main-{project}' for main pulses
  project     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_main     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Unique constraint: one main pulse per project, unique names within project
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulses_main ON pulses(project) WHERE is_main = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulses_name ON pulses(project, name);

-- Session <-> Pulse memberships
CREATE TABLE IF NOT EXISTS pulse_members (
  pulse_id    TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  PRIMARY KEY (pulse_id, session_id)
);

-- Append-only knowledge entries
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
CREATE INDEX IF NOT EXISTS idx_pulse_members_session ON pulse_members(session_id);
```

**Note:** `db.js` already sets `PRAGMA foreign_keys = ON` (line 8), so CASCADE works.
`ON DELETE CASCADE` is used on `pulse_members` and `pulse_entries` so that
deleting a pulse cleans up all its entries and memberships automatically. This is
intentionally different from the existing tables (`events`, `heartbeats`, `file_edits`)
which don't cascade — those are historical records that should survive even if a session
row is manually deleted. The `FOREIGN KEY (session_id) REFERENCES sessions(session_id)`
on `pulse_members` also cascades so that deleting a session auto-removes its memberships.
`pulse_entries.session_id` is nullable (system-generated entries have no session) and
does NOT cascade — entries survive session deletion since they're project knowledge.

### Entry Types

| `entry_type` | Source | Description |
|---|---|---|
| `briefing` | Agent (via CC prompt) | Agent-curated summary of work done, decisions, findings |
| `file_change` | Automatic (hooks) | Structured file edit record — which files, by which session |
| `status` | Automatic (session lifecycle) | Session started/stopped/idle notifications |
| `user_note` | User (via UI) | Manual notes added by the user |
| `compaction` | System (dream cycle) | Consolidated summary replacing older entries — includes mined transcript knowledge, contradiction resolutions, and staleness corrections |

### Migration from Current Pulse

- **Discover existing projects** via two sources (union, deduplicate):
  1. `SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL` — covers all
     projects that have sessions (even those without pulse notes)
  2. Scan `data/pulse/` directory for `*.json` files — the filename (minus `.json`) is
     the project name. Covers projects that have user notes but whose sessions may have
     been cleaned up. Use the same sanitization as the current `pulse.js` (line 9:
     `project.replace(/[^a-zA-Z0-9_-]/g, '_')`) to match filenames to project names.
- Auto-create a main pulse for each discovered project
- Migrate existing `data/pulse/{project}.json` user notes as `user_note` entries
- Keep the old `data/pulse/` files as backup, stop writing to them
- The `pulse_enabled` field on sessions maps to pulse_members: enabled = member
  of the project's main pulse

### Main Pulse Lazy Creation

New projects won't have a main pulse until their first session. Create it lazily:
- On session launch with a project → `getOrCreateMainPulse(project)` ensures the
  main pulse row exists (INSERT OR IGNORE with deterministic ID `main-{sanitized_project}`)
- On first API access to a project's pulses → same lazy creation
- This avoids needing a "create project" event and handles organically-created projects

---

## How Agents Contribute

Three mechanisms, in order of implementation priority:

### C. Hook-Based File Change Entries (Automatic)

The heartbeat hook already fires on every file-editing tool use (Bash|Write|Edit|MultiEdit)
and records to `file_edits`. Extend this:

- When a heartbeat with `file_path` arrives, also append a `file_change` entry to the
  session's project main pulse
- Debounce per-session: batch file changes over a 30-second window into a single entry
  listing all files touched (avoids flooding the pulse with per-edit entries)
- Content format: `"[Session 'Auth Worker'] edited: src/auth/middleware.js, src/auth/jwt.ts"`
- No agent involvement required — CC generates these from hook data

### A. Triggered Briefing (User-Initiated)

User clicks "Brief" on a session card, selects a target pulse:

1. CC checks that the session is idle (waiting for input, not mid-response).
   If not idle, queue the briefing request and show a toast: "Will brief when idle."

2. CC sends a structured prompt to the agent's tmux pane:
   ```
   Summarize your work for the shared project knowledge base. Include:
   - What you changed and why
   - Key decisions or trade-offs you made
   - Anything the next person working here should know
   - Open questions or blockers
   Be concise — 200 words max. This will be read by other agents.
   ```

3. CC watches the transcript JSONL for the next assistant response after the prompt's
   timestamp. This is the briefing content.

4. CC stores the response as a `briefing` entry on the selected pulse.

5. In the transcript view, this exchange shows as a special "Pulse Update" block
   (visually distinct from normal conversation — different icon, different background,
   labeled with the target pulse name).

**Idle detection (two signals, either sufficient):**

1. **Transcript-based (all CLIs):** Use the existing `isLastTurnComplete(filePath)`
   function from `transcript.js` — checks whether the most recent `stop_reason` (any value
   except `'tool_use'`, typically `'end_turn'`) comes after the most recent user/tool_result
   input. Require: `session.status === 'active'` AND `isLastTurnComplete(session.transcript)`.

2. **TeammateIdle hook (Claude Code only):** When CC receives a `TeammateIdle` event for
   a session, that is an authoritative "agent is idle" signal directly from Claude Code.
   Store the timestamp on the session (`last_idle_signal`). This is more reliable than
   transcript polling and works even when the transcript file hasn't flushed yet.

If neither signal is available, queue the request and re-check every 5 seconds
(up to 120s timeout).

**Response capture:** The idle detection guard (above) ensures the agent is NOT
mid-response before sending the briefing prompt. This eliminates the ambiguity of
overlapping responses. After sending the prompt via `load-buffer`/`paste-buffer`
(same mechanism as `POST /api/sessions/:id/input`), CC records `promptSentAt =
Date.now()` and polls the session's transcript JSONL file. It uses
`readTranscriptStructured()` to find the first assistant entry where `entry.timestamp
> promptSentAt` AND the entry has a `stop_reason` that is NOT `'tool_use'` (i.e., the
agent finished generating, not just a tool call mid-response). This captures the final
text of the briefing response, skipping any intermediate tool-use turns. Poll every 3
seconds, timeout after 120 seconds. On timeout, log a warning and don't create an entry.

**Briefing and permissions:** The agent may use tools while generating the briefing
(e.g., reading files to verify what it changed). If the session's `auto_approve` is set
to `full` (the default), this is invisible. If set to `readonly` or `none`, tool use
during briefing will trigger normal permission prompts. This is acceptable — don't
special-case it. The briefing prompt itself is just user input; the agent handles it
like any other message.

### B. Auto-Briefing on Session End/Idle (Automatic)

When `handleSessionEnded()` fires for a session (see "Session-End Detection" section):

1. If the session is a member of any pulse, and has done meaningful work (tool_count > 3),
   CC attempts to auto-brief. By the time `handleSessionEnded` fires (from the `SessionEnd`
   hook), the agent process has already exited.

2. **Transcript-based extraction (only path):** The agent is always gone by the time
   `handleSessionEnded` runs — the Kill endpoint calls `execFileSync('tmux', ['kill-session',
   ...])` synchronously (tmux is dead before `handleSessionEnded` is called), and
   `SessionEnd` fires after the agent process has already exited. There is no window to
   brief a live agent. Instead: read the last 10 assistant messages from the transcript
   via `readTranscriptStructured()`, send them to a temporary headless Claude Code session
   (via `child_process.spawn` with stdin piping and `--bare` flag — see Dream Cycle
   "Mechanism" section for the pattern) with the prompt
   "Summarize this agent's work into a concise briefing for the project knowledge base."
   Store the result as a `briefing` entry.

3. **Idle auto-briefing:** For idle sessions (>5 minutes idle, configurable): optionally
   auto-trigger a briefing. This should be a per-pulse setting, defaulting to off, since
   it interrupts the agent.

### D. MCP Server Integration (Future)

CC registers as an MCP server that Claude Code sessions can call natively:
- `read_pulse(pulse_name)` — returns current pulse content
- `update_pulse(pulse_name, content)` — appends a briefing entry
- `list_pulses()` — returns available pulses for the project

This gives agents first-class read/write access to pulses mid-conversation without
CC having to inject prompts through tmux. Deferred because it requires MCP configuration
per-session and doesn't work for Gemini/Codex CLIs.

---

## How Agents Read Pulse Content

### At Launch (Existing, Enhanced)

When a session is launched with a project, CC assembles pulse content from all pulses
the session is a member of:

1. Main pulse: auto-generated status (active agents, file conflicts) + recent entries
2. Topic pulses: recent entries only
3. Format as structured context block, inject into initial prompt
4. Character budget: 6000 chars for main pulse + 3000 chars per topic pulse, configurable.
   (Current system uses 3000 chars for the single pulse. Roughly ~4 chars per token.)
5. Newest entries first, truncated at budget

### What Happens to `generatePulse()`

The current `pulse.js` `generatePulse()` function queries active sessions, recent file
edits, and file conflicts from the DB to build a markdown document on-the-fly. After
migration:

- **Active sessions section** — kept as a live header in assembled pulse content (queried
  from `sessions` table, not stored as entries). This is ephemeral status, not knowledge.
- **File conflicts section** — kept as a live header (queried from `file_edits` table).
- **Recent file edits section** — replaced by `file_change` entries in pulse_entries.
  The old query-based generation is removed.
- **User notes section** — replaced by `user_note` entries in pulse_entries.
- **`schedulePulseRegeneration()` debounce** — removed. Pulse content is now assembled
  on-demand from entries, not pre-generated and cached.

The `pulse.js` file is rewritten to export: `getOrCreateMainPulse()`, `assemblePulseContent()`,
`assembleProjectPulseContext(project)` (for launch-time injection — includes main pulse
for the project), `assembleSessionPulseContext(sessionId)` (for mid-session refresh —
includes all pulses the session is subscribed to), and the entry/membership CRUD helpers.
`getUserNotes()` and `setUserNotes()` become thin wrappers during migration, then removed.
During the wrapper period: `getUserNotes(project)` returns the content of the most recent
`user_note` entry for the project's main pulse (or empty string if none). `setUserNotes(
project, notes)` DELETEs all existing `user_note` entries on the main pulse and INSERTs
one new entry with the provided content. This preserves the old UX where notes are a
single editable text blob. The new PulsePanel (Phase 3) replaces this with per-entry
display, at which point the wrappers are removed.

### Mid-Session Refresh (New)

User clicks "Sync Pulse" on a session card (or keyboard shortcut):

1. CC assembles current pulse content for the session's subscribed pulses
2. Sends to the agent's tmux pane as a context message:
   ```
   [Pulse Update — project knowledge base refresh]
   {assembled pulse content}
   [End pulse update — continue with your current task]
   ```
3. Same idle-detection guard as briefing: only send when `isLastTurnComplete()` returns
   true (agent is waiting for input)

### On Subscription Change (New)

When a session is added to a topic pulse:

1. CC immediately sends the topic pulse's content to the agent
2. Optionally, CC prompts the agent to contribute back:
   ```
   You've been added to the "{pulse_name}" knowledge base. Here's what's known so far:
   {pulse content}
   If you have relevant knowledge to add, please share it concisely. Otherwise, continue.
   ```

---

## Hook Architecture Evolution

CC currently uses shell script hooks (`cc-report.sh`, `cc-heartbeat.sh`) that parse
hook payloads and `curl` to the server. Claude Code now supports native HTTP hooks
as a first-class feature, and exposes new event types that CC should ingest.

### Migration to Native HTTP Hooks

**Current (shell scripts):**
```
Claude Code → cc-report.sh → curl POST http://localhost:7700/api/hooks
Claude Code → cc-heartbeat.sh → curl POST http://localhost:7700/api/hooks
```

**Target (native HTTP hooks):**
```
Claude Code → HTTP POST http://localhost:7700/api/hooks (direct, structured JSON)
```

**Critical: no event overlap.** Shell scripts and native HTTP hooks must NOT be configured
for the same events, otherwise Claude Code fires BOTH and the server processes duplicates
(creating duplicate `file_edits` records, etc.). Strategy: keep shell scripts for existing
events they already handle; add native HTTP only for NEW events that shell scripts don't
handle.

Shell script hooks (keep existing — provide `tmux_session` field):
- `cc-report.sh`: SessionStart, Stop, PermissionRequest, Notification
- `cc-heartbeat.sh`: PostToolUse (with matcher for `Bash|Write|Edit|MultiEdit`)

Native HTTP hooks (new events only — configured in `~/.claude/settings.json`):
```json
{
  "hooks": {
    "SubagentStart":   [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }],
    "SubagentStop":    [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }],
    "TaskCreated":     [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }],
    "TaskCompleted":   [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }],
    "TeammateIdle":    [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }],
    "SessionEnd":      [{ "hooks": [{ "type": "http", "url": "http://localhost:7700/api/hooks" }] }]
  }
}
```

Future: once native HTTP hooks are proven stable, migrate existing events from shell scripts
to native HTTP (requires solving the `tmux_session` field gap — see payload format table).

**Benefits over shell scripts:**
- No shell parsing — Claude Code sends the full structured JSON payload directly
- More reliable — no `curl` dependency, no script permission issues, no PATH problems
- Lower latency — no process spawn overhead for each event
- Access to new event types (SubagentStart, TaskCreated, etc.) that the shell scripts
  don't handle
- Claude Code natively handles the HTTP response format (JSON with `{ok, decision, reason}`)

**Payload format differences:**

The shell scripts build a custom payload with CC-specific fields (`tmux_session`,
`event` mapped from Claude Code event names). Native HTTP hooks send Claude Code's
raw payload format. The `/api/hooks` handler must detect and normalize both:

| Field | Shell Script Format | Native HTTP Format |
|---|---|---|
| Event type | `event` (CC name: "Heartbeat") | `hook_event_name` (CC name: "PostToolUse") |
| Session ID | `session_id` | `session_id` |
| Tmux session | `tmux_session` (added by script) | Not present — detect from `$TMUX` env or skip |
| Tool name | `tool_name` | `tool_name` |
| File path | `file_path` (extracted by script) | `tool_input.file_path` or `tool_input.path` (extract server-side) |
| Agent ID | Not present | `agent_id` (for subagents) |
| Agent type | Not present | `agent_type` (for subagents) |

**Detection logic:** If payload has `hook_event_name`, it's native HTTP format. If it
has `event` but no `hook_event_name`, it's shell script format. Normalize to a common
internal format before processing.

**Auto-approve response format:**
- PermissionRequest stays on shell scripts (no native HTTP overlap), so the existing flow
  is unchanged: server returns `{auto_approve: true}` → script reads response, outputs
  `{"decision":"approve"}` to stdout → Claude Code reads stdout. Server also sends tmux
  Enter key as fallback (800ms delay).
- Future (when/if PermissionRequest migrates to native HTTP): server returns
  `{"decision":"approve"}` directly in HTTP response → Claude Code reads it natively.

**Backward compatibility:**
- Gemini CLI and Codex CLI don't support native HTTP hooks — keep `gc-report.sh`,
  `gc-heartbeat.sh`, and `cx-report.sh` shell scripts for those CLIs
- During transition, CC's `/api/hooks` endpoint accepts both formats (see detection
  logic above). Shell script hooks kept as fallback if native HTTP hooks fail.
- The `update.sh` script deploys both: native HTTP hook config for Claude Code,
  shell scripts for Gemini/Codex

### New Hook Events

CC currently handles 5 hook event types: SessionStart, Stop, PermissionRequest, and
Heartbeat have explicit handlers; Notification is recorded via the generic `insertEvent()`
call (no special logic). The new events to add:

| Event | Payload Fields | CC Action |
|---|---|---|
| `SubagentStart` | `session_id` (PARENT), `agent_id` (subagent), `agent_type` | Create child session row: use `agent_id` as the child's session_id, set `parent_session_id` = payload `session_id`. Generate `status` pulse entry. |
| `SubagentStop` | `session_id` (PARENT), `agent_id`, `agent_type`, `last_assistant_message`, `agent_transcript_path` | Mark child session stopped. `last_assistant_message` provides the subagent's final response text directly — no transcript parsing needed. Store as pulse entry if substantive. |
| `TaskCreated` | `session_id`, `task_subject`, `task_description` | Create `status` pulse entry: "[Session] created task: {subject}". Optionally sync to CC TODO. |
| `TaskCompleted` | `session_id`, `task_subject`, `task_id` | Create `status` pulse entry: "[Session] completed task: {subject}". Update CC TODO if synced. |
| `TeammateIdle` | `session_id`, `agent_id` | Authoritative idle signal — use as briefing trigger (more reliable than transcript polling). |
| `SessionEnd` | `session_id` | Authoritative session-exit signal. Look up session in DB; if it exists and has a `tmux_target`, mark stopped and call `handleSessionEnded()`. This is distinct from `Stop` (which fires per-turn). `SessionEnd` fires once when the process exits. |

### Session-End Detection

**Critical note:** The `Stop` hook event means "model turn ended" (i.e., the model stopped
generating), NOT "session ended." It fires multiple times per session — once per turn. The
current handler (server.js line 869) correctly sets status to `'active'` on Stop, not
`'stopped'`. Sessions currently get marked `'stopped'` only by:
1. The Kill endpoint (`POST /api/sessions/:id/kill`)
2. Zombie cleanup (`cleanupZombies()` — tmux gone + heartbeat > 4 hours old)

Neither mechanism is suitable for triggering time-sensitive session-end actions (auto-briefing,
debounce flush, team completion). Zombie cleanup has a 4-hour delay, and Kill is only for
user-initiated termination.

**Solution: `SessionEnd` hook event.** Claude Code provides a `SessionEnd` hook event that
fires exactly once when the session process exits. This is distinct from `Stop` (which fires
per-turn). `SessionEnd` is the authoritative session-exit signal and replaces any need for
delayed tmux checks or polling.

**New: `handleSessionEnded(session_id)` function** — a centralized handler for session-end
actions. Called from all code paths that mark a session as stopped:
1. **Kill endpoint** — called after `db.updateStatus(id, 'stopped')` (immediate, always works)
2. **`SessionEnd` hook event** — look up session in DB by `session_id`. If it exists and
   has a `tmux_target` (i.e., not headless), mark stopped and call `handleSessionEnded()`.
   This fires when the Claude Code process exits naturally, or when it's killed by
   `tmux kill-session` (the process receives SIGTERM and fires `SessionEnd` during cleanup).
3. **Zombie cleanup** — for any sessions missed by (1) and (2), remains as a safety net
   (e.g., if `SessionEnd` hook fails to reach the server).

**Stop handler fix:** The current Stop handler (line 869) checks `currentStatus !== 'waiting_permission'` but does NOT check for `'stopped'`. This means a Stop event arriving after Kill (from the dying process) would revert the status back to `'active'`. Fix: add `currentStatus !== 'stopped'` to the guard:
```javascript
if (currentStatus !== 'waiting_permission' && currentStatus !== 'stopped') {
  db.updateStatus(session_id, 'active');
}
```

`handleSessionEnded()` is an **async function** defined in `server.js` (it needs access
to `db`, pulse functions, debounce maps, and WS broadcast — all in server.js scope).
Callers invoke it **fire-and-forget** (do NOT await it in request handlers):
`handleSessionEnded(session_id).catch(err => console.error('[handleSessionEnded]', err))`.
This ensures the Kill endpoint returns 204 immediately and the SessionEnd hook handler
responds without blocking.

It performs:
- Flush pending file_change debounce entries for the session (sync — Map lookup + DB insert)
- Auto-briefing if session is a pulse member with `tool_count > 3` (async — spawns headless
  Claude Code, waits for result, stores entry)
- Team completion check if session is a team lead (sync — DB query + update)
- TODO notification if session is linked to a TODO (sync — DB query + WS broadcast).
  This replaces the existing TODO notification in both the Kill endpoint and cleanupZombies.
- Broadcast session_update to dashboard (sync)

This function is idempotent — calling it multiple times for the same session is safe.
Uses an in-memory `Set<session_id>` to track sessions already processed. On entry: if
session_id is in the processed Set, return immediately. Otherwise add it, verify
`status === 'stopped'`, then proceed. This prevents duplicate auto-briefing, duplicate
TODO notifications, etc. The Set persists for the server's lifetime.

**Restart safety:** On server restart, the Set is empty. A late `SessionEnd` event could
arrive for a session that was already processed before the restart. To prevent re-processing:
record the server start time (`const SERVER_START = new Date().toISOString()`). In
`handleSessionEnded`, if `session.updated_at < SERVER_START` (session was stopped in a
prior server lifetime), skip the substantive work (auto-briefing, TODO notification) —
only log a debug message. The debounce maps are empty after restart anyway, so the
debounce flush is naturally a no-op.

### Subagent Tracking

When CC receives a `SubagentStart` event, it creates a session row with:
- `session_id` = `payload.agent_id` (the subagent's unique identifier)
- `parent_session_id` = `payload.session_id` (the PARENT session — note: `session_id`
  in SubagentStart/Stop payloads is always the parent, not the child)
- `cli_type` = 'claude' (subagents are always Claude Code)
- `status` = 'active'
- Label derived from `agent_type` (e.g., "code-reviewer subagent")

Subagent sessions appear as **nested cards** under the parent session in the UI. They
share the parent's project and are auto-subscribed to the same main pulse. When the
subagent stops, CC marks it stopped and stores the subagent's result as a pulse entry.
The `SubagentStop` payload includes `last_assistant_message` (the subagent's final
response text) and `agent_transcript_path`, so no transcript parsing is needed —
use `last_assistant_message` directly if it has substantive content.

Schema changes for sessions table:
```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN last_idle_signal TEXT DEFAULT NULL;
```

`last_idle_signal` stores the timestamp of the most recent `TeammateIdle` hook event
for this session. Used as an authoritative idle signal for briefing (more reliable than
transcript polling). Updated in the `TeammateIdle` handler (Phase 2). The UPDATE
statement should also set `updated_at = datetime('now')` so that SessionCard's memo
comparison (which checks `updated_at`) triggers a re-render when idle signal changes.

**New prepared statements for these columns:**
- `setParentSession`: `UPDATE sessions SET parent_session_id = @parent_id, updated_at = datetime('now') WHERE session_id = @id` — called from `SubagentStart` handler to link child to parent. Neither `upsertSession` nor `updateSession` accepts `parent_session_id`, so this needs its own statement.
- `setLastIdleSignal`: `UPDATE sessions SET last_idle_signal = @ts, updated_at = datetime('now') WHERE session_id = @id` — called from `TeammateIdle` handler.

**Query impact:** The `getSession`, `getAllSessions`, `getActiveSessions`, and
`getSessionsByProject` queries all use `SELECT s.*` so they'll automatically include
`parent_session_id` and `last_idle_signal`. However, `searchSessions` (session history)
uses explicit column names — add `s.parent_session_id` and `s.last_idle_signal` to its
SELECT list. The `upsertSession` and `ensureSession` INSERT statements don't need changes
since both new columns have DEFAULTs.

---

## Compaction & Dream Cycle

Over time, pulse entries accumulate and become stale. The dream cycle consolidates
old entries, mines session transcripts for uncaptured knowledge, resolves contradictions,
and verifies that referenced files still exist.

**Inspiration:** Claude Code's unreleased Auto-Dream feature (behind feature flag
`tengu_onyx_plover`) performs a similar four-phase memory consolidation cycle during
idle time: orient → gather signal → consolidate → prune. CC's dream cycle adapts this
concept with two structural advantages: (1) CC has structured data in SQLite (file_edits,
events, heartbeats) so the "gather signal" phase can be SQL queries instead of transcript
grep, and (2) CC sees ALL sessions across ALL agents (Claude, Gemini, Codex) for a project,
not just one CLI instance's history.

### Mechanism

A temporary headless Claude Code process handles the dream cycle, spawned via
`child_process.spawn` with stdin piping (not tmux — no dashboard card, no hooks):

```javascript
// Use spawn (not execFile) with stdin to avoid argv length limits on long prompts.
// execFile passes the prompt as an argument, which has platform-dependent limits
// (~128KB on Linux). Dream prompts with many old entries + transcript excerpts
// can exceed this. Piping via stdin has no practical limit.
import { spawn } from 'node:child_process';

const proc = spawn('claude', [
  '-p', '-',                    // '-' reads prompt from stdin
  '--output-format', 'stream-json',
  '--bare'  // skip hooks, MCP servers, CLAUDE.md — prevents this process from
            // firing SessionStart/PostToolUse/SessionEnd hooks back to CC server
]);

// NOTE: spawn() does NOT accept a `timeout` option (only execFile/exec do).
// Implement timeout manually with setTimeout + proc.kill().
const killTimer = setTimeout(() => { proc.kill(); }, 180_000);

proc.stdin.write(dreamPrompt);
proc.stdin.end();

let stdout = '';
proc.stdout.on('data', (chunk) => { stdout += chunk; });
proc.on('close', (code) => {
  clearTimeout(killTimer);
  // Parse stream-json output: each line is a JSON event.
  // Extract the final assistant message text from the 'result' event.
});
```

**CLI flag verification (required before Phase 6 implementation):** The `--bare` flag
and `--output-format stream-json` format are assumed based on Claude Code CLI capabilities.
Before implementing Phase 6, verify these flags exist in the installed Claude Code version:
`claude --help | grep -E 'bare|output-format'`. If `--bare` is not available, use
`--no-hooks` or equivalent flag to suppress hook events. If `stream-json` is not available,
use `--output-format json` and adjust the parsing logic accordingly. The `-p -` (read
prompt from stdin) pattern should also be verified.

This process:
- Does NOT appear in session cards — it's a `child_process`, not a tmux session.
  The `--bare` flag prevents ALL hooks from firing, so no SessionStart/SessionEnd/
  PostToolUse events reach the CC server. Without `--bare`, native HTTP hooks
  configured in `~/.claude/settings.json` would fire and spam the server with
  unwanted events from these utility processes.
- Uses Claude Code's own model (not DeepSeek) for better summarization quality
- Is short-lived: one prompt, one response, then exits automatically
- Has a 180-second timeout via `setTimeout` + `proc.kill()` (longer than basic compaction because
  the prompt includes transcript excerpts and staleness data)
- On timeout, the process is killed and the dream is skipped (entries just accumulate)

### Triggers

- **Manual:** "Dream" button in the pulse panel (replaces "Compact")
- **Automatic (main pulse):** When entry count exceeds 100, or oldest uncompacted entry
  is >24 hours old
- **Automatic (topic pulses):** When entry count exceeds 50
- **Activity-based:** When a session with tool_count > 10 stops without having produced
  a briefing entry (knowledge was likely created but not captured)
- **Session-count gate:** At least 3 sessions stopped for the project since the last dream
  (prevents running on idle projects). Query:
  `SELECT COUNT(*) FROM sessions WHERE project = @project AND status = 'stopped'
  AND updated_at > (SELECT COALESCE(value, '1970-01-01') FROM stats WHERE key = 'dream:' || @pulse_id || ':last_run')`
  — compares session `updated_at` against stored dream timestamp. Sessions with any
  `tool_count` are counted (a session with 0 tools still represents user activity).

### Four-Phase Dream Process

**Phase 1 — Gather (server-side, before spawning Claude):**

CC assembles the dream context using structured data it already has. No AI needed yet.

1. Read all entries for the pulse, separate into "recent" (last 2 hours) and "old"
2. **Transcript mining:** Find sessions that stopped since the last dream with
   `tool_count > 3` and no `briefing` entry in `pulse_entries`. For each, call
   `readTranscriptStructured(session.transcript)` and extract the last 5 assistant
   messages. These are "uncaptured session excerpts."
3. **Staleness check:** Extract file paths mentioned in `file_change` and `briefing`
   entries. Run `fs.existsSync()` on each. Flag any that no longer exist.
4. **Conflict signals:** Query `file_edits` for files edited by multiple sessions
   since the last dream. These are potential contradiction zones.

**Phase 2 — Consolidate (headless Claude Code):**

Send the assembled context to the headless agent with a structured prompt:

```
You are performing a dream cycle — a reflective consolidation of this project's
shared knowledge base. Synthesize what was learned recently into durable,
well-organized knowledge so that future sessions can orient quickly.

## OLD ENTRIES (to consolidate):
{old pulse entries, oldest first}

## RECENT ENTRIES (keep as-is, but check for contradictions with old):
{entries from last 2 hours}

## UNCAPTURED SESSION ACTIVITY (extract if valuable):
{transcript excerpts from sessions that ended without briefing}

## STALE FILE REFERENCES (flagged for removal):
{list of file paths from entries that no longer exist on disk}

Tasks:
1. Merge and summarize the old entries into a concise knowledge document
2. If any old entries contradict newer ones, resolve in favor of newer information
   and note what changed
3. Extract any valuable patterns or decisions from uncaptured session excerpts
   (skip routine tool use — focus on decisions, discoveries, and blockers)
4. Remove or update any references to stale file paths
5. Output a single consolidated summary as markdown
```

**Phase 3 — Store (atomic):**

Wrap in a single SQLite transaction (`db.transaction(() => { ... })()`) to ensure
the compaction entry and old entry deletion are atomic. If either fails, neither
takes effect — the pulse retains its original entries and the dream can retry.

1. Store the response as a `compaction` entry on the pulse
2. Delete the original "old" entries by ID (collect their IDs in Phase 1 Gather step).
   The compaction entry replaces them.
3. Recent entries are preserved as-is (they may still be actively relevant)
4. If transcript mining produced new knowledge, it gets included in the compaction
   entry — no separate entry needed, keeping the pulse clean

**Phase 4 — Record:**

1. Store the dream timestamp in the `stats` table (key: `dream:{pulse_id}:last_run`,
   value: ISO datetime string stored as TEXT via `new Date().toISOString()`). Although
   `stats.value` is typed as REAL, SQLite is dynamically typed — storing a TEXT string
   in a REAL column works fine. Using ISO strings ensures the session-count gate query
   (`updated_at > value`) performs a correct string comparison (both sides are ISO
   datetime TEXT). Do NOT use Unix epoch numbers — `updated_at` is ISO TEXT, and
   SQLite's mixed-type comparison rules would make the filter unreliable.
   This requires a new prepared statement — the existing `statsStmts.increment` does
   `value = value + @delta` (additive), which doesn't work for overwriting timestamps.
   Add a `statsStmts.set` prepared statement: `INSERT INTO stats (key, value)
   VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value`.
2. Log what the dream did: entry count before/after, how many sessions were mined,
   stale references removed. Log to console (`console.log('[dream]', ...)`). No need
   for a separate entry type — the `compaction` entry itself is the durable record.

### Why This Is Better Than Basic Compaction

Basic compaction just summarizes old entries. The dream cycle adds three things that
significantly improve knowledge quality:

1. **Transcript mining** fills knowledge gaps — sessions where the user didn't click
   "Brief" still contribute their discoveries to the project knowledge base
2. **Contradiction resolution** prevents stale knowledge from misleading future agents —
   if an early session says "using REST" but a later session migrated to GraphQL, the
   dream catches this
3. **Staleness verification** is nearly free (just `fs.existsSync` calls) but prevents
   entries like "refactored auth into src/auth/middleware.js" from persisting after the
   file was deleted or renamed

---

## UI Changes

### Session Cards

**Pulse badges** — bottom-right of each card, next to kill button and other actions:
- Small colored pills showing pulse names (truncated if needed)
- Main pulse shown as a dot (always present for sessions with a project)
- Topic pulses shown as named pills (e.g., "Auth Refactor")
- Clicking a badge opens the pulse panel for that pulse
- Max 3 visible, "+N" overflow if more

**New actions in card menu:**
- "Brief" — dropdown showing available pulses → triggers briefing to selected pulse
- "Add to Pulse" — dropdown showing unsubscribed topic pulses → subscribe
- "Remove from Pulse" — shown for topic pulse badges → unsubscribe
- "Sync Pulse" — refresh the agent's pulse context

### Pulse Panel (Evolved)

**Tabbed interface:**
- One tab per pulse (Main + topic pulses)
- Each tab shows entries chronologically with:
  - Author label (session name or "You" for user notes)
  - Entry type icon (briefing, file change, status, note, compaction)
  - Timestamp (relative)
  - Content (markdown rendered)
- User can add notes directly (text input at bottom, replaces current textarea)
- "Dream" button per tab (consolidate + mine transcripts + verify staleness)
- Auto-refresh every 30s (existing behavior, extended to entries)

**Pulse management:**
- "New Pulse" button — name, optional description
- Edit pulse name/description (inline edit)
- Delete pulse (with confirmation — deletes all entries)
- Shows member sessions for each pulse

### Transcript View Integration

When a briefing exchange occurs (CC prompted the agent for a pulse update):
- Show as a special block, visually distinct from normal messages
- Header: "Pulse Update → {pulse_name}" with a document icon
- Collapsible — the prompt is hidden by default, only the agent's briefing is shown
- Different background color (subtle accent tint)

### Project Group Header

- Existing "Pulse" button remains, opens the main pulse tab
- Add a small badge showing total unread entries across all project pulses since last view

---

## API Routes

### Pulse CRUD

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/projects/:name/pulses` | All pulses for a project (includes entry counts) |
| `POST` | `/api/projects/:name/pulses` | `{name, description?}` — create topic pulse |
| `PATCH` | `/api/pulses/:id` | `{name?, description?}` — update pulse metadata |
| `DELETE` | `/api/pulses/:id` | Delete pulse + all entries (CASCADE). Returns 403 if `is_main = 1`. |

### Pulse Entries

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/pulses/:id/entries` | `?limit=50&before=<timestamp>` — paginated entries |
| `POST` | `/api/pulses/:id/entries` | `{content, entry_type?}` — add user note entry |
| `DELETE` | `/api/pulses/:id/entries/:entryId` | Delete a single entry |
| `POST` | `/api/pulses/:id/dream` | Trigger dream cycle (spawns headless Claude Code) |

### Pulse Membership

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/pulses/:id/members` | Sessions subscribed to this pulse |
| `POST` | `/api/pulses/:id/members` | `{session_id}` — subscribe session |
| `DELETE` | `/api/pulses/:id/members/:sessionId` | Unsubscribe session |

### Briefing

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/sessions/:id/brief` | `{pulse_id}` — trigger briefing prompt to agent |
| `POST` | `/api/sessions/:id/sync-pulse` | Inject current pulse content into agent |

### Assembled Pulse Content

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/pulses/:id/content` | Assembled markdown from entries (for display) |
| `GET` | `/api/sessions/:id/pulse-context` | Assembled content from all subscribed pulses (for injection) |

### Team Templates (Phase 8)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/team-templates` | All templates |
| `POST` | `/api/team-templates` | `{name, description, roles, coordinator_prompt}` — create template |
| `PUT` | `/api/team-templates/:id` | Update template |
| `DELETE` | `/api/team-templates/:id` | Delete template |
| `POST` | `/api/team-templates/:id/launch` | `{project, objective}` — launch a team from template |
| `GET` | `/api/teams` | `?project=X` — active and recent team instances |
| `GET` | `/api/teams/:id` | Team instance detail (lead session, member sessions, task status) |
| `POST` | `/api/teams/:id/stop` | Stop the team (kill all member sessions) |

### Backward Compatibility

Existing endpoints remain but delegate to new system:
- `GET /api/projects/:name/pulse` → assembles from main pulse entries
- `PUT /api/projects/:name/pulse/notes` → creates `user_note` entry on main pulse
- `GET /api/projects/:name/pulse/prompt` → calls new pulse-context assembly

---

## WebSocket Updates

New message types on `/ws/events`:

```typescript
// Server → client: new pulse entry added
{ type: 'pulse_entry', pulse_id: string, entry: PulseEntry }

// Server → client: pulse metadata changed (name, description)
{ type: 'pulse_update', pulse: Pulse }

// Server → client: pulse deleted
{ type: 'pulse_deleted', pulse_id: string }

// Server → client: membership changed
{ type: 'pulse_member_added', pulse_id: string, session_id: string }
{ type: 'pulse_member_removed', pulse_id: string, session_id: string }

// Server → client: subagent lifecycle
// NOTE: subagent_started REPLACES session_update for subagent sessions. The SubagentStart
// handler must NOT also broadcast session_update, otherwise the frontend adds the session
// twice. subagent_started carries the full Session object plus parent context.
{ type: 'subagent_started', parent_session_id: string, session: Session }
{ type: 'subagent_stopped', parent_session_id: string, session_id: string }

// Server → client: task events (from Agent Teams Task API hooks)
{ type: 'task_created', session_id: string, task_subject: string }
{ type: 'task_completed', session_id: string, task_subject: string }

// Server → client: team lifecycle (Phase 8)
{ type: 'team_launched', team: TeamInstance }
{ type: 'team_completed', team_id: string, summary: string }
```

---

## TypeScript Types

```typescript
interface Pulse {
  id: string;
  project: string;
  name: string;
  description: string;
  is_main: number;              // SQLite INTEGER 0/1, not boolean (matches pulse_enabled, auto_approve convention)
  entry_count: number;          // computed via subquery: (SELECT COUNT(*) FROM pulse_entries WHERE pulse_id = ?)
  created_at: string;
  updated_at: string;
}

interface PulseEntry {
  id: number;
  pulse_id: string;
  session_id: string | null;
  session_label?: string;       // joined from sessions table
  entry_type: 'briefing' | 'file_change' | 'status' | 'user_note' | 'compaction';
  content: string;
  created_at: string;
}

// On Session type, add:
interface Session {
  // ... existing fields ...
  parent_session_id?: string;   // if this is a subagent, points to spawning session
  last_idle_signal?: string;    // timestamp of most recent TeammateIdle event
  pulses?: Pulse[];             // which pulses this session belongs to
}

// Note: `pulses` on Session requires a secondary query. Don't add it to the main
// getAllSessions query — that would be N+1. Instead, fetch all memberships in one
// batch query and merge client-side:
//
// WebSocket init message shape (extends existing):
// {
//   type: 'init',
//   sessions: Session[],           // existing — from getAllSessions()
//   recentEvents: SessionEvent[],  // existing
//   pulseMemberships: Array<{ session_id: string, pulse_id: string, pulse_name: string, is_main: number }>
//   // ^ batch query: SELECT pm.session_id, pm.pulse_id, p.name AS pulse_name, p.is_main
//   //   FROM pulse_members pm JOIN pulses p ON pm.pulse_id = p.id
//   // Frontend groups by session_id to build each session's pulse list
// }
//
// This adds one query to the init path (bounded by pulse_members row count, typically
// small). Pulse entry content is NOT included in init — fetched on demand when user
// opens the PulsePanel.

// Team templates (Phase 8)
interface TeamRole {
  name: string;                 // e.g., "Reviewer", "Tester", "Researcher"
  description: string;          // what this role does
  agent_type: string;           // maps to .claude/agents/ definition name
  auto_approve: 'full' | 'readonly' | 'none';
}

interface TeamTemplate {
  id: string;                   // crypto.randomUUID()
  name: string;                 // e.g., "Full Dev Cycle", "Code Review Team"
  description: string;
  roles: TeamRole[];            // the team composition
  coordinator_prompt: string;   // system prompt for the team lead
  project?: string;             // optional: restrict to a specific project
  created_at: string;
  updated_at: string;
}

interface TeamInstance {
  id: string;
  template_id: string;
  project: string;
  lead_session_id: string;      // the team lead session
  status: 'active' | 'completed' | 'failed';
  objective: string;            // what the user asked the team to do
  created_at: string;
  completed_at?: string;
  summary?: string;             // final results summary
}
```

---

## Implementation Phases

### Phase 1: Schema + Migration + Core API + Hook Migration

**Files:** `db.js`, `pulse.js`, `server.js`, `hooks/`, `update.sh`

Schema & migration:
1. Add new tables (`pulses`, `pulse_members`, `pulse_entries`) to `db.js`
2. Add `parent_session_id TEXT` and `last_idle_signal TEXT` columns to sessions
   (for subagent tracking and TeammateIdle signal storage respectively)
3. Write migration: create main pulse per existing project, migrate user notes from
   `data/pulse/{project}.json` as `user_note` entries, and for each existing session
   with `pulse_enabled = 1`, insert into `pulse_members` linking to their project's
   main pulse (so existing active sessions become pulse members without needing to restart)
4. Add prepared statements for all CRUD operations (pulses, entries, membership)

Pulse rewrite:
5. Rewrite `pulse.js`: replace `generatePulse()` with entry-based `assemblePulseContent()`.
   Keep backward-compat wrappers for `getUserNotes()` / `setUserNotes()` / `getPulseForPrompt()`
   that delegate to new system. Add `getOrCreateMainPulse(project)` with lazy creation.
6. Remove `schedulePulseRegeneration()` from `server.js` — pulse content is now assembled
   on-demand from entries, not pre-generated and cached. Remove BOTH the function definition
   (line 295) and its two call sites (line 922 in heartbeat handler, line 957 in
   SessionStart/Stop handler). Also remove the `pulseDebounceTimers` map (line 294).
   Between Phase 1 and Phase 2, file edits will not trigger pulse entries (only recorded
   in `file_edits` table) — this is acceptable as a temporary gap.

Hook migration:
7. Update `/api/hooks` handler to accept both shell-script payload format and native
   HTTP hook format (detect via presence of `hook_event_name` field)
8. Add handlers for new event types: `SubagentStart`, `SubagentStop`, `TaskCreated`,
   `TaskCompleted`, `TeammateIdle`
9. Add native HTTP hook config for NEW events only (SubagentStart, SubagentStop,
   TaskCreated, TaskCompleted, TeammateIdle, SessionEnd) to `~/.claude/settings.json`
   hooks section, preserving existing shell script hooks for SessionStart/Stop/
   PermissionRequest/PostToolUse. No overlap = no duplicate processing. Keep shell
   scripts for Gemini/Codex.
10. Fix `gc-report.sh` line 15: change `SessionEnd) CC_EVENT="Stop"` to
    `SessionEnd) CC_EVENT="SessionEnd"`. Currently Gemini's SessionEnd (authoritative
    process-exit) is mapped to Stop (turn-end), so Gemini sessions never trigger
    `handleSessionEnded()`. This is a pre-existing bug, not introduced by the plan.
11. Update `update.sh` to deploy both: shell scripts (existing events) + native HTTP
    config (new events only)

Bridging:
12. Add `pulse_enabled` ↔ `pulse_members` bridging to the PATCH `/api/sessions/:id`
    handler: when `pulse_enabled` is written, also toggle pulse_members membership
    (add/remove from project's main pulse). This keeps the existing toggle working
    while the backend uses pulse_members as the source of truth. Removed in Phase 4.

API & WebSocket:
13. Implement new API routes (pulse CRUD, entries, membership)
14. Update existing pulse endpoints (`/api/projects/:name/pulse`, etc.) to delegate to new system
15. Add WebSocket broadcast for pulse events
16. Tests for all new endpoints + hook migration tests

**Checkpoint:** All existing tests pass + new API tests pass. Old pulse endpoints
still return the same shape (`{markdown, userNotes}`). Native HTTP hooks active for
Claude Code. Shell scripts still work for Gemini/Codex.

### Phase 2: Automatic Entries (File Changes + Subagents + Tasks)

**Files:** `server.js` (hook handler)

File change entries:
1. In the heartbeat handler, when `file_path` is present, batch and append
   `file_change` entries to the session's project main pulse
2. Debounce: in-memory `Map<session_id, { files: Set<string>, timer: Timeout }>` in
   `server.js`. Each heartbeat with `file_path` adds to the set and resets the 30-second
   timer. On timer fire, look up `session.project` — if null (SessionStart hasn't arrived
   yet), skip the pulse entry (the files are still recorded in `file_edits` table, so no
   data loss). If project exists, write one `file_change` entry listing all files, clear
   the set. This handles the race where heartbeats arrive before SessionStart — the
   `file_edits` table captures everything; pulse entries are enrichment that start flowing
   once SessionStart populates the project field (typically within 1-2 seconds).
3. Auto-subscribe new sessions to their project's main pulse (in the `SessionStart`
   hook handler and in `/api/sessions/launch`)

Subagent tracking:
4. On `SubagentStart`: create child session row using `agent_id` as session_id, set
   `parent_session_id` = payload `session_id` (which is the PARENT). Inherit project
   from parent, auto-subscribe to parent's main pulse. Generate `status` pulse entry:
   "[Session '{label}'] spawned subagent: {agent_type}"
5. On `SubagentStop`: mark child session (keyed by `agent_id`) stopped. Use
   `payload.last_assistant_message` directly as the pulse entry content (no transcript
   parsing needed). Store as a `briefing` entry if the message has substantive content
   (length > 50 chars and agent_type suggests meaningful work).

Task event bridge:
6. On `TaskCreated`: generate `status` pulse entry on the project's main pulse:
   "[Session '{label}'] created task: {task_subject}"
7. On `TaskCompleted`: generate `status` pulse entry: "[Session '{label}'] completed
   task: {task_subject}". If the session is linked to a CC TODO, update the TODO status.

TeammateIdle signal:
8. On `TeammateIdle`: store `last_idle_signal` timestamp on the session (new column
   added in Phase 1). This is used as an authoritative idle detection signal for
   briefing (Phase 5). Update via: `db.prepare('UPDATE sessions SET last_idle_signal = @ts WHERE session_id = @id')`.

Session-end detection:
9. Implement `handleSessionEnded(session_id)` as described in the "Session-End Detection"
   section. This is the centralized handler for all session-end actions. Wire it into:
   (a) the Kill endpoint (after `db.updateStatus(id, 'stopped')`),
   (b) the `SessionEnd` hook handler (look up session, verify tmux_target exists, mark
   stopped, call `handleSessionEnded`).
   Note: the `Stop` event is a turn-end signal, NOT a session-end signal. `SessionEnd`
   is the authoritative session-exit signal — see the "Session-End Detection" section.

Debounce cleanup (inside `handleSessionEnded`):
10. Flush any pending file_change debounce entries for the session (if the session's timer
    is still pending, clear it and immediately write the accumulated file changes). Then
    delete the session's debounce map entry to prevent memory leaks for long-running servers.

**Checkpoint:** File edits, subagent lifecycle, and task events automatically appear
as pulse entries. Subagent sessions display as nested under parent.

### Phase 3: Pulse Panel UI Evolution

**Files:** `client/src/components/PulsePanel.tsx` (rewrite existing), `PulsePanel.css`, new components

1. Rewrite existing PulsePanel (currently a simple modal with markdown display + notes textarea)
   as tabbed interface (main + topic pulses)
2. Render entries with author labels, type icons, timestamps
3. Add user note input (bottom of panel)
4. Add "New Pulse" creation flow
5. Add pulse management (edit name, delete)
6. Wire up WebSocket updates for real-time entry display
   ("Dream" button shown in UI design spec is deferred to Phase 6 — backend doesn't exist yet)

**Checkpoint:** Users can view pulse entries, create topic pulses, add notes.

### Phase 4: Session Card Integration

**Files:** `client/src/components/SessionCard.tsx`, `SessionCard.css`

1. Add pulse badges to session cards (query `pulse_members` → `pulses` for each session)
2. Add "Add to Pulse" / "Remove from Pulse" actions
3. Add "Brief" action (UI only — backend in Phase 5)
4. Add "Sync Pulse" action (UI only — backend in Phase 5)
   (Auto-subscribe to main pulse was done in Phase 2, step 3)
5. Remove old "Pulse On/Off" toggle from SessionCard. Remove the `pulse_enabled` ↔
   `pulse_members` bridging code from the PATCH handler (added in Phase 1 step 12).
   `pulse_members` is now the sole source of truth for pulse subscriptions.

**Checkpoint:** Session cards show pulse memberships. Users can manage subscriptions.

### Phase 5: Briefing System (Mechanisms A + B)

**Files:** `server.js`, `transcript.js`
(`pty-manager.js` not needed — prompt sending uses `execFileSync('tmux', ['load-buffer', ...])` already in server.js)

1. Implement idle detection using two signals (either sufficient):
   (a) `isLastTurnComplete(session.transcript)` from transcript.js (already exists), or
   (b) `session.last_idle_signal` is recent (within 60s) — set by TeammateIdle handler (Phase 2)
2. Implement `POST /api/sessions/:id/brief` — sends prompt via tmux load-buffer/paste-buffer,
   polls transcript with `readTranscriptStructured()`, captures response, stores entry
3. Implement `POST /api/sessions/:id/sync-pulse` — assembles and injects context
4. Add auto-briefing logic inside `handleSessionEnded()` (Phase 2 step 9). When a session
   ends and has `tool_count > 3` and is a pulse member: use transcript-based extraction
   via headless Claude Code (the agent is always gone by this point — see Mechanism B in
   "How Agents Contribute" section).
5. Add transcript view integration — special "Pulse Update" blocks
6. Handle edge cases: agent not responsive, agent confused by prompt, timeout

**Checkpoint:** Users can trigger briefings. Stopped sessions auto-brief. Transcript
shows briefing exchanges. This is the highest-risk phase — test thoroughly.

### Phase 6: Dream Cycle (Compaction + Transcript Mining + Staleness)

**Files:** `server.js` (new dream handler), `pulse.js`, `transcript.js`

Phase 6a — Basic compaction (get the plumbing working):
1. Implement headless Claude Code spawning via `child_process.spawn('claude', ['-p', '-', ...])`
   with stdin piping (same pattern as Dream Cycle "Mechanism" section). No tmux, no session
   card, no hooks. Parse `stream-json` output for the result.
2. Implement `POST /api/pulses/:id/dream` endpoint (basic: old entries → summarize → store)
3. Add "Dream" button to pulse panel UI
4. Add automatic triggers (entry count, age threshold, session-count gate)
5. Store last-dream timestamp in `stats` table (key: `dream:{pulse_id}:last_run`)

Phase 6b — Enhanced dream (add intelligence):
6. Add transcript mining: query sessions stopped since last dream with no briefing,
   read their transcripts via `readTranscriptStructured()`, extract last 5 assistant
   messages, include in dream prompt as "uncaptured session activity"
7. Add staleness check: extract file paths from entries, `fs.existsSync()` each one,
   pass flagged paths to dream agent for removal/update
8. Add contradiction resolution: include recent entries in dream prompt with explicit
   instruction to resolve conflicts in favor of newer information
9. Add activity-based trigger: auto-dream when a high-activity session (tool_count > 10)
   stops without a briefing entry

**Checkpoint:** Dream cycle consolidates old entries, mines uncaptured session knowledge,
resolves contradictions, and removes stale file references. Runs automatically.

### Phase 7: Enhanced Launch Integration

**Files:** `server.js` (launch handler), `pulse.js`

The launch handler already injects pulse content (lines 1056-1063 in server.js,
calling `pulse.getPulseForPrompt()`). This phase upgrades it to use the new system.

1. Update `POST /api/sessions/launch` to call `assembleProjectPulseContext(project)` instead
   of `getPulseForPrompt(project)`. At launch time, the session doesn't exist yet (it's
   registered when the SessionStart hook fires), so use the project-level assembler which
   includes the main pulse + any topic pulses the user selects in the launch modal.
   Also update `POST /api/todos/:id/launch` (same injection logic). For mid-session
   refresh (`sync-pulse`), use `assembleSessionPulseContext(sessionId)` which reads the
   session's actual memberships.
2. Configurable character budgets per pulse type (env vars or per-pulse settings)
3. On subscription change, optionally inject pulse content mid-session
4. When launching from a TODO, include relevant topic pulse content
5. Remove the old `getPulseForPrompt()` backward-compat wrapper (all callers now use
   the new system)

**Checkpoint:** New sessions get rich multi-pulse context at launch. Full feature complete.

### Phase 8: Agent Team Orchestration

**Files:** `server.js`, `db.js`, `client/src/components/TeamPanel.tsx`, `.claude/agents/`

**Depends on:** Phases 1-5 (hook handlers, pulse entries, briefing system, session card
integration) and Phase 7 (enhanced launch — the coordinator prompt uses
`assembleProjectPulseContext()` which Phase 7 introduces). Phase 6 (dream cycle) is
independent.

#### Concept

CC launches and monitors agent teams that perform end-to-end work autonomously.
**CC does NOT implement coordination logic** — Claude Code's Agent Teams handles task
delegation, dependency resolution, and teammate messaging natively. CC provides:
1. A launch interface (team templates with pre-defined role compositions)
2. Monitoring via hooks (SubagentStart/Stop, TaskCreated/Completed already ingested)
3. A dashboard showing team progress, task status, and results
4. A review workflow where the user sees results when the team is done

This is the same relationship CC has with individual sessions: CC launches, observes,
and presents — the AI agent does the actual work.

#### Team Templates

A team template defines a reusable team composition with specialized roles:

```
Template: "Full Dev Cycle"
├── Coordinator (team lead)
│   Prompt: "You are a senior engineering lead. Break the objective into tasks,
│   delegate to your teammates, review their work, and report final results.
│   Use Agent Teams to spawn teammates and the Task API to track work."
├── Researcher
│   Agent: .claude/agents/researcher.md
│   Permissions: readonly (Read, Grep, Glob, WebSearch, WebFetch)
├── Developer
│   Agent: .claude/agents/developer.md
│   Permissions: full
├── Reviewer
│   Agent: .claude/agents/reviewer.md
│   Permissions: readonly
└── Tester
    Agent: .claude/agents/tester.md
    Permissions: full (needs to run tests)
```

**Storage:** `team_templates` table in SQLite:
```sql
CREATE TABLE IF NOT EXISTS team_templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT DEFAULT '',
  roles               TEXT NOT NULL,       -- JSON array of TeamRole objects
  coordinator_prompt  TEXT NOT NULL,
  project             TEXT,                -- NULL = available for all projects
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);
```

**Pre-built templates** (shipped with CC, defined in `data/team-templates.json`):
Seeded into `team_templates` SQLite table on first run or update. On server startup,
read the JSON file and INSERT OR IGNORE each template (keyed by a deterministic ID
like `builtin-{name-slug}`). This lets users customize pre-built templates — edits are
stored in SQLite and won't be overwritten. Users can also create fully custom templates
via the API, which are only stored in SQLite.

1. **Code Review Team** — Coordinator + Reviewer + Tester. For thorough code review
   with automated test verification. User provides a PR or diff to review.

2. **Research & Plan** — Coordinator + Researcher. For investigating approaches,
   reading docs, analyzing tradeoffs, and producing a recommendation. User provides
   a question or feature idea.

3. **Full Dev Cycle** — Coordinator + Researcher + Developer + Reviewer + Tester.
   For end-to-end feature development. User provides a feature description; the team
   researches, implements, reviews, tests, and presents results.

4. **Bug Hunt** — Coordinator + Researcher + Developer + Tester. For investigating
   and fixing a bug. User provides a bug description or error message.

5. **Benchmark & Optimize** — Coordinator + Analyst + Developer + Tester. For
   performance profiling, identifying bottlenecks, implementing optimizations, and
   verifying improvements with benchmarks.

#### Specialized Role Definitions

Each role maps to a `.claude/agents/` definition. CC ships pre-built agent definitions
and deploys them during setup. Users can customize or create new roles.

**Researcher** (`.claude/agents/cc-researcher.md`):
```markdown
---
name: cc-researcher
description: Investigates approaches, reads docs, analyzes tradeoffs
tools: Read, Grep, Glob, WebSearch, WebFetch, Bash
model: inherit
---
You are a research specialist. Your job is to investigate the assigned topic
thoroughly and report findings concisely. Focus on:
- What approaches exist and their tradeoffs
- Relevant documentation, APIs, and prior art
- Risks, edge cases, and open questions
Do NOT modify any code. Report findings via the Task API.
```

**Reviewer** (`.claude/agents/cc-reviewer.md`):
```markdown
---
name: cc-reviewer
description: Code review, bug detection, security analysis
tools: Read, Grep, Glob, Bash
model: inherit
---
You are a senior code reviewer. Analyze the assigned code changes for:
- Correctness: logic errors, edge cases, off-by-one errors
- Security: injection, XSS, auth bypass, OWASP top 10
- Performance: N+1 queries, unnecessary allocations, blocking calls
- Style: consistency with existing codebase patterns
Report issues via the Task API with severity (critical/warning/info).
```

**Tester** (`.claude/agents/cc-tester.md`):
```markdown
---
name: cc-tester
description: Runs tests, improves coverage, validates changes
tools: Read, Grep, Glob, Bash, Write, Edit
model: inherit
---
You are a test engineer. Your responsibilities:
- Run the existing test suite and report results
- Identify untested code paths in the changes
- Write new tests for uncovered functionality
- Verify that all tests pass after changes
Report via the Task API. Include test output and coverage changes.
```

**Developer** (`.claude/agents/cc-developer.md`):
```markdown
---
name: cc-developer
description: Implements features and fixes
tools: Read, Grep, Glob, Bash, Write, Edit, MultiEdit
model: inherit
---
You are a software developer. Implement the assigned task following the
project's existing patterns and conventions. Keep changes minimal and focused.
Write tests for new functionality. Report completion via the Task API.
```

**Analyst** (`.claude/agents/cc-analyst.md`):
```markdown
---
name: cc-analyst
description: Benchmarks, performance profiling, impact analysis
tools: Read, Grep, Glob, Bash
model: inherit
---
You are a performance analyst. Your responsibilities:
- Run benchmarks and profile performance
- Identify bottlenecks and their root causes
- Measure impact of changes (before/after comparisons)
- Report findings with data and recommendations
```

#### Launch Flow

When the user clicks "Launch Team" in the project view:

1. **Select template** — dropdown of available templates (pre-built + custom)
2. **Provide objective** — text input: "What should this team do?"
3. **Configure (optional)** — adjust roles, permissions, add/remove teammates
4. **Launch** — CC creates a tmux session for the team lead with:

```javascript
const coordinatorPrompt = `${template.coordinator_prompt}

OBJECTIVE: ${objective}

TEAM COMPOSITION:
${template.roles.map(r => `- ${r.name}: ${r.description}`).join('\n')}

INSTRUCTIONS:
1. Analyze the objective and break it into discrete tasks
2. Use Agent Teams to spawn teammates for each role
3. Delegate tasks via the Task API
4. Monitor progress and review completed work
5. When all tasks pass your review, compile a final summary
6. The summary should include: what was done, key decisions, test results, and any remaining items
7. Write the summary as your final message — the user will see it in Control Center

PROJECT CONTEXT:
${assembleProjectPulseContext(project)}`;

const tmuxTarget = ptyManager.createTmuxSession({
  label: `Team: ${template.name}`,
  cwd: projectCwd,
  initialPrompt: coordinatorPrompt,
  cli_type: 'claude',
});
```

5. **Track** — CC creates a `team_instances` row with `lead_session_id = NULL` (the
   session doesn't exist yet — it's created when the SessionStart hook fires) and stores
   `teamInstanceId` in the `pendingLabels` map (same pattern as `todoId` for TODO
   launches). When the SessionStart hook fires, the handler reads `teamInstanceId` from
   `pendingLabels` and updates `team_instances SET lead_session_id = @session_id WHERE
   id = @teamInstanceId`. Then monitors via hooks:
   - `SubagentStart` → register teammate sessions under the team (match via
     `parent_session_id` pointing to the team lead's session)
   - `TaskCreated` / `TaskCompleted` → track task progress
   - `TeammateIdle` on the lead → team may be finishing up
   - Session-end detection on the lead → team is done, extract final summary
     (Note: `Stop` is a turn-end signal, not session-end. Use `handleSessionEnded()`
     which fires from Kill endpoint or `SessionEnd` hook — see "Session-End Detection")

6. **Present results** — when the team lead's session ends (detected by `handleSessionEnded`):
   - Extract the final assistant message from the lead's transcript
   - Store as a `briefing` pulse entry on the project's main pulse
   - Mark the `team_instances` row as completed with the summary
   - Broadcast `team_completed` WS event → UI shows results notification

```sql
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
```

**FK behavior:** `template_id` intentionally has no `ON DELETE CASCADE` — deleting a
template that has team instances will fail with a constraint error. This is the safest
default: team instances are historical records of past work and shouldn't disappear
when a template is deleted. The `DELETE /api/team-templates/:id` endpoint should check
for existing team_instances first and return 409 Conflict with a helpful message.
`lead_session_id` also has no CASCADE — this means the existing
`deleteStoppedSessionsOlderThan()` cleanup (db.js line 462) will fail on sessions
referenced by `team_instances`. Fix: update the cleanup query to skip sessions that
are referenced as `lead_session_id` in `team_instances`, OR set `lead_session_id = NULL`
before deleting the session (preferred: `UPDATE team_instances SET lead_session_id = NULL
WHERE lead_session_id IN (SELECT session_id FROM sessions WHERE ...)` before the DELETE).

#### Team Progress UI

**Team Panel** (new component, accessible from project header):
- List of active and recent teams for the project
- Each team shows: template name, objective, status, duration
- Expanding a team shows:
  - The team lead session card
  - Nested teammate/subagent session cards (from `parent_session_id`)
  - Task list with status indicators (pending/in_progress/completed)
  - Task dependency graph (if dependencies exist)
  - Final summary when complete

**Session cards for team members:**
- Show a "Team: {name}" badge (similar to pulse badges)
- Subagent cards are visually nested under the team lead
- Color-coded by role (researcher=blue, developer=green, reviewer=orange, tester=purple)

**Results notification:**
- When a team completes, show a toast: "Team '{name}' completed — click to view results"
- The results view shows the summary + links to all sessions for detailed transcripts
- User can give feedback directly in the results view (typed into the team lead's tmux
  pane, restarting the team if the session is still alive)

#### Why This Is Low-Risk

CC's backend work for team orchestration is minimal because:

1. **No coordination logic** — Claude Code's Agent Teams handles task DAG, dependency
   unblocking, teammate messaging, and file locking. CC just launches the lead.
2. **Hooks already ingested** — SubagentStart/Stop and TaskCreated/Completed are handled
   in Phase 2. Team progress tracking is just querying those events.
3. **Existing launch mechanism** — `ptyManager.createTmuxSession()` + initial prompt is
   how all sessions launch. Team launch is the same, with a richer prompt.
4. **Schema is simple** — two new tables (`team_templates`, `team_instances`), both
   straightforward CRUD.
5. **The complexity lives in the prompts** — the coordinator prompt engineering determines
   team quality. If a template doesn't work well, the fix is a prompt edit, not a code change.

The risk is in **prompt engineering quality**, not in CC's infrastructure. A bad coordinator
prompt produces a disorganized team — but CC's infrastructure is unaffected. Ship with
conservative pre-built templates, iterate on prompts based on real usage.

#### Implementation Steps

Phase 8a — Templates & launch (backend):
1. Add `team_templates` and `team_instances` tables to `db.js`
2. Implement template CRUD API endpoints
3. Implement `POST /api/team-templates/:id/launch` — create tmux session for team lead
   with assembled coordinator prompt + pulse context
4. Deploy pre-built agent definitions to `.claude/agents/` (via `update.sh`)
5. Ship 5 pre-built team templates in `data/team-templates.json`
6. Track team lifecycle: wire `handleSessionEnded()` to detect lead session end,
   extract final summary from transcript, update `team_instances` status to 'completed'

Phase 8b — Team progress UI (frontend):
7. Team Panel component (list teams, expand for detail)
8. Task progress display (from TaskCreated/TaskCompleted events)
9. Nested subagent session cards (from parent_session_id)
10. Results notification and review workflow
11. Role-colored badges on session cards

Phase 8c — Refinement:
12. Template editor UI (create/edit templates in the dashboard)
13. "Give feedback" flow — send follow-up prompt to team lead for revisions
14. Team history view — past teams with their results and durations
15. Team timeout enforcement: on team launch, set a `setTimeout` for 60 minutes
    (configurable via `CC_TEAM_TIMEOUT_MINUTES` env var). On fire: send "wrap up now"
    prompt to team lead via tmux. Set a second 15-minute grace timer. If the lead's
    session is still active after grace, force-stop all team sessions. Store timer
    handles in a `Map<team_id, { warnTimer, killTimer }>` and clear on normal completion.

**Checkpoint:** Users can launch pre-built agent teams from the dashboard, monitor
progress in real-time, and review results when complete. Custom templates supported.

### Existing Code That Needs Updates Per Phase

This section catalogs specific existing code that must be updated in each phase,
based on codebase verification. Not updating these will cause bugs.

**Phase 1 (Schema + Hooks):**
- `db.js`: Add `parent_session_id TEXT DEFAULT NULL` and `last_idle_signal TEXT DEFAULT NULL`
  migrations (try/catch ALTER TABLE, same pattern as existing migrations at lines 29-35)
- `db.js`: Add `statsStmts.set` prepared statement (`INSERT ... ON CONFLICT DO UPDATE
  SET value = @value`) for direct value writes (timestamps). Existing `increment` does
  `value + @delta` which breaks for non-additive values.
- `db.js`: Add `parent_session_id` and `last_idle_signal` to `searchSessions` SELECT list
  (it uses explicit column names, not `s.*`, so new columns won't appear without this)
- `server.js` `/api/hooks` handler: The existing validation guard (line 795) requires
  `payload.event && payload.session_id`, which will reject native HTTP hooks (they use
  `hook_event_name`, not `event`). Update the guard to:
  `if (!payload || (!payload.event && !payload.hook_event_name) || !payload.session_id)`.
  Then add format detection based on presence of `hook_event_name` field. Normalize both
  to internal format. Native HTTP is only used for new events (SubagentStart, SubagentStop,
  TaskCreated, TaskCompleted, TeammateIdle, SessionEnd) — no overlap with shell script events.
- `server.js`: Add `SessionEnd` handler that looks up session by `session_id`, verifies
  it has a `tmux_target` (skip headless), marks stopped, and calls `handleSessionEnded()`.
- `server.js`: PermissionRequest is still shell-script only (no native HTTP overlap), so
  the response format stays `{auto_approve: true}`. No change needed here.
- `server.js` `/api/hooks` handler: Add new event handlers for `SubagentStart`,
  `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `SessionEnd` (Phase 1
  step 8). These use native HTTP payload format (`hook_event_name` instead of `event`).
  The normalization logic (step 7) must run before these handlers.
- `hooks/gc-report.sh` (line 15): Fix `SessionEnd` mapping — currently maps to `Stop`
  (which is a turn-end signal). Change to pass through as `SessionEnd`:
  `SessionEnd) CC_EVENT="SessionEnd" ;;`
  Without this fix, Gemini sessions never fire the authoritative session-exit signal.
- `update.sh`: Add native HTTP hook config deployment to `~/.claude/settings.json`
  (merge into existing hooks section, don't overwrite non-CC hooks). Use `jq` for
  JSON manipulation (available at `/home/zapperz/miniconda3/bin/jq`). Back up
  existing settings.json before modification.

**Phase 2 (Automatic Entries):**
- `server.js` SessionStart handler (line 802): After session creation, call
  `getOrCreateMainPulse(project)` and insert into `pulse_members`.
- `server.js` heartbeat handler (line 902): Add file_change debounce map and pulse entry
  creation. (`schedulePulseRegeneration()` call sites already removed in Phase 1 step 6.)
- `server.js` Stop handler (line 869): Add `currentStatus !== 'stopped'` to the guard.
  Currently only checks `!== 'waiting_permission'`, so a Stop event arriving after Kill
  (from the dying process) reverts the status back to 'active'. The fix:
  `if (currentStatus !== 'waiting_permission' && currentStatus !== 'stopped')`
- `server.js`: Add `handleSessionEnded(session_id)` function and wire it into:
  (a) Kill endpoint (line 1162, after `db.updateStatus`), and
  (b) the new `SessionEnd` hook handler (look up session by session_id, verify it has a
  `tmux_target`, mark stopped, call `handleSessionEnded`).
  `handleSessionEnded` flushes file_change debounce, triggers auto-briefing, and handles
  team completion. Also refactor `cleanupZombies()` (line 260) to call `handleSessionEnded()`
  for each zombie instead of directly sending `todo_session_stopped` — centralizes all
  session-end logic in one place.

**Phase 3 (Pulse Panel UI):**
- `client/src/types.ts`: Add Pulse, PulseEntry interfaces. Extend WSIncoming union with
  new message types. Update PulseDocument or replace with new types.
- `client/src/api.ts`: Add all new pulse API functions. Keep existing `getPulse()` and
  `updatePulseNotes()` working (backward compat endpoints).
- `client/src/hooks/useWebSocket.ts`: Add cases to switch statement (line 121) for new
  WS message types. Currently has no default case — new types are silently ignored.

**Phase 1→4 transition — `pulse_enabled` bridging:** Between Phase 1 (backend uses
`pulse_members`) and Phase 4 (frontend replaces the toggle), the SessionCard still has
a "Pulse On/Off" toggle that writes `pulse_enabled` via PATCH. During this window, the
PATCH handler must ALSO toggle `pulse_members` membership (add/remove from main pulse)
when `pulse_enabled` is written. This ensures the toggle still works while the backend
uses the new system. Phase 4 removes the toggle and the bridging code.

**Phase 4 (Session Card Integration):**
- `client/src/components/SessionCard.tsx`: Add pulse badges, remove old "Pulse On/Off"
  toggle. Update React.memo comparison (lines 298-306): replace `pulse_enabled` with a
  stable pulse comparison. Since `pulses` is an array and `===` always returns false for
  different references, compare a derived value instead — e.g., `prev.session.pulseVersion
  === next.session.pulseVersion` (a counter bumped on pulse_member_added/removed WS events)
  or `JSON.stringify(prev.session.pulses) === JSON.stringify(next.session.pulses)` (simpler
  but allocates on every comparison — acceptable for small arrays).
- `client/src/api.ts`: Update `patchSession` type (line 57) if new patchable fields added.

**Phase 5 (Briefing):**
- `server.js`: The input sending mechanism (line 1135-1141, load-buffer/paste-buffer)
  is the same one used for briefing prompts. No new mechanism needed.
- `client/src/components/TranscriptView.tsx`: Add special rendering for briefing entries
  (detect via entry content pattern or a new field on TranscriptEntry).

**Phase 6 (Dream Cycle):**
- `server.js`: Add `POST /api/pulses/:id/dream` handler. Spawns headless Claude Code
  via `child_process.spawn` (same pattern as auto-briefing). No existing handlers modified.
- `pulse.js`: Add dream-specific helpers (gather old entries, separate recent vs old,
  extract file paths from entries for staleness check). These are new functions, not
  modifications to existing ones.
- `transcript.js`: No changes — uses existing `readTranscriptStructured()` for transcript
  mining of unbriefed sessions.
- `db.js`: Add `statsStmts.set` prepared statement (if not already added in Phase 1 step 4).
- `client/src/components/PulsePanel.tsx`: Add "Dream" button (deferred from Phase 3).

**Phase 7 (Enhanced Launch):**
- `server.js` launch handler (line 1059): Replace `pulse.getPulseForPrompt(project)` call
  with `pulse.assembleProjectPulseContext(project)`. Same location, different function.
- `server.js` TODO launch handler: Same change as above for `POST /api/todos/:id/launch`.
- `pulse.js`: Remove `getPulseForPrompt()` backward-compat wrapper (all callers now use
  the new system). Remove `getUserNotes()` / `setUserNotes()` wrappers if not already
  removed in Phase 3.

**Phase 8 (Teams):**
- `server.js` SessionStart handler: Add `teamInstanceId` check in `pendingLabels` map
  (same pattern as `todoId` at line 846). When present, link the session to the team
  instance by updating `team_instances.lead_session_id`.
- `server.js`: Team launch uses its own endpoint (`POST /api/team-templates/:id/launch`)
  but the same underlying mechanism as regular session launch: `ptyManager.createTmuxSession()`
  + `pendingLabels` map. The `pendingLabels` map already supports `todoId` — extend it with
  `teamInstanceId` using the same pattern.
- `server.js`: Wire `handleSessionEnded()` to check if the ended session is a team lead
  (`team_instances.lead_session_id`). If so, extract final summary and mark team completed.
- `pty-manager.js`: No changes needed — `createTmuxSession()` already handles the
  label/cwd/prompt/cli_type interface that team launch requires.

### Post-Implementation Cleanup

- Update `CLAUDE.md` with new API endpoints, tables, and WebSocket message types
- Update test count baseline (currently "121+ tests")
- Remove deprecated `data/pulse/*.json` files after confirming migration success
- Remove `pulse_enabled` column from sessions (replaced by pulse_members)

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Briefing prompt confuses the agent | Agent goes off-track, produces garbage | Clear prompt framing with delimiters. Timeout and discard on nonsense. Only prompt when idle. |
| Response capture misidentifies content | Wrong text stored as briefing | Use transcript timestamps: capture only the first assistant entry after the prompt timestamp. |
| Pulse context bloats context budget | Agent performance degrades from too much context | Strict per-pulse character budgets (6000 main + 3000 per topic). Truncate oldest entries first. User can see injection preview. |
| Compaction loses important info | Agent summaries omit critical details | Keep recent entries uncompacted (2h buffer). User can view compaction history. |
| Too many pulse entries (noisy) | Main pulse becomes a stream of file changes | Debounce file changes aggressively (30s batches). Separate "activity" from "knowledge" in the UI. |
| Dream cycle headless Claude Code fails | Dream hangs or produces bad output | 180-second timeout (via `spawn` + manual kill). On failure, skip dream (entries just accumulate). Log error. |
| Transcript mining extracts noise | Low-value or misleading content enters pulse | Only mine sessions with tool_count > 3. Dream prompt says "focus on decisions, discoveries, and blockers — skip routine tool use." Agent curates, not raw extraction. |
| Staleness check false positives | Valid files flagged as missing (e.g., on different branch) | Only flag, don't auto-delete. Dream agent sees the flag and uses judgment. Files on other branches will reappear — conservative approach. |
| Dream runs too frequently / too rarely | Wasted compute or stale knowledge | Dual gate (entry count/age threshold AND session-count gate). Manual "Dream" button as escape hatch. |
| Migration breaks existing pulse behavior | Users lose notes or see errors | Backward-compatible API endpoints. Migrate notes as entries. Keep old JSON files as backup. |
| Auto-briefing on session end races agent exit | Agent always gone | Not a race: `tmux kill-session` is synchronous (`execFileSync`), and `SessionEnd` fires after process exit. The agent is always dead by the time `handleSessionEnded` runs. Auto-briefing uses transcript extraction via headless Claude Code exclusively — no attempt to prompt a live agent. |
| Session-end detection misses exits | Session stays 'active' despite agent being gone | Three layers: (1) `SessionEnd` hook event (authoritative), (2) Kill endpoint, (3) zombie cleanup as safety net. `Set<session_id>` prevents multiple handleSessionEnded calls. |
| Stop event reactivates killed session | Killed session shows as 'active' briefly | Stop handler updated to check `currentStatus !== 'stopped'` in addition to `!== 'waiting_permission'`. Prevents Stop events from dying process reverting Kill endpoint's status change. |
| Dual hook firing creates duplicates | Double file_edit records, double broadcasts | Shell scripts and native HTTP hooks configured for DIFFERENT events (no overlap). Shell scripts handle existing events; native HTTP handles new events only. |
| Headless Claude Code fires hooks | Dream cycle / fallback briefing creates unwanted sessions | Use `--bare` flag on headless `claude -p` calls. This skips all hooks, MCP servers, and CLAUDE.md — prevents hook events from reaching the CC server. |
| Headless Claude Code not installed | Compaction/fallback briefing fails | Check for `claude` binary on startup. Log warning if missing. Compaction simply skipped. |
| CLI flags (`--bare`, `stream-json`) don't exist | Dream cycle / auto-briefing can't run | Verify flags before Phase 6 implementation (see CLI flag verification note in Dream Cycle section). Fall back to `--no-hooks` or `--output-format json` if needed. |
| Coordinator prompt produces disorganized team | Teammates work on wrong things or duplicate effort | Conservative pre-built templates tested manually before shipping. Coordinator prompt includes explicit task breakdown instructions. Easy to iterate — fix is a prompt edit, not code. |
| Team spawns too many subagents | Resource exhaustion (CPU, API rate limits) | Coordinator prompt caps teammates at role count. CC enforces max 8 active sessions per team (configurable via `CC_MAX_TEAM_SESSIONS`, default 8). Kill team if cap exceeded. |
| Team runs indefinitely (no completion) | Wasted API credits, stuck dashboard state | 60-minute timeout on team instances (configurable via `CC_TEAM_TIMEOUT_MINUTES`). On timeout, send "wrap up" prompt to team lead via tmux. 15-minute grace period, then force-stop all team sessions. Timer handles stored in memory map, cleared on normal completion. |
| Native HTTP hooks not supported by user's Claude Code version | Hook events don't reach CC | Detect during setup: if Claude Code version < 2.1.32, fall back to shell scripts. Log warning suggesting upgrade. |
| SubagentStart fires before parent session registered | parent_session_id lookup fails | Use `ensureSession()` (INSERT OR IGNORE) for parent before creating child row. Same pattern used for heartbeats today. |

---

## Future Enhancements (Post-Implementation)

- **D. MCP server integration** — CC as an MCP server for native agent read/write access
  to pulses without tmux prompt injection
- **URL-based routing** — deep links to specific pulses (`/project/:name/pulse/:pulseId`)
- **Pulse templates** — pre-defined topic pulse structures for common workflows
  (e.g., "Investigation" template with sections for Findings, Decisions, Open Questions)
- **Cross-project pulses** — share knowledge between related projects
- **Pulse search** — FTS5 index on pulse_entries for searching across all project knowledge
- **Cross-pulse dream** — a second dream pass that looks across all project pulses to
  reorganize: move entries to more appropriate topic pulses, merge related topic pulses,
  suggest new topic groupings. Deferred because the value is marginal until users have
  many topic pulses.
- **Git worktree isolation for teams** — launch each team member in an isolated git
  worktree (separate branch per agent). CC manages worktree creation, assigns branches,
  and provides a merge queue UI for consolidating work. Every community multi-agent system
  uses worktrees — this is the natural next step for team-based work.
- **Agent Teams filesystem watcher** — beyond hook-based tracking, directly watch
  `~/.claude/teams/` and `~/.claude/tasks/` directories for changes. This would catch
  teams created outside CC (e.g., user spawns a team from the terminal) and surface them
  in the dashboard. Lower priority since hook-based tracking covers CC-launched teams.

---

## Relationship to Claude Code Agent Teams

CC and Agent Teams are **layered, not competing**. Agent Teams is the runtime coordination
engine (task DAG, teammate messaging, file locking). CC is the platform layer on top
(launch, monitor, present results, persist knowledge).

| Concern | Agent Teams (Runtime) | CC (Platform) |
|---|---|---|
| Task coordination | Task files + dependency DAG | Launches teams, displays task progress |
| Teammate spawning | TeammateTool operations (13 ops) | Tracks via SubagentStart/Stop hooks |
| Knowledge sharing | Mailbox messages (ephemeral) | Curated briefings + persistent pulse entries |
| Multi-CLI support | Claude Code only | Claude + Gemini + Codex |
| User visibility | Hidden in `~/.claude/teams/` files | Full dashboard UI with team progress view |
| Persistence | Filesystem (cleaned up on team delete) | SQLite (persists indefinitely) |
| Configuration | Manual (env vars, CLI flags) | Template-based (pre-built + custom roles) |

**How they work together:**
1. CC defines team templates (role compositions, coordinator prompts)
2. CC launches the team lead as a tmux session with the coordinator prompt
3. The team lead uses Agent Teams natively to spawn teammates and delegate tasks
4. CC ingests hook events (SubagentStart/Stop, TaskCreated/Completed) to track progress
5. CC displays team progress in the dashboard
6. When the team completes, CC extracts results and stores them as pulse entries
7. Pulse context (shared knowledge from past teams) is injected into future team launches

The team lead doesn't know or care that CC exists. It just uses Agent Teams normally.
CC observes from the outside via hooks and provides the user-facing experience.

---

## Relationship to Claude Code Auto-Dream

Claude Code's Auto-Dream (unreleased, behind feature flag `tengu_onyx_plover`) performs
periodic memory consolidation on a single CLI instance's auto-memory files. It runs a
background subagent that reviews, consolidates, prunes, and reorganizes `~/.claude/projects/
<project>/memory/` files between sessions. Inspired by the "Sleep-time Compute" paper
(UC Berkeley + Letta, 2025) showing that idle-time pre-computation reduces inference cost.

CC's dream cycle is adapted from this concept but has structural advantages:

| Concern | Claude Code Auto-Dream | CC Pulse Dream |
|---|---|---|
| Data sources | Transcript JSONL grep | SQLite queries + transcript reads |
| Scope | Single CLI instance's memory | All sessions across all agents (Claude/Gemini/Codex) |
| Trigger | 24h + 5 sessions (dual gate) | Entry count + age + session-count + activity-based |
| Output | Updated memory files | Compaction entries in SQLite |
| Staleness check | Checks files in codebase | `fs.existsSync()` on referenced paths |
| Contradiction handling | Resolves across memory entries | Resolves across entries + recent session data |
| Transcript mining | Grep for corrections/patterns | `readTranscriptStructured()` on unbriefed sessions |
| Visibility | Hidden background process | "Dream" button in UI + dream metadata in pulse panel |

Key difference: Auto-Dream is a **per-instance** process that only sees what one Claude
Code session has accumulated. CC's dream cycle is a **project-level** process that sees
the aggregate knowledge from all agents and all sessions. This makes CC's version better
at detecting cross-session contradictions and extracting patterns that no single agent saw.

CC's dream does NOT replace Claude Code's Auto-Dream — they operate on different data.
Auto-Dream consolidates per-instance memory (preferences, corrections). CC's dream
consolidates project-level shared knowledge (decisions, progress, findings).

---

## Community Research Basis

The design in this plan was informed by studying existing multi-agent orchestration
systems. Key projects and what we learned from each:

| Project | Key Pattern Adopted | What CC Does Differently |
|---|---|---|
| **Overstory** (SQLite mail, worker types) | Typed message system, role specialization | CC uses pulse entries (richer schema) instead of raw mail. Roles defined as Claude Code agent definitions. |
| **Citadel** (wave-based execution) | Discovery relay (~500-token briefs between waves) | CC's briefing system serves the same purpose. Dream cycle adds automatic consolidation. |
| **Agent Farm** (prompt-based coordination) | Coordination protocol in prompts, not code | CC's coordinator prompt handles delegation. No runtime synchronization needed. |
| **IttyBitty** (minimal bash+tmux) | PreToolUse hook for path validation, tmux send-keys | CC already uses tmux. Could adopt worktree isolation per team in future. |
| **Multiclaude** (daemon+state.json+worktrees) | Supervisor agent, merge queue, atomic state writes | CC's team lead serves as supervisor. Merge queue is a future enhancement. |
| **Gas Town** (git-backed issues, hierarchy) | Agent hierarchy (Mayor→Rigs→Polecats), session discovery | CC's team templates define hierarchy. Subagent tracking provides discovery. |
| **disler/observability** (12 hook scripts→SQLite→WS→Vue) | Full hook event ingestion with real-time UI | CC does this already. Native HTTP hooks replace the 12 script approach. |

**Key architectural insight from the community:** Every successful multi-agent system
uses the same three primitives: (1) isolated workspaces (git worktrees or separate dirs),
(2) persistent terminals (tmux), (3) structured communication (SQLite or filesystem JSON).
CC already has (2) and (3). Worktree isolation is deferred to a future enhancement but
is the natural next step for team-based work.
