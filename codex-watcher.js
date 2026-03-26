import { watch, statSync, openSync, readSync, closeSync } from 'node:fs';

const activeWatchers = new Map();

export function startWatching(sessionId, transcriptPath, onHeartbeat, onPermission) {
  if (!transcriptPath || activeWatchers.has(sessionId)) return;
  let lastSize = 0;
  try { lastSize = statSync(transcriptPath).size; } catch { return; }

  // Track call_ids of escalation requests so we can detect when they resolve
  const pendingEscalations = new Set();

  const checkNewContent = () => {
    try {
      const currentSize = statSync(transcriptPath).size;
      if (currentSize <= lastSize) return;
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      readSync(fd, buf, 0, buf.length, lastSize);
      closeSync(fd);
      lastSize = currentSize;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);

          // Codex format: response_item with function_call or custom_tool_call
          if (entry.type === 'response_item') {
            const payload = entry.payload;
            if (payload?.type === 'function_call') {
              let filePath = null;
              let args = {};
              try {
                args = JSON.parse(payload.arguments || '{}');
                filePath = args.file_path || args.path || null;
              } catch { /* ignore */ }

              // Detect escalation requests (permission prompts)
              if (args.sandbox_permissions === 'require_escalated' && onPermission) {
                pendingEscalations.add(payload.call_id || payload.name);
                onPermission({
                  waiting: true,
                  tool_name: payload.name,
                  tool_input: args.cmd || payload.arguments,
                });
              }

              onHeartbeat({ tool_name: payload.name, file_path: filePath });
            } else if (payload?.type === 'function_call_output') {
              // Escalation resolved — the user approved (or denied) in the TUI
              if (pendingEscalations.size > 0 && onPermission) {
                const callId = payload.call_id || '';
                if (pendingEscalations.has(callId) || pendingEscalations.size > 0) {
                  pendingEscalations.delete(callId);
                  if (pendingEscalations.size === 0) {
                    onPermission({ waiting: false });
                  }
                }
              }
            } else if (payload?.type === 'custom_tool_call') {
              let filePath = null;
              if (payload.name === 'apply_patch' && payload.input) {
                const match = payload.input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
                if (match) filePath = match[1];
              }
              onHeartbeat({ tool_name: payload.name, file_path: filePath });
            }
          }

          // Claude format: assistant message with tool_use blocks
          if (entry.type === 'assistant' && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use') {
                onHeartbeat({ tool_name: block.name, file_path: block.input?.file_path || null });
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file may not exist yet */ }
  };

  let watcher = null;
  try {
    watcher = watch(transcriptPath, { persistent: false }, checkNewContent);
  } catch { /* watch may fail on some filesystems */ }
  const interval = setInterval(checkNewContent, 3000);
  activeWatchers.set(sessionId, { watcher, interval, lastSize });
}

export function stopWatching(sessionId) {
  const entry = activeWatchers.get(sessionId);
  if (!entry) return;
  entry.watcher?.close();
  clearInterval(entry.interval);
  activeWatchers.delete(sessionId);
}
