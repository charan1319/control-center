#!/usr/bin/env bash
# Control Center — one-command installer
# Supports: Linux (native), WSL2, macOS
set -euo pipefail

REPO_URL="https://github.com/charan1319/control-center.git"
DEFAULT_INSTALL_DIR="$HOME/control-center"
PORT=7700

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()    { echo -e "${CYAN}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}!${RESET} $*"; }
die()     { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

echo ""
echo "  Control Center — Installer"
echo "  ──────────────────────────"
echo ""

# ── Detect OS ────────────────────────────────────
IS_MAC=false
if [[ "$(uname)" == "Darwin" ]]; then IS_MAC=true; fi

# ── Check prerequisites ───────────────────────────
info "Checking prerequisites..."

command -v git   &>/dev/null || die "git not found. Install git first."
command -v curl  &>/dev/null || die "curl not found."
command -v jq    &>/dev/null || die "jq not found. Install: sudo apt install jq  |  brew install jq"
command -v python3 &>/dev/null || die "python3 not found."

if ! command -v node &>/dev/null; then
  die "Node.js not found. Install Node.js 20+ from https://nodejs.org or via nvm."
fi
NODE_MAJ=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
[[ "$NODE_MAJ" -ge 20 ]] || die "Node.js 20+ required (found v$(node --version)). Upgrade via nvm."

if ! command -v tmux &>/dev/null; then
  warn "tmux not found — terminal view will be disabled. Install: sudo apt install tmux"
fi

success "Prerequisites OK (Node $(node --version))"

# ── Install directory ─────────────────────────────
echo ""
read -rp "  Install directory [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing repo found — pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── npm install ───────────────────────────────────
info "Installing Node.js dependencies..."
npm install --omit=dev --silent
success "Dependencies installed"

# ── Create .env ───────────────────────────────────
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  info "Creating .env..."
  cat > "$INSTALL_DIR/.env" <<EOF
# Control Center configuration — edit to enable optional features
CC_PORT=$PORT
CC_HOST=0.0.0.0

# AI session summaries via DeepSeek (get key at https://platform.deepseek.com)
# DEEPSEEK_API_KEY=sk-...

# Telegram notifications via OpenClaw (optional)
# OPENCLAW_BIN=/path/to/openclaw
# TELEGRAM_CHAT_ID=123456789

# Session cleanup: auto-delete stopped sessions older than N days (0 = disabled)
CC_SESSION_CLEANUP_DAYS=7

# Auto-approve Claude Code tool permissions (comma-separated)
CC_AUTO_APPROVE_TOOLS=Read,Glob,Grep,WebFetch,WebSearch,LS
EOF
  success ".env created — edit $INSTALL_DIR/.env to add API keys"
else
  info ".env already exists — skipping"
fi

# ── Deploy hooks ──────────────────────────────────
HOOKS_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

info "Deploying hook scripts..."
mkdir -p "$HOOKS_DIR"
cp "$INSTALL_DIR/hooks/cc-report.sh"    "$HOOKS_DIR/cc-report.sh"
cp "$INSTALL_DIR/hooks/cc-heartbeat.sh" "$HOOKS_DIR/cc-heartbeat.sh"
chmod +x "$HOOKS_DIR/cc-report.sh" "$HOOKS_DIR/cc-heartbeat.sh"
success "Hook scripts → $HOOKS_DIR"

# ── Register hooks in ~/.claude/settings.json ────
info "Registering hooks in $SETTINGS..."
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

python3 - "$HOOKS_DIR/cc-report.sh" "$HOOKS_DIR/cc-heartbeat.sh" "$SETTINGS" <<'PYEOF'
import json, sys
report, heartbeat, path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(path) as f:
    cfg = json.load(f)

new_hooks = {
    'SessionStart':      [{'hooks': [{'type':'command','command':report}]}],
    'Stop':              [{'hooks': [{'type':'command','command':report}]}],
    'PermissionRequest': [{'hooks': [{'type':'command','command':report}]}],
    'Notification':      [{'hooks': [{'type':'command','command':report}]}],
    'PostToolUse': [{'matcher':'Bash|Write|Edit|MultiEdit',
                     'hooks':[{'type':'command','command':heartbeat,'timeout':5}]}],
}

cfg.setdefault('hooks', {})
for event, handlers in new_hooks.items():
    if event not in cfg['hooks']:
        cfg['hooks'][event] = handlers
    else:
        existing = {h.get('command','') for g in cfg['hooks'][event] for h in g.get('hooks',[])}
        for g in handlers:
            for h in g.get('hooks', []):
                if h.get('command','') not in existing:
                    cfg['hooks'][event].append({'hooks': [h]})

with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
PYEOF
success "Hooks registered in $SETTINGS"

# ── System service ────────────────────────────────
NODE_BIN="$(command -v node)"

if [[ "$IS_MAC" == "false" ]] && command -v systemctl &>/dev/null; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_DIR/control-center.service" <<EOF
[Unit]
Description=Control Center — Claude Code dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env server.js
Restart=on-failure
RestartSec=5s
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now control-center.service 2>/dev/null \
    && success "Systemd service enabled and started" \
    || warn "Could not start service — run manually: cd $INSTALL_DIR && npm start"

elif [[ "$IS_MAC" == "true" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.control-center.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.control-center</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file-if-exists=.env</string>
    <string>$INSTALL_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.control-center.log</string>
  <key>StandardOutPath</key><string>$HOME/.control-center.log</string>
</dict></plist>
EOF
  launchctl load "$PLIST" 2>/dev/null \
    && success "launchd agent loaded" \
    || warn "Could not load agent — run manually: cd $INSTALL_DIR && npm start"
fi

# ── Done ──────────────────────────────────────────
echo ""
echo -e "  ${GREEN}Done!${RESET} Control Center is installed."
echo ""
echo "  Dashboard  →  http://localhost:$PORT"
echo "  Config     →  $INSTALL_DIR/.env"
echo ""
echo "  Next steps:"
echo "  1. Add DEEPSEEK_API_KEY to .env for AI session summaries"
echo "  2. Open a new Claude Code session — it will appear automatically"
echo ""
