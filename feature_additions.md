# Feature Additions — Control Center

Full implementation plan: React + Vite + TypeScript frontend rewrite combined with new features.
Backend (Fastify + SQLite + WebSocket) stays unchanged except for new endpoints and modules.

This document is self-contained. A fresh Claude Code agent should be able to read this and execute the entire multi-phase plan autonomously.

---

## Project Context

**What is Control Center?** A self-hosted Node.js/Fastify web dashboard that monitors, controls, and provides browser terminals for multiple Claude Code sessions running in tmux. Users access it via browser at `http://localhost:7700`.

**Read the project's architecture reference first.** The original CLAUDE.md was deleted during the pre-rewrite checkpoint but its content is available via `git show cac31ac:CLAUDE.md`. It's also loaded into your conversation context as project instructions (look for "Contents of /home/zapperz/Charan/control-center/CLAUDE.md" in your system context). It contains the full architecture reference, database schema, all API endpoints, file map, and design decisions. You need this context to implement correctly. If you can't find it in context, run `git show cac31ac:CLAUDE.md` to read it.

**Current state:**
- Branch: `dev` (verify with `git branch --show-current`)
- Checkpoint tag: `checkpoint-pre-rewrite` — this marks the stable state before any migration work
- All 84+ existing tests pass at this checkpoint
- The old vanilla JS frontend is in `public/` and is fully functional

**If the `dev` branch doesn't exist or you're on `main`:** Run `git checkout dev` or `git checkout -b dev`. Never work on `main`.

---

## How to Read This Document

This document is ~2510 lines. **Do not read it all at once.** Read in this order:

1. **First:** Read these top sections (Safety Rules through Engineering Principles) — ~240 lines. This is your operational guide.
2. **Before each phase:** Read only that phase's technical section. Phase 0 starts at "## Phase 0". Phase 1 starts at "## Phase 1". Etc.
3. **When delegating to a subagent:** Copy the relevant section of the plan into the subagent's task description. The subagent does not need this full document — it needs its specific task's technical details.
4. **The Subagent Task Breakdown** (at the end) lists every task with what files to read. Reference it when deciding what to delegate next.

---

## Pre-Flight Checklist

Before starting any implementation work, verify:

```bash
# 1. Correct branch
git branch --show-current
# Must show: dev

# 2. Clean working tree (no uncommitted changes from previous work)
git status
# Should be clean, or only show feature_additions.md as untracked

# 3. Node.js and npm available
node --version   # Must be 18+
npm --version

# 4. Dependencies installed
npm install

# 5. All existing tests pass
npm test
# Must show 84+ tests passing, 0 failing

# 6. Server starts successfully
npm start
# Ctrl+C after verifying "Server listening on 0.0.0.0:7700"

# 7. tmux available (needed for session launch/terminal features)
tmux -V

# 8. Checkpoint tag exists (used by rollback strategy)
git rev-parse checkpoint-pre-rewrite
# If this fails: create it with: git tag checkpoint-pre-rewrite
```

If any of these fail, fix them before proceeding. Do not start implementation with a broken baseline.

---

## Rollback Strategy

If something goes badly wrong during a phase:

1. **If tests are failing and you can't figure out why:** `git stash` your current changes, verify tests pass on clean code, then `git stash pop` and debug the specific change that broke things.
2. **If a phase is fundamentally not working:** `git checkout -- .` to discard all uncommitted changes back to the last commit. You lose only uncommitted work.
3. **If you need to go back to the pre-migration state:** `git checkout checkpoint-pre-rewrite` restores the exact state before any migration work began.
4. **Never use `git reset --hard` or `git clean -f`** — these can destroy work permanently. Use `git stash` or `git checkout -- <specific-file>` instead.
5. **Commit frequently** so that rollback only loses a small amount of work.

---

## CRITICAL: Safety Rules

This session runs with `--dangerously-skip-permissions`. Follow these rules strictly:

### Scope restrictions

- **ONLY modify files inside `/home/zapperz/Charan/control-center/`.** Do not touch any files outside this directory. No exceptions.
- **NEVER modify `~/.claude/settings.json`, `~/.claude/hooks/`, or any user-level config** unless explicitly working on the install.sh script and the user has confirmed it.
- **NEVER `rm -rf` directories without first listing their contents.** If you need to delete something, use targeted `rm` on specific files you've verified.
- **NEVER run `git push` to `main`.** All work happens on the `dev` branch. See branch rules below.
- **NEVER run destructive git commands** (`reset --hard`, `checkout .`, `clean -f`) without confirmation.

### Branch rules

- All development is on the `dev` branch. Verify with `git branch --show-current` before any commit.
- Never push to `main`. The `main` branch is a production release branch with real users.
- Commit frequently — at least once per completed sub-feature. Small, focused commits.
- Push to `dev` freely (no confirmation needed for `dev`).

### File safety

- Before deleting any file: read it first to confirm it's what you expect.
- Before overwriting any file: read it first to understand what you're replacing.
- The `public/` directory (old frontend) must be kept working until the React frontend is fully verified. Do not delete it until Phase 1 is complete and tested.
- The `data/` directory contains the SQLite database and user data. Never delete or overwrite files in `data/`.
- The `.env` file is machine-local and gitignored. Never overwrite it.

---

## Autonomous Execution

This session is fully autonomous. You will implement the entire plan without user input. Do not stop to ask for confirmation, clarification, or approval at any point during implementation. Make decisions and keep moving.

### Decision-making

When you encounter an ambiguous situation where the plan doesn't specify exactly what to do:

1. **Make the best decision you can** based on the plan's intent, the existing codebase patterns, and sound engineering judgment.
2. **Log it** — append a short entry to `data/decisions.log` (create this file on first use) with the date, the situation, what you decided, and why. Format:
   ```
   [2026-03-21] SITUATION: <what was ambiguous>
   DECISION: <what you chose>
   REASON: <why>
   ```
3. **Keep going.** Do not block on the decision. The user will review `data/decisions.log` at the very end, after everything is fully implemented, and can adjust anything they disagree with.

### Progress tracking

Maintain a running progress log at `data/progress.log` (create on first use). After each completed sub-feature or significant milestone, append a line:
```
[2026-03-21 14:30] Phase 1.2: Transcript backend complete — 3 new tests added, all 87 passing
```

This serves two purposes:
- After context compaction, you can read this file to know exactly where you left off.
- The user can check progress without interrupting you.

### Dependency and environment issues

If `npm install` fails, a dependency has issues, or the build breaks for environmental reasons:

1. Read the error output carefully.
2. Try the obvious fix (clear node_modules and reinstall, check for version conflicts, etc.).
3. If the fix requires a judgment call (e.g., pinning a different version), make it and log to `data/decisions.log`.
4. If the environment is truly broken and you cannot proceed (e.g., Node.js version too old, system package missing), write the blocker to `data/decisions.log` and move on to any tasks that don't depend on the broken piece.

### Context window management

Your context will compact during this long session. To stay oriented:

- **Read per-phase, not all at once.** Before each phase, read only that phase's section of this document.
- **After each phase**, check `data/progress.log` and `git log --oneline -20` to confirm what's done.
- **After compaction**, don't re-read the entire plan. Read the progress log, check the current phase section, and continue.
- **Commit frequently** — your commits are your persistent memory. Use descriptive messages.

### Do not stop

The only reason to stop before the plan is fully complete is if the environment is fundamentally broken in a way you cannot work around (e.g., disk full, Node.js missing). In all other cases — ambiguous decisions, test failures, subagent errors, unexpected code patterns — resolve it yourself, log it, and continue.

---

## Workflow: How to Execute This Plan

### You are the coordinator

You are the **main coordinating agent**. Your job is to:

1. **Maintain big-picture context.** You hold the overall plan in your context. You know what's done, what's next, and how pieces fit together.
2. **Delegate implementation to subagents.** Spin out agents (via agent teams or individual subagents) to do the actual coding. Give them focused, specific tasks with clear deliverables.
3. **Verify results.** When a subagent completes, review its work, run tests, and confirm the feature works before moving on.
4. **Never implement large features yourself.** If you start writing 200+ lines of code in your own context, STOP. Spin out a subagent instead. Your context window is for coordination, not implementation.

### Why subagents

Each subagent gets a fresh context window. They can focus deeply on implementation without worrying about the big picture. When they finish, their result comes back as a summary — your context stays clean. Without this discipline, your context will fill with implementation details and you'll lose track of the plan.

### How to delegate

For each task, give the subagent:

1. **What to build** — specific files to create/modify, exact behavior expected
2. **Context it needs** — relevant existing code (tell it which files to read first), relevant types, API contracts
3. **How to verify** — what tests to run, what to check manually
4. **What NOT to do** — don't modify files outside scope, don't refactor unrelated code, don't add features beyond what's specified

Example delegation:

```
Create the file_edits table and prepared statements in db.js.

Read db.js first to understand the existing pattern (schema at top, prepared statements in `stmts` object).

Add:
1. CREATE TABLE IF NOT EXISTS file_edits (... exact SQL from plan ...)
2. Three prepared statements: insertFileEdit, getFilesBySession, getActiveFileConflicts (... exact SQL from plan ...)

After making changes, run: npm test
All 84+ existing tests must still pass.
Do not modify any other files.
```

### Avoiding conflicts between subagents

**Never have two subagents modify the same file at the same time.** If Task A modifies `server.js` and Task B also modifies `server.js`, run them sequentially — A first, commit, then B reads the updated file.

Safe to parallelize: tasks that touch completely different files (e.g., one creates `snapshots.js` while another creates `PulsePanel.tsx`).

Unsafe to parallelize: two tasks that both modify `server.js`, or `db.js`, or any shared file. The second subagent would overwrite the first's changes.

When in doubt, run sequentially. The time cost of sequential execution is small compared to the cost of debugging merge conflicts from parallel edits.

### How to verify each phase

After each phase, before moving to the next:

1. **Run `npm test`** — all existing tests must pass. If any fail, fix before proceeding.
2. **Run the new feature's tests** — if you added tests for the new feature, verify they pass.
3. **Manual smoke test** — start the server (`npm start` or `npm run dev`), open the dashboard, and verify the feature works visually. For backend-only changes, use `curl` to test the API endpoint.
4. **Commit** — create a focused commit on `dev` with a descriptive message.

### Commit strategy

- Commit after each completed sub-feature (not after each file change, not after an entire phase).
- Commit message format: `Phase X.Y: brief description` (e.g., `Phase 1.3: file change tracking backend + heartbeat hook`)
- If a subagent makes changes, review them, run tests, then commit from the main agent context.
- Push to `dev` after each phase completes (not after every commit — batch pushes per phase).

---

## Testing Strategy

### Existing tests

The project uses Node.js built-in test runner (`node --test`). Tests are in `test/api.test.js` and `test/integration.test.js`. There are 84+ tests that must always pass. Run with `npm test`.

Tests use `buildServer()` from `server.js` to spin up a full in-memory Fastify server with a temp SQLite database. No mocking — real server, real DB, real routes.

### Adding new tests

For every new API endpoint, add tests following the existing pattern in `test/api.test.js`:

```js
test('GET /api/sessions/:id/files returns file edits', async (t) => {
  const server = await buildServer({ logger: false });
  t.after(() => server.close());

  // Setup: create a session, insert file edits
  // ...

  const res = await server.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/files`,
  });

  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.files));
  // ... specific assertions
});
```

### Test coverage per phase

**Phase 0:** No new tests needed. Just verify existing 84+ tests still pass after server.js changes.

**Phase 1:**
- `readTranscriptStructured()` — unit tests with sample JSONL input, verify output TranscriptEntry[] structure
- `GET /api/sessions/:id/transcript` — API test with a session that has a transcript file
- `GET /api/sessions/:id/files` — API test: insert heartbeats with file_path, verify file list
- Conflict detection — API test: two sessions in same project editing same file, verify conflicts in response
- Heartbeat with file_path — integration test: POST to `/api/hooks` with file_path, verify file_edits table

**Phase 2:**
- `snapshots.js` — unit tests: initRepo, capture, diff, restore on a temp directory
- `GET /api/sessions/:id/snapshot-diff` — API test with a session that has a snapshot
- `POST /api/sessions/:id/revert` — API test: verify revert only works on stopped sessions
- `GET /api/sessions/history` — API test: create sessions with various projects/dates, search, verify results
- FTS5 — integration test: create events, search via FTS, verify matches

**Phase 3:**
- `pulse.js` — unit tests: generatePulse with mock DB data, getPulseForPrompt truncation
- Pulse API endpoints — CRUD tests
- Todos CRUD — API tests for all five endpoints
- `POST /api/todos/:id/launch` — integration test: verify session created, todo linked
- Session stop → todo notification — integration test

**Phase 4:**
- Hook ingestion with `cli_type` field — API test
- `shouldAutoApprove()` with Gemini tool names — unit test
- `codex-watcher.js` — unit test with a temp JSONL file
- Multi-CLI launch — integration test

### When tests fail

If `npm test` fails after your changes:

1. Read the failure output carefully. Identify which test failed and why.
2. If your change broke an existing test: your change has a bug. Fix the bug, don't modify the test.
3. If the test is testing behavior you intentionally changed (e.g., you added a new column and the test asserts exact column count): update the test to match the new behavior.
4. Run `npm test` again. Repeat until all pass.
5. Never skip or disable existing tests.

---

## Implementation Process: Step by Step

### Phase 0 — React + Vite Setup

**Coordinator actions:**
1. **FIRST:** Spin out a subagent to update package.json (add React/Vite/TypeScript deps, new scripts), modify server.js (static serving from dist/, SPA fallback), update .gitignore and update.sh. Run `npm install` to make all new deps available.
2. Spin out a subagent to create the Vite + React scaffold (client/vite.config.ts, tsconfig.json, index.html, main.tsx, App.tsx, index.css)
3. Spin out a subagent to create TypeScript foundations (types.ts, api.ts, utils.ts)
4. Spin out a subagent to create React hooks (useWebSocket.ts, useSessions.ts, useApi.ts, useTranscript.ts)
5. After all complete: run `npm run build`, `npm test`, verify the React app loads at localhost:5173
6. Commit: `Phase 0: React + Vite + TypeScript scaffold`

**Verification:** Open browser to `localhost:5173` (with server running on 7700). See "Control Center" header. WebSocket connects. The old frontend at `localhost:7700` still works unchanged.

### Phase 1 — Core UI + Foundation

**Coordinator actions:**
1. Backend subagent: build `readTranscriptStructured()` in transcript.js + transcript API endpoint + WebSocket transcript streaming + file_edits table + file tracking endpoint + conflict detection. Run `npm test` after.
2. Hook subagent: modify cc-heartbeat.sh to extract file_path. Small, focused change.
3. Frontend subagent: build ALL React components for Phase 1 (this is the biggest task — can be split into multiple subagents if needed):
   - Start with Layout + Header + SessionList + SessionCard (get cards rendering from WS data)
   - Then SessionDetail + TranscriptView + InputBar + TerminalView
   - Then modals (NewSession, EditSession, LinkTmux)
   - Then EventLog + Toast
   - Then responsive CSS
4. Integration: verify frontend talks to backend correctly. Run through all flows manually.
5. Delete `public/` only after verifying the React frontend fully replaces it.
6. Commit per sub-feature. Push after phase complete.

**Verification:** All session card features work (status, preview, summary, grant, kill, edit). Transcript view renders entries, accepts input. Terminal view works. Mobile layout is usable. File changes show on cards. Conflict warnings appear.

### Phases 2-3 — Features

For each feature (Snapshots, History, Pulse, TODOs):
1. Backend subagent: create module + DB changes + API endpoints + tests
2. Frontend subagent: create React component(s)
3. Verify: run tests, manual smoke test
4. Commit

Backend tasks must be **sequential** (all modify `db.js` and `server.js` — parallel edits would overwrite each other). Run: 2.1a → 2.2a → 3.1a → 3.2a. Frontend tasks can start as soon as their backend counterpart finishes (they touch different files).

### Phase 4 — Multi-Model

1. Hook subagent: create gc-report.sh, gc-heartbeat.sh, cx-report.sh
2. Backend subagent: cli_type column, shouldAutoApprove mapping, codex-watcher.js, pty-manager changes, install.sh updates
3. Frontend subagent: CLI selector in launch modal, CLI badges on cards
4. Test with actual Gemini/Codex CLIs if installed, otherwise test hook scripts with curl

### Cleanup

1. Delete the entire `public/` directory (not just app.js/index.html/style.css — it also contains sw.js, manifest.json, and icons/ which are already copied to `client/public/` and built into `dist/`). Verify `dist/` is being served.
2. Update README.md
3. Recreate CLAUDE.md with new architecture documentation
4. Run full test suite one final time
5. Commit: `Cleanup: remove legacy frontend, update docs`

---

## Engineering Principles

Follow these throughout all phases:

1. **Simplest solution that works.** Don't add abstractions, configurability, or error handling for scenarios that can't happen. Three straightforward lines > one clever function.
2. **Big picture first.** Before writing code, consider how it fits the overall architecture. If a solution feels like a band-aid, stop and find the root cause.
3. **Don't copy code from other repos.** This plan draws inspiration from Entourage and other tools, but all implementations must be original.
4. **Don't refactor what you're not changing.** If you're adding file tracking, don't also "improve" the session card CSS or "clean up" the WebSocket handler. Scope creep compounds.
5. **Test as you go.** Run `npm test` after every significant change. Don't batch up changes and test at the end — you'll waste time debugging compound failures.
6. **Read before writing.** Before modifying any file, read it first. Understand the existing patterns. Follow them. Don't introduce a new coding style into an existing file.

---

## Phase 0 — React + Vite + TypeScript Setup

**What:** Set up the frontend build toolchain. Get a blank React app rendering through the existing Fastify server with working WebSocket and API proxy. Pure scaffolding — no features yet.

**Why:** Every subsequent phase builds on this. Do it once, do it right.

### New dependencies — `package.json`

```json
{
  "devDependencies": {
    "vite": "^6",
    "@vitejs/plugin-react": "^4",
    "typescript": "^5",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "concurrently": "^9"
  },
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@xterm/xterm": "^5.5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-web-links": "^0.11"
  }
}
```

Note: xterm moves from CDN to npm under the `@xterm/` scope. The main package is `@xterm/xterm` (not the old unscoped `xterm`). This simplifies version management and enables proper TypeScript imports. In component code, import as `import { Terminal } from '@xterm/xterm'`.

### Scripts — `package.json`

```json
{
  "scripts": {
    "start": "node --env-file-if-exists=.env server.js",
    "dev": "concurrently -n server,client -c blue,green \"node --env-file-if-exists=.env --watch server.js\" \"npx vite --config client/vite.config.ts\"",
    "build": "npx vite build --config client/vite.config.ts",
    "test": "node --test test/*.test.js"
  }
}
```

**IMPORTANT:** The `--env-file-if-exists=.env` flag is **required** on both `start` and `dev`. It loads environment variables from `.env` (CC_PORT, DEEPSEEK_API_KEY, VAPID keys, CC_AUTO_APPROVE_TOOLS, etc.). Without it, the server runs with all defaults — AI summaries, push notifications, and custom settings won't work. The `--watch` flag on the dev server enables auto-reload when backend files change.

Note: All dependencies (React, Vite, TypeScript) are in the root `package.json`. A single `npm install` at root installs everything. The scripts reference `client/vite.config.ts` explicitly so vite resolves paths correctly without needing to `cd` into client/. The vite config's `root: '.'` is relative to the config file location (i.e., `client/`).

### Project structure

```
control-center/
├── client/                        # NEW — React frontend source
│   ├── index.html                 # Vite entry HTML
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── public/                    # Static assets (copied to dist/ on build)
│   │   ├── sw.js                  # Service worker for push notifications
│   │   ├── manifest.json          # PWA manifest
│   │   └── icons/icon.svg         # App icon
│   └── src/
│       ├── main.tsx               # ReactDOM.createRoot, renders <App />
│       ├── App.tsx                # Root: WebSocketProvider → Layout
│       ├── types.ts               # All shared TypeScript interfaces
│       ├── api.ts                 # Typed fetch helpers for every endpoint
│       ├── utils.ts               # Ported utility functions (timeAgo, escapeHtml, statusClass)
│       ├── hooks/
│       │   ├── useWebSocket.ts    # WS connection, reconnect, message dispatch
│       │   ├── useSessions.ts     # Sessions + events state derived from WS
│       │   ├── useTranscript.ts   # Transcript fetch + WS subscription
│       │   └── useApi.ts          # Generic GET with cache, refresh interval, loading/error
│       ├── components/
│       │   ├── Layout.tsx
│       │   ├── Header.tsx         # Title, connection dot, summary bar, stats, version banner
│       │   ├── SessionList.tsx
│       │   ├── ProjectGroup.tsx   # Group header + pulse button + todo section + session cards
│       │   ├── SessionCard.tsx
│       │   ├── SessionDetail.tsx
│       │   ├── TranscriptView.tsx
│       │   ├── InputBar.tsx
│       │   ├── TerminalView.tsx
│       │   ├── EventLog.tsx
│       │   ├── Toast.tsx
│       │   ├── ErrorBoundary.tsx   # Class component: catches render crashes
│       │   └── modals/
│       │       ├── NewSessionModal.tsx
│       │       ├── EditSessionModal.tsx
│       │       ├── LinkTmuxModal.tsx
│       │       └── SnapshotDiffModal.tsx   # Phase 2
│       │   # Phase 2+
│       │   ├── HistoryView.tsx
│       │   ├── PulsePanel.tsx
│       │   ├── TodoSection.tsx
│       │   └── TodoItem.tsx
│       └── styles/
│           └── index.css          # Global: Catppuccin Mocha variables + base styles
├── server.js                      # Modified: static serving from dist/ + new endpoints
├── db.js                          # Modified: new tables + statements
├── pty-manager.js                 # Modified: cli_type support in Phase 4
├── transcript.js                  # Modified: readTranscriptStructured()
├── snapshots.js                   # NEW Phase 2
├── pulse.js                       # NEW Phase 3
├── config.js                      # Modified: new env vars
├── hooks/                         # Modified in Phase 1 + Phase 4
├── public/                        # OLD — kept during migration, deleted at end
└── dist/                          # BUILD OUTPUT — gitignored, generated by `npm run build`
```

### Vite config — `client/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7700',
      '/ws/events': { target: 'ws://localhost:7700', ws: true },
      '/ws/terminal': { target: 'ws://localhost:7700', ws: true },
    },
  },
});
```

### TypeScript config — `client/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": "./src",
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

### Entry HTML — `client/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#1e1e2e" />
  <title>Control Center</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
  <link rel="manifest" href="/manifest.json" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

### PWA assets — `client/public/`

The existing frontend has PWA support that must be preserved:

- `public/sw.js` — Service worker that handles web push notifications (shows notification on push, focuses app on click). **Required** for push notifications to work.
- `public/manifest.json` — PWA manifest (app name, icons, theme color, standalone display).
- `public/icons/icon.svg` — App icon referenced by manifest and service worker.

Copy these into `client/public/` (Vite serves files from the `public/` directory relative to root as static assets — they get copied to `dist/` on build without processing):

```
client/public/
├── sw.js              # Copy from public/sw.js (no changes needed)
├── manifest.json      # Copy from public/manifest.json (no changes needed)
└── icons/
    └── icon.svg       # Copy from public/icons/icon.svg
```

The service worker registration must also be ported to the React app. In `App.tsx` or `main.tsx`:

```ts
// Register service worker for push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

Without these files, push notifications will silently stop working.

### Server changes — `server.js`

Two changes:

1. Serve from `dist/` when it exists (production build), fall back to `public/` (legacy):

```js
import { existsSync } from 'node:fs';
// NOTE: server.js already defines __dirname near the top of the file:
//   const __dirname = dirname(fileURLToPath(import.meta.url));
// Just use the existing variable — do NOT redefine it.
const distDir = join(__dirname, 'dist');
const publicDir = join(__dirname, 'public');
const staticRoot = existsSync(distDir) ? distDir : publicDir;

await fastify.register(fastifyStatic, { root: staticRoot, prefix: '/' });
```

2. SPA fallback — serve `index.html` for any non-API, non-WS request that doesn't match a static file:

```js
fastify.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
    reply.code(404).send({ error: 'Not found' });
  } else {
    reply.sendFile('index.html');
  }
});
```

### CSS approach

Keep Catppuccin Mocha as the theme. Define CSS custom properties in `client/src/styles/index.css`:

```css
:root {
  --ctp-base: #1e1e2e;
  --ctp-mantle: #181825;
  --ctp-surface0: #313244;
  --ctp-surface1: #45475a;
  --ctp-text: #cdd6f4;
  --ctp-subtext0: #a6adc8;
  --ctp-blue: #89b4fa;
  --ctp-green: #a6e3a1;
  --ctp-red: #f38ba8;
  --ctp-yellow: #f9e2af;
  --ctp-peach: #fab387;
  --ctp-overlay0: #6c7086;
  /* ... full palette */
}
```

Component styles: plain CSS files colocated with components (e.g., `SessionCard.css` imported by `SessionCard.tsx`). No CSS modules or Tailwind — keep it simple, use the CSS variables.

### TypeScript types — `client/src/types.ts`

```ts
// ─── Database models (match server responses) ───

export interface Session {
  session_id: string;
  cwd: string;
  model: string;
  transcript: string | null;
  tmux_target: string | null;
  status: 'active' | 'waiting_permission' | 'stopped';
  label: string | null;
  project: string | null;
  auto_approve: number;            // 0=none, 1=full, 2=no-edits
  pending_tool: string | null;
  pending_tool_input: string | null;
  created_at: string;
  updated_at: string;
  // Joined from heartbeats
  last_tool: string | null;
  last_heartbeat: string | null;
  tool_count: number;
  // Added in later phases (optional until then)
  cli_type?: 'claude' | 'gemini' | 'codex';
  snapshot_hash?: string | null;
  pulse_enabled?: number;
  files?: FileEdit[];
  conflicts?: string[];
}

export interface SessionEvent {
  id: number;
  session_id: string;
  event: string;
  tool_name: string | null;
  tool_input: string | null;
  created_at: string;
  // Enrichments from server
  auto_approved?: boolean;
}

export interface FileEdit {
  file_path: string;
  tool_name: string;
  last_edited: string;
}

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'system';
  content: string;
  tool_name?: string;
  tool_input_summary?: string;       // e.g. "server.js" for Edit, "npm test" for Bash
  tool_input_full?: string;          // full JSON string for expand view
  tool_result?: string;              // truncated result text
  is_error?: boolean;
  timestamp?: string;
}

export interface Todo {
  id: number;
  project: string;
  title: string;
  details: string;
  status: 'pending' | 'in_progress' | 'done';
  priority: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PulseDocument {
  markdown: string;
  userNotes: string;
}

export interface ProjectPreset {
  name: string;
  cwd: string;
}

export interface SessionTemplate {
  id: string;
  name: string;
  label?: string;
  cwd?: string;
  project?: string;
  autoApprove?: number;
  prompt?: string;
}

export interface ServerInfo {
  serverCwd: string;
  aiSummaryEnabled: boolean;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export interface Stats {
  totalSessions: number;
  sessionsThisWeek: number;
  totalEvents: number;
  mostUsedTool: string | null;
  avgDurationMinutes: number;
  aiSummaryCalls: number;
  aiCostUsd: number;
}

// ─── WebSocket messages ───

export type WSIncoming =
  | { type: 'init'; sessions: Session[]; recentEvents: SessionEvent[] }
  | { type: 'session_update'; session: Session }
  | { type: 'event'; event: string; session_id: string; tool_name?: string; timestamp?: string; auto_approved?: boolean }
  | { type: 'transcript_update'; session_id: string; entries: TranscriptEntry[] }
  | { type: 'todo_session_stopped'; todo_id: number; session_id: string };

export type WSOutgoing =
  | { type: 'subscribe_transcript'; session_id: string }
  | { type: 'unsubscribe_transcript' };

// ─── Derived UI types ───

export type StatusClass = 'active' | 'idle' | 'waiting' | 'stopped';
```

### Utility functions — `client/src/utils.ts`

Port from current `app.js`:
- `getStatusClass(session: Session): StatusClass` — same 120-second idle threshold logic
- `getStatusText(session: Session): string`
- `getDetailText(session: Session): string`
- `formatToolDetail(toolName: string, toolInput: string | null): string`
- `timeAgo(dateStr: string): string`
- `escapeHtml(str: string): string` — may not be needed in React (JSX auto-escapes)
- `projectColor(name: string): string` — deterministic color per project name
- `groupByProject(sessions: Session[]): Map<string, Session[]>` — groups active sessions by project field, sorts groups alphabetically, puts ungrouped (no project) at the end. Used by `useSessions` hook.

### API helper — `client/src/api.ts`

Typed wrapper around fetch for every endpoint:

```ts
const BASE = '';  // relative to origin (works with Vite proxy and production)

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Typed endpoint functions
export const api = {
  getSessions: () => fetchJson<Session[]>('/api/sessions'),  // NOTE: endpoint returns a flat array, NOT { sessions: [...] }
  getSession: (id: string) => fetchJson<Session>(`/api/sessions/${id}`),
  patchSession: (id: string, data: Partial<Session>) => fetchJson(/* ... */),
  launchSession: (data: { label?: string; cwd?: string; initialPrompt?: string; project?: string; cli_type?: string; skipPermissions?: boolean }) => fetchJson(/* ... */),
  sendInput: (id: string, text: string) => fetchJson(/* ... */),
  killSession: (id: string) => fetchJson(/* ... */),
  grantPermission: (id: string) => fetchJson(/* ... */),
  getPreview: (id: string) => fetchJson<{ text: string | null }>(/* ... */),
  getSummary: (id: string) => fetchJson<{ summary: string | null }>(/* ... */),
  getTranscript: (id: string, limit?: number, before?: string) => fetchJson<{ entries: TranscriptEntry[]; hasMore: boolean }>(/* ... */),
  getSessionFiles: (id: string) => fetchJson<{ files: FileEdit[] }>(/* ... */),
  getEvents: (limit?: number) => fetchJson(/* ... */),
  getSessionEvents: (id: string, limit?: number, offset?: number) => fetchJson(/* ... */),
  getProjects: () => fetchJson<ProjectPreset[]>('/api/projects'),
  getTemplates: () => fetchJson<SessionTemplate[]>('/api/templates'),
  createTemplate: (data: Partial<SessionTemplate>) => fetchJson(/* ... */),
  getTmuxSessions: () => fetchJson(/* ... */),
  getInfo: () => fetchJson<ServerInfo>('/api/info'),
  getVersion: () => fetchJson<VersionInfo>('/api/version'),
  getStats: () => fetchJson<Stats>('/api/stats'),
  // Phase 2
  getSnapshotDiff: (id: string) => fetchJson(/* ... */),
  revertSession: (id: string) => fetchJson(/* ... */),
  searchHistory: (params: { project?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number }) => fetchJson(/* ... */),
  // Phase 3
  getPulse: (project: string) => fetchJson<PulseDocument>(/* ... */),
  updatePulseNotes: (project: string, notes: string) => fetchJson(/* ... */),
  getTodos: (project: string) => fetchJson<{ todos: Todo[] }>(/* ... */),
  createTodo: (data: { project: string; title: string; details?: string }) => fetchJson(/* ... */),
  updateTodo: (id: number, data: Partial<Todo>) => fetchJson(/* ... */),
  deleteTodo: (id: number) => fetchJson(/* ... */),
  launchTodo: (id: number, skipPermissions?: boolean) => fetchJson(/* ... */),
  // Push notifications
  getVapidKey: () => fetchJson<{ publicKey: string; enabled: boolean }>('/api/push/vapid-public-key'),
  subscribePush: (sub: PushSubscriptionJSON) => fetchJson(/* ... */),
  unsubscribePush: (endpoint: string) => fetchJson(/* ... */),
};
```

### Generic fetch hook — `client/src/hooks/useApi.ts`

```ts
interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function useApi<T>(
  url: string | null,              // null = don't fetch (conditional)
  options?: {
    refreshInterval?: number;       // ms, 0 = no auto-refresh (default)
    cacheTtl?: number;              // ms, use stale data while refreshing (default 0)
    enabled?: boolean;              // false = skip fetch entirely (default true)
  }
): UseApiResult<T>
```

Implementation:
- Fetches `url` on mount and when `url` changes
- If `refreshInterval` is set, re-fetches on that interval (only when tab is visible via `document.visibilityState`)
- Returns `{ data, loading, error, refresh }` — `loading` is true only on first fetch, not on background refreshes
- On error: sets `error` string, keeps stale `data` if available
- On component unmount: cancels in-flight requests via `AbortController`

Used by SessionCard for previews (`refreshInterval: 20000`), summaries (`refreshInterval: 90000`), and file lists (`refreshInterval: 20000`, `enabled: session.status !== 'stopped'`).

### Sessions hook — `client/src/hooks/useSessions.ts`

Thin selector over the WebSocket context:

```ts
function useSessions() {
  const { sessions, recentEvents } = useWebSocket();
  // Derived state
  const activeCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'active').length, [sessions]);
  const waitingCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'waiting').length, [sessions]);
  const idleCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'idle').length, [sessions]);
  const byProject = useMemo(() => groupByProject(sessions), [sessions]);
  return { sessions, recentEvents, activeCount, waitingCount, idleCount, byProject };
}
```

This avoids recomputing grouping/counts in every component that needs them. Used by Layout (summary bar), SessionList (grouping), Header (badge counts).

### Core hook — `client/src/hooks/useWebSocket.ts`

```ts
interface WebSocketState {
  sessions: Session[];
  recentEvents: SessionEvent[];
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  sendMessage: (msg: WSOutgoing) => void;
}
```

Implementation:
- Connects to `ws(s)://${location.host}/ws/events`
- Exponential backoff reconnect (1s → 2s → 4s → ... → 30s max), resets on success
- On `init`: replaces sessions and recentEvents
- On `session_update`: patches the specific session in the array (or prepends if new)
- On `event` with type `Heartbeat`: updates the session's last_tool, last_heartbeat, and status in-place
- On `event` with type `PermissionRequest` (not auto_approved): sets session status to waiting_permission
- On other events: prepends to recentEvents (cap at 200)
- On `transcript_update`: stored in a `transcriptUpdates` ref — a `Map<string, TranscriptEntry[][]>` keyed by session_id. Each incoming update appends its entries array. The `useTranscript` hook reads and drains its session's queue via `useEffect` on a version counter that increments on each WS message. This avoids re-rendering every component on transcript updates — only the component subscribed to that session re-renders.
- Exposed via React Context so all components can access without prop drilling

### App-level state — `App.tsx`

```tsx
function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // ...
  return (
    <WebSocketProvider>
      <ToastProvider>
        <Layout
          selectedSessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          onCloseDetail={() => setSelectedSessionId(null)}
        />
      </ToastProvider>
    </WebSocketProvider>
  );
}
```

`selectedSessionId` lives at the App level because it's needed by:
- `SessionList` → to highlight the selected card
- `SessionDetail` → to know which session to show
- `Layout` → to show/hide the detail panel

It's passed down as props, not put in context, because only Layout and its direct children need it. No need for URL routing — this is a single-page dashboard, not a multi-page app.

### Age refresh timer

The current app re-renders session cards every 15s to update relative timestamps ("Active · 30s ago"). In React, this is handled by a timer in `SessionList` or `Layout`:

```tsx
const [, setTick] = useState(0);
useEffect(() => {
  const timer = setInterval(() => setTick(t => t + 1), 15000);
  return () => clearInterval(timer);
}, []);
```

This triggers a re-render every 15s, which causes `timeAgo()` to recompute. Only affects displayed strings — no API calls.

### Error handling pattern

- API errors: each component that fetches data shows inline error state (red text with retry button)
- WebSocket disconnect: connection banner at top (same as current behavior)
- React error boundary wrapping the main layout: catches render crashes, shows "Something went wrong, reload" message. **Note:** Error boundaries must be class components in React — they cannot be functional components. Create a small `ErrorBoundary` class component with `componentDidCatch` and `getDerivedStateFromError`.
- Loading states: skeleton placeholders for session cards and transcript entries while data loads

### Deliverable for Phase 0

A working React app at `localhost:5173` that:
- Shows "Control Center" header with connection status dot
- Connects to the WebSocket and receives session data
- Renders a simple "N sessions loaded" text proving the pipeline works
- All API calls proxy correctly to Fastify
- `npm run build` produces working static files in `dist/` that Fastify serves

---

## Phase 1 — Core UI + Foundation Features

Port all existing UI to React AND build the first new features. Every component is built once in React with new features included from the start.

### 1.1 Session Cards + WebSocket State

**What:** Port session grid, project grouping, status logic, card interactions, modals, and all existing features.

#### `SessionList.tsx`

- Receives `sessions` from the WebSocket context
- Separates into active (status !== 'stopped') and stopped
- Groups active sessions by `session.project` (sorted alphabetically, ungrouped at bottom)
- Renders a `ProjectGroup` per group
- Renders stopped sessions in a collapsible `<details>` section at bottom, sorted by updated_at desc

#### `ProjectGroup.tsx`

- Renders project heading with deterministic color accent
- Contains: `TodoSection` (Phase 3, placeholder div for now), then `SessionCard` list
- Project heading has "Pulse" button (Phase 3, hidden for now)

#### `SessionCard.tsx`

Props: `session: Session`, `isSelected: boolean`, `serverInfo: ServerInfo`, `onSelect: () => void`

Renders (same visual structure as current cards):
- Status indicator dot (colored by `getStatusClass()`)
- Label (or truncated session_id)
- Age (`timeAgo(created_at)`) + tool count
- Status text line (Active · 30s ago, Waiting for permission, Idle · 5m ago, Stopped · 1h ago)
- If waiting: pending tool detail (`formatToolDetail()`)
- If not waiting: last tool detail
- Transcript preview (fetched via `useApi`, refreshes every 20s for active sessions)
- AI summary (fetched via `useApi`, refreshes every 90s if aiSummaryEnabled)
- File list with conflict warnings (Phase 1.3 data)
- Action buttons row:
  - **Grant** (only if waiting + has tmux_target) — calls `api.grantPermission(id)`
  - **Terminal** (if has tmux_target) / **Link tmux** (if not) — opens SessionDetail or LinkTmuxModal
  - **Edit** — opens EditSessionModal
  - **Kill** — with confirmation dialog; special warning if `session.cwd === serverInfo.serverCwd`
- Click on card body: opens SessionDetail

Key behavior:
- Preview and summary cached in component state via `useApi` hook with TTL
- Wrapped in `React.memo` with a custom comparison that checks the fields that affect rendering:
  ```ts
  React.memo(SessionCard, (prev, next) =>
    prev.session.session_id === next.session.session_id &&
    prev.session.updated_at === next.session.updated_at &&
    prev.session.last_heartbeat === next.session.last_heartbeat &&
    prev.session.status === next.session.status &&
    prev.session.pending_tool === next.session.pending_tool &&
    prev.isSelected === next.isSelected
  )
  ```
  Comparing only `session_id` would prevent all re-renders — the comparison must include fields that change over time.
- Kill-protected sessions (serverCwd match) get orange Kill button + extra confirmation

#### `Header.tsx`

- App title "Control Center"
- Connection status dot (green/yellow/red)
- Summary bar: `N active · M waiting · P idle` (computed from sessions)
- Stats bar (fetched from `/api/stats` every 60s): total sessions, this week, most used tool
- Version banner: fetches `/api/version` on mount, shows "Update available: vX.Y.Z" banner if updateAvailable is true, with "Update" button that calls `POST /api/update`
- "History" button (Phase 2, hidden for now)
- "+ New Session" button (opens NewSessionModal)

#### `modals/NewSessionModal.tsx`

Port existing new session modal:
- Label input
- CWD input with project presets dropdown (fetched from `/api/projects`)
- Project name input (auto-filled from preset)
- Initial prompt textarea
- Auto-approve selector: Full / No Edits / None
- Template selector (fetched from `/api/templates`)
- "Save as template" button
- CLI type dropdown: Claude (default) — Gemini/Codex added in Phase 4
- "Skip permissions" checkbox (default off)
- Launch button → calls `api.launchSession()`

#### `modals/EditSessionModal.tsx`

- Label input (pre-filled)
- Project input with datalist (pre-filled)
- Save → calls `api.patchSession(id, { label, project })`

#### `modals/LinkTmuxModal.tsx`

- Fetches `/api/tmux-sessions` on open
- Lists available tmux sessions
- Click to link → calls `api.patchSession(id, { tmux_target })`

#### `EventLog.tsx`

- Renders `recentEvents[]` from WebSocket context
- Each row: timestamp, event type badge, session label, tool detail
- Clicking a row selects that session (opens SessionDetail)
- Auto-scrolls, caps at 200 events

#### `Toast.tsx`

- Toast container fixed at bottom-right
- `useToast()` hook: `showToast(message, type: 'info' | 'success' | 'error')`
- Auto-dismiss after 4.5s, click to dismiss
- Exposed via React Context

#### Web push notifications

Port existing push notification subscription logic:
- On mount, check `api.getVapidKey()` — if enabled, request notification permission
- Subscribe via `api.subscribePush()`
- Handle incoming push events (permission requests)
- PWA badge: `navigator.setAppBadge(waitingCount)` when sessions change

### 1.2 Transcript View (NEW)

**What:** Primary session view. Renders JSONL transcript as terminal-styled HTML. Accepts input.

#### Backend — `transcript.js`

New exported function:

```js
export function readTranscriptStructured(filePath, maxBytes = 65536) {
  // 1. Read tail of JSONL (same approach as readTranscriptTail)
  // 2. Parse each line
  // 3. For each entry, flatten message.content arrays:
  //    - type:"user" → entries with type:'user', content = text blocks joined
  //    - type:"assistant" → iterate message.content array:
  //      - {type:"thinking"} → entry with type:'thinking', content = thinking text
  //      - {type:"text"} → entry with type:'assistant', content = text
  //      - {type:"tool_use"} → entry with type:'tool_use', tool_name, tool_input_summary, tool_input_full
  //    - type:"tool_result" → entry with type:'tool_result', content = truncated result
  // 4. Return TranscriptEntry[]

  // Tool input summarization:
  //   Edit/Write/MultiEdit/NotebookEdit → file_path
  //   Bash → first 80 chars of command
  //   Read → file_path
  //   Glob → pattern
  //   Grep → pattern + path
  //   WebFetch → URL
  //   Other → first 80 chars of JSON.stringify(input)

  // Error handling:
  //   - Skip malformed JSON lines (same as existing readTranscriptTail)
  //   - Skip first line if reading from mid-file (may be partial)
  //   - Return empty array if file doesn't exist
}
```

#### Backend — `server.js`

New endpoint:

```
GET /api/sessions/:id/transcript?limit=100&before=<timestamp>
→ { entries: TranscriptEntry[], hasMore: boolean }
```

- Reads session's transcript path from DB
- If no `before` param: reads the most recent `limit` entries (default behavior). Calls `readTranscriptStructured(path, limit * 1024)` (scale bytes with limit).
- If `before` param is present (scroll-up pagination): reads entries older than that timestamp. Implementation: pass a larger `maxBytes` (e.g., `limit * 2048`) to read further back from the tail of the file, parse all entries, filter to only those with timestamp < `before`, then return the last `limit` entries from that filtered set. This is imprecise (may need to read even further back for very old entries) but practical for scroll-up pagination where users typically load a few pages.
- `hasMore`: set to `true` if the function read exactly `maxBytes` (meaning the file has more content before what was read). If fewer bytes were read, we reached the beginning of the file and `hasMore` = `false`.

New WebSocket feature — transcript streaming:

```js
// In-memory tracking of transcript subscriptions
const transcriptWatchers = new Map();
// Map<session_id, { watcher: FSWatcher | null, lastSize: number, subscribers: Set<WebSocket> }>

// When client sends { type: 'subscribe_transcript', session_id }:
//   1. Add client to subscribers set
//   2. If no watcher exists for this session:
//      a. Get transcript path from DB
//      b. Record current file size as lastSize
//      c. Start fs.watch() on the file (or setInterval polling as fallback)
//      d. On change: read bytes from lastSize to new size, parse new lines,
//         broadcast { type: 'transcript_update', session_id, entries } to all subscribers
//      e. Update lastSize
//   3. fs.watch fallback: if fs.watch fires no events for 5s after creation,
//      switch to 2s polling via setInterval (WSL/network drives can be unreliable)

// When client sends { type: 'unsubscribe_transcript' } or disconnects:
//   1. Remove from subscribers set
//   2. If subscribers set is empty, close watcher, delete from map
```

#### Frontend — `client/src/hooks/useTranscript.ts`

```ts
export function useTranscript(sessionId: string | null) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { sendMessage, connectionStatus } = useWebSocket();

  useEffect(() => {
    if (!sessionId) { setEntries([]); return; }
    if (connectionStatus !== 'connected') return; // wait for connection

    // 1. Fetch initial transcript
    setLoading(true);
    api.getTranscript(sessionId, 100)
      .then(data => setEntries(data.entries))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));

    // 2. Subscribe to live updates
    sendMessage({ type: 'subscribe_transcript', session_id: sessionId });

    // 3. Cleanup: unsubscribe
    return () => sendMessage({ type: 'unsubscribe_transcript' });
  }, [sessionId, connectionStatus]);
  // ↑ Re-runs when connectionStatus changes to 'connected' (after reconnect).
  // This re-subscribes to transcript updates because the server lost the
  // subscription when the WebSocket dropped. Also re-fetches the transcript
  // to catch any entries that arrived during the disconnect.

  // 4. Listen for transcript_update messages via the WS context's transcriptUpdates map.
  //    The useWebSocket context stores incoming transcript_update messages in a
  //    Map<string, TranscriptEntry[][]> keyed by session_id, with a version counter
  //    that increments on each update. This hook watches the version counter for its
  //    session_id, drains the queued entry arrays, and appends them:
  //    On update: setEntries(prev => [...prev, ...newEntries])

  // 5. Scroll-up pagination: when user scrolls to top, fetch older entries
  const loadOlder = useCallback(async () => {
    if (!sessionId || !entries.length) return;
    const oldest = entries[0];
    const older = await api.getTranscript(sessionId, 100, oldest.timestamp);
    if (older.entries.length) {
      setEntries(prev => [...older.entries, ...prev]);
    }
    setHasMore(older.hasMore);
  }, [sessionId, entries]);

  return { entries, loading, error, loadOlder, hasMore };
}
```

#### Frontend — `client/src/components/TranscriptView.tsx`

Props: `sessionId: string`

Renders `entries` from `useTranscript(sessionId)`.

Each entry type maps to a styled element:

| Entry type | Element | Style |
|---|---|---|
| `user` | `<div class="tx-user">` | `var(--ctp-blue)`, `❯` prefix, 2px left border in blue |
| `thinking` | `<details class="tx-thinking">` | `var(--ctp-overlay0)`, italic summary "Thinking...", collapsed by default |
| `assistant` | `<div class="tx-assistant">` | `var(--ctp-text)`, minimal formatting via regex (not a full markdown renderer — just code blocks via triple-backtick detection, inline code via single backtick, and **bold** via double asterisks). No dependency on react-markdown — keep it lightweight. If richer markdown is needed later, add `react-markdown` as a dependency at that point. |
| `tool_use` | `<details class="tx-tool">` | Summary: tool icon + name + `tool_input_summary`. Body: `tool_input_full` in `<pre>` |
| `tool_result` | `<div class="tx-result">` | Inside preceding tool_use. `var(--ctp-subtext0)`, smaller font. Green left border if ok, red if `is_error` |
| `system` | `<div class="tx-system">` | `var(--ctp-overlay0)`, centered, italic |

**tool_use + tool_result pairing:** In the flat `TranscriptEntry[]`, tool_result entries follow their corresponding tool_use. The component pairs them during rendering: iterate entries, and when entry[i] is `tool_use` and entry[i+1] is `tool_result`, render the result inside the tool_use's collapsible `<details>` block, then skip i+1. If a tool_use has no following tool_result (e.g., still in progress), render it without a result section and show a small spinner/ellipsis.

Auto-scroll behavior:
- `scrollContainerRef` on the transcript container
- Track `isScrolledUp` via `onScroll` handler (true if `scrollTop + clientHeight < scrollHeight - 50`)
- When entries change and `!isScrolledUp`: `scrollContainerRef.current.scrollTo({ top: scrollHeight, behavior: 'smooth' })`
- When `isScrolledUp`: show floating "↓ Jump to latest" button (fixed position, bottom-right of container)
- Click button: scroll to bottom, set `isScrolledUp = false`

Scroll-up pagination:
- When user scrolls to top (`scrollTop < 50`) and `hasMore` is true: call `loadOlder()` from useTranscript
- Show a small loading spinner at top while fetching
- After prepending older entries, restore scroll position so the view doesn't jump (save scrollHeight before prepend, set scrollTop to new scrollHeight - old scrollHeight after)

Loading state: skeleton blocks (3 pulsing gray bars) while initial fetch is in progress.

#### Frontend — `client/src/components/InputBar.tsx`

Props: `sessionId: string, mode: 'transcript' | 'terminal', terminalWs?: WebSocket`

Sticky at bottom of SessionDetail:
- `<textarea>` that auto-grows (1 row default, max 3 rows via scrollHeight measurement)
- Send button (or Enter key). Shift+Enter for newline.
- Quick-action buttons: `Ctrl+C` (sends `\x03`), `Tab` (sends `\t`), `↑` (sends `\x1b[A`), `↓` (sends `\x1b[B`)
- On send: calls `api.sendInput(sessionId, text)`, clears textarea
- Focus textarea on mount

**Mode behavior:**
- In `transcript` mode: sends via `api.sendInput()` (HTTP POST to tmux load-buffer/paste-buffer)
- In `terminal` mode: sends via the terminal WebSocket (`terminalWs.send(JSON.stringify({type:'input', data: text + '\n'}))`)
- Quick buttons always send via the appropriate channel based on mode
- In terminal mode on desktop, xterm.js also captures keyboard directly — InputBar is supplementary (mainly useful on mobile where virtual keyboard + xterm.js interaction is poor). On desktop, InputBar is hidden when terminal tab is active (xterm.js handles input natively).

#### Frontend — `client/src/components/TerminalView.tsx`

Props: `sessionId: string, tmuxTarget: string`

xterm.js wrapped in React:
- `useEffect` on mount: create Terminal instance, attach FitAddon + WebLinksAddon, open in container ref
- Connect WebSocket to `/ws/terminal/${sessionId}`
- On WS message `{type:'output', data}`: `terminal.write(data)`
- On terminal input: send `{type:'input', data}` to WS
- On resize: `fitAddon.fit()`, send `{type:'resize', cols, rows}` to WS
- `useEffect` cleanup: dispose terminal, close WS
- ResizeObserver on container for dynamic resizing

#### Frontend — `client/src/components/SessionDetail.tsx`

Props: `session: Session, onClose: () => void`

Layout:
- Header bar: session label, status badge, close (×) button
- Tab bar: "Transcript" (default) | "Terminal" (only if tmux_target exists)
- Content area: `<TranscriptView>` or `<TerminalView>` based on active tab
- `<InputBar>` visible at bottom:
  - Transcript tab: always shown (sends via API)
  - Terminal tab on mobile: shown (sends via terminal WS, since xterm.js keyboard interaction is poor on mobile)
  - Terminal tab on desktop: hidden (xterm.js captures keyboard directly)

Responsive behavior:
- Desktop (>= 1200px): slides in from right as a panel, takes 60% width
- Tablet (768-1199px): slides over session list, takes 70% width
- Mobile (< 768px): full-screen overlay with back arrow
- CSS transition: `transform: translateX(100%)` → `translateX(0)` with 200ms ease

Keyboard: Escape closes the panel.

### 1.3 File Change Display (NEW)

**What:** Show which files each session has modified. Warn when two active sessions in the same project edit the same file.

#### Backend — `hooks/cc-heartbeat.sh`

Add `file_path` extraction to the jq payload:

```bash
PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: "Heartbeat",
  session_id: .session_id,
  tool_name: (.tool_name // null),
  file_path: (
    if (.tool_name == "Write" or .tool_name == "Edit" or .tool_name == "MultiEdit" or .tool_name == "NotebookEdit") then
      (.tool_input.file_path // .tool_input.path // null)
    else null end
  ),
  timestamp: (now | todate)
}')
```

#### Backend — `db.js`

New table:

```sql
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
```

Prepared statements:

```js
// NOTE: Use @param named style to match existing db.js patterns (not positional ?)
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
```

#### Backend — `server.js`

In Heartbeat handler:
```js
if (body.file_path) {
  db.insertFileEdit(body.session_id, body.file_path, body.tool_name);
}
```

Include `file_path` in the WebSocket heartbeat event broadcast.

New endpoint:
```
GET /api/sessions/:id/files
→ { files: [{ file_path, tool_name, last_edited }] }
```

Conflict detection — in the session_update WebSocket broadcast, after any heartbeat with a file_path:
```js
const session = db.getSession(session_id);
if (session.project) {
  const conflicts = db.getActiveFileConflicts(session.project);
  // Attach relevant conflicts to the session_update message
}
```

#### Frontend — `SessionCard.tsx`

- Fetch files via `useApi(`/api/sessions/${id}/files`)` (refresh every 20s for active sessions, never for stopped)
- Show collapsible "Files (N)" section after preview/summary, listing basenames with tooltips for full paths
- If `session.conflicts` is present: yellow warning icon (⚠) with tooltip: "Also being edited by: {other session labels}"

### 1.4 Mobile & Desktop Responsive Layout

#### `Layout.tsx`

```
Desktop (>= 1200px):
┌──────────────────────────────────────────────┐
│ Header (full width)                          │
├───────────────────────┬──────────────────────┤
│ SessionList (40%)     │ SessionDetail (60%)   │
│ + EventLog (below)    │                       │
└───────────────────────┴──────────────────────┘

Tablet (768-1199px):
┌──────────────────────────────────────────────┐
│ Header                                        │
├──────────────────────────────────────────────┤
│ SessionList (full width)                      │
│ SessionDetail slides over from right (70%)    │
└──────────────────────────────────────────────┘

Mobile (< 768px):
┌──────────────────────────────────────────────┐
│ Header (compact)                              │
├──────────────────────────────────────────────┤
│ SessionList (full width)                      │
│ SessionDetail = full-screen overlay           │
└──────────────────────────────────────────────┘
```

CSS implementation: CSS Grid with `grid-template-columns` changing at breakpoints. SessionDetail panel uses CSS `transform: translateX()` for slide-in animation.

Mobile specifics:
- All interactive elements: min 44px touch target
- Grant button on waiting cards: full-width, 48px tall, prominent red background
- No hover-only interactions — everything works on tap
- Transcript view: fills viewport height minus header (48px) and input bar (52px)
- Scrolling: `-webkit-overflow-scrolling: touch` for smooth momentum scroll

Keyboard shortcuts (desktop only, via `useEffect` on `document.keydown`):
- `j` / `k`: navigate session cards (next / previous)
- `Enter`: open selected session detail
- `Escape`: close session detail
- `/`: focus search (Phase 2)

---

## Phase 2 — Safety & History

### 2.1 Snapshots & Revert

**What:** Auto-capture project state when sessions start. One-click revert from dashboard.

#### Backend — new module `snapshots.js`

```js
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';

const SNAPSHOTS_DIR = join(process.cwd(), 'data', 'snapshots');

function repoDir(cwd) {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(SNAPSHOTS_DIR, hash);
}

function gitEnv(cwd) {
  return { GIT_DIR: join(repoDir(cwd), 'repo.git'), GIT_WORK_TREE: cwd };
}

export function initRepo(cwd) {
  const dir = join(repoDir(cwd), 'repo.git');
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: dir, stdio: 'ignore' });
  // Write default exclude rules (equivalent to .gitignore)
  const excludeDir = join(dir, 'info');
  mkdirSync(excludeDir, { recursive: true });
  writeFileSync(join(excludeDir, 'exclude'), [
    'node_modules/', '.env', '.env.*', 'dist/', 'build/', '.next/',
    '*.log', '.DS_Store', '__pycache__/', '*.pyc', '.git/',
    '.control-center/'
  ].join('\n'));
}

export function capture(cwd) {
  // Stage all files, write tree, return hash
  const env = gitEnv(cwd);
  execFileSync('git', ['add', '-A'], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 30000 });
  const hash = execFileSync('git', ['write-tree'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 }).trim();
  return hash || null;
}

export function diff(cwd, treeHash) {
  // Returns { added: string[], modified: string[], deleted: string[] }
  const env = gitEnv(cwd);
  // Capture current state
  const currentHash = capture(cwd);
  if (!currentHash) return { added: [], modified: [], deleted: [] };
  // Diff the two trees
  const output = execFileSync('git', ['diff-tree', '-r', '--name-status', treeHash, currentHash],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
  const result = { added: [], modified: [], deleted: [] };
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [status, filePath] = line.split('\t');
    if (status === 'A') result.added.push(filePath);
    else if (status === 'M') result.modified.push(filePath);
    else if (status === 'D') result.deleted.push(filePath);
  }
  return result;
}

export function restore(cwd, treeHash) {
  // Restore working tree to match treeHash, return changed files
  const changes = diff(cwd, treeHash);
  const env = gitEnv(cwd);
  execFileSync('git', ['read-tree', treeHash], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 10000 });
  execFileSync('git', ['checkout-index', '-a', '-f'], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 30000 });
  // Delete files that were added after the snapshot
  for (const f of changes.added) {
    const fullPath = join(cwd, f);
    try { unlinkSync(fullPath); } catch {}
    // Clean up empty parent directories (but never the project root itself)
    const parentDir = dirname(fullPath);
    if (parentDir !== cwd) {
      try { rmdirSync(parentDir); } catch {}
    }
  }
  return [...changes.added, ...changes.modified, ...changes.deleted];
}
```

#### Snapshot per session vs per CWD

Multiple sessions may share a CWD. Each session gets its own snapshot_hash stored in its DB row. The shadow repo is shared (one per CWD), but each `capture()` call returns a unique tree hash representing the state at that moment. This is fine — tree hashes are immutable. Session A's snapshot is not affected by Session B capturing later.

#### Backend — `db.js`

Migration (wrap in try/catch — SQLite throws if column already exists):
```js
try { db.exec("ALTER TABLE sessions ADD COLUMN snapshot_hash TEXT"); } catch {}
```

New statement (use `@param` named style to match existing db.js patterns):
```js
updateSnapshotHash: db.prepare('UPDATE sessions SET snapshot_hash = @hash WHERE session_id = @session_id')
```

#### Backend — `server.js`

In SessionStart handler — run snapshot capture asynchronously so it doesn't block the hook response (large projects may take seconds for `git add -A`):

```js
import * as snapshots from './snapshots.js';
// After session upsert — fire and forget, don't block the hook response:
setImmediate(() => {
  try {
    snapshots.initRepo(cwd);
    const hash = snapshots.capture(cwd);
    if (hash) db.updateSnapshotHash(session_id, hash);
  } catch (err) {
    fastify.log.warn({ err, session_id }, 'Snapshot capture failed');
  }
});
```

New endpoints:
```
GET /api/sessions/:id/snapshot-diff → { added: string[], modified: string[], deleted: string[] }
  - Returns 404 if session has no snapshot_hash
  - Returns 404 if session has no cwd

POST /api/sessions/:id/revert → { reverted: true, files: string[] }
  - Only allowed if session.status === 'stopped'
  - Only allowed if session.snapshot_hash exists
  - Returns 400 if session is still active
```

#### Frontend — `SessionCard.tsx` + `modals/SnapshotDiffModal.tsx`

On stopped session cards where `session.snapshot_hash` exists:
- "Revert" button in card actions
- Click fetches `api.getSnapshotDiff(id)` and opens `SnapshotDiffModal`
- Modal shows file lists: added (red, will be deleted), modified (yellow, will be restored), deleted (green, will be restored)
- "Confirm Revert" button calls `api.revertSession(id)`, shows toast

### 2.2 Session History & Search

**What:** Searchable archive of past sessions.

#### Backend — `db.js`

FTS5 virtual table:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  tool_name,
  tool_input,
  content='events',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, tool_name, tool_input)
  VALUES (new.id, new.tool_name, new.tool_input);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, tool_name, tool_input)
  VALUES ('delete', old.id, old.tool_name, old.tool_input);
END;
```

Note: FTS5 uses the special `'delete'` command (passed as the first column value) to remove entries from its index. Without this trigger, the FTS5 index would accumulate stale entries whenever events are deleted during session cleanup.

Backfill existing data on first run:
```js
// After creating the FTS table, check if it's empty and backfill
const ftsCount = db.prepare('SELECT COUNT(*) as n FROM events_fts').get().n;
if (ftsCount === 0) {
  db.exec(`INSERT INTO events_fts(rowid, tool_name, tool_input)
           SELECT id, tool_name, tool_input FROM events WHERE tool_input IS NOT NULL`);
}
```

Search query:
```sql
-- NOTE: Use @param named style to match existing db.js patterns (not :param or positional ?)
SELECT DISTINCT s.session_id, s.label, s.project, s.cwd, s.status,
       s.created_at, s.updated_at, h.last_seen as last_heartbeat,
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
LIMIT @limit OFFSET @offset
```

Note: FTS5 MATCH uses its own query syntax. For simple keyword searches, wrap the query term: `'"' + q + '"'` for exact phrase, or just pass the raw term for OR-matching.

#### Backend — `server.js`

```
GET /api/sessions/history?project=X&q=keyword&from=2026-03-01&to=2026-03-20&limit=50&offset=0
→ { sessions: Session[], total: number }
```

For the `total` count (needed for "showing N of M results"), use a separate count query:
```sql
SELECT COUNT(DISTINCT s.session_id) as total
FROM sessions s
WHERE ... (same WHERE clause as the main query, without LIMIT/OFFSET)
```

Run both in a transaction for consistency. The count query is cheap because SQLite caches the query plan.

#### Frontend — `HistoryView.tsx`

- Toggled via "History" button in Header
- On desktop: replaces EventLog in the left panel. On mobile: full-screen view.
- Search bar (debounced 300ms) + project dropdown (from known projects) + date range inputs
- Results: compact list of sessions (label, project, date, tool_count, status badge)
- Click → opens SessionDetail with TranscriptView for that session (works for stopped sessions too since transcripts persist)
- "Load more" button at bottom (increments offset)
- "Clear filters" button to reset

---

## Phase 3 — Coordination & Productivity

### 3.1 Project Pulse (Shared Working Memory)

**What:** Per-project living document. Auto-populated by server. User-editable notes section. Injected into session launch prompts.

#### Backend — new module `pulse.js`

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './db.js';

const PULSE_DIR = join(process.cwd(), 'data', 'pulse');
mkdirSync(PULSE_DIR, { recursive: true });

function pulseFilePath(project) {
  // Sanitize project name for filesystem
  const safe = project.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(PULSE_DIR, `${safe}.json`);
}

// Read user-editable notes from disk
export function getUserNotes(project) {
  try {
    const data = JSON.parse(readFileSync(pulseFilePath(project), 'utf8'));
    return data.userNotes || '';
  } catch { return ''; }
}

// Save user-editable notes to disk
export function setUserNotes(project, notes) {
  const filePath = pulseFilePath(project);
  let data = {};
  try { data = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
  data.userNotes = notes;
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Generate the full pulse document from current state
export function generatePulse(project) {
  const activeSessions = db.getSessionsByProject(project).filter(s => s.status !== 'stopped');
  const recentFiles = db.getRecentFileEditsByProject(project, 30); // last 30 min
  const conflicts = db.getActiveFileConflicts(project);
  const userNotes = getUserNotes(project);

  let md = `# Project Pulse: ${project}\nUpdated: ${new Date().toISOString()}\n\n`;

  // Active Agents section
  md += `## Active Agents\n`;
  if (activeSessions.length === 0) {
    md += `No active sessions.\n\n`;
  } else {
    for (const s of activeSessions) {
      const label = s.label || s.session_id.slice(0, 8);
      const lastTool = s.last_tool ? `Last: ${s.last_tool}` : '';
      md += `- **${label}**: ${lastTool}\n`;
    }
    md += '\n';
  }

  // Recent File Changes section
  if (recentFiles.length > 0) {
    md += `## Recent File Changes\n`;
    for (const f of recentFiles.slice(0, 15)) {
      const sessionLabel = activeSessions.find(s => s.session_id === f.session_id)?.label || f.session_id.slice(0, 8);
      md += `- ${f.file_path} — ${sessionLabel}\n`;
    }
    md += '\n';
  }

  // Conflicts section
  if (conflicts.length > 0) {
    md += `## Conflicts\n`;
    for (const c of conflicts) {
      md += `- ${c.file_path} is being edited by: ${c.session_ids}\n`;
    }
    md += '\n';
  }

  // User Notes section
  md += `## Notes\n${userNotes || '(No notes yet — add big-picture context, priorities, or warnings here.)'}\n`;

  return { markdown: md, userNotes };
}

// Compact version for injecting into session prompts (no markdown headers, ≤2000 tokens)
export function getPulseForPrompt(project) {
  const pulse = generatePulse(project);
  // Strip markdown headers, compress whitespace, truncate
  const compact = pulse.markdown
    .replace(/^#+\s.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000); // rough token estimate: 3000 chars ≈ 750 tokens
  return compact;
}
```

New prepared statements in `db.js`:

```js
// NOTE: Use @param named style to match existing db.js patterns (not positional ?)
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
```

#### Regeneration triggers

Call `generatePulse()` (which is cheap — just DB reads) on:
- SessionStart/Stop events (debounce: 2 seconds)
- Heartbeats with file_path (debounce: 10 seconds — these are frequent)
- User saves notes via API (immediate)

Debounce implementation in `server.js`:
```js
const pulseDebounceTimers = new Map(); // project → NodeJS.Timeout

function schedulePulseRegeneration(project, delayMs) {
  if (pulseDebounceTimers.has(project)) {
    clearTimeout(pulseDebounceTimers.get(project));
  }
  pulseDebounceTimers.set(project, setTimeout(() => {
    pulseDebounceTimers.delete(project);
    pulse.generatePulse(project);  // regenerate + optionally write to project dir
  }, delayMs));
}
```

Called with `delayMs = 2000` after session events, `delayMs = 10000` after file heartbeats.

#### Backend — `server.js`

New endpoints:
```
GET /api/projects/:name/pulse → { markdown: string, userNotes: string }
PUT /api/projects/:name/pulse/notes → body: { notes: string } → { ok: true }
GET /api/projects/:name/pulse/prompt → { text: string }
```

Integration with session launch — in `POST /api/sessions/launch`:

**IMPORTANT:** At launch time, the DB session does NOT exist yet (it's created when the `SessionStart` hook fires after Claude starts). There is no `session` object to check `pulse_enabled` on. Since `pulse_enabled` defaults to 1 for all new sessions, always inject pulse when a project is specified:

```js
if (project) {
  const pulseText = pulse.getPulseForPrompt(project);
  if (pulseText.trim()) {
    initialPrompt = `[Project context — auto-generated by Control Center]\n${pulseText}\n[End project context]\n\n${initialPrompt}`;
  }
}
```

#### Backend — `db.js`

Migration (wrap in try/catch — SQLite throws if column already exists):
```js
try { db.exec("ALTER TABLE sessions ADD COLUMN pulse_enabled INTEGER DEFAULT 1"); } catch {}
```

#### Backend — `config.js`

New env var:
```js
pulseWriteToProject: process.env.CC_PULSE_WRITE_TO_PROJECT === 'true',
```

If enabled, after generating pulse, also write to `<cwd>/.control-center/pulse.md`. Agents can read this file for mid-session awareness.

#### Frontend — `PulsePanel.tsx`

Props: `project: string, onClose: () => void`

- Opens as a slide-in panel or modal from the "Pulse" button on ProjectGroup header
- Top section: rendered pulse markdown (read-only). Refreshes every 30s via `useApi`.
- Bottom section: "Notes" textarea (pre-filled from `pulseDocument.userNotes`)
- Auto-save: debounce 1s after typing, call `api.updatePulseNotes(project, notes)`
- Save indicator: "Saved" / "Saving..." text

#### Frontend — `SessionCard.tsx`

- Small "Pulse" toggle (on/off) in the card actions or edit modal
- Toggles `session.pulse_enabled` via `api.patchSession(id, { pulse_enabled: value ? 1 : 0 })`
- **Note:** Two places need updating: (1) The `PATCH /api/sessions/:id` route handler in `server.js` must accept `pulse_enabled` in the body (in addition to `label`, `tmux_target`, `project`). (2) The `updateSession` prepared statement in `db.js` must add `pulse_enabled = COALESCE(@pulse_enabled, pulse_enabled)` to its SET clause, and the exported `updateSession()` function must accept and pass `pulse_enabled`. Add both when implementing the Pulse feature.

### 3.2 TODO Tracker

**What:** Per-project TODO list. One-click launch as Claude Code session.

#### Backend — `db.js`

```sql
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
```

Prepared statements (use `@param` named style to match existing db.js patterns):
```js
getTodosByProject: db.prepare(
  `SELECT * FROM todos WHERE project = @project ORDER BY
   CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'done' THEN 2 END,
   priority ASC, created_at DESC`
),
insertTodo: db.prepare(
  `INSERT INTO todos (project, title, details, priority) VALUES (@project, @title, @details, @priority) RETURNING *`
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
```

#### Backend — `server.js`

CRUD:
```
GET    /api/todos?project=X              → { todos: Todo[] }
POST   /api/todos                         → body: { project, title, details?, priority? } → Todo
PATCH  /api/todos/:id                     → body: { title?, details?, status?, priority? } → { ok: true }
DELETE /api/todos/:id                     → { ok: true }
```

Launch:
```
POST   /api/todos/:id/launch             → body: { skipPermissions?: boolean } → { success: true, tmux_target, todo_id }
```

Launch implementation:

**IMPORTANT:** Like the main launch endpoint (`POST /api/sessions/launch`), the DB session does NOT exist at launch time. `createTmuxSession()` returns a `tmux_target` (e.g., "cc-0"), not a `session_id`. The `session_id` is only created when the `SessionStart` hook fires after the CLI starts. Therefore, the todo↔session link must happen asynchronously in the SessionStart handler, not in this endpoint.

1. Read the todo from DB
2. Resolve project CWD (in order of priority):
   a. Check `data/projects.json` for a preset with matching project name → use its `cwd`
   b. Check most recent session with the same `project` field → use its `cwd`
   c. If neither found: return 400 error `{ error: "Cannot determine CWD for project. Add it to project presets." }`
3. Build prompt (see template below)
4. If pulse exists for this project, prepend pulse context (same pattern as main launch endpoint — `pulse_enabled` defaults to 1 for new sessions)
5. Call `createTmuxSession({ cwd, label: todo.title, initialPrompt, skipPermissions })` — note: `project` is NOT a parameter of `createTmuxSession()`, it goes into `pendingLabels` (step 6)
6. Store in `pendingLabels.set(tmuxTarget, { label: todo.title, project: todo.project, autoApproveDbVal: 1, todoId: todo.id, createdAt: Date.now() })` — follows the same pattern as the existing launch endpoint (server.js lines 606-614). The `todoId` field is new.
7. In the **SessionStart handler** (where `pendingLabels` is consumed), add: `if (pending.todoId) { db.linkTodoSession(pending.todoId, session_id); }` — this is where the todo↔session link actually happens, because now we have the real `session_id`.
8. Return `{ success: true, tmux_target: tmuxTarget, todo_id: todo.id }`

The `skipPermissions` flag passes `--dangerously-skip-permissions` as an additional argument to the `claude` command in the tmux pane.

Session lifecycle — broadcast `todo_session_stopped` when sessions actually stop:

**IMPORTANT:** Do NOT put this in the `Stop` hook event handler. In Control Center, the `Stop` hook event fires at the end of each Claude **turn** (not when the session truly ends). The server handles Stop by setting status to `'active'`, not `'stopped'`. Sessions only become `'stopped'` via two paths:

1. **Explicit kill** — `POST /api/sessions/:id/kill` sets `status = 'stopped'`
2. **Zombie cleanup** — `cleanupZombies()` marks sessions as stopped when tmux is gone

Add the todo notification in **both** places:

In the kill endpoint (`POST /api/sessions/:id/kill`), after `db.updateStatus(request.params.id, 'stopped')`:
```js
const todo = db.getTodoBySessionId(request.params.id);
if (todo) {
  const msg = JSON.stringify({ type: 'todo_session_stopped', todo_id: todo.id, session_id: request.params.id });
  for (const client of dashboardClients) {
    try { if (client.readyState === 1) client.send(msg); } catch {}
  }
}
```

In `cleanupZombies()`, after `db.updateStatus(s.session_id, 'stopped')`:
```js
const todo = db.getTodoBySessionId(s.session_id);
if (todo) {
  const msg = JSON.stringify({ type: 'todo_session_stopped', todo_id: todo.id, session_id: s.session_id });
  for (const client of dashboardClients) {
    try { if (client.readyState === 1) client.send(msg); } catch {}
  }
}
```

Note: `dashboardClients` is a module-level Set (server.js line 21), accessible from both `cleanupZombies()` and the route handlers.

Launch prompt:
```
You are a skilled software engineer working on the "{project}" project.
You have been assigned a specific task to complete.

Before writing any code:
1. Read the project's CLAUDE.md file to understand conventions, architecture, and rules.
2. Read .control-center/pulse.md if it exists for awareness of other active sessions.
3. Identify and read the files most relevant to this task.
4. Formulate a clear, concise implementation plan.
5. Present your plan and wait for approval before proceeding.

After receiving approval, implement the changes methodically:
- Make the minimal changes needed to accomplish the task.
- Run existing tests if applicable (check CLAUDE.md for test commands).
- Do not modify files unrelated to the task.

## Task: {title}

{details}

Begin by reading CLAUDE.md and the relevant source files, then present your implementation plan.
```

#### Frontend — `TodoSection.tsx`

Props: `project: string`

- Fetches `api.getTodos(project)` on mount, refreshes when `todo_session_stopped` WS message arrives
- Collapsible header: "TODOs (N)" with "+ Add" button
- When expanded: list of `TodoItem` components
- "+ Add" button toggles an inline form: title input (required) + details textarea (optional) + Save/Cancel buttons

#### Frontend — `TodoItem.tsx`

Props: `todo: Todo, onUpdate: () => void`

- Compact row: status dot + title + action buttons
- Status dot colors: pending (gray), in_progress (blue, pulsing), done (green)
- Click title to expand: inline details textarea (editable, auto-saves on blur via debounced `api.updateTodo`)
- Buttons:
  - "▶ Launch" (only if pending) — opens confirmation popover:
    - Pre-filled session label (todo title)
    - "Skip permissions" checkbox (default off)
    - "Launch" / "Cancel"
    - On launch: `api.launchTodo(id, skipPermissions)`, optimistically update status to in_progress
  - "✓ Done" (if in_progress) — `api.updateTodo(id, { status: 'done' })`
  - "×" delete — with confirmation
- When `todo_session_stopped` arrives for this todo's session: show inline prompt "Session stopped. Mark as done?" with Yes/No buttons

---

## Phase 4 — Expansion

### 4.1 Multi-Model Support (Gemini CLI + Codex CLI)

#### Backend — `db.js`

Migration (wrap in try/catch — SQLite throws if column already exists):
```js
try { db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'"); } catch {}
```

#### Backend — `hooks/gc-report.sh` (Gemini lifecycle)

Gemini CLI provides env vars: `$GEMINI_SESSION_ID`, `$GEMINI_CWD`
Hook JSON on stdin includes: `event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0
CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"
INPUT=$(cat)

# Map Gemini event names to Control Center event names
EVENT=$(echo "$INPUT" | jq -r '.event_name // empty')
case "$EVENT" in
  SessionStart) CC_EVENT="SessionStart" ;;
  SessionEnd)   CC_EVENT="Stop" ;;
  BeforeTool)   CC_EVENT="PermissionRequest" ;;
  *)            exit 0 ;;
esac

TMUX_SESSION_NAME=""
if [ -n "${TMUX:-}" ]; then
  TMUX_SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || true)
fi

PAYLOAD=$(echo "$INPUT" | jq -c \
  --arg cc_event "$CC_EVENT" \
  --arg tmux_session "$TMUX_SESSION_NAME" \
  '{
    event: $cc_event,
    session_id: .session_id,
    cwd: .cwd,
    tool_name: (.tool_name // null),
    tool_input: (.tool_input // null),
    cli_type: "gemini",
    timestamp: (now | todate),
    tmux_session: (if $tmux_session != "" then $tmux_session else null end)
  }')

curl -sS --max-time 5 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
```

#### Backend — `hooks/gc-heartbeat.sh` (Gemini tool activity)

Triggered on `AfterTool` events:

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0
CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"
INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: "Heartbeat",
  session_id: .session_id,
  tool_name: (.tool_name // null),
  file_path: (
    if (.tool_name == "edit_file" or .tool_name == "write_file") then
      (.tool_input.path // null)
    else null end
  ),
  cli_type: "gemini",
  timestamp: (now | todate)
}')

curl -sS --max-time 2 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
```

Note: Gemini tool names differ from Claude's (e.g., `edit_file` vs `Edit`). The `shouldAutoApprove()` function needs to recognize both.

#### Backend — `hooks/cx-report.sh` (Codex lifecycle)

Codex provides `session_id`, `cwd`, `transcript_path` in hook JSON:

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0
CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"
INPUT=$(cat)

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
case "$EVENT" in
  SessionStart|Stop) ;;
  *) exit 0 ;;
esac

TMUX_SESSION_NAME=""
if [ -n "${TMUX:-}" ]; then
  TMUX_SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || true)
fi

PAYLOAD=$(echo "$INPUT" | jq -c \
  --arg tmux_session "$TMUX_SESSION_NAME" \
  '{
    event: .hook_event_name,
    session_id: .session_id,
    cwd: .cwd,
    transcript_path: (.transcript_path // null),
    cli_type: "codex",
    timestamp: (now | todate),
    tmux_session: (if $tmux_session != "" then $tmux_session else null end)
  }')

curl -sS --max-time 5 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
```

#### Backend — `codex-watcher.js` (Codex heartbeat via transcript watching)

Codex has no PostToolUse hook. Instead, watch the transcript JSONL file for new lines:

```js
import { watch, statSync, openSync, readSync, closeSync } from 'node:fs';

const activeWatchers = new Map(); // session_id → { watcher, interval, lastSize }

export function startWatching(sessionId, transcriptPath, onHeartbeat) {
  if (!transcriptPath || activeWatchers.has(sessionId)) return;
  let lastSize = 0;
  try { lastSize = statSync(transcriptPath).size; } catch { return; }

  const checkNewContent = () => {
    try {
      const currentSize = statSync(transcriptPath).size;
      if (currentSize <= lastSize) return;
      // Read new bytes
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      readSync(fd, buf, 0, buf.length, lastSize);
      closeSync(fd);
      lastSize = currentSize;
      // Parse new lines for tool activity
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use') {
                onHeartbeat({ tool_name: block.name, file_path: block.input?.file_path || null });
              }
            }
          }
        } catch {}
      }
    } catch {}
  };

  // Try fs.watch first, fall back to polling
  let watcher = null;
  try {
    watcher = watch(transcriptPath, { persistent: false }, checkNewContent);
  } catch {}

  // Always also poll as fallback (fs.watch unreliable on WSL/NFS)
  const interval = setInterval(checkNewContent, 3000);

  activeWatchers.set(sessionId, { watcher, interval, lastSize });
}

export function stopWatching(sessionId) {
  const entry = activeWatchers.get(sessionId);
  if (!entry) return;
  entry.watcher?.close();
  clearInterval(entry.interval);
  activeWatchers.delete(sessionId);
}
```

#### Backend — `server.js` changes

Hook ingest: accept `cli_type` field, pass to `db.upsertSession()`.

In the Stop event handler, clean up Codex watchers:
```js
if (session.cli_type === 'codex') {
  codexWatcher.stopWatching(session_id);
}
```

`shouldAutoApprove()`: add tool name mapping:
```js
// Gemini tool names → canonical names
const GEMINI_TOOL_MAP = { edit_file: 'Edit', write_file: 'Write', read_file: 'Read', shell: 'Bash', /* ... */ };

function shouldAutoApprove(payload, session) {
  const toolName = payload.cli_type === 'gemini'
    ? (GEMINI_TOOL_MAP[payload.tool_name] || payload.tool_name)
    : payload.tool_name;
  // ... rest of existing logic using canonical toolName
}
```

#### Backend — `pty-manager.js` changes

`createTmuxSession()` accepts `cli_type` parameter:
```js
// Build the CLI command based on type
// NOTE: Gemini and Codex CLI flags below are best guesses and MUST be verified
// against actual CLI documentation at implementation time. Run `gemini --help`
// and `codex --help` to confirm the correct flags.
let cliCmd;
switch (cli_type) {
  case 'gemini':
    cliCmd = skipPermissions ? 'gemini --yolo' : 'gemini';  // verify: may be --auto-approve or similar
    break;
  case 'codex':
    cliCmd = skipPermissions ? 'codex --full-auto' : 'codex';  // verify: check `codex --help` for approval flags
    break;
  case 'claude':
  default:
    cliCmd = skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude';
}
// Then launch in tmux with initialPrompt appended
```

For Codex sessions, also start the transcript watcher after launch:
```js
if (cli_type === 'codex') {
  // Codex transcript path is known after SessionStart hook fires
  // Register a one-time listener for SessionStart from this tmux target
  // Then call codexWatcher.startWatching(session_id, transcript_path, heartbeatCallback)
}
```

#### Backend — `install.sh` changes

Add detection and deployment for Gemini and Codex:

```bash
# Gemini CLI hooks
if command -v gemini &>/dev/null; then
  echo "Gemini CLI detected — deploying hooks..."
  GEMINI_HOOKS_DIR="$HOME/.gemini/hooks"
  mkdir -p "$GEMINI_HOOKS_DIR"
  cp "$INSTALL_DIR/hooks/gc-report.sh" "$GEMINI_HOOKS_DIR/"
  cp "$INSTALL_DIR/hooks/gc-heartbeat.sh" "$GEMINI_HOOKS_DIR/"
  chmod +x "$GEMINI_HOOKS_DIR"/*.sh
  # Register hooks in ~/.gemini/settings.json
  # Gemini hooks are registered under the "hooks" key, keyed by event name:
  # {
  #   "hooks": {
  #     "SessionStart":  [{ "command": "~/.gemini/hooks/gc-report.sh" }],
  #     "SessionEnd":    [{ "command": "~/.gemini/hooks/gc-report.sh" }],
  #     "BeforeTool":    [{ "command": "~/.gemini/hooks/gc-report.sh" }],
  #     "AfterTool":     [{ "command": "~/.gemini/hooks/gc-heartbeat.sh" }]
  #   }
  # }
  # Use jq to merge into existing settings without overwriting other keys.
fi

# Codex CLI hooks
if command -v codex &>/dev/null; then
  echo "Codex CLI detected — deploying hooks..."
  CODEX_HOOKS_DIR="$HOME/.codex/hooks"
  mkdir -p "$CODEX_HOOKS_DIR"
  cp "$INSTALL_DIR/hooks/cx-report.sh" "$CODEX_HOOKS_DIR/"
  chmod +x "$CODEX_HOOKS_DIR"/*.sh
  # Register hooks in ~/.codex/hooks.json (or ~/.codex/config.toml depending on version)
  # Codex hooks format:
  # {
  #   "hooks": {
  #     "SessionStart": [{ "command": "~/.codex/hooks/cx-report.sh" }],
  #     "Stop":         [{ "command": "~/.codex/hooks/cx-report.sh" }]
  #   }
  # }
  # Note: Codex only supports SessionStart/Stop hooks. No tool-level hooks.
fi
```

#### Backend — `transcript.js` changes

`readTranscriptStructured()` needs to handle different JSONL formats:
- Claude: `{type: "user"|"assistant", message: {content: [...]}}` — well-documented
- Gemini: sessions stored in `~/.gemini/tmp/<hash>/chats/` — format similar but field names may differ. Research needed at implementation time.
- Codex: rollout JSONL at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — each line is a conversation turn. Research needed at implementation time.

The function should detect format by checking for known fields and dispatch to the appropriate parser. The output is always the same `TranscriptEntry[]` regardless of source CLI.

#### Frontend — `NewSessionModal.tsx`

Add CLI selector:
- Dropdown: "Claude Code" (default), "Gemini CLI", "Codex CLI"
- When Codex is selected: show additional "Approval Policy" dropdown (Auto / On Request)
- When Gemini is selected: no additional options needed (hooks handle everything)
- The CLI type is passed to `api.launchSession({ ..., cli_type })`

#### Frontend — `SessionCard.tsx`

- Small badge next to label showing CLI type: "C" (blue), "G" (green), "X" (orange)
- Only shown if `cli_type !== 'claude'` (keep default clean)
- Permission grant button: shown for Claude + Gemini, hidden for Codex (show tooltip "Codex approval policy is set at launch")

---

## Configuration Summary

New `.env` variables across all phases:

| Variable | Default | Phase | Description |
|---|---|---|---|
| `CC_PULSE_WRITE_TO_PROJECT` | `false` | 3 | Write pulse.md into project directories |

No other new env vars needed — all other configuration is in-DB or via the dashboard UI.

---

## Session Cleanup Cascade

The existing `CC_SESSION_CLEANUP_DAYS` feature auto-deletes stopped sessions older than N days. When implementing new tables, the cleanup logic in `server.js` (search for `deleteStoppedSessionsOlderThan` or `sessionCleanupDays` — around line 979) must be extended to also delete related rows:

```js
// After deleting old sessions, cascade to all related tables.
// The existing cleanup only deletes from `sessions` — it does NOT cascade.
// These statements clean up orphaned rows in every table with a session_id reference:
db.prepare('DELETE FROM events WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
db.prepare('DELETE FROM heartbeats WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
db.prepare('DELETE FROM file_edits WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
db.prepare('DELETE FROM todos WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT session_id FROM sessions)').run();
// Note: events_fts is kept in sync automatically via the DELETE trigger on events (added in Phase 2).
// Codex watchers: call codexWatcher.stopWatching(session_id) for each deleted Codex session.
```

Without this, orphaned rows accumulate in `file_edits` and `todos` over time.

---

## Housekeeping Changes (apply during Phase 0)

### `.gitignore` additions

```
dist/
client/node_modules/
```

### `update.sh` changes

Two changes needed:

1. Change `--omit=dev` to a full install (Vite and TypeScript are devDependencies needed for `npm run build`):

```bash
# BEFORE (current): npm install --omit=dev --silent
# AFTER:
npm install --silent
```

2. After the `npm install` step, add the frontend build:

```bash
# Build React frontend
echo "Building frontend..."
cd "$INSTALL_DIR" && npm run build
```

**Why both changes:** `npm install --omit=dev` skips devDependencies (Vite, TypeScript, @vitejs/plugin-react), so `npm run build` would fail because `vite` isn't installed. The full `npm install` adds ~50MB of dev deps but is necessary for the build step.

This ensures that `update.sh` (which does git pull + npm install + restart) also rebuilds the frontend after an update. Without this, users would get stale frontend files after updating.

### `install.sh` changes (apply during cleanup, after `public/` is deleted)

Once the old `public/` directory is deleted, fresh installs need to build the React frontend. Same issue as update.sh — `install.sh` currently uses `npm install --omit=dev` which skips Vite/TypeScript. Update `install.sh`:

1. Change `npm install --omit=dev --silent` to `npm install --silent`
2. Add after the install step:
```bash
echo "Building frontend..."
npm run build
```

Without this, fresh `install.sh` runs would have no `dist/` and no `public/`, resulting in a blank page.

### CLAUDE.md update (after Phase 1 complete)

Update the project's CLAUDE.md to reflect the new architecture:
- File map: add `client/` directory and its structure
- Frontend architecture: replace vanilla JS section with React + TypeScript section
- Development workflow: `npm run dev` runs both servers, access via port 5173
- Build: `npm run build` produces `dist/`, `npm start` serves it
- Testing: note that frontend tests (if added) live in `client/`
- Adding a new feature: create component in `client/src/components/`, add route/API call, add types

---

## Implementation Order & Dependencies

```
Phase 0 (Vite + React Setup)
    │
    ▼
Phase 1.1 (Session Cards)  ──┐
Phase 1.2 (Transcript View) ──┼── parallel frontend components + backend endpoints
Phase 1.3 (File Changes)    ──┤
Phase 1.4 (Responsive)      ──┘
    │
    ▼   all Phase 1 integrates, old public/ can be deleted
    │
Phase 2.1 (Snapshots)       ──┐
Phase 2.2 (History/Search)   ──┤── backend tasks sequential (all modify db.js + server.js)
Phase 3.1 (Project Pulse)   ──┤   frontend tasks can overlap with next backend task
Phase 3.2 (TODO Tracker)    ──┘
    │
    ▼
Phase 4.1 (Multi-Model)
    │
    ▼
Cleanup: remove public/, update README, update CLAUDE.md
```

## Subagent Task Breakdown

Below is the concrete list of subagent tasks per phase. The coordinator should spin out these tasks to subagents (via agent teams or individual agents). Each task is self-contained — a subagent can complete it with just the task description and the files it's told to read.

### Phase 0 tasks

**IMPORTANT: Task 0.4 must run FIRST** — it adds React, Vite, and TypeScript to `package.json` and runs `npm install`. Without these packages, Tasks 0.1-0.3 cannot build or type-check.

**Task 0.4 — Dependencies + server changes** (subagent, RUN FIRST)
- Modify: `package.json` (add deps, scripts), `server.js` (static serving from dist/, SPA fallback), `.gitignore` (add dist/), `update.sh` (add npm run build)
- Read first: `server.js` (find the `fastifyStatic` registration — there is NO existing `setNotFoundHandler`, you will ADD one for SPA fallback), `package.json` (current deps/scripts), `.gitignore`, `update.sh`
- After modifying package.json: run `npm install` to make React/Vite/TypeScript available
- Verify: `npm install` succeeds, `npm test` passes (all 84+ existing tests)
- Note: `server.js` uses ES modules (import/export). It already defines `__dirname` near the top of the file (`const __dirname = dirname(fileURLToPath(import.meta.url))`). Use the existing variable — do NOT redefine it. Read the existing code first.
- **IMPORTANT:** When updating the `start` and `dev` scripts, keep the `--env-file-if-exists=.env` flag. This loads the `.env` file with user configuration (CC_PORT, DEEPSEEK_API_KEY, VAPID keys, etc.). Dropping it breaks the server configuration.

**Task 0.1 — Vite + React scaffold** (subagent, after 0.4)
- Create: `client/vite.config.ts`, `client/tsconfig.json`, `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/styles/index.css`
- Copy PWA assets: `public/sw.js` → `client/public/sw.js`, `public/manifest.json` → `client/public/manifest.json`, `public/icons/icon.svg` → `client/public/icons/icon.svg` (these are required for push notifications to work)
- Read first: this plan's Phase 0 section for exact file contents
- Verify: `npx vite build --config client/vite.config.ts` succeeds, files appear in `dist/` including `sw.js` and `manifest.json`

**Task 0.2 — TypeScript foundations** (subagent, after 0.1)
- Create: `client/src/types.ts`, `client/src/api.ts`, `client/src/utils.ts`
- Read first: this plan's types, api, and utils sections; also read `public/app.js` for the utility functions to port
- Verify: `npx tsc --noEmit --project client/tsconfig.json` passes

**Task 0.3 — React hooks** (subagent, after 0.2)
- Create: `client/src/hooks/useWebSocket.ts`, `client/src/hooks/useSessions.ts`, `client/src/hooks/useApi.ts`, `client/src/hooks/useTranscript.ts`
- Read first: this plan's hook sections; read `public/app.js` lines 60-173 for current WS logic to understand message types
- Verify: TypeScript compiles

**After all Phase 0 tasks:** Coordinator runs `npm run dev`, opens `localhost:5173`, verifies React app loads and connects to WebSocket. Commits.

### Phase 1 tasks

**Task 1.1 — Transcript backend** (subagent)
- Modify: `transcript.js` (add `readTranscriptStructured`), `server.js` (add GET `/api/sessions/:id/transcript`, add WS transcript streaming with `fs.watch`)
- Read first: `transcript.js` (existing functions), `server.js` lines 280+ (existing route patterns), this plan's 1.2 backend section
- Verify: `npm test` passes. Manual test: `curl http://localhost:7700/api/sessions/<id>/transcript` returns entries.
- Also add tests to `test/api.test.js` for the new endpoint.

**Task 1.2 — File tracking backend** (subagent)
- Modify: `db.js` (file_edits table + statements), `server.js` (heartbeat handler for file_path, GET `/api/sessions/:id/files`, conflict detection), `hooks/cc-heartbeat.sh` (extract file_path)
- Read first: `db.js` (schema patterns), `server.js` hooks handler, `hooks/cc-heartbeat.sh`, this plan's 1.3 backend section
- Verify: `npm test` passes. Add tests for file_edits insertion and retrieval.

**Task 1.3 — Core React components** (subagent, LARGE — may split further)
- Create: `Layout.tsx`, `Header.tsx`, `SessionList.tsx`, `ProjectGroup.tsx`, `SessionCard.tsx`, `EventLog.tsx`, `Toast.tsx`, `ErrorBoundary.tsx`
- Read first: `public/app.js` (entire file — understand every feature to port), `client/src/types.ts`, `client/src/hooks/`, this plan's 1.1 section
- Verify: `npm run build` succeeds. Open `localhost:5173` — sessions appear as cards, grouped by project, with status/preview/summary.

**Task 1.4 — Session detail + transcript view** (subagent)
- Create: `SessionDetail.tsx`, `TranscriptView.tsx`, `InputBar.tsx`, `TerminalView.tsx`
- Read first: `client/src/hooks/useTranscript.ts`, `client/src/types.ts`, this plan's 1.2 frontend section, `public/app.js` terminal-related code
- Verify: Click a session card → detail panel opens. Transcript entries render. Input bar sends text. Terminal tab works with xterm.js.

**Task 1.5 — Modals** (subagent)
- Create: `modals/NewSessionModal.tsx`, `modals/EditSessionModal.tsx`, `modals/LinkTmuxModal.tsx`
- Read first: `public/app.js` modal-related code (search for "modal"), `client/src/api.ts`, this plan's 1.1 modals section
- Verify: All three modals open, submit, and close correctly. Session launch works.

**Task 1.6 — Responsive CSS + mobile** (subagent)
- Modify: `client/src/styles/index.css` and component CSS files
- Read first: `public/style.css` (current theme), this plan's 1.4 section and CSS approach section
- Verify: Resize browser to mobile width — layout adapts. Session detail is full-screen overlay. Touch targets are 44px+.

**After Phase 1:** Coordinator verifies everything works end-to-end. Runs `npm test`. Opens on desktop AND mobile. All features from the old frontend work in the new one. Then (and only then) considers deleting `public/`.

### Phases 2-3 tasks

Each feature is one backend task + one frontend task:

**Task 2.1a — Snapshots backend** → create `snapshots.js`, DB migration, API endpoints, tests
**Task 2.1b — Snapshots frontend** → create `SnapshotDiffModal.tsx`, add revert button to SessionCard

**Task 2.2a — History backend** → FTS5 migration + backfill, search endpoint, tests
**Task 2.2b — History frontend** → create `HistoryView.tsx`

**Task 3.1a — Pulse backend** → create `pulse.js`, DB migration, API endpoints, session launch integration, tests
**Task 3.1b — Pulse frontend** → create `PulsePanel.tsx`, add pulse toggle to SessionCard

**Task 3.2a — TODOs backend** → DB migration, CRUD endpoints, launch endpoint, session lifecycle integration, tests
**Task 3.2b — TODOs frontend** → create `TodoSection.tsx`, `TodoItem.tsx`

### Phase 4 tasks

**Task 4.1 — Hook scripts** → create `gc-report.sh`, `gc-heartbeat.sh`, `cx-report.sh`
**Task 4.2 — Multi-model backend** → DB migration, shouldAutoApprove mapping, codex-watcher.js, pty-manager changes, install.sh updates
**Task 4.3 — Multi-model frontend** → CLI selector in NewSessionModal, CLI badges on SessionCard

### Parallel vs sequential

- **Phase 0:** Sequential. Run in this order: **0.4 first** (deps + server) → 0.1 (scaffold) → 0.2 (types) → 0.3 (hooks). Task 0.4 must run first because it adds React/Vite/TypeScript to package.json and installs them.
- **Phase 1:** Tasks 1.1 and 1.2 must be **sequential** (both modify `server.js` and `test/api.test.js`). Run 1.1 first, then 1.2. However, task 1.3 (frontend) can run in parallel with the 1.1→1.2 sequence since it touches different files. Tasks 1.4 and 1.5 depend on 1.3. Task 1.6 depends on all others.
- **Phases 2-3:** Backend tasks (2.1a, 2.2a, 3.1a, 3.2a) must be **sequential** — they all modify `db.js` and `server.js`. Run in this order: 2.1a → 2.2a → 3.1a → 3.2a. However, each frontend task can start as soon as its backend counterpart finishes (e.g., start 2.1b as soon as 2.1a is done, even while 2.2a is running — they touch different files).
- **Phase 4:** Tasks 4.1, 4.2, 4.3 can run in parallel.

### If a subagent gets stuck

If a subagent reports an error or can't complete its task:
1. Read its output to understand what went wrong.
2. If it's a simple fix (missing import, typo): fix it yourself or send a follow-up message to the agent.
3. If it's a design issue (the plan's approach doesn't work): think about why, adjust the plan, and re-delegate.
4. If it's an environment issue (npm install fails, dependency conflict): troubleshoot in your own context, then re-delegate.
5. Never let a stuck subagent block the entire plan — work on independent tasks while troubleshooting.

### Context management

- Your context window is finite. After each phase, your earlier messages will compact.
- To preserve continuity: after each phase, write a brief status note to yourself (e.g., in a comment at the top of feature_additions.md or as a git commit message) summarizing what's done and what's next.
- If you lose context of what's been implemented, `git log --oneline` shows the commit history, and reading the files shows what exists.
- Don't re-read this entire plan after every compaction. Read only the section for the current phase.

---

## Future Features (DO NOT IMPLEMENT — reference only)

These are ideas for after the current plan is complete. Listed here so they don't get lost. **Ignore these during Phases 0-4.**

- **Voice mode**: Browser-based push-to-talk via Web Audio API + MediaStream. Could also auto-toggle Claude Code's built-in voice mode (space bar) by sending keydown/keyup to tmux via the terminal WebSocket, with voice activity detection to auto-release on silence.
- **Drag-and-drop file/image upload from remote device**: Drop files in the browser (phone/tablet), upload to Fastify server, place in session's CWD or a staging area. Standard HTML5 Drag and Drop + `<input type="file">`.
- **File/image download from local PC to remote device**: Serve files from the project directory via Fastify. Could add a file browser panel or "share file" button on session cards.
- **Layout variants**: The current desktop layout (card grid left, detail panel right) should be preserved as the default. If alternative layouts are explored later, keep the original as a selectable option so it's easy to revert.
