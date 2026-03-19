# Setup Guide

Complete instructions for getting the control center running from scratch on a new machine
or after a fresh clone.

---

## Prerequisites

```bash
# Node.js 22+ via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22 && nvm use 22

# System dependencies (Ubuntu/Debian/WSL)
sudo apt install -y tmux jq curl build-essential python3

# Verify
node --version   # v22.x.x
tmux -V          # tmux 3.x
```

---

## 1. Clone and install

```bash
git clone https://github.com/charan1319/control-center.git ~/Charan/control-center
cd ~/Charan/control-center
npm install          # compiles node-pty native module — needs build-essential
npm test             # all 84 tests should pass
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
CC_PORT=7700
CC_HOST=0.0.0.0
CC_DB_PATH=./data/control-center.sqlite

# Push notifications (optional — leave empty to disable)
OPENCLAW_BIN=/home/zapperz/.nvm/versions/node/v22.22.1/bin/openclaw
TELEGRAM_CHAT_ID=8778592568

# AI summaries (optional — set CC_AI_SUMMARY=true to enable)
DEEPSEEK_API_KEY=sk-...
CC_AI_SUMMARY=false

# Auto-approve permissions (comma-separated tool names)
CC_AUTO_APPROVE_TOOLS=Read,Glob,Grep,WebFetch,WebSearch,LS
```

---

## 3. Create project presets

`data/projects.json` is gitignored (machine-local). Create it:

```bash
mkdir -p data
cat > data/projects.json << 'EOF'
[
  { "name": "Deep Discovery",  "cwd": "/home/zapperz/Charan/deep-discovery" },
  { "name": "Stim Analysis",   "cwd": "/home/zapperz/lab3/scripts/stim_expt_analysis" },
  { "name": "Control Center",  "cwd": "/home/zapperz/Charan/control-center" }
]
EOF
```

---

## 4. Install Claude Code hooks

The hook scripts need to be deployed to `~/.claude/hooks/` and registered in `~/.claude/settings.json`.
The install script handles this:

```bash
./install.sh
```

Or manually:
```bash
mkdir -p ~/.claude/hooks
cp hooks/cc-report.sh ~/.claude/hooks/cc-report.sh
cp hooks/cc-heartbeat.sh ~/.claude/hooks/cc-heartbeat.sh
chmod +x ~/.claude/hooks/cc-report.sh ~/.claude/hooks/cc-heartbeat.sh
```

Then add to `~/.claude/settings.json` under `"hooks"`:
```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-report.sh" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-report.sh" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-report.sh" }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-report.sh" }] }],
    "PostToolUse":       [{ "matcher": "Bash|Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-heartbeat.sh" }] }]
  }
}
```

---

## 5. Start the server

```bash
# Start in a dedicated tmux pane so it persists
tmux new-session -d -s cc-server -c ~/Charan/control-center 'npm start; exec bash'

# Verify it's running
curl -s http://localhost:7700/api/sessions | head -c 100
```

Open `http://localhost:7700` in a browser.

---

## 6. Verify end-to-end

1. Open the dashboard — connection dot should be green
2. Open a new terminal and run `claude` in any project directory
3. The session should appear as a card within a few seconds
4. Open the terminal panel — it should connect to the tmux pane
5. Run a tool — the heartbeat should update the card status

---

## 7. Remote access via Tailscale

```bash
# Install Tailscale (if not already)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Get your Tailscale IP
tailscale ip -4
```

Then access `http://<tailscale-ip>:7700` from any device on your Tailscale network.
On phone: install the Tailscale app (iOS/Android), sign in with the same account.

---

## 8. Auto-start on login (systemd)

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/control-center.service << EOF
[Unit]
Description=Control Center Dashboard
After=network.target

[Service]
WorkingDirectory=/home/zapperz/Charan/control-center
ExecStart=/home/zapperz/.nvm/versions/node/v22.22.1/bin/node --env-file=.env server.js
Restart=on-failure
RestartSec=5
Environment=PATH=/home/zapperz/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now control-center.service
systemctl --user status control-center.service
```

## 9. Prevent Windows from sleeping

Run this once from WSL to disable system sleep and hibernate on both AC and battery:

```bash
powershell.exe -Command "
  powercfg /change standby-timeout-ac 0
  powercfg /change standby-timeout-dc 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /change hibernate-timeout-dc 0
"
```

This persists across reboots (Windows power plan setting).
To re-enable sleep later: replace `0` with a timeout in minutes (e.g. `30`).

---

## 9. Daily GitHub backup (systemd timer)

A systemd timer pushes all three repos to GitHub at 6am daily:

```bash
# Timer files are at:
~/.config/systemd/user/morning-git-push.service
~/.config/systemd/user/morning-git-push.timer

# Push script:
~/bin/cc-morning-push.sh

# Check status:
systemctl --user status morning-git-push.timer
systemctl --user list-timers
```

---

## Troubleshooting

**Sessions not appearing in dashboard**
- Check hooks are installed: `ls ~/.claude/hooks/`
- Check hook is registered: `cat ~/.claude/settings.json | grep cc-report`
- Test the hook manually: `echo '{"hook_event_name":"SessionStart","session_id":"test-123","cwd":"/tmp"}' | ~/.claude/hooks/cc-report.sh`
- Check server is running: `curl http://localhost:7700/api/sessions`

**Terminal won't connect**
- Session needs a tmux target linked — click "Link tmux" on the card
- Check tmux session exists: `tmux ls`
- Auto-linking fires on SessionStart; start a fresh `claude` session to trigger it

**node-pty compile error**
- Ensure build tools are installed: `sudo apt install -y build-essential python3`
- Try: `npm rebuild node-pty`

**Port already in use**
- Check what's on 7700: `ss -tlnp | grep 7700`
- Change port in `.env`: `CC_PORT=7800`
