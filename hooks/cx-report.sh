#!/usr/bin/env bash
# Codex CLI hook — reports lifecycle events to the control center.
# Used for: SessionStart, Stop
set -euo pipefail

[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0

CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"

INPUT=$(cat)

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
case "$EVENT" in
  SessionStart|Stop) ;;
  *) exit 0 ;;
esac

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
    transcript_path: (.transcript_path // null),
    cli_type: "codex",
    timestamp: (now | todate),
    tmux_session: (if $tmux_session != "" then $tmux_session else null end)
  }') || { echo "cx-report: jq parse failed" >&2; exit 0; }

curl -sS --max-time 5 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
