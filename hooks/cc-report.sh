#!/usr/bin/env bash
# Claude Code hook — reports lifecycle events to the control center.
# Used for: SessionStart, Stop, PermissionRequest, Notification
set -euo pipefail

# Skip reporting for headless/batch runs that shouldn't appear in the dashboard
[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0

# Server URL — override with CC_SERVER_URL if using a non-default port
CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"

INPUT=$(cat)

# If running inside tmux, capture the session name for unambiguous linking
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
  transcript_path: .transcript_path,
  tool_name: (.tool_name // null),
  tool_input: (.tool_input // null),
  permission_suggestions: (.permission_suggestions // null),
  source: (.source // null),
  model: (.model // null),
  stop_hook_active: (.stop_hook_active // false),
  timestamp: (now | todate),
  tmux_session: (if $tmux_session != "" then $tmux_session else null end)
}' 2>/dev/null) || { echo "cc-report: jq parse failed" >&2; exit 0; }

curl -sS --max-time 5 \
  -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
