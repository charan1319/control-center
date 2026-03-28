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
  SessionEnd)   CC_EVENT="SessionEnd" ;;
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

# Post to server with retry logic — PermissionRequest events are critical
RESPONSE=""
MAX_ATTEMPTS=3
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  RESPONSE=$(curl -sS --max-time 10 -X POST "$CC_SERVER/api/hooks" \
    -H "Content-Type: application/json" -d "$PAYLOAD" 2>/dev/null) && break
  if [ "$CC_EVENT" != "PermissionRequest" ] || [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    exit 0
  fi
  sleep 2
done

# For BeforeTool (mapped to PermissionRequest): communicate auto-approve decision
if [ "$CC_EVENT" = "PermissionRequest" ]; then
  AUTO=$(echo "$RESPONSE" | jq -r '.auto_approve' 2>/dev/null || true)
  if [ "$AUTO" = "true" ]; then
    echo '{"decision":"approve"}'
  fi
fi
