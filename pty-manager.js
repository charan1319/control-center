import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import config from './config.js';

// Map of tmux_target → { ptyProcess, clients: Set<WebSocket>, graceTimer, scrollback }
const activePTYs = new Map();

// Default timeout for all tmux execFileSync calls (10 seconds)
const TMUX_TIMEOUT_MS = 10_000;

/**
 * Trim a scrollback buffer from the left without cutting inside an ANSI escape
 * sequence. ESC (0x1b) always begins a new sequence, so advancing the cut point
 * forward to the next ESC guarantees the replay starts at a safe boundary.
 *
 * Codex's Rust TUI emits dense SGR/CSI/alt-screen streams, so the buffer rolls
 * over frequently and a naive left-slice was clipping escape sequences — leaving
 * orphan parameter bytes that xterm.js rendered as garbage, or worse, clipping
 * the alt-screen enter (ESC[?1049h) so subsequent frame draws landed in the
 * wrong buffer on replay.
 */
function trimScrollback(buffer, maxSize) {
  if (buffer.length <= maxSize) return buffer;
  const start = buffer.length - maxSize;
  // Search a small window after the cut for the next ESC — ANSI sequences are
  // typically <32 bytes, so 256 bytes is plenty to step past any clipped one.
  const windowEnd = Math.min(buffer.length, start + 256);
  for (let i = start; i < windowEnd; i++) {
    if (buffer.charCodeAt(i) === 0x1b) return buffer.slice(i);
  }
  // No ESC in the window — the cut is in plain text, safe to slice as-is.
  return buffer.slice(start);
}

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
      execFileSync('tmux', ['has-session', '-t', target], { timeout: TMUX_TIMEOUT_MS, stdio: 'ignore' });
      return true;
    } catch {
      if (attempt === 0) continue; // retry once
      return false;
    }
  }
  return false;
}

/**
 * Ensure a PTY bridge exists for a tmux target. Creates one if needed.
 * Returns the entry, or null if the tmux session doesn't exist.
 */
function ensureBridge(tmuxTarget) {
  let entry = activePTYs.get(tmuxTarget);
  if (entry) return entry;

  if (!tmuxSessionExists(tmuxTarget)) return null;

  let ptyProcess;
  try {
    // -2 forces tmux to assume 256-color support, bypassing its default-terminal setting.
    // Without this, tmux may use 'screen' which strips/remaps colors from Claude Code.
    ptyProcess = pty.spawn('/bin/bash', [
      '-c', `TERM=xterm-256color exec tmux -2 attach-session -t ${tmuxTarget}`
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
    headless: false, // true = auto-started capture, don't kill on client disconnect
    scrollback: '',
  };

  ptyProcess.onData((data) => {
    entry.scrollback = trimScrollback(entry.scrollback + data, config.scrollbackBufferSize);
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
  return entry;
}

/**
 * Start headless PTY capture for a tmux session.
 * Begins buffering all output immediately — no WebSocket client needed.
 * Call this when a session is launched so scrollback is captured from the start.
 */
export function startCapture(tmuxTarget) {
  const entry = ensureBridge(tmuxTarget);
  if (entry) entry.headless = true;
  return !!entry;
}

/**
 * Attach a WebSocket client to a tmux session's PTY.
 * Creates the PTY bridge if it doesn't exist yet.
 * Multiple clients can attach to the same PTY simultaneously.
 * Returns the pty process, or null if the tmux session doesn't exist.
 */
export function attach(tmuxTarget, socket) {
  const entry = ensureBridge(tmuxTarget);
  if (!entry) return null;

  // Clear grace timer if set (a new client connected before grace period expired)
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }

  entry.clients.add(socket);

  // Replay scrollback so the new client sees current terminal state.
  // Strip terminal query sequences that would cause xterm.js to send responses
  // back as input to the running program (producing garbage characters).
  if (entry.scrollback.length > 0) {
    try {
      let data = entry.scrollback;
      data = data.replace(/\x1b\[>c/g, '');   // Secondary Device Attributes request
      data = data.replace(/\x1b\[=c/g, '');   // Tertiary Device Attributes request
      data = data.replace(/\x1b\[c/g, '');    // Primary Device Attributes request
      data = data.replace(/\x1b\[>q/g, '');   // XTVERSION request
      data = data.replace(/\x1b\[6n/g, '');   // Cursor position report request
      data = data.replace(/\x1b\[5n/g, '');   // Device status report request
      socket.send(JSON.stringify({ type: 'output', data }));
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

  if (entry.clients.size === 0 && !entry.headless) {
    // No clients and not a headless capture — start grace timer
    entry.graceTimer = setTimeout(() => {
      try { entry.ptyProcess.kill(); } catch { /* already dead */ }
      activePTYs.delete(tmuxTarget);
    }, config.ptyGracePeriodMs);
  }
  // Headless bridges persist with zero clients — they keep capturing output
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
 * Write raw input to a tmux session's PTY (same path as the terminal WebSocket).
 * Used for CLIs like Codex whose TUI doesn't respond to tmux send-keys.
 * Returns true if written, false if no PTY bridge exists.
 */
export function writeInput(tmuxTarget, data) {
  const entry = ensureBridge(tmuxTarget);
  if (!entry) return false;
  entry.ptyProcess.write(data);
  return true;
}

/**
 * Get the raw PTY scrollback buffer for a tmux target.
 * Returns the actual terminal output stream (with ANSI codes), or null if no PTY bridge exists.
 */
export function getScrollback(tmuxTarget) {
  const entry = activePTYs.get(tmuxTarget);
  return entry ? entry.scrollback : null;
}

/**
 * Get a cleaned version of the scrollback suitable for replay into a read-only xterm.js.
 * Strips alternate screen, cursor positioning, and screen clear sequences
 * while preserving text content and color/style codes.
 */
export function getCleanScrollback(tmuxTarget) {
  const entry = activePTYs.get(tmuxTarget);
  if (!entry || !entry.scrollback) return null;

  let data = entry.scrollback;

  // Strip alternate screen enter/exit
  data = data.replace(/\x1b\[\?1049[hl]/g, '');
  data = data.replace(/\x1b\[\?47[hl]/g, '');
  data = data.replace(/\x1b\[\?1047[hl]/g, '');

  // Strip screen clears
  data = data.replace(/\x1b\[2J/g, '');
  data = data.replace(/\x1b\[3J/g, '');

  // Strip cursor positioning (ESC[H, ESC[row;colH, ESC[row;colf)
  data = data.replace(/\x1b\[\d*;\d*[Hf]/g, '');
  data = data.replace(/\x1b\[H/g, '');

  // Strip cursor show/hide
  data = data.replace(/\x1b\[\?25[hl]/g, '');

  // Strip erase in display (clear from cursor)
  data = data.replace(/\x1b\[[012]?J/g, '');

  // Strip erase in line
  data = data.replace(/\x1b\[[012]?K/g, '');

  // Strip cursor save/restore
  data = data.replace(/\x1b\[s/g, '');
  data = data.replace(/\x1b\[u/g, '');
  data = data.replace(/\x1b7/g, '');
  data = data.replace(/\x1b8/g, '');

  // Strip scroll region
  data = data.replace(/\x1b\[\d*;\d*r/g, '');

  // Strip window title sequences
  data = data.replace(/\x1b\][^\x07]*\x07/g, '');
  data = data.replace(/\x1b\][^\x1b]*\x1b\\/g, '');

  // Strip terminal query sequences (would cause xterm.js to send responses as input)
  data = data.replace(/\x1b\[>c/g, '');
  data = data.replace(/\x1b\[=c/g, '');
  data = data.replace(/\x1b\[c/g, '');
  data = data.replace(/\x1b\[>q/g, '');
  data = data.replace(/\x1b\[6n/g, '');
  data = data.replace(/\x1b\[5n/g, '');

  // Collapse runs of blank lines (>3 consecutive) into 2
  data = data.replace(/(\r?\n){4,}/g, '\n\n\n');

  return data;
}

/**
 * List tmux sessions with their pane working directories.
 * Returns array of { name, cwd }.
 */
export function listTmuxSessions() {
  try {
    const output = execFileSync(
      'tmux', ['list-sessions', '-F', '#{session_name}|#{pane_current_path}'],
      { encoding: 'utf-8', timeout: TMUX_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'ignore'] }
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
export function createTmuxSession({ label, cwd, initialPrompt, cli_type = 'claude' }) {
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

  // Build CLI command based on cli_type
  // Permission bypass flags removed — use Claude Code's built-in auto mode (Shift+Tab) instead.
  let cliCmd;
  let promptIncludedInCmd = false;
  switch (cli_type) {
    case 'gemini':
      cliCmd = 'gemini';
      break;
    case 'codex':
      // Codex accepts the prompt as a positional CLI argument.
      // Its Rust TUI doesn't accept pasted text via tmux paste-buffer,
      // so the prompt must be passed on the command line.
      if (initialPrompt) {
        const escaped = initialPrompt.replace(/'/g, "'\\''");
        cliCmd = `codex '${escaped}'`;
        promptIncludedInCmd = true;
      } else {
        cliCmd = 'codex';
      }
      break;
    case 'claude':
    default:
      cliCmd = 'claude';
  }
  execFileSync('tmux', ['send-keys', '-t', sessionName, cliCmd, 'Enter'], { timeout: TMUX_TIMEOUT_MS });

  // If there's an initial prompt and it wasn't already passed as a CLI argument,
  // wait for the TUI to initialize then paste it in.
  if (initialPrompt && !promptIncludedInCmd) {
    // 8s delay: Claude Code TUI typically needs 5-8s to initialize after launch.
    // sendPrompt adds its own internal delays for paste processing + Enter.
    setTimeout(() => sendPrompt(sessionName, initialPrompt), 8000);
  }

  return sessionName;
}

/**
 * Send a prompt to a tmux pane via paste-buffer, then submit with Enter.
 * Called from the SessionStart hook handler so Claude is guaranteed to be running.
 * Uses a short delay between paste and Enter to let the TUI process the paste.
 */
export function sendPrompt(tmuxTarget, text) {
  sanitizeTmuxTarget(tmuxTarget);
  setTimeout(() => {
    try {
      const buf = `cc-init-${Date.now()}`;
      execFileSync('tmux', ['load-buffer', '-b', buf, '-'], { input: text, timeout: TMUX_TIMEOUT_MS });
      execFileSync('tmux', ['paste-buffer', '-t', tmuxTarget, '-b', buf, '-d'], { timeout: TMUX_TIMEOUT_MS });
      setTimeout(() => {
        try {
          execFileSync('tmux', ['send-keys', '-t', tmuxTarget, 'Enter'], { timeout: TMUX_TIMEOUT_MS });
        } catch (err) {
          console.error(`[pty-manager] Failed to submit prompt to ${tmuxTarget}: ${err.message}`);
        }
      }, 1500);
    } catch (err) {
      console.error(`[pty-manager] Failed to send prompt to ${tmuxTarget}: ${err.message}`);
    }
  }, 2000);
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
