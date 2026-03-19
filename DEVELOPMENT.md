# Development Notes

Ongoing todos, decisions, and ideas for the control center.
Keep this file updated as the project evolves.

---

## Current Status (2026-03-18)

The core product is complete and in daily use. The server runs manually in a tmux pane
(`npm start` from `/home/zapperz/Charan/control-center`). All 84 tests pass.

### What's working

- Session cards with real-time status (active / idle / waiting / stopped)
- Color-coded border glow by status (green / gray / red pulsing)
- Summary bar: `N active · M waiting · P idle`
- One-click Grant button for permission approval
- Auto-approve for safe read-only tools + configurable Bash patterns
- Transcript preview (last 2 lines of Claude's last message) on each card
- Session age + tool count on each card
- Better tool detail line: `Edit: server.js`, `Bash: npm test`
- Browser terminal (xterm.js) with input bar + mobile quick-action buttons
- Tap-to-type on Android via mobile input bar
- Clickable event log rows → opens that session's terminal
- Project grouping of active sessions; collapsible stopped sessions section
- New Session modal with project presets (data/projects.json)
- Edit session (label + project reassignment)
- Kill button (with special warning for control-center directory sessions)
- Telegram push notifications via OpenClaw (30s inactivity gate)
- AI summary per card via DeepSeek (disabled by default; toggle CC_AI_SUMMARY=true)
- 6am daily git push to GitHub for all 3 repos (systemd timer)
- Remote access via Tailscale (phone + laptop)

---

## Todos

### High priority

- [x] **Systemd auto-start** — `~/.config/systemd/user/control-center.service` created and enabled.
  Server starts automatically on WSL boot and restarts on crash. No manual `npm start` needed.

- [x] **Windows auto-start** — `wsl-services.vbs` placed in Windows Startup folder fires WSL + all
  user services (control-center + openclaw) silently at login. Windows auto-login configured via
  `netplwiz` so the full chain runs on power-cycle with no manual intervention.

- [ ] **Session cleanup** — stopped sessions accumulate in the DB indefinitely.
  Options: auto-delete after N days, or a manual "Clear all stopped" button in the UI.
  The stopped sessions section is already collapsed, so it's not urgent.

- [ ] **Auth** — the HTTP API is completely open. Fine for Tailscale-only access, but worth
  adding a simple shared secret header check (`X-CC-Token`) before exposing more broadly.

### Medium priority

- [ ] **Enable AI summaries** — currently disabled (`CC_AI_SUMMARY=false`). When ready to
  try it, set `CC_AI_SUMMARY=true` in `.env` and restart. DeepSeek cost estimate: ~$3-5/month
  with normal usage (3 active sessions, page open a few hours/day). The infrastructure is
  fully built — just flip the flag.

- [ ] **Activity log: show auto-approved events** — currently auto-approved permissions are
  silently swallowed. Could add a dimmed row in the activity log showing "Auto-approved: Read"
  for visibility without being noisy.

- [ ] **Search / filter sessions** — filter cards by project, status, or keyword. Useful when
  running many sessions at once.

- [ ] **Session notes** — a free-text notes field per session (stored in DB, editable via the
  Edit modal). Useful for remembering what a long-running session was tasked with.

### Lower priority / ideas

- [ ] **ResizeObserver on terminal container** — the current double-rAF fit approach covers 99%
  of cases. A `ResizeObserver` would be the belt-and-suspenders fix for slow machines.

- [ ] **Tailscale MagicDNS hostname** — hardcode the stable hostname once confirmed so phone
  access doesn't require remembering the IP.

- [ ] **Two-way Telegram interaction** — the OpenClaw agent can already call the API via Telegram.
  A more structured "command bot" flow could make remote control smoother.

- [ ] **Transcript panel inline** — expandable inline view of last N messages on the card
  (beyond the current 2-line preview). The /api/sessions/:id/preview endpoint is ready; just
  need to extend it to return more lines and add a toggle on the card.

- [ ] **Per-project color coding** — assign a color to each project so it's visually distinct
  in the grid at a glance.

---

## Architecture Decisions

**Why SQLite and not something else?**
Single-user, single-machine tool. SQLite is zero-ops, fast enough, and `better-sqlite3`
gives synchronous access which simplifies the Fastify route handlers considerably.

**Why vanilla JS for the frontend?**
No build step = no toolchain to maintain. The dashboard is simple enough that a framework
would add more complexity than it removes. The full app.js is one file, easy to read and edit.

**Why node-pty + tmux instead of direct PTY?**
Users may have sessions already running in tmux before the dashboard starts. tmux also
provides persistence — if the dashboard restarts, the sessions keep running and can be
re-attached. node-pty bridges an existing tmux pane rather than creating a new PTY.

**Why auto-approve sends "1\n" instead of "\n"?**
Claude Code permission prompts show numbered options. "1" explicitly selects "Yes, do it".
Just "\n" (empty Enter) might not always accept the default depending on Claude Code version.

**Why is the transcript tail-read 32KB?**
Large conversations can produce multi-MB transcripts. Reading the last 32KB captures the
most recent ~20 turns which is enough for preview and AI summary without loading the full file.
The notifier.js still uses readFileSync for the full file — this is a known inconsistency
(noted in CLAUDE.md Known Limitations).

**Why is the 120s idle threshold in the client, not the server?**
The status field in the DB is a coarse state machine (active / waiting_permission / stopped).
The "idle" distinction is a UI concern — a session is active but quiet. Computing it client-side
lets the cards update their visual state every 15s without any server polling or DB writes.

---

## Project Context

The control center is one of three repos in active use:

| Repo | Path | Purpose |
|------|------|---------|
| control-center | `/home/zapperz/Charan/control-center` | This dashboard |
| deep-discovery | `/home/zapperz/Charan/deep-discovery` | Main research project |
| stim_expt_analysis | `/home/zapperz/lab3/scripts/stim_expt_analysis` | Photostimulation analysis pipeline |

All three are pushed to GitHub daily at 6am by a systemd timer (`morning-git-push.service`).
The push script is at `/home/zapperz/bin/cc-morning-push.sh`.

**OpenClaw** (`~/.openclaw/`) is a self-hosted AI gateway (always-running systemd service)
that connects to Telegram and can call the control center API on behalf of the user.
It uses DeepSeek (`deepseek-chat`) as its LLM.

**Claude Code hooks** are configured globally in `~/.claude/settings.json` and deployed
to `~/.claude/hooks/`. Any Claude Code session anywhere on the machine reports to this dashboard.
