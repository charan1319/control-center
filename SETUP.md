# Setup Guide

Complete instructions for getting Control Center running on a new machine.
Works on **Linux**, **macOS**, and **WSL2**.

---

## Quick Install (recommended)

The installer handles cloning, dependencies, hooks, and service setup:

```bash
curl -fsSL https://raw.githubusercontent.com/charan1319/control-center/main/install.sh | bash
```

Or if you already cloned the repo:

```bash
cd ~/control-center
./install.sh
```

The rest of this guide covers manual setup or explains what the installer does.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Claude Code | any | The CLI tool this dashboard monitors ([install](https://docs.anthropic.com/en/docs/claude-code/overview)) |
| Node.js | 20+ | Server runtime |
| tmux | any | Terminal multiplexer for session management |
| jq | any | JSON processing in hook scripts |
| curl | any | HTTP requests in hook scripts |
| build-essential / Xcode CLI | -- | Compiling the `node-pty` native module |
| python3 | any | Required by `node-gyp` for native module compilation |
| git | any | Cloning the repository |

### Linux / WSL2

```bash
# System packages
sudo apt install -y tmux jq curl build-essential python3

# Node.js via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22
```

### macOS

```bash
# Xcode Command Line Tools (required for native compilation)
xcode-select --install

# System packages via Homebrew
brew install tmux jq curl

# Node.js via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 22 && nvm use 22
```

### Verify

```bash
node --version   # v20.x.x or v22.x.x
tmux -V          # tmux 3.x
jq --version     # jq-1.x
```

---

## 1. Clone and Install

```bash
git clone https://github.com/charan1319/control-center.git ~/control-center
cd ~/control-center
npm install          # compiles node-pty — requires build-essential/Xcode CLI
npm test             # all tests should pass
```

---

## 2. Configure Environment (.env)

```bash
cp .env.example .env
```

Edit `.env` with your settings. The key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_PORT` | `7700` | Server port |
| `CC_HOST` | `0.0.0.0` | Bind address |
| `CC_DB_PATH` | `./data/control-center.sqlite` | SQLite database path |
| `DEEPSEEK_API_KEY` | _(empty)_ | DeepSeek API key for AI session summaries |
| `CC_AI_SUMMARY` | `true` | Set `false` to disable AI summaries |
| `CC_AUTO_APPROVE_TOOLS` | `Read,Glob,Grep,WebFetch,WebSearch,LS` | Tools auto-approved without prompting |
| `CC_SESSION_CLEANUP_DAYS` | `7` | Auto-delete stopped sessions after N days (0 = disabled) |

For web push notifications (requires HTTPS via Tailscale Serve):

```bash
# Generate VAPID keys once
npx web-push generate-vapid-keys
```

Then add to `.env`:
```env
VAPID_PUBLIC_KEY=<your public key>
VAPID_PRIVATE_KEY=<your private key>
VAPID_EMAIL=mailto:you@example.com
```

See `.env.example` for the full list of options with comments.

---

## 3. Project Presets (optional)

Create `data/projects.json` to populate the "New Session" dropdown with your project directories:

```bash
mkdir -p data
cat > data/projects.json << 'EOF'
[
  { "name": "My App",        "cwd": "/home/user/projects/my-app" },
  { "name": "Backend API",   "cwd": "/home/user/projects/backend" },
  { "name": "Control Center", "cwd": "/home/user/control-center" }
]
EOF
```

This file is gitignored (machine-local). Adjust paths to match your system.

---

## 4. Install Claude Code Hooks

Hook scripts report session events to the Control Center server.

**Automated (recommended):** The installer handles this. Run `./install.sh` if you haven't already.

**Manual:**

```bash
# Deploy hook scripts
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
    "PostToolUse":       [{ "matcher": "Bash|Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "~/.claude/hooks/cc-heartbeat.sh", "timeout": 5 }] }]
  }
}
```

**Non-default port:** If you changed `CC_PORT` in `.env`, add this to your shell profile (`~/.bashrc` or `~/.zshrc`) so hook scripts reach the server:

```bash
export CC_SERVER_URL=http://127.0.0.1:YOUR_PORT
```

---

## 5. Start the Server

### Manual start (in tmux)

```bash
cd ~/control-center
tmux new-session -d -s cc-server 'npm start; exec bash'
```

### Auto-start with systemd (Linux / WSL2)

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/control-center.service << EOF
[Unit]
Description=Control Center -- Claude Code dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME/control-center
ExecStart=$(command -v node) --env-file-if-exists=.env server.js
Restart=on-failure
RestartSec=5s
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now control-center.service
systemctl --user status control-center.service
```

### Auto-start with launchd (macOS)

The installer generates `~/Library/LaunchAgents/com.control-center.plist` automatically.
To manage it manually:

```bash
# Load (start)
launchctl load ~/Library/LaunchAgents/com.control-center.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.control-center.plist

# View logs
tail -f ~/.control-center.log
```

---

## 6. Verify End-to-End

```bash
# 1. Check the server is responding
curl -s http://localhost:7700/api/info

# 2. Open the dashboard in your browser
#    http://localhost:7700

# 3. Start a Claude Code session in any project directory
#    The session should appear on the dashboard within seconds

# 4. Click "Terminal" on a session card to connect to the tmux pane

# 5. Run a tool in Claude — the heartbeat should update the card status
```

---

## 7. Remote Access via Tailscale

Tailscale creates a private network so you can access the dashboard from any device.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Get your Tailscale IP
tailscale ip -4
```

Access from any device on your Tailscale network:
- Browser: `http://<tailscale-ip>:7700`
- Phone: Install the Tailscale app (iOS/Android), sign in with the same account

For HTTPS (required for web push notifications), use [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve):

```bash
tailscale serve --bg 7700
```

---

## 8. Phone App (PWA)

Control Center works as a Progressive Web App — you can install it on your phone's home screen for an app-like experience with no browser chrome.

**On your phone:**
1. Set up Tailscale (see above) so your phone can reach the server
2. Open `http://<tailscale-ip>:7700` in your phone's browser
3. **iOS Safari:** Tap the share button → "Add to Home Screen"
4. **Android Chrome:** Tap the three-dot menu → "Add to Home screen" (or "Install app")

The dashboard is optimized for mobile with touch-friendly buttons and an input bar for typing commands.

---

## 9. Push Notifications

Get notified on your phone when a session needs permission approval.

**Requirements:** HTTPS (needed for browser push) — use Tailscale Serve:
```bash
tailscale serve --bg 7700
```

**Setup:**
1. Generate VAPID keys:
   ```bash
   cd ~/control-center
   npx web-push generate-vapid-keys
   ```
2. Add the keys to `.env`:
   ```env
   VAPID_PUBLIC_KEY=<your public key>
   VAPID_PRIVATE_KEY=<your private key>
   VAPID_EMAIL=mailto:you@example.com
   ```
3. Restart the server: `systemctl --user restart control-center`
4. Open the dashboard via HTTPS (`https://<tailscale-hostname>`)
5. Click the bell icon in the header to enable notifications
6. Allow notifications when your browser prompts

You'll now get push notifications when any session needs permission approval.

---

## Troubleshooting

### Sessions not appearing on the dashboard

1. Check hooks are installed:
   ```bash
   ls ~/.claude/hooks/
   ```
2. Check hooks are registered:
   ```bash
   cat ~/.claude/settings.json | python3 -m json.tool | grep cc-report
   ```
3. Test a hook manually:
   ```bash
   echo '{"hook_event_name":"SessionStart","session_id":"test-123","cwd":"/tmp"}' | ~/.claude/hooks/cc-report.sh
   ```
4. Check the server is running:
   ```bash
   curl http://localhost:7700/api/sessions
   ```

### Terminal won't connect

- The session needs a tmux target linked. Click "Link tmux" on the session card.
- Check tmux sessions exist: `tmux ls`
- Auto-linking happens on SessionStart. Start a fresh `claude` session to trigger it.

### node-pty compilation error

- Linux: `sudo apt install -y build-essential python3`
- macOS: `xcode-select --install`
- Then: `npm rebuild node-pty`

### Port already in use

```bash
# Check what's using the port
ss -tlnp | grep 7700    # Linux
lsof -i :7700           # macOS

# Change port in .env
# CC_PORT=7800
# Don't forget to also set CC_SERVER_URL in your shell profile
```

### Service won't start (systemd)

```bash
# Check status and logs
systemctl --user status control-center.service
journalctl --user -u control-center.service -f

# Restart
systemctl --user restart control-center.service
```

### WSL-specific: systemd not available

If `systemctl` is not available in your WSL distribution, enable systemd:

```bash
# Add to /etc/wsl.conf
sudo tee -a /etc/wsl.conf << 'EOF'
[boot]
systemd=true
EOF
```

Then restart WSL from PowerShell: `wsl --shutdown` and reopen your terminal.
