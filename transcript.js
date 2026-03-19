import { openSync, closeSync, readSync, fstatSync } from 'node:fs';

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
