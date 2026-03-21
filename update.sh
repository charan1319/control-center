#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Pulling latest changes..."
git pull --ff-only || { echo "Cannot fast-forward — manual intervention needed"; exit 1; }

echo "Installing dependencies..."
npm install --omit=dev --silent

echo "Deploying hook scripts..."
HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR"
cp hooks/cc-report.sh "$HOOKS_DIR/cc-report.sh"
cp hooks/cc-heartbeat.sh "$HOOKS_DIR/cc-heartbeat.sh"
chmod +x "$HOOKS_DIR/cc-report.sh" "$HOOKS_DIR/cc-heartbeat.sh"

echo "Restarting server..."
# Try systemd first, then launchd, then just inform
if systemctl --user restart control-center.service 2>/dev/null; then
  echo "Server restarted via systemd"
elif launchctl kickstart -k gui/$(id -u)/com.control-center 2>/dev/null; then
  echo "Server restarted via launchd"
else
  echo "Could not auto-restart. Please restart the server manually."
fi

echo "Update complete!"
