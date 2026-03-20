#!/usr/bin/env bash
# Claude Code hook — lightweight heartbeat on PostToolUse.
set -euo pipefail

[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0

INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: "Heartbeat",
  session_id: .session_id,
  tool_name: (.tool_name // null),
  timestamp: (now | todate)
}' 2>/dev/null) || { echo "cc-heartbeat: jq parse failed" >&2; exit 0; }

curl -sS --max-time 2 \
  -X POST http://127.0.0.1:7700/api/hooks \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
