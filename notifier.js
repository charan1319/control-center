import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import config from './config.js';

/**
 * Read the last assistant text block from a Claude Code transcript (JSONL).
 * Returns the trimmed text, or null if not found / unreadable.
 */
function getLastAssistantText(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j];
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            return block.text.trim();
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* transcript not readable */ }
  return null;
}

/**
 * Send a notification via OpenClaw's built-in Telegram channel.
 * Uses `openclaw message send` CLI — the canonical way to push proactive
 * messages through OpenClaw to a paired Telegram account.
 * Only fires for Stop and PermissionRequest events.
 * Fails silently if OPENCLAW_BIN or TELEGRAM_CHAT_ID are not configured.
 */
export async function send(payload) {
  if (!config.openclawBin || !config.telegramChatId) return;

  const { event, session_id, tool_name, cwd } = payload;

  let message;
  if (event === 'PermissionRequest') {
    const cmd = payload.tool_input?.command
      ? `: ${String(payload.tool_input.command).slice(0, 80)}`
      : '';
    message = `⏳ Session ${session_id.slice(0, 8)} needs permission for ${tool_name || 'unknown tool'}${cmd}`;
  } else if (event === 'Stop') {
    const dir = cwd ? ` in ${cwd}` : '';
    const lastText = getLastAssistantText(payload.transcript_path);
    const excerpt = lastText
      ? `\n💬 ${lastText.slice(0, 300)}${lastText.length > 300 ? '…' : ''}`
      : '';
    message = `✅ Session ${session_id.slice(0, 8)} finished${dir}${excerpt}`;
  } else {
    return;
  }

  try {
    execFileSync(config.openclawBin, [
      'message', 'send',
      '--channel', 'telegram',
      '--target', config.telegramChatId,
      '--message', `[Control Center] ${message}`,
    ], {
      env: { ...process.env },
      timeout: 15_000,
      stdio: 'ignore',
    });
  } catch (err) {
    console.error(`[notifier] OpenClaw notification failed: ${err.message}`);
  }
}
