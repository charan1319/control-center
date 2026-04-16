# Control Center handoff for a fresh Codex session

Last updated: 2026-04-15 (America/New_York)

## Read this first

This repo was investigated after the Control Center server dropped overnight. The key conclusion is:

- the server did **not** look like it crashed because of a Control Center code bug
- the Linux guest went through a **clean poweroff / reboot** around **2026-04-15 01:29 EDT**
- Control Center then came back up on the next boot
- there is a **separate current Claude Code auth problem** in a live tmux session, but that does not appear to be the cause of the reboot

If you are a new Codex session, do **not** start by debugging Control Center application code as the primary cause of the overnight outage. Start from the reboot evidence below.

## What this repo is

`control-center` is a local dashboard for managing Claude Code sessions.

Core behavior:

- Fastify server with SQLite-backed session state
- WebSocket dashboard updates
- tmux + `node-pty` browser terminal integration
- Claude/Codex session registration and status tracking
- permission prompts, pulse entries, snapshots, summaries, and project grouping

Primary orientation files:

- `README.md`
- `server.js`
- `db.js`
- `pty-manager.js`
- `codex-watcher.js`

Current git state at investigation time:

- branch: `dev`
- commit: `3398b3e`
- worktree looked clean

## What happened this morning

### Strongest conclusion

The machine did **not** show signs of a Linux-side crash, OOM kill, panic, or abrupt service death. The journal showed a normal shutdown sequence:

- boot `-1` ended at **2026-04-15 01:29:17 EDT**
- boot `0` began at **2026-04-15 01:32:30 EDT**
- the prior boot logged:
  - `Received SIGTERM. Shutting down...`
  - many normal service stop lines
  - `Finished System Power Off.`
  - `Reached target System Power Off.`
  - `Shutting down.`

Best inference: the host or WSL instance was intentionally shut down or rebooted from outside the Linux guest. That is much more consistent with a Windows reboot / shutdown / WSL termination than with a Control Center app failure.

### Commands that produced the evidence

Use these exact commands if you need to re-check:

```bash
journalctl --list-boots
journalctl --since '2026-04-15 01:00:00' --until '2026-04-15 01:40:00' -b -1 -o short-iso
journalctl -b -1 -o short-iso | rg 'poweroff|reboot|shutdown|halt|systemctl|terminate|sigterm'
```

## Control Center state after reboot

The Control Center DB showed the service recovered after boot and retained recent session history. Relevant recent session rows:

- `b6062d7a-6254-4d7d-aae8-d01049505373` — active — `cwd=/mnt/c/Users/zapperz`
- `codex-1776118018449-wa7sf5` — `Codex Benchmarking` — project `Deep Discovery` — stopped
- `codex-1776222345735-wyjb6z` — `[NEW] Graph NN Analyses` — project `Stim Analysis` — stopped
- `11e28038-087e-4f6e-9d64-a707ee165cfb` — `Graph NN Analyses` — project `Stim Analysis` — stopped

Useful query:

```bash
sqlite3 data/control-center.sqlite \
  "select session_id,label,project,status,cwd,updated_at from sessions order by updated_at desc limit 20;"
```

## Important non-reboot issue currently visible

There was one live tmux session during investigation:

- tmux session: `cc-66320`
- pane scrollback showed repeated Claude Code auth failures:
  - `Please run /login`
  - `API Error: 401`
  - `Invalid authentication credentials`

This looked like a Claude Code login/session problem in `/mnt/c/Users/zapperz`, not a Control Center server crash.

Useful commands:

```bash
tmux ls
tmux list-windows -t cc-66320 -a -F '#{session_name}:#{window_index}:#{window_name}:#{window_active}'
tmux capture-pane -p -t cc-66320:0.0 -S -200
```

## Other historical instability that is real but probably not last night's cause

Earlier logs showed:

- a `systemd` restart loop on **2026-03-18**
- some `node --watch` restart churn on **2026-03-20**
- a later non-fatal snapshot capture issue (`spawnSync git ETIMEDOUT`)

These are worth knowing, but they do **not** match the clean reboot evidence from 2026-04-15 around 01:29-01:32 EDT.

## What a fresh Codex session should do next

1. Confirm the service is currently healthy.
2. Treat the overnight drop as a host/WSL reboot unless new contrary evidence appears.
3. If asked to investigate the live Claude problem, treat it as a separate auth issue and inspect the active tmux session plus Control Center hook handling around failed logins.
4. Do not spend time chasing an application crash in Control Center unless you first find evidence that contradicts the clean-poweroff journal trail.

## Suggested verification checklist

```bash
git status --short --branch
systemctl status control-center --no-pager
journalctl -u control-center --since '2026-04-15 01:20:00' --no-pager
curl -s http://127.0.0.1:7700/api/sessions
sqlite3 data/control-center.sqlite \
  "select session_id,label,project,status,cwd,updated_at from sessions order by updated_at desc limit 20;"
```

## Bottom line

If you only remember one thing, remember this:

- **The server drop aligns with a clean machine/guest reboot, not an in-app crash.**
- **The visible Claude 401 issue is real, but it appears to be a separate problem.**
