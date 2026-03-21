#!/usr/bin/env bash
# Gemini CLI hook — lightweight heartbeat on tool use.
set -euo pipefail

[ "${CC_SKIP_REPORT:-0}" = "1" ] && exit 0

CC_SERVER="${CC_SERVER_URL:-http://127.0.0.1:7700}"

INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
  event: "Heartbeat",
  session_id: .session_id,
  tool_name: (.tool_name // null),
  file_path: (
    if (.tool_name == "edit_file" or .tool_name == "write_file") then
      (.tool_input.path // null)
    else null end
  ),
  cli_type: "gemini",
  timestamp: (now | todate)
}') || { echo "gc-heartbeat: jq parse failed" >&2; exit 0; }

curl -sS --max-time 2 -X POST "$CC_SERVER/api/hooks" \
  -H "Content-Type: application/json" -d "$PAYLOAD" > /dev/null 2>&1 || true
