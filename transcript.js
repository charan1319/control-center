import { openSync, closeSync, readSync, fstatSync, existsSync } from 'node:fs';

/**
 * Read the last `maxBytes` of a JSONL transcript and return parsed user/assistant turns.
 * Reads from the end of the file — avoids loading large transcripts into memory.
 */
export function readTranscriptTail(filePath, maxBytes = 32768) {
  const turns = [];
  try {
    const fd = openSync(filePath, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return turns;
      const readSize = Math.min(maxBytes, size);
      const buf = Buffer.allocUnsafe(readSize);
      readSync(fd, buf, 0, readSize, size - readSize);
      const lines = buf.toString('utf8').split('\n');
      const startIdx = size > maxBytes ? 1 : 0; // skip potentially incomplete first line
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' || obj.type === 'assistant') turns.push(obj);
        } catch { /* malformed line */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* file may not exist yet */ }
  return turns;
}

/**
 * Summarize tool input for display — returns a short human-readable string.
 */
function summarizeToolInput(toolName, input) {
  if (!input) return '';
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    switch (toolName) {
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        return obj.file_path || obj.path || '';
      case 'Bash':
        return (obj.command || '').slice(0, 80);
      case 'Read':
        return obj.file_path || obj.path || '';
      case 'Glob':
        return obj.pattern || '';
      case 'Grep':
        return [obj.pattern, obj.path].filter(Boolean).join(' ');
      case 'WebFetch':
        return obj.url || '';
      default:
        return JSON.stringify(obj).slice(0, 80);
    }
  } catch {
    return String(input).slice(0, 80);
  }
}

/**
 * Read the tail of a JSONL transcript file and return a structured array of entries.
 *
 * Each entry has: { type, content, tool_name?, tool_input_summary?, tool_input_full?, tool_result?, is_error?, timestamp? }
 *
 * Types: 'user', 'assistant', 'thinking', 'tool_use', 'tool_result'
 */
export function readTranscriptStructured(filePath, maxBytes = 65536) {
  const entries = [];
  if (!filePath || !existsSync(filePath)) return entries;

  try {
    const fd = openSync(filePath, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return entries;
      const readSize = Math.min(maxBytes, size);
      const buf = Buffer.allocUnsafe(readSize);
      readSync(fd, buf, 0, readSize, size - readSize);
      const lines = buf.toString('utf8').split('\n');
      const startIdx = size > maxBytes ? 1 : 0; // skip potentially incomplete first line

      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        const timestamp = obj.timestamp || undefined;

        if (obj.type === 'user') {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            // Extract tool_result blocks (new format: tool_result inside user messages)
            const textParts = [];
            for (const block of content) {
              if (block.type === 'tool_result') {
                const rawContent = block.content;
                let text = '';
                if (typeof rawContent === 'string') {
                  text = rawContent;
                } else if (Array.isArray(rawContent)) {
                  text = rawContent.map(x => x.text || '').join(' ');
                }
                entries.push({
                  type: 'tool_result',
                  content: text.slice(0, 500),
                  is_error: block.is_error || false,
                  timestamp,
                });
              } else if (block.type === 'text') {
                textParts.push(block.text || '');
              }
            }
            const userText = textParts.join('\n');
            if (userText) entries.push({ type: 'user', content: userText, timestamp });
          } else if (typeof content === 'string') {
            if (content) entries.push({ type: 'user', content, timestamp });
          }

        } else if (obj.type === 'assistant') {
          const content = obj.message?.content;
          if (!Array.isArray(content)) continue;
          const stopReason = obj.message?.stop_reason || undefined;
          for (const block of content) {
            if (block.type === 'thinking') {
              entries.push({ type: 'thinking', content: block.thinking || '', timestamp, stop_reason: stopReason });
            } else if (block.type === 'text') {
              entries.push({ type: 'assistant', content: block.text || '', timestamp, stop_reason: stopReason });
            } else if (block.type === 'tool_use') {
              entries.push({
                type: 'tool_use',
                content: summarizeToolInput(block.name, block.input),
                tool_name: block.name || '',
                tool_input_summary: summarizeToolInput(block.name, block.input),
                tool_input_full: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2),
                timestamp,
                stop_reason: stopReason,
              });
            }
          }

        } else if (obj.type === 'tool_result') {
          // Legacy format: top-level tool_result entries
          const rawContent = obj.content;
          let text = '';
          if (typeof rawContent === 'string') {
            text = rawContent;
          } else if (Array.isArray(rawContent)) {
            text = rawContent.map(x => x.text || '').join(' ');
          }
          entries.push({
            type: 'tool_result',
            content: text.slice(0, 500),
            is_error: obj.is_error || false,
            timestamp,
          });

        } else if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && obj.content) {
          // Message queued while Claude was busy — treat as user input
          entries.push({ type: 'user', content: obj.content, timestamp });
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* file read error */ }
  return entries;
}

/**
 * Return the byte size of a transcript file, or 0 if it doesn't exist.
 */
export function getTranscriptSize(filePath) {
  if (!filePath || !existsSync(filePath)) return 0;
  try {
    const fd = openSync(filePath, 'r');
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch { return 0; }
}

/**
 * Return the last assistant text block from a transcript, or null.
 */
export function getLastAssistantText(filePath, maxBytes = 16384) {
  if (!filePath) return null;
  const turns = readTranscriptTail(filePath, maxBytes);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].type !== 'assistant') continue;
    const content = turns[i].message?.content;
    if (!Array.isArray(content)) continue;
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock?.text?.trim()) return textBlock.text.trim();
  }
  return null;
}
