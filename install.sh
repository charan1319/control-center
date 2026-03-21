#!/usr/bin/env bash
# Control Center — one-command installer
# Supports: Linux (native), WSL2, macOS
set -euo pipefail

REPO_URL="https://github.com/charan1319/control-center.git"
DEFAULT_INSTALL_DIR="$HOME/control-center"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}-->${RESET} $*"; }
success() { echo -e "${GREEN}[ok]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
die()     { echo -e "${RED}[x]${RESET} $*" >&2; exit 1; }

# Prompt user for yes/no, default to $2 (y or n)
confirm() {
  local prompt="$1" default="${2:-y}"
  local yn
  if [[ "$default" == "y" ]]; then
    read -rp "  $prompt [Y/n]: " yn
    yn="${yn:-y}"
  else
    read -rp "  $prompt [y/N]: " yn
    yn="${yn:-n}"
  fi
  [[ "$yn" =~ ^[Yy] ]]
}

echo ""
echo -e "  ${BOLD}Control Center${RESET} -- Installer"
echo "  ────────────────────────────"
echo ""

# ── Detect OS ────────────────────────────────────
IS_MAC=false
IS_LINUX=false
PKG_MANAGER=""

if [[ "$(uname)" == "Darwin" ]]; then
  IS_MAC=true
  if command -v brew &>/dev/null; then
    PKG_MANAGER="brew"
  fi
elif [[ "$(uname)" == "Linux" ]]; then
  IS_LINUX=true
  if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
  elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
  elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
  fi
fi

# ── Helper: install a package ────────────────────
install_pkg() {
  local pkg="$1"
  case "$PKG_MANAGER" in
    apt)    sudo apt-get install -y "$pkg" ;;
    dnf)    sudo dnf install -y "$pkg" ;;
    pacman) sudo pacman -S --noconfirm "$pkg" ;;
    brew)   brew install "$pkg" ;;
    *)      return 1 ;;
  esac
}

# ── Check prerequisites ───────────────────────────
info "Checking prerequisites..."
MISSING_PKGS=()

# Check and offer to install: git, curl, jq, tmux
for tool in git curl jq tmux; do
  if ! command -v "$tool" &>/dev/null; then
    MISSING_PKGS+=("$tool")
  fi
done

# On Linux, check for build tools needed by node-pty
if [[ "$IS_LINUX" == "true" ]]; then
  if ! dpkg -s build-essential &>/dev/null 2>&1 && ! command -v gcc &>/dev/null; then
    MISSING_PKGS+=("build-essential")
  fi
  if ! command -v python3 &>/dev/null; then
    MISSING_PKGS+=("python3")
  fi
fi

# On macOS, check for Xcode CLI tools (needed for node-pty compilation)
if [[ "$IS_MAC" == "true" ]]; then
  if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools not found (required for native module compilation)."
    info "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    echo "  After the Xcode tools install dialog completes, re-run this installer."
    exit 1
  fi
fi

# Offer to install missing packages
if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  if [[ -n "$PKG_MANAGER" ]]; then
    warn "Missing packages: ${MISSING_PKGS[*]}"
    if confirm "Install them now via $PKG_MANAGER?"; then
      for pkg in "${MISSING_PKGS[@]}"; do
        info "Installing $pkg..."
        install_pkg "$pkg" || die "Failed to install $pkg"
        success "Installed $pkg"
      done
    else
      # Check if any are hard requirements
      for pkg in "${MISSING_PKGS[@]}"; do
        if [[ "$pkg" == "tmux" ]]; then
          warn "tmux not installed -- terminal view will be disabled."
        elif [[ "$pkg" == "build-essential" ]]; then
          warn "build-essential not installed -- node-pty may fail to compile."
        else
          die "$pkg is required. Install it manually and re-run the installer."
        fi
      done
    fi
  else
    # No known package manager
    for pkg in "${MISSING_PKGS[@]}"; do
      if [[ "$pkg" == "tmux" ]]; then
        warn "tmux not found -- terminal view will be disabled."
      else
        die "$pkg not found. Please install it manually."
      fi
    done
  fi
fi

# Node.js check — offer to install via nvm if missing
if ! command -v node &>/dev/null; then
  echo ""
  warn "Node.js not found."
  if confirm "Install Node.js 22 via nvm (recommended)?"; then
    info "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh 2>/dev/null | bash > /dev/null 2>&1
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    info "Installing Node.js 22..."
    nvm install 22 > /dev/null 2>&1
    nvm use 22 > /dev/null 2>&1
    if command -v node &>/dev/null; then
      success "Node.js $(node --version) installed via nvm"
    else
      die "nvm installed but Node.js not found. Open a new terminal and re-run the installer."
    fi
  else
    die "Node.js 20+ is required. Install manually:
    nvm:   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
           nvm install 22 && nvm use 22
    Site:  https://nodejs.org"
  fi
fi
NODE_MAJ=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [[ "$NODE_MAJ" -lt 20 ]]; then
  die "Node.js 20+ required (found v$(node --version)). Upgrade via nvm: nvm install 22"
fi

success "Prerequisites OK (Node $(node --version))"

# Claude Code check — warn if not installed (not fatal, they may install it later)
if ! command -v claude &>/dev/null; then
  echo ""
  warn "Claude Code CLI not found."
  echo "  Control Center monitors Claude Code sessions, so you'll need it installed."
  echo "  Install: npm install -g @anthropic-ai/claude-code"
  echo "  (You can continue the install and set up Claude Code later.)"
  echo ""
fi

# ── Install directory ─────────────────────────────
echo ""
read -rp "  Install directory [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing repo found -- pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only || warn "Pull failed -- continuing with existing code"
else
  info "Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── npm install ───────────────────────────────────
info "Installing Node.js dependencies..."
npm install --omit=dev --silent 2>&1 | tail -1 || die "npm install failed. Check build-essential/python3 are installed."
success "Dependencies installed"

# ── Create .env ───────────────────────────────────
if [[ -f "$INSTALL_DIR/.env" ]]; then
  success "Found existing .env -- keeping your configuration"
else
  echo ""
  info "Setting up environment configuration..."
  echo ""

  # Port
  read -rp "  Server port [7700]: " USER_PORT
  USER_PORT="${USER_PORT:-7700}"

  # DeepSeek
  echo ""
  echo "  AI summaries use DeepSeek to generate session status overviews."
  echo "  Get a key at: https://platform.deepseek.com"
  read -rp "  DeepSeek API key (leave blank to skip): " USER_DEEPSEEK_KEY

  # Build .env
  cat > "$INSTALL_DIR/.env" <<EOF
# Control Center configuration
CC_PORT=$USER_PORT
CC_HOST=0.0.0.0
CC_DB_PATH=./data/control-center.sqlite

# AI summaries (DeepSeek)
EOF

  if [[ -n "$USER_DEEPSEEK_KEY" ]]; then
    cat >> "$INSTALL_DIR/.env" <<EOF
DEEPSEEK_API_KEY=$USER_DEEPSEEK_KEY
CC_AI_SUMMARY=true
EOF
  else
    cat >> "$INSTALL_DIR/.env" <<EOF
# DEEPSEEK_API_KEY=sk-...
CC_AI_SUMMARY=false
EOF
  fi

  cat >> "$INSTALL_DIR/.env" <<EOF

# Session cleanup: auto-delete stopped sessions older than N days (0 = disabled)
CC_SESSION_CLEANUP_DAYS=7

# Auto-approve Claude Code tool permissions (comma-separated)
CC_AUTO_APPROVE_TOOLS=Read,Glob,Grep,WebFetch,WebSearch,LS

# Web push notifications (generate keys with: npx web-push generate-vapid-keys)
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
# VAPID_EMAIL=mailto:you@example.com
EOF

  echo ""
  success ".env created at $INSTALL_DIR/.env"
fi

# ── Project presets ──────────────────────────────
PROJECTS_FILE="$INSTALL_DIR/data/projects.json"
if [[ ! -f "$PROJECTS_FILE" ]]; then
  mkdir -p "$INSTALL_DIR/data"
  echo ""
  info "Project presets populate the 'New Session' dropdown in the dashboard."
  echo "  You can add projects now or edit data/projects.json later."
  echo ""

  PROJECTS="["
  PROJECT_COUNT=0
  while true; do
    read -rp "  Project name (or press Enter to finish): " PROJ_NAME
    [[ -z "$PROJ_NAME" ]] && break
    read -rp "  Working directory for '$PROJ_NAME': " PROJ_CWD
    [[ -z "$PROJ_CWD" ]] && continue
    PROJ_CWD="${PROJ_CWD/#\~/$HOME}"
    [[ $PROJECT_COUNT -gt 0 ]] && PROJECTS+=","
    PROJECTS+="
  { \"name\": \"$PROJ_NAME\", \"cwd\": \"$PROJ_CWD\" }"
    PROJECT_COUNT=$((PROJECT_COUNT + 1))
    success "Added: $PROJ_NAME → $PROJ_CWD"
  done
  PROJECTS+="
]"

  if [[ $PROJECT_COUNT -gt 0 ]]; then
    echo "$PROJECTS" > "$PROJECTS_FILE"
    success "$PROJECT_COUNT project preset(s) saved"
  else
    echo '[]' > "$PROJECTS_FILE"
    info "No presets added -- you can edit data/projects.json anytime"
  fi
fi

# Read the configured port from .env for later use
PORT=$(grep -E '^CC_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "7700")
PORT="${PORT:-7700}"

# ── Deploy hooks ──────────────────────────────────
HOOKS_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

info "Deploying hook scripts..."
mkdir -p "$HOOKS_DIR"
cp "$INSTALL_DIR/hooks/cc-report.sh"    "$HOOKS_DIR/cc-report.sh"
cp "$INSTALL_DIR/hooks/cc-heartbeat.sh" "$HOOKS_DIR/cc-heartbeat.sh"
chmod +x "$HOOKS_DIR/cc-report.sh" "$HOOKS_DIR/cc-heartbeat.sh"
success "Hook scripts deployed to $HOOKS_DIR"

# If using a non-default port, remind about CC_SERVER_URL
if [[ "$PORT" != "7700" ]]; then
  warn "Non-default port ($PORT) detected."
  echo "  Add this to your shell profile (~/.bashrc or ~/.zshrc):"
  echo "    export CC_SERVER_URL=http://127.0.0.1:$PORT"
  echo ""
fi

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
  SERVICE_FILE="$SERVICE_DIR/control-center.service"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Control Center -- Claude Code dashboard
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
    || warn "Could not start service -- you can start manually: cd $INSTALL_DIR && npm start"

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
    || warn "Could not load agent -- you can start manually: cd $INSTALL_DIR && npm start"

else
  warn "No systemd or launchd found. Start the server manually:"
  echo "  cd $INSTALL_DIR && npm start"
fi

# ── Post-install verification ─────────────────────
echo ""
info "Verifying installation..."

# Give the service a moment to start
sleep 2

HEALTH_OK=false
for i in 1 2 3; do
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/info" > /dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

if [[ "$HEALTH_OK" == "true" ]]; then
  success "Server is responding on port $PORT"
else
  warn "Server did not respond on port $PORT -- it may still be starting up."
  echo "  Check status:  systemctl --user status control-center.service"
  echo "  View logs:     journalctl --user -u control-center.service -f"
  echo "  Start manually: cd $INSTALL_DIR && npm start"
fi

# ── Usage stats ───────────────────────────────────
# Send install event for development diagnostics (disable with CC_TELEMETRY=false in .env)
if ! grep -qE '^CC_TELEMETRY=false' "$INSTALL_DIR/.env" 2>/dev/null; then
  node -e "
    const u = '$(git config user.name 2>/dev/null || echo "")';
    const h = require('os').hostname();
    const o = process.platform === 'win32' ? 'WSL' : require('os').type();
    const v = require('./package.json').version;
    fetch('https://script.google.com/macros/s/AKfycbxn6CpA0OA04C095757DIkFhT13z5E4B0Eddhf44SdcmHdTwDE9RYrENUgj5PpJtETc/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'install', git_user: u, hostname: h, os: o, version: v }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  " > /dev/null 2>&1 || true
fi

# ── Done ──────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo "  Dashboard  -->  http://localhost:$PORT"
echo "  Config     -->  $INSTALL_DIR/.env"
echo "  Hooks      -->  $HOOKS_DIR/"
echo ""
echo "  Next steps:"
echo "  1. Open http://localhost:$PORT in your browser"
echo "  2. Click '+ New Session' to launch a Claude Code session from the dashboard"
echo "     Or start one manually: tmux new-session -s my-project && claude"
echo ""
echo "  Phone access:"
echo "  3. Install Tailscale on this machine and your phone (https://tailscale.com/download)"
echo "  4. Open http://<tailscale-ip>:$PORT on your phone"
echo "  5. Tap 'Add to Home Screen' for an app-like experience"
echo ""
if ! grep -qE '^DEEPSEEK_API_KEY=' "$INSTALL_DIR/.env" 2>/dev/null; then
  echo "  Optional: Add DEEPSEEK_API_KEY to .env for AI session summaries"
fi
echo "  Full setup guide: $INSTALL_DIR/SETUP.md"
echo ""
