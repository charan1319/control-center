import pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import config from './config.js';

// Map of tmux_target → { ptyProcess, clients: Set<WebSocket>, graceTimer, scrollback }
const activePTYs = new Map();

// Default timeout for all tmux execSync calls (10 seconds)
const TMUX_TIMEOUT_MS = 10_000;

/**
 * Validate and sanitize a tmux target name.
 * Rejects anything outside [a-zA-Z0-9_-] to prevent shell injection.
 */
function sanitizeTmuxTarget(target) {
  if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) {
    throw new Error(`Invalid tmux target name: "${target}"`);
  }
  return target;
}

/**
 * Check if a tmux session exists. Retries once on transient failure.
 */
function tmuxSessionExists(target) {
  sanitizeTmuxTarget(target);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execSync(`tmux has-session -t ${target} 2>/dev/null`, { timeout: TMUX_TIMEOUT_MS });
      return true;
    } catch {
      if (attempt === 0) continue; // retry once
      return false;
    }
  }
  return false;
}

/**
 * Attach a WebSocket client to a tmux session's PTY.
 * Creates the PTY bridge if it doesn't exist yet.
 * Multiple clients can attach to the same PTY simultaneously.
 * Returns the pty process, or null if the tmux session doesn't exist.
 */
export function attach(tmuxTarget, socket) {
  if (!tmuxSessionExists(tmuxTarget)) {
    return null;
  }

  let entry = activePTYs.get(tmuxTarget);

  if (!entry) {
    // Spawn a new PTY bridged to the tmux session.
    // Target is already validated by tmuxSessionExists → sanitizeTmuxTarget above.
    let ptyProcess;
    try {
      ptyProcess = pty.spawn('/bin/bash', [
        '-c', `exec tmux attach-session -t ${tmuxTarget}`
      ], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (err) {
      console.error(`[pty-manager] Failed to spawn PTY for ${tmuxTarget}: ${err.message}`);
      return null;
    }

    entry = {
      ptyProcess,
      clients: new Set(),
      graceTimer: null,
      scrollback: '',
    };

    // Pipe PTY output → all connected WebSocket clients + scrollback buffer
    ptyProcess.onData((data) => {
      entry.scrollback += data;
      if (entry.scrollback.length > config.scrollbackBufferSize) {
        entry.scrollback = entry.scrollback.slice(-config.scrollbackBufferSize);
      }
      const msg = JSON.stringify({ type: 'output', data });
      for (const client of entry.clients) {
        try {
          if (client.readyState === 1) client.send(msg);
        } catch { /* client gone */ }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      activePTYs.delete(tmuxTarget);
      const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
      for (const client of entry.clients) {
        try {
          client.send(exitMsg);
          client.close();
        } catch { /* ignore */ }
      }
    });

    activePTYs.set(tmuxTarget, entry);
  }

  // Clear grace timer if set (a new client connected before grace period expired)
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }

  entry.clients.add(socket);

  // Replay scrollback so the new client sees current terminal state
  if (entry.scrollback.length > 0) {
    try {
      socket.send(JSON.stringify({ type: 'output', data: entry.scrollback }));
    } catch { /* ignore */ }
  }

  return entry.ptyProcess;
}

/**
 * Detach a WebSocket client from a tmux session's PTY.
 * If no clients remain, starts a grace period before killing the PTY bridge.
 * (The tmux session itself always stays alive — we only kill the node-pty bridge.)
 */
export function detach(tmuxTarget, socket) {
  const entry = activePTYs.get(tmuxTarget);
  if (!entry) return;

  entry.clients.delete(socket);

  if (entry.clients.size === 0) {
    entry.graceTimer = setTimeout(() => {
      try { entry.ptyProcess.kill(); } catch { /* already dead */ }
      activePTYs.delete(tmuxTarget);
    }, config.ptyGracePeriodMs);
  }
}

/**
 * Resize a tmux session's PTY.
 */
export function resize(tmuxTarget, cols, rows) {
  const entry = activePTYs.get(tmuxTarget);
  if (entry) {
    entry.ptyProcess.resize(cols, rows);
  }
}

/**
 * List tmux sessions with their pane working directories.
 * Returns array of { name, cwd }.
 */
export function listTmuxSessions() {
  try {
    const output = execSync(
      `tmux list-sessions -F '#{session_name}|#{pane_current_path}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: TMUX_TIMEOUT_MS }
    );
    return output.trim().split('\n').filter(Boolean).map(line => {
      const idx = line.indexOf('|');
      if (idx === -1) return { name: line, cwd: '' };
      return { name: line.slice(0, idx), cwd: line.slice(idx + 1) };
    });
  } catch (err) {
    console.error(`[pty-manager] Failed to list tmux sessions: ${err.message}`);
    return [];
  }
}

/**
 * Create a new tmux session and start Claude Code in it.
 * Returns the tmux session name.
 *
 * NOTE: initialPrompt is best-effort — it fires after a 5s delay to give
 * the Claude Code TUI time to initialize. It may fail silently if the TUI
 * isn't ready. The session is still created and usable either way.
 */
export function createTmuxSession({ label, cwd, initialPrompt }) {
  const existing = listTmuxSessions().map(s => s.name);
  let n = 0;
  while (existing.includes(`${config.tmuxSessionPrefix}${n}`)) n++;
  const sessionName = `${config.tmuxSessionPrefix}${n}`;

  // Validate session name (should always pass since we generate it, but belt-and-suspenders)
  sanitizeTmuxTarget(sessionName);

  // Build tmux new-session command — execFileSync avoids shell entirely
  const args = ['new-session', '-d', '-s', sessionName];
  if (cwd) {
    args.push('-c', cwd);
  }
  execFileSync('tmux', args, { timeout: TMUX_TIMEOUT_MS });

  // Start Claude Code in the session
  execFileSync('tmux', ['send-keys', '-t', sessionName, 'claude', 'Enter'], { timeout: TMUX_TIMEOUT_MS });

  // If there's an initial prompt, wait for Claude Code TUI to initialize then send it.
  // Uses tmux send-keys -l (literal) to avoid shell metacharacter interpretation.
  if (initialPrompt) {
    setTimeout(() => {
      try {
        // Use execFileSync to bypass shell — avoids injection via $(), backticks, etc.
        // -l flag sends keys literally (no special tmux key interpretation)
        execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', initialPrompt], { timeout: TMUX_TIMEOUT_MS });
        execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { timeout: TMUX_TIMEOUT_MS });
      } catch (err) {
        console.error(`[pty-manager] Failed to send initial prompt to ${sessionName}: ${err.message}`);
      }
    }, 5000);
  }

  return sessionName;
}

/**
 * Kill all active PTY bridges. Called during graceful shutdown.
 * Does NOT kill the underlying tmux sessions — only the node-pty bridges.
 */
export function shutdown() {
  for (const [target, entry] of activePTYs) {
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    try { entry.ptyProcess.kill(); } catch { /* already dead */ }
    for (const client of entry.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
  }
  activePTYs.clear();
}
