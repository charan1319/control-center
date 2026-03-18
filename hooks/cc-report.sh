#!/usr/bin/env bash
# Claude Code hook — reports lifecycle events to the control center.
# Used for: SessionStart, Stop, PermissionRequest, Notification
set -euo pipefail

INPUT=$(cat)

PAYLOAD=$(echo "$INPUT" | jq -c '{
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
  timestamp: (now | todate)
}' 2>/dev/null) || { echo "cc-report: jq parse failed" >&2; exit 0; }

curl -sS --max-time 5 \
  -X POST http://127.0.0.1:7700/api/hooks \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
