import config from './config.js';

/**
 * Send a notification via OpenClaw's /v1/responses endpoint.
 * Only fires for Stop and PermissionRequest events.
 * Fails silently if OpenClaw is not configured or unreachable.
 */
export async function send(payload) {
  if (!config.openclawToken) return;

  const { event, session_id, tool_name, cwd } = payload;

  let message;
  if (event === 'PermissionRequest') {
    const cmd = payload.tool_input?.command
      ? `: \`${String(payload.tool_input.command).slice(0, 80)}\``
      : '';
    message = `⏳ Claude Code session \`${session_id.slice(0, 8)}\` needs permission for ${tool_name || 'unknown tool'}${cmd}`;
  } else if (event === 'Stop') {
    const dir = cwd ? ` in ${cwd}` : '';
    message = `✅ Claude Code session \`${session_id.slice(0, 8)}\` finished${dir}`;
  } else {
    return;
  }

  try {
    const response = await fetch(config.openclawUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openclawToken}`,
        'x-openclaw-agent-id': config.openclawAgent,
      },
      body: JSON.stringify({
        model: 'openclaw',
        input: `[Control Center] ${message}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`OpenClaw notification failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`OpenClaw notification error: ${err.message}`);
  }
}
