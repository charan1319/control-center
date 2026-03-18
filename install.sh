#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DIR="$HOME/.claude/hooks"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "╔══════════════════════════════════════════════╗"
echo "║  Control Center — Lab PC Setup               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ──────────────────────────────────────────────
# 1. Check prerequisites
# ──────────────────────────────────────────────

echo "▸ Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install Node.js 22+ and try again."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  ✗ Node.js $NODE_MAJOR found, but 22+ is required."
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

if ! command -v tmux &>/dev/null; then
  echo "  ✗ tmux not found. Install tmux and try again."
  exit 1
fi
echo "  ✓ tmux $(tmux -V)"

if ! command -v jq &>/dev/null; then
  echo "  ✗ jq not found. Install jq (needed by hook scripts)."
  exit 1
fi
echo "  ✓ jq $(jq --version)"

if ! command -v curl &>/dev/null; then
  echo "  ✗ curl not found. Install curl (needed by hook scripts)."
  exit 1
fi
echo "  ✓ curl"

# Check for C/C++ build tools (needed by node-pty and better-sqlite3)
if ! command -v make &>/dev/null || ! (command -v gcc &>/dev/null || command -v cc &>/dev/null); then
  echo "  ⚠ Build tools (make, gcc) not found. native modules may fail to compile."
  echo "    On Ubuntu/Debian: sudo apt install -y build-essential python3"
  echo "    On macOS: xcode-select --install"
  echo ""
  read -p "  Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
else
  echo "  ✓ Build tools (make, cc)"
fi

echo ""

# ──────────────────────────────────────────────
# 2. Install npm dependencies (native compilation happens here)
# ──────────────────────────────────────────────

echo "▸ Installing npm dependencies (this compiles native modules)..."
cd "$SCRIPT_DIR"
npm install
echo "  ✓ Dependencies installed"
echo ""

# ──────────────────────────────────────────────
# 3. Copy hook scripts
# ──────────────────────────────────────────────

echo "▸ Installing hook scripts to $HOOK_DIR..."
mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/hooks/cc-report.sh" "$HOOK_DIR/"
cp "$SCRIPT_DIR/hooks/cc-heartbeat.sh" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/cc-report.sh" "$HOOK_DIR/cc-heartbeat.sh"
echo "  ✓ cc-report.sh"
echo "  ✓ cc-heartbeat.sh"
echo ""

# ──────────────────────────────────────────────
# 4. Merge hook configuration into Claude Code settings
#    IDEMPOTENT: strips existing control-center hooks before adding.
# ──────────────────────────────────────────────

echo "▸ Configuring Claude Code hooks..."

# Generate the hooks JSON with absolute paths
HOOKS_JSON=$(cat <<ENDJSON
{
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "PermissionRequest": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "Notification": [
    { "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-report.sh" }] }
  ],
  "PostToolUse": [
    {
      "matcher": "Bash|Write|Edit|MultiEdit",
      "hooks": [{ "type": "command", "command": "$HOOK_DIR/cc-heartbeat.sh", "timeout": 5 }]
    }
  ]
}
ENDJSON
)

# Create settings.json if it doesn't exist
mkdir -p "$HOME/.claude"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# FIXED: Idempotent merge — first remove any existing hooks whose command
# contains cc-report.sh or cc-heartbeat.sh, then append the new ones.
MERGED=$(jq --arg hookdir "$HOOK_DIR" --argjson newhooks "$HOOKS_JSON" '
  # Strip existing control-center hooks from each event array
  .hooks = (
    ((.hooks // {}) | to_entries | map(
      .value = ([.value[] | select(
        (.hooks // []) | all(.command | test("cc-report\\.sh|cc-heartbeat\\.sh") | not)
      )] )
    ) | from_entries) as $cleaned |
    # Now append the new hooks
    $newhooks | to_entries | reduce .[] as $entry (
      $cleaned;
      .[$entry.key] = ((.[$entry.key] // []) + $entry.value)
    )
  )
' "$SETTINGS_FILE")

echo "$MERGED" > "$SETTINGS_FILE"
echo "  ✓ Hooks merged into $SETTINGS_FILE (idempotent — safe to re-run)"
echo ""

# ──────────────────────────────────────────────
# 5. Create .env if it doesn't exist
# ──────────────────────────────────────────────

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "▸ Created .env from .env.example"
  echo "  Edit .env to set OPENCLAW_TOKEN if you want push notifications."
  echo ""
fi

# ──────────────────────────────────────────────
# 6. Optional: systemd user service (Linux only)
# ──────────────────────────────────────────────

if [[ "$(uname)" == "Linux" ]] && command -v systemctl &>/dev/null; then
  echo "▸ Setting up systemd user service..."
  read -p "  Install as a systemd user service (auto-start on login)? [y/N] " -n 1 -r
  echo

  if [[ $REPLY =~ ^[Yy]$ ]]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/control-center.service" << EOF
[Unit]
Description=Claude Code Control Center
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
EnvironmentFile=$SCRIPT_DIR/.env
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable control-center
    systemctl --user start control-center
    echo "  ✓ Service installed, enabled, and started"
    echo "  Commands: systemctl --user {start|stop|restart|status} control-center"
  else
    echo "  Skipped. Run manually with: npm start"
  fi
elif [[ "$(uname)" == "Darwin" ]]; then
  echo "▸ macOS detected. To auto-start, create a launchd plist or run manually:"
  echo "  cd $SCRIPT_DIR && npm start"
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✓ Setup complete!                           ║"
echo "║                                              ║"
echo "║  Start:  cd $SCRIPT_DIR && npm start"
echo "║  Open:   http://localhost:7700               ║"
echo "╚══════════════════════════════════════════════╝"
