import { watch, statSync, openSync, readSync, closeSync } from 'node:fs';

const activeWatchers = new Map();

export function startWatching(sessionId, transcriptPath, onHeartbeat) {
  if (!transcriptPath || activeWatchers.has(sessionId)) return;
  let lastSize = 0;
  try { lastSize = statSync(transcriptPath).size; } catch { return; }

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
