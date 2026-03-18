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

  const body = JSON.stringify({
    model: 'openclaw',
    input: `[Control Center] ${message}`,
  });

  // Retry up to 3 times with exponential backoff for transient failures
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(config.openclawUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openclawToken}`,
          'x-openclaw-agent-id': config.openclawAgent,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return; // Success
      if (response.status >= 400 && response.status < 500) {
        // Client error — don't retry
        console.error(`OpenClaw notification failed: HTTP ${response.status}`);
        return;
      }
      // Server error — retry
      console.error(`OpenClaw notification failed: HTTP ${response.status} (attempt ${attempt + 1}/3)`);
    } catch (err) {
      console.error(`OpenClaw notification error (attempt ${attempt + 1}/3): ${err.message}`);
    }

    // Wait before retry (1s, 2s)
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
    }
  }
}
