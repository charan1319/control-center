# Pulse Evolution — Shared Working Memory for Multi-Agent Collaboration

Implementation plan for evolving the Pulse system from a simple project status display
into a multi-document shared working memory system that enables cross-session knowledge
sharing between AI coding agents.

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
   (Exception: compaction replaces old entries with a summary — see Compaction section.)
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
  entry_type  TEXT DEFAULT 'note' CHECK(entry_type IN ('briefing','file_change','status','user_note','compaction')),
  content     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pulse_entries_pulse ON pulse_entries(pulse_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pulse_entries_session ON pulse_entries(session_id);
```

**Note:** `ON DELETE CASCADE` is used on `pulse_members` and `pulse_entries` so that
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
| `compaction` | System (Claude Code) | Summarized older entries replacing originals |

### Migration from Current Pulse

- Auto-create a main pulse for each project that has sessions
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

**Idle detection:** Use the existing `isLastTurnComplete(filePath)` function from
`transcript.js` — it checks whether the most recent `stop_reason: 'end_turn'` comes
after the most recent user/tool_result input, which is exactly "the agent finished
responding and is waiting for input." This is more reliable than the 120s heartbeat
threshold (which is a UI heuristic) or checking for a terminal prompt character.
Require: `session.status === 'active'` AND `isLastTurnComplete(session.transcript)`.
If not idle, queue the request and re-check every 5 seconds (up to 120s timeout).

**Response capture:** After sending the briefing prompt via `load-buffer`/`paste-buffer`
(same mechanism as `POST /api/sessions/:id/input`), CC polls the session's transcript
JSONL file. It uses `readTranscriptStructured()` to look for a new assistant entry with
a timestamp after the prompt was sent. Poll every 3 seconds, timeout after 120 seconds.
On timeout, log a warning and don't create an entry.

**Briefing and permissions:** The agent may use tools while generating the briefing
(e.g., reading files to verify what it changed). If the session's `auto_approve` is set
to `full` (the default), this is invisible. If set to `readonly` or `none`, tool use
during briefing will trigger normal permission prompts. This is acceptable — don't
special-case it. The briefing prompt itself is just user input; the agent handles it
like any other message.

### B. Auto-Briefing on Session Stop/Idle (Automatic)

When the CC hook receives a `Stop` event for a session:

1. If the session is a member of any pulse, and has done meaningful work (tool_count > 3),
   CC attempts to auto-brief. However, by the time the `Stop` event fires, the agent
   process may already be exiting and unable to respond to a briefing prompt.

2. **Primary path (agent still responsive):** Check if the tmux pane still exists
   (`tmux has-session -t <target>`). If yes, attempt the briefing flow from (A) with a
   shorter timeout (30s). This works when the user types `/stop` in Claude Code, which
   fires the Stop hook before the process fully exits.

3. **Fallback path (agent gone):** If the tmux pane is gone or the briefing times out,
   use transcript-based extraction: read the last 10 assistant messages from the transcript
   via `readTranscriptStructured()`, send them to a temporary headless Claude Code session
   (via `child_process.execFile`) with the prompt "Summarize this agent's work into a
   concise briefing for the project knowledge base." Store the result as a `briefing` entry.

4. **Idle auto-briefing:** For idle sessions (>5 minutes idle, configurable): optionally
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
`assemblePulseContext()` (for prompt injection), and the entry/membership CRUD helpers.
`getUserNotes()` and `setUserNotes()` become thin wrappers during migration, then removed.

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

## Compaction

Over time, pulse entries accumulate and become stale. Compaction summarizes old entries
into fewer, denser entries.

### Mechanism

A temporary headless Claude Code process handles compaction, spawned via
`child_process.execFile` (not tmux — no dashboard card, no hooks):

```javascript
const { execFile } = require('node:child_process');
execFile('claude', [
  '-p', compactionPrompt,
  '--output-format', 'stream-json'
], { timeout: 120_000 }, (err, stdout) => {
  // Parse stream-json output: each line is a JSON event.
  // Extract the final assistant message text from the 'result' event.
});
```

This process:
- Does NOT appear in session cards — it's a `child_process`, not a tmux session,
  so no `SessionStart` hook fires and no session row is created
- Uses Claude Code's own model (not DeepSeek) for better summarization quality
- Is short-lived: one prompt, one response, then exits automatically
- Has a 120-second timeout via `execFile` options — on timeout, the process is
  killed and compaction is skipped (entries just accumulate until next attempt)

### Triggers

- **Manual:** "Compact" button in the pulse panel
- **Automatic (main pulse):** When entry count exceeds 100, or oldest uncompacted entry
  is >24 hours old
- **Automatic (topic pulses):** When entry count exceeds 50

### Process

1. Read all entries for the pulse
2. Separate entries into "recent" (last 2 hours) and "old"
3. Send "old" entries to the headless Claude Code session for summarization
4. Store the summary as a `compaction` entry
5. Delete the original "old" entries
6. Recent entries are preserved as-is (they may still be actively relevant)

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
- "Compact" button per tab
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
| `DELETE` | `/api/pulses/:id` | Delete pulse + all entries (main pulse cannot be deleted) |

### Pulse Entries

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/pulses/:id/entries` | `?limit=50&before=<timestamp>` — paginated entries |
| `POST` | `/api/pulses/:id/entries` | `{content, entry_type?}` — add user note entry |
| `DELETE` | `/api/pulses/:id/entries/:entryId` | Delete a single entry |
| `POST` | `/api/pulses/:id/compact` | Trigger compaction (spawns headless Claude Code) |

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
```

---

## TypeScript Types

```typescript
interface Pulse {
  id: string;
  project: string;
  name: string;
  description: string;
  is_main: boolean;
  entry_count: number;
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
  pulses?: Pulse[];             // which pulses this session belongs to
}

// Note: `pulses` on Session requires a secondary query (pulse_members JOIN pulses
// WHERE session_id = ?). Don't add it to the main getAllSessions query — that would
// be N+1. Instead, fetch pulse memberships as a separate batch query in the init
// WebSocket message and in the sessions list API, or fetch per-session on demand
// when opening the session detail view.

```

---

## Implementation Phases

### Phase 1: Schema + Migration + Core API

**Files:** `db.js`, `pulse.js`, `server.js`

1. Add new tables (`pulses`, `pulse_members`, `pulse_entries`) to `db.js`
2. Write migration: create main pulse per existing project, migrate user notes from
   `data/pulse/{project}.json` as `user_note` entries
3. Add prepared statements for all CRUD operations (pulses, entries, membership)
4. Rewrite `pulse.js`: replace `generatePulse()` with entry-based `assemblePulseContent()`.
   Keep backward-compat wrappers for `getUserNotes()` / `setUserNotes()` / `getPulseForPrompt()`
   that delegate to new system. Add `getOrCreateMainPulse(project)` with lazy creation.
5. Remove `schedulePulseRegeneration()` from `server.js` — pulse content is now assembled
   on-demand from entries, not pre-generated and cached
6. Implement new API routes (pulse CRUD, entries, membership)
7. Update existing pulse endpoints (`/api/projects/:name/pulse`, etc.) to delegate to new system
8. Add WebSocket broadcast for pulse events
9. Tests for all new endpoints

**Checkpoint:** All existing tests pass + new API tests pass. Old pulse endpoints
still return the same shape (`{markdown, userNotes}`).

### Phase 2: Automatic File Change Entries (Mechanism C)

**Files:** `server.js` (hook handler)

1. In the heartbeat handler, when `file_path` is present, batch and append
   `file_change` entries to the session's project main pulse
2. Debounce: in-memory `Map<session_id, { files: Set<string>, timer: Timeout }>` in
   `server.js`. Each heartbeat with `file_path` adds to the set and resets the 30-second
   timer. On timer fire, write one `file_change` entry listing all files, clear the set.
   (Replaces the old `schedulePulseRegeneration` pattern.)
3. Auto-subscribe new sessions to their project's main pulse (in the `SessionStart`
   hook handler and in `/api/sessions/launch`)

**Checkpoint:** File edits automatically appear as pulse entries. Visible via API.

### Phase 3: Pulse Panel UI Evolution

**Files:** `client/src/components/PulsePanel.tsx` (rewrite existing), `PulsePanel.css`, new components

1. Rewrite existing PulsePanel (currently a simple modal with markdown display + notes textarea)
   as tabbed interface (main + topic pulses)
2. Render entries with author labels, type icons, timestamps
3. Add user note input (bottom of panel)
4. Add "New Pulse" creation flow
5. Add pulse management (edit name, delete)
6. Wire up WebSocket updates for real-time entry display

**Checkpoint:** Users can view pulse entries, create topic pulses, add notes.

### Phase 4: Session Card Integration

**Files:** `client/src/components/SessionCard.tsx`, `SessionCard.css`

1. Add pulse badges to session cards (query `pulse_members` → `pulses` for each session)
2. Add "Add to Pulse" / "Remove from Pulse" actions
3. Add "Brief" action (UI only — backend in Phase 5)
4. Add "Sync Pulse" action (UI only — backend in Phase 5)
   (Auto-subscribe to main pulse was done in Phase 2, step 3)

**Checkpoint:** Session cards show pulse memberships. Users can manage subscriptions.

### Phase 5: Briefing System (Mechanisms A + B)

**Files:** `server.js`, `transcript.js`
(`pty-manager.js` not needed — prompt sending uses `execFileSync('tmux', ['load-buffer', ...])` already in server.js)

1. Implement idle detection using `isLastTurnComplete(session.transcript)` from transcript.js
   (already exists — just needs to be called in the briefing guard)
2. Implement `POST /api/sessions/:id/brief` — sends prompt via tmux load-buffer/paste-buffer,
   polls transcript with `readTranscriptStructured()`, captures response, stores entry
3. Implement `POST /api/sessions/:id/sync-pulse` — assembles and injects context
4. Add auto-briefing on session stop (when tool_count > 3)
5. Add transcript view integration — special "Pulse Update" blocks
6. Handle edge cases: agent not responsive, agent confused by prompt, timeout

**Checkpoint:** Users can trigger briefings. Stopped sessions auto-brief. Transcript
shows briefing exchanges. This is the highest-risk phase — test thoroughly.

### Phase 6: Compaction

**Files:** `server.js` (new compaction handler), `pulse.js`

1. Implement headless Claude Code spawning via `child_process.execFile('claude', ['-p', ...])`
   — no tmux, no session card, no hooks. Parse `stream-json` output for the result.
2. Implement `POST /api/pulses/:id/compact` endpoint
3. Add "Compact" button to pulse panel UI
4. Add automatic compaction triggers (entry count threshold, age threshold)
5. Add compaction settings (configurable thresholds)

**Checkpoint:** Pulse entries can be compacted. Old entries replaced with summaries.

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
| System Claude Code session for compaction fails | Compaction hangs or produces bad output | 120-second timeout (via `execFile` options). On failure, skip compaction (entries just accumulate). Log error. |
| Migration breaks existing pulse behavior | Users lose notes or see errors | Backward-compatible API endpoints. Migrate notes as entries. Keep old JSON files as backup. |
| Auto-briefing on stop races agent exit | Prompt sent but agent already gone | Check tmux pane exists first (`tmux has-session`). Short timeout (30s). Fall back to transcript-based extraction via headless Claude Code. |
| Headless Claude Code not installed | Compaction/fallback briefing fails | Check for `claude` binary on startup. Log warning if missing. Compaction simply skipped. |

---

## Future Enhancements (Post-Implementation)

- **D. MCP server integration** — CC as an MCP server for native agent read/write access
  to pulses without tmux prompt injection
- **URL-based routing** — deep links to specific pulses (`/project/:name/pulse/:pulseId`)
- **Pulse templates** — pre-defined topic pulse structures for common workflows
  (e.g., "Investigation" template with sections for Findings, Decisions, Open Questions)
- **Cross-project pulses** — share knowledge between related projects
- **Pulse search** — FTS5 index on pulse_entries for searching across all project knowledge
- **Agent Teams integration** — observe `~/.claude/teams/` and `~/.claude/tasks/` to display
  native Claude Code agent team activity in CC, and bridge team task results into pulses

---

## Relationship to Claude Code Agent Teams

This system is **complementary**, not competing:

| Concern | Agent Teams | CC Pulse System |
|---|---|---|
| Task coordination | Task files + dependency DAG | Not addressed (use Agent Teams or TODOs) |
| Knowledge sharing | Mailbox messages (raw text) | Curated briefings + structured entries |
| Multi-CLI support | Claude Code only | Claude + Gemini + Codex |
| User visibility | Hidden in `~/.claude/teams/` files | Full UI in dashboard |
| Persistence | Filesystem (cleaned up on team delete) | SQLite (persists indefinitely) |

Agent Teams excels at "divide this work among N agents." Pulse excels at "share what was
learned across sessions over time." A future integration could:
1. Monitor Agent Teams activity and surface it in CC's UI
2. Auto-generate pulse entries from completed team tasks
3. Inject pulse context into team member sessions
