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
      const parsed = [];
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try { parsed.push(JSON.parse(line)); } catch { /* malformed line */ }
      }
      // For Codex transcripts, synthesize Claude-like turn objects from structured entries
      if (isCodexFormat(parsed)) {
        for (const obj of parsed) {
          if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
            turns.push({ type: 'user', message: { content: obj.payload.message }, timestamp: obj.timestamp });
          } else if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'assistant') {
            const text = (obj.payload.content || [])
              .filter(c => c.type === 'output_text' || c.type === 'text')
              .map(c => c.text || '').join('');
            if (text) {
              turns.push({ type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: obj.timestamp });
            }
          }
        }
      } else {
        for (const obj of parsed) {
          if (obj.type === 'user' || obj.type === 'assistant') turns.push(obj);
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* file may not exist yet */ }
  return turns;
}

/**
 * Summarize tool input for display — returns a short human-readable string.
 * Works for both Claude and Codex tool names.
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
      // Codex tool names
      case 'exec_command':
        return (obj.cmd || '').slice(0, 80);
      case 'apply_patch':
        return input ? String(input).slice(0, 80) : '';
      case 'read_file':
        return obj.file_path || obj.path || '';
      default:
        return JSON.stringify(obj).slice(0, 80);
    }
  } catch {
    return String(input).slice(0, 80);
  }
}

/**
 * Detect system-injected content masquerading as user messages.
 * Returns a system entry object if matched, or null for real user input.
 */
function classifySystemInjection(text, timestamp) {
  const trimmed = text.trim();

  // Task/subagent notifications: <task-notification>...<summary>X</summary>...<result>Y</result>...</task-notification>
  if (trimmed.startsWith('<task-notification>')) {
    const summaryMatch = trimmed.match(/<summary>([\s\S]*?)<\/summary>/);
    const resultMatch = trimmed.match(/<result>([\s\S]*?)<\/result>/);
    const statusMatch = trimmed.match(/<status>([\s\S]*?)<\/status>/);
    return {
      type: 'system',
      subtype: 'task_notification',
      content: summaryMatch ? summaryMatch[1].trim() : 'Task completed',
      detail: resultMatch ? resultMatch[1].trim() : '',
      status: statusMatch ? statusMatch[1].trim() : '',
      timestamp,
    };
  }

  // Compact continuation: "This session is being continued from a previous conversation..."
  if (trimmed.startsWith('This session is being continued from a previous conversation')) {
    // Extract the summary portion after "Summary:"
    const summaryIdx = trimmed.indexOf('Summary:');
    const detail = summaryIdx !== -1 ? trimmed.slice(summaryIdx + 'Summary:'.length).trim() : '';
    return {
      type: 'system',
      subtype: 'compact',
      content: 'Context compacted',
      detail,
      timestamp,
    };
  }

  // Local command infrastructure — not useful to display
  if (trimmed.startsWith('<local-command-caveat>') ||
      trimmed.startsWith('<command-name>') ||
      trimmed.startsWith('<local-command-stdout>')) {
    return { type: 'system', subtype: 'local_command', content: '', timestamp };
  }

  // Project context pulse injection
  if (trimmed.startsWith('[Project context')) {
    return { type: 'system', subtype: 'local_command', content: '', timestamp };
  }

  return null;
}

/**
 * Detect whether a set of parsed JSONL objects are in Codex format.
 * Codex entries use { type: 'event_msg' | 'response_item' | 'session_meta' | 'turn_context' }.
 */
export function isCodexFormat(parsedLines) {
  for (const obj of parsedLines) {
    if (obj.type === 'event_msg' || obj.type === 'response_item' || obj.type === 'session_meta' || obj.type === 'turn_context') {
      return true;
    }
    // Claude format uses top-level type: 'user' | 'assistant' | 'tool_result'
    if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_result') {
      return false;
    }
  }
  return false;
}

/**
 * Parse Codex JSONL objects into the same TranscriptEntry format used by the frontend.
 * Codex format: event_msg (user_message, agent_message, task_started, task_complete, token_count),
 *               response_item (message, function_call, function_call_output, custom_tool_call,
 *                              custom_tool_call_output, reasoning)
 */
export function parseCodexEntries(parsedLines) {
  const entries = [];
  for (const obj of parsedLines) {
    const timestamp = obj.timestamp || undefined;
    const payload = obj.payload;
    if (!payload) continue;

    if (obj.type === 'event_msg') {
      if (payload.type === 'user_message' && payload.message) {
        entries.push({ type: 'user', content: payload.message, timestamp });
      }
      // agent_message is a duplicate of response_item message — skip to avoid doubling
    } else if (obj.type === 'response_item') {
      const subtype = payload.type;

      if (subtype === 'message' && payload.role === 'assistant') {
        const content = payload.content;
        if (Array.isArray(content)) {
          const text = content
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text || '')
            .join('');
          if (text) {
            entries.push({ type: 'assistant', content: text, timestamp });
          }
        }
      } else if (subtype === 'message' && payload.role === 'user') {
        // User context messages (input_text blocks) — usually the initial prompt
        const content = payload.content;
        if (Array.isArray(content)) {
          const text = content
            .filter(c => c.type === 'input_text' || c.type === 'text')
            .map(c => c.text || '')
            .join('\n');
          if (text) {
            entries.push({ type: 'user', content: text, timestamp });
          }
        }
      } else if (subtype === 'reasoning') {
        // Codex reasoning (summary is visible, content may be encrypted)
        const summaryParts = payload.summary;
        if (Array.isArray(summaryParts)) {
          const text = summaryParts.map(s => s.text || '').join('');
          if (text) {
            entries.push({ type: 'thinking', content: text, timestamp });
          }
        }
      } else if (subtype === 'function_call') {
        const toolName = payload.name || '';
        let argsObj = {};
        try { argsObj = JSON.parse(payload.arguments || '{}'); } catch { /* ignore */ }
        const summary = summarizeToolInput(toolName, argsObj);
        entries.push({
          type: 'tool_use',
          content: summary,
          tool_name: toolName,
          tool_input_summary: summary,
          tool_input_full: JSON.stringify(argsObj, null, 2),
          timestamp,
        });
      } else if (subtype === 'function_call_output') {
        const output = payload.output || '';
        entries.push({
          type: 'tool_result',
          content: output.slice(0, 500),
          is_error: false,
          timestamp,
        });
      } else if (subtype === 'custom_tool_call') {
        const toolName = payload.name || '';
        const input = payload.input || '';
        const summary = toolName === 'apply_patch'
          ? (input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/)?.[1] || input.slice(0, 80))
          : String(input).slice(0, 80);
        entries.push({
          type: 'tool_use',
          content: summary,
          tool_name: toolName,
          tool_input_summary: summary,
          tool_input_full: input,
          timestamp,
        });
      } else if (subtype === 'custom_tool_call_output') {
        let output = payload.output || '';
        if (typeof output === 'object') {
          output = output.output || JSON.stringify(output);
        }
        entries.push({
          type: 'tool_result',
          content: String(output).slice(0, 500),
          is_error: false,
          timestamp,
        });
      }
    }
  }
  return entries;
}

/**
 * Read the tail of a JSONL transcript file and return a structured array of entries.
 * Auto-detects Claude vs Codex transcript format.
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

      // Parse all lines first, then detect format
      const parsedLines = [];
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try { parsedLines.push(JSON.parse(line)); } catch { continue; }
      }

      // Codex uses a different transcript format — dispatch to its parser
      if (isCodexFormat(parsedLines)) {
        return parseCodexEntries(parsedLines);
      }

      for (const obj of parsedLines) {
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
            if (userText) {
              const systemEntry = classifySystemInjection(userText, timestamp);
              if (systemEntry) entries.push(systemEntry);
              else entries.push({ type: 'user', content: userText, timestamp });
            }
          } else if (typeof content === 'string') {
            if (content) {
              const systemEntry = classifySystemInjection(content, timestamp);
              if (systemEntry) entries.push(systemEntry);
              else entries.push({ type: 'user', content, timestamp });
            }
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
          // Message queued while Claude was busy — treat as user input (unless system-injected)
          const systemEntry = classifySystemInjection(obj.content, timestamp);
          if (systemEntry) entries.push(systemEntry);
          else entries.push({ type: 'user', content: obj.content, timestamp });
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
 * Check whether the model's last turn is complete by scanning the tail of the JSONL.
 * Returns true when the most recent stop_reason:'end_turn' comes AFTER the most recent
 * user/tool_result input — meaning Claude has finished responding.
 * Reads only the last `maxBytes` (default 16KB) so it's lightweight regardless of file size.
 */
export function isLastTurnComplete(filePath, maxBytes = 262144) {
  if (!filePath || !existsSync(filePath)) return true;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return true;
      const readSize = Math.min(maxBytes, size);
      const buf = Buffer.allocUnsafe(readSize);
      readSync(fd, buf, 0, readSize, size - readSize);
      const lines = buf.toString('utf8').split('\n');
      const startIdx = size > maxBytes ? 1 : 0;

      const parsed = [];
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try { parsed.push({ idx: i, obj: JSON.parse(line) }); } catch { continue; }
      }

      // Codex format: task_complete means the turn is done, user_message means new input
      if (parsed.length > 0 && isCodexFormat(parsed.map(p => p.obj))) {
        let lastDone = -1;
        let lastInput = -1;
        for (const { idx, obj } of parsed) {
          if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') lastDone = idx;
          else if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') lastInput = idx;
        }
        if (lastInput === -1) return true;
        if (lastDone === -1) return false;
        return lastDone > lastInput;
      }

      // Claude format: scan for stop_reason and input positions
      let lastDone = -1;
      let lastInput = -1;
      for (const { idx, obj } of parsed) {
        if (obj.type === 'assistant') {
          const sr = obj.message?.stop_reason;
          if (sr && sr !== 'tool_use') lastDone = idx;
        } else if (obj.type === 'user') {
          const content = obj.message?.content;
          if (typeof content === 'string') {
            // Skip system-injected entries (local commands, context tags, etc.)
            if (!classifySystemInjection(content, null)) lastInput = idx;
          } else if (Array.isArray(content)) {
            if (content.some(b => b.type === 'tool_result')) lastInput = idx;
            else if (content.some(b => b.type === 'text')) {
              // Skip if ALL text blocks are system injections
              const texts = content.filter(b => b.type === 'text');
              const allSystem = texts.length > 0 && texts.every(b => classifySystemInjection(b.text || '', null));
              if (!allSystem) lastInput = idx;
            }
          }
        } else if (obj.type === 'tool_result') {
          lastInput = idx;
        }
        // queue-operation intentionally NOT counted as input
      }

      if (lastInput === -1) return true;
      if (lastDone === -1) return false;
      return lastDone > lastInput;
    } finally {
      closeSync(fd);
    }
  } catch { return true; }
}

/**
 * Read the latest context usage from a JSONL transcript file.
 * Supports both Claude (message.usage on assistant entries) and
 * Codex (event_msg with payload.type === 'token_count').
 *
 * Returns { used, output, contextWindow } or null if unavailable.
 *   used = total input tokens (context fill)
 *   output = output tokens for the latest turn
 *   contextWindow = max context size (from model or Codex metadata)
 */
export function readContextUsage(filePath, model) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return null;
      const readSize = Math.min(32768, size);
      const buf = Buffer.allocUnsafe(readSize);
      readSync(fd, buf, 0, readSize, size - readSize);
      const lines = buf.toString('utf8').split('\n');
      const startIdx = size > readSize ? 1 : 0;

      let result = null;

      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        // Claude: assistant entries with message.usage
        if (obj.type === 'assistant' && obj.message?.usage) {
          const u = obj.message.usage;
          const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          result = {
            used,
            output: u.output_tokens || 0,
            contextWindow: getContextWindow(model),
          };
        }

        // Codex: token_count events with model_context_window
        // Use last_token_usage (current turn) not total_token_usage (cumulative across all turns)
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
          const info = obj.payload.info;
          if (info) {
            const tu = info.last_token_usage || info.total_token_usage || {};
            result = {
              used: tu.input_tokens || 0,
              output: tu.output_tokens || 0,
              contextWindow: info.model_context_window || null,
            };
          }
        }
      }

      return result;
    } finally {
      closeSync(fd);
    }
  } catch { return null; }
}

/**
 * Extract context usage from pre-parsed JSONL lines.
 * Used by the WS watcher to avoid re-reading the file.
 */
export function extractContextUsage(parsedLines, model) {
  let result = null;
  for (const obj of parsedLines) {
    if (obj.type === 'assistant' && obj.message?.usage) {
      const u = obj.message.usage;
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      result = { used, output: u.output_tokens || 0, contextWindow: getContextWindow(model) };
    }
    if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
      const info = obj.payload.info;
      if (info) {
        const tu = info.last_token_usage || info.total_token_usage || {};
        result = { used: tu.input_tokens || 0, output: tu.output_tokens || 0, contextWindow: info.model_context_window || null };
      }
    }
  }
  return result;
}

/** Map model string to context window size in tokens. */
function getContextWindow(model) {
  if (!model) return null;
  if (model.includes('[1m]')) return 1_000_000;
  if (model.startsWith('claude-')) return 200_000;
  return null; // Codex provides its own via token_count events
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
