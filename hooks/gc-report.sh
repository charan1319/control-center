#!/usr/bin/env bash
# Gemini CLI hook — reports lifecycle events to the control center.
# Used for: SessionStart (event_name), SessionEnd, BeforeTool
set -euo pipefail

[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0

CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"

INPUT=$(cat)

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
  }') || { echo "gc-report: jq parse failed" >&2; exit 0; }

curl -sS --max-time 5 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
