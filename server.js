import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync, execFile, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, watch, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import webpush from 'web-push';
import config from './config.js';
import * as db from './db.js';
import * as ptyManager from './pty-manager.js';
import * as snapshots from './snapshots.js';
import { readTranscriptTail, getLastAssistantText, readTranscriptStructured, getTranscriptSize } from './transcript.js';
import * as pulse from './pulse.js';

// Configure web-push VAPID keys (no-op if keys not set)
if (config.pushEnabled) {
  webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);
}

// Global WebSocket clients for dashboard
const dashboardClients = new Set();

// Transcript file watchers: session_id → { watcher, subscribers: Set<socket>, lastSize, filePath }
const transcriptWatchers = new Map();

async function sendPushNotification(title, body, tag = 'cc', url = '/') {
  if (!config.pushEnabled) return;
  const subscriptions = db.getAllPushSubscriptions();
  const payload = JSON.stringify({ title, body, tag, url });
  await Promise.all(subscriptions.map(async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    } catch (err) {
      // 404/410 = subscription expired — clean it up
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.deletePushSubscription(sub.endpoint);
      } else {
        console.error('[push] sendNotification failed:', err.statusCode, err.message);
      }
    }
  }));
}

const PROJECTS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'projects.json');
const TEMPLATES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'templates.json');

// ──────────────────────────────────────────────
// Version check (GitHub)
// ──────────────────────────────────────────────

const LOCAL_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version;
const GITHUB_PKG_URL = 'https://raw.githubusercontent.com/charan1319/control-center/main/package.json';
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _versionCache = { latest: null, checkedAt: 0 };

/**
 * Compare two semver strings (e.g. "1.2.3" vs "1.3.0").
 * Returns true if remote is strictly newer than local.
 */
function isNewerVersion(local, remote) {
  const lp = local.split('.').map(Number);
  const rp = remote.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((rp[i] || 0) > (lp[i] || 0)) return true;
    if ((rp[i] || 0) < (lp[i] || 0)) return false;
  }
  return false;
}

async function fetchLatestVersion() {
  if (Date.now() - _versionCache.checkedAt < VERSION_CACHE_TTL_MS && _versionCache.latest !== null) {
    return _versionCache.latest;
  }
  try {
    const res = await fetch(GITHUB_PKG_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pkg = await res.json();
    _versionCache = { latest: pkg.version, checkedAt: Date.now() };
    return pkg.version;
  } catch {
    // Network error, rate limited, etc. — return cached value or null
    return _versionCache.latest || null;
  }
}

// readTranscriptTail and getLastAssistantText are imported from transcript.js

// ──────────────────────────────────────────────
// AI summary (DeepSeek)
// ──────────────────────────────────────────────

const summaryCache = new Map(); // session_id → { summary, generatedAt }

async function generateSummary(transcript) {
  const turns = readTranscriptTail(transcript, 48_000);
  if (turns.length === 0) return null;

  const messages = [];
  for (const turn of turns.slice(-30)) {
    const role = turn.type === 'user' ? 'user' : 'assistant';
    const c = turn.message?.content;
    let content = '';
    if (typeof c === 'string') {
      content = c;
    } else if (Array.isArray(c)) {
      content = c.map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') {
          if (b.name === 'Bash') return `[Bash: ${(b.input?.command || '').slice(0, 150)}]`;
          if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
            return `[${b.name}: ${b.input?.file_path || b.input?.path || ''}]`;
          }
          if (['Read', 'Glob', 'Grep', 'LS'].includes(b.name)) {
            return `[${b.name}: ${b.input?.file_path || b.input?.pattern || b.input?.path || ''}]`;
          }
          return `[${b.name}: ${JSON.stringify(b.input || {}).slice(0, 100)}]`;
        }
        if (b.type === 'tool_result') {
          const rc = Array.isArray(b.content)
            ? b.content.map(x => x.text || '').join(' ')
            : (typeof b.content === 'string' ? b.content : '');
          const snippet = rc.trim().slice(0, 200);
          return snippet ? `[Result: ${snippet}]` : '';
        }
        return '';
      }).filter(Boolean).join(' ');
    }
    if (content.trim()) messages.push({ role, content: content.slice(0, 900) });
  }
  if (messages.length === 0) return null;

  const response = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages: [
        {
          role: 'system',
          content: 'You are monitoring a Claude Code AI coding session. Summarize the current state in 2-3 sentences. Include: (1) the specific task or files being worked on, (2) what tool was last used and what happened, (3) whether the session is blocked/waiting or actively progressing. Name specific files, functions, or errors when visible. Be concrete and terse. No headers or lists.',
        },
        ...messages,
      ],
      max_tokens: 150,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error(`DeepSeek API error: ${response.status}`);
  const data = await response.json();

  // Track token usage for cost analytics
  if (data.usage) {
    db.incrementStat('ai_summary_calls', 1);
    db.incrementStat('ai_prompt_tokens', data.usage.prompt_tokens || 0);
    db.incrementStat('ai_completion_tokens', data.usage.completion_tokens || 0);
  }

  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ──────────────────────────────────────────────
// Auto-approve permissions
// ──────────────────────────────────────────────

// File-editing tools that are never auto-approved in "no-edits" mode
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Map Gemini CLI tool names to Claude Code equivalents for auto-approve matching
const GEMINI_TOOL_MAP = { edit_file: 'Edit', write_file: 'Write', read_file: 'Read', shell: 'Bash', list_directory: 'LS', search_files: 'Grep', glob_tool: 'Glob' };

// auto_approve DB values: 0 = none, 1 = full (config-driven), 2 = no-edits (all except file writes)
function shouldAutoApprove(payload, session) {
  const mode = session?.auto_approve ?? 1; // default: full
  if (mode === 0) return false;

  // Normalize Gemini tool names to Claude equivalents
  let toolName = payload.tool_name || '';
  if (payload.cli_type === 'gemini' && GEMINI_TOOL_MAP[toolName]) {
    toolName = GEMINI_TOOL_MAP[toolName];
  }

  if (mode === 2) {
    // No-edits mode: approve everything the full mode would, except file-editing tools
    if (EDIT_TOOLS.has(toolName)) return false;
  }

  // Full mode (mode === 1): use server-configured tool list + bash pattern
  if (config.autoApproveTools.includes(toolName)) return true;

  if (toolName === 'Bash' && config.autoApproveBashPattern) {
    try {
      const input = typeof payload.tool_input === 'string'
        ? JSON.parse(payload.tool_input)
        : (payload.tool_input || {});
      const command = (input.command || input.cmd || '').trimStart();
      if (command && new RegExp(config.autoApproveBashPattern).test(command)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function readProjects() {
  try { return JSON.parse(readFileSync(PROJECTS_PATH, 'utf8')); } catch { return []; }
}

function readTemplates() {
  try { return JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8')); } catch { return []; }
}
function writeTemplates(templates) {
  writeFileSync(TEMPLATES_PATH, JSON.stringify(templates, null, 2) + '\n');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a query param as an integer, clamped to [min, max].
 * Returns defaultVal for missing, NaN, or out-of-range values.
 */
function clampInt(raw, defaultVal, min, max) {
  if (raw == null) return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(max, n));
}

// ──────────────────────────────────────────────
// Hook ingest rate limiter (no extra dependency)
// 120 requests per minute per IP — allows burst from active sessions
// while blocking runaway hooks or network-level abuse.
// ──────────────────────────────────────────────

const _hookBuckets = new Map(); // ip → timestamp[]
const HOOK_RATE_MAX = 120;
const HOOK_RATE_WINDOW_MS = 60_000;

function hookRateLimited(ip) {
  // Hook scripts always call from localhost — only rate-limit external IPs
  // to guard against network-level abuse while never blocking legitimate hooks.
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
  const now = Date.now();
  const cutoff = now - HOOK_RATE_WINDOW_MS;
  const bucket = (_hookBuckets.get(ip) || []).filter(t => t > cutoff);
  if (bucket.length >= HOOK_RATE_MAX) {
    _hookBuckets.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  _hookBuckets.set(ip, bucket);
  return false;
}

// ──────────────────────────────────────────────
// Zombie session cleanup
// Marks sessions as 'stopped' if their tmux target no longer exists
// and their last heartbeat is more than 4 hours ago.
// ──────────────────────────────────────────────

// Returns array of session_ids that were marked stopped.
function cleanupZombies() {
  const liveTmuxNames = new Set(ptyManager.listTmuxSessions().map(s => s.name));
  const active = db.getActiveSessions();
  const stopped = [];

  for (const s of active) {
    if (s.status === 'waiting_permission') continue;
    const hasLiveTmux = s.tmux_target && liveTmuxNames.has(s.tmux_target);
    if (!hasLiveTmux) {
      const msAgo = s.last_heartbeat
        ? Date.now() - new Date(s.last_heartbeat.replace(' ', 'T') + 'Z').getTime()
        : Infinity;
      if (msAgo > 4 * 60 * 60 * 1000) {
        db.updateStatus(s.session_id, 'stopped');
        stopped.push(s.session_id);

        // Notify dashboard if a todo was linked to this zombie session
        const todo = db.getTodoBySessionId(s.session_id);
        if (todo) {
          const msg = JSON.stringify({ type: 'todo_session_stopped', todo_id: todo.id, session_id: s.session_id });
          for (const client of dashboardClients) {
            try { if (client.readyState === 1) client.send(msg); } catch {}
          }
        }
      }
    }
  }
  return stopped;
}

// ──────────────────────────────────────────────
// Debounced pulse regeneration
// ──────────────────────────────────────────────

const pulseDebounceTimers = new Map();
function schedulePulseRegeneration(project, delayMs) {
  if (!project) return;
  if (pulseDebounceTimers.has(project)) {
    clearTimeout(pulseDebounceTimers.get(project));
  }
  pulseDebounceTimers.set(project, setTimeout(() => {
    pulseDebounceTimers.delete(project);
    pulse.generatePulse(project);
  }, delayMs));
}

// ──────────────────────────────────────────────
// Build server (exported for tests)
// ──────────────────────────────────────────────

export async function buildServer(opts = {}) {
  const fastify = Fastify({ logger: opts.logger ?? true });

  // ──────────────────────────────────────────────
  // Plugins (registration order matters)
  // ──────────────────────────────────────────────

  await fastify.register(fastifyWebSocket);

  const distDir = join(__dirname, 'dist');
  const publicDir = join(__dirname, 'public');
  const staticRoot = existsSync(distDir) ? distDir : publicDir;

  await fastify.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
  });

  // ──────────────────────────────────────────────
  // Pending labels from /api/sessions/launch
  // Maps tmux_target → label, consumed when SessionStart auto-links
  // ──────────────────────────────────────────────

  const pendingLabels = new Map();     // tmux_target → { label, createdAt }
  const PENDING_LABEL_TTL_MS = 60_000; // Auto-expire after 60s

  // ──────────────────────────────────────────────
  // Pending permission grants
  // When PermissionRequest is not auto-approved, the hook script long-polls
  // /api/sessions/:id/permission-decision (up to 50s).  When the user clicks
  // "Grant" in the dashboard, /api/sessions/:id/grant-permission resolves it.
  // ──────────────────────────────────────────────
  const pendingPermissions = new Map(); // session_id → resolve()

  // ──────────────────────────────────────────────
  // WebSocket: Dashboard event stream
  // ──────────────────────────────────────────────

  fastify.get('/ws/events', { websocket: true }, (socket, request) => {
    dashboardClients.add(socket);

    // Send full current state on connect
    const sessions = db.getAllSessions();
    const recentEvents = db.getRecentEvents(50);
    socket.send(JSON.stringify({ type: 'init', sessions, recentEvents }));

    // Track which transcript this socket is subscribed to (at most one)
    let subscribedSessionId = null;

    socket.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === 'subscribe_transcript' && msg.session_id) {
          // Unsubscribe from previous if any
          unsubscribeTranscript(socket, subscribedSessionId);
          subscribedSessionId = msg.session_id;
          subscribeTranscript(socket, msg.session_id);

        } else if (msg.type === 'unsubscribe_transcript') {
          unsubscribeTranscript(socket, subscribedSessionId);
          subscribedSessionId = null;
        }
      } catch { /* malformed message */ }
    });

    const cleanup = () => {
      dashboardClients.delete(socket);
      unsubscribeTranscript(socket, subscribedSessionId);
      subscribedSessionId = null;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  function broadcastEvent(payload) {
    const msg = JSON.stringify({ type: 'event', ...payload });
    for (const client of dashboardClients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch { /* client gone */ }
    }
  }

  function broadcastSessionUpdate(session) {
    const msg = JSON.stringify({ type: 'session_update', session });
    for (const client of dashboardClients) {
      try {
        if (client.readyState === 1) client.send(msg);
      } catch { /* client gone */ }
    }
  }

  // ──────────────────────────────────────────────
  // Transcript watcher helpers
  // ──────────────────────────────────────────────

  function subscribeTranscript(socket, sessionId) {
    if (!sessionId) return;
    const session = db.getSession(sessionId);
    if (!session?.transcript) return;

    let entry = transcriptWatchers.get(sessionId);
    if (entry) {
      entry.subscribers.add(socket);
      return;
    }

    // Create new watcher
    const filePath = session.transcript;
    let lastSize = 0;
    try {
      const fd = openSync(filePath, 'r');
      try { lastSize = fstatSync(fd).size; } finally { closeSync(fd); }
    } catch { /* file may not exist yet */ }

    let watcher = null;
    try {
      // Use polling as fallback (interval 2s) for network/virtual filesystems
      watcher = watch(filePath, { persistent: false, interval: 2000 }, () => {
        const w = transcriptWatchers.get(sessionId);
        if (!w || w.subscribers.size === 0) return;

        let currentSize = 0;
        try {
          const fd = openSync(filePath, 'r');
          try { currentSize = fstatSync(fd).size; } finally { closeSync(fd); }
        } catch { return; }

        if (currentSize <= w.lastSize) return;

        // Read only the new bytes
        const newBytes = currentSize - w.lastSize;
        try {
          const fd = openSync(filePath, 'r');
          try {
            const buf = Buffer.allocUnsafe(newBytes);
            readSync(fd, buf, 0, newBytes, w.lastSize);
            const lines = buf.toString('utf8').split('\n');
            const entries = parseTranscriptLines(lines, false);

            if (entries.length > 0) {
              const msg = JSON.stringify({
                type: 'transcript_update',
                session_id: sessionId,
                entries,
              });
              for (const sub of w.subscribers) {
                try { if (sub.readyState === 1) sub.send(msg); } catch { /* gone */ }
              }
            }
          } finally { closeSync(fd); }
        } catch { /* read error */ }

        w.lastSize = currentSize;
      });
    } catch { /* watch failed — file may not exist */ }

    entry = { watcher, subscribers: new Set([socket]), lastSize, filePath };
    transcriptWatchers.set(sessionId, entry);
  }

  function unsubscribeTranscript(socket, sessionId) {
    if (!sessionId) return;
    const entry = transcriptWatchers.get(sessionId);
    if (!entry) return;
    entry.subscribers.delete(socket);
    if (entry.subscribers.size === 0) {
      if (entry.watcher) {
        try { entry.watcher.close(); } catch { /* ignore */ }
      }
      transcriptWatchers.delete(sessionId);
    }
  }

  /**
   * Parse an array of JSONL lines into structured transcript entries.
   * Mirrors readTranscriptStructured logic but works on pre-split lines.
   */
  function parseTranscriptLines(lines, skipFirst = false) {
    const entries = [];
    const startIdx = skipFirst ? 1 : 0;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const timestamp = obj.timestamp || undefined;

      if (obj.type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
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
        for (const block of content) {
          if (block.type === 'thinking') {
            entries.push({ type: 'thinking', content: block.thinking || '', timestamp });
          } else if (block.type === 'text') {
            entries.push({ type: 'assistant', content: block.text || '', timestamp });
          } else if (block.type === 'tool_use') {
            const summary = summarizeToolInputInline(block.name, block.input);
            entries.push({
              type: 'tool_use',
              content: summary,
              tool_name: block.name || '',
              tool_input_summary: summary,
              tool_input_full: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2),
              timestamp,
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
      }
    }
    return entries;
  }

  function summarizeToolInputInline(toolName, input) {
    if (!input) return '';
    try {
      const obj = typeof input === 'string' ? JSON.parse(input) : input;
      switch (toolName) {
        case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
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

  // ──────────────────────────────────────────────
  // WebSocket: Terminal relay (per session)
  // ──────────────────────────────────────────────

  fastify.get('/ws/terminal/:sessionId', { websocket: true }, (socket, request) => {
    const { sessionId } = request.params;
    const session = db.getSession(sessionId);

    if (!session?.tmux_target) {
      socket.send(JSON.stringify({ type: 'error', message: 'No tmux target linked to this session. Use the dashboard to link a tmux session.' }));
      socket.close();
      return;
    }

    const ptyProcess = ptyManager.attach(session.tmux_target, socket);

    if (!ptyProcess) {
      socket.send(JSON.stringify({ type: 'error', message: `tmux session "${session.tmux_target}" does not exist.` }));
      socket.close();
      return;
    }

    socket.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.type === 'input') {
          ptyProcess.write(msg.data);
          // If the user typed anything into the terminal, they responded to the
          // permission prompt — clear waiting_permission immediately so the Grant
          // button disappears without waiting for the next hook event.
          const cur = db.getSession(sessionId);
          if (cur?.status === 'waiting_permission') {
            db.updateStatus(sessionId, 'active');
            db.clearPendingPermission(sessionId);
            const updated = db.getSession(sessionId);
            if (updated) broadcastSessionUpdate(updated);
          }
        } else if (msg.type === 'resize') {
          ptyManager.resize(session.tmux_target, msg.cols, msg.rows);
        }
      } catch { /* malformed message */ }
    });

    socket.on('close', () => ptyManager.detach(session.tmux_target, socket));
    socket.on('error', () => ptyManager.detach(session.tmux_target, socket));
  });

  // ──────────────────────────────────────────────
  // REST: Hook ingest (called by Claude Code hook scripts)
  // ──────────────────────────────────────────────

  fastify.post('/api/hooks', { bodyLimit: 65_536 }, async (request, reply) => {
    if (hookRateLimited(request.ip)) {
      return reply.status(429).send({ error: 'Rate limit exceeded' });
    }

    const payload = request.body;
    if (!payload || !payload.event || !payload.session_id) {
      return reply.status(400).send({ error: 'Missing event or session_id' });
    }

    const { event, session_id } = payload;

    // 1. Upsert session on SessionStart
    if (event === 'SessionStart') {
      // Ignore headless sessions (not running inside a tmux pane).
      // Only interactive sessions in tmux get a dashboard card.
      if (!payload.tmux_session) {
        return reply.status(204).send();
      }
      db.upsertSession({
        session_id,
        cwd: payload.cwd,
        model: payload.model,
        transcript: payload.transcript_path,
        cli_type: payload.cli_type,
      });
      // Auto-link tmux target by matching cwd, and apply any pending label from launch
      // Prefer the tmux session name reported by the hook (unambiguous),
      // fall back to CWD matching when Claude Code is not running inside tmux.
      // For CWD-match: skip targets already claimed by another active session —
      // prevents headless/batch Claude Code runs from hijacking the interactive terminal.
      const tmuxSessions = ptyManager.listTmuxSessions();
      let match;
      if (payload.tmux_session) {
        match = tmuxSessions.find(ts => ts.name === payload.tmux_session);
      } else {
        const claimedTargets = new Set(
          db.getAllSessions()
            .filter(s => s.status !== 'stopped' && s.session_id !== session_id && s.tmux_target)
            .map(s => s.tmux_target)
        );
        match = tmuxSessions.find(ts => ts.cwd === payload.cwd && !claimedTargets.has(ts.name));
      }
      if (match) {
        const pending = pendingLabels.get(match.name);
        const validPending = pending && (Date.now() - pending.createdAt < PENDING_LABEL_TTL_MS);
        const existing = db.getSession(session_id);
        const defaultLabel = (!existing?.label && !validPending)
          ? `${hostname()}:${basename(payload.cwd || process.env.HOME || '~')}`
          : undefined;
        db.updateSession(session_id, {
          tmux_target: match.name,
          label: validPending ? pending.label : defaultLabel,
          project: validPending ? pending.project : undefined,
          auto_approve: validPending ? pending.autoApproveDbVal : undefined,
        });
        if (pending) {
          if (pending.todoId) {
            db.linkTodoSession(pending.todoId, session_id);
          }
          pendingLabels.delete(match.name);
        }
      }

      // Capture initial snapshot (fire and forget — don't block hook response)
      const snapshotCwd = payload.cwd;
      const snapshotSid = session_id;
      setImmediate(() => {
        try {
          snapshots.initRepo(snapshotCwd);
          const hash = snapshots.capture(snapshotCwd);
          if (hash) db.updateSnapshotHash(snapshotSid, hash);
        } catch (err) {
          fastify.log.warn({ err, session_id: snapshotSid }, 'Snapshot capture failed');
        }
      });
    }

    // 2. Update session status (with auto-approve logic for PermissionRequest)
    let autoApproved = false;
    if (event === 'Stop') {
      // Stop fires at the end of each Claude turn, including when a turn is paused
      // waiting for a PermissionRequest. Only set 'active' if we're not waiting —
      // PermissionRequest may have already fired and set 'waiting_permission'.
      const currentStatus = db.getSession(session_id)?.status;
      if (currentStatus !== 'waiting_permission') {
        db.updateStatus(session_id, 'active');
      }
    } else if (event === 'PermissionRequest') {
      const sess = db.getSession(session_id);
      const willAutoApprove = shouldAutoApprove(payload, sess);
      fastify.log.debug(`[perm] session=${session_id.slice(0, 8)} tool=${payload.tool_name || '(none)'} mode=${sess?.auto_approve ?? 1} auto=${willAutoApprove}`);
      if (willAutoApprove) {
        autoApproved = true;
        // Claude Code shows the TUI permission prompt AFTER the hook exits, so we
        // can't paste immediately (the TUI isn't there yet). Schedule a delayed paste
        // so "1\n" arrives once the TUI is visible.
        if (sess?.tmux_target && /^[a-zA-Z0-9_-]+$/.test(sess.tmux_target)) {
          const tmuxTarget = sess.tmux_target;
          setTimeout(() => {
            try {
              // Permission prompt defaults to "Yes" — just press Enter to confirm
              execFileSync('tmux', ['send-keys', '-t', tmuxTarget, 'Enter'], { timeout: 5_000 });
            } catch { /* tmux paste failed */ }
          }, 800);
        }
      }
      if (!autoApproved) {
        db.updateStatus(session_id, 'waiting_permission');
        db.setPendingPermission(session_id, payload.tool_name, payload.tool_input);
      }
    }

    // 3. Handle heartbeats (lightweight — skip event log)
    if (event === 'Heartbeat') {
      // Ensure session row exists for FK (uses INSERT ... ON CONFLICT DO NOTHING
      // so it won't overwrite status on existing sessions — avoids resetting
      // 'waiting_permission' back to 'active' if a late heartbeat arrives)
      db.ensureSession(session_id);
      db.upsertHeartbeat({ session_id, tool_name: payload.tool_name });
      if (payload.file_path) {
        db.insertFileEdit(session_id, payload.file_path, payload.tool_name);
      }
      const heartbeatBroadcast = { event, session_id, tool_name: payload.tool_name, timestamp: payload.timestamp };
      if (payload.file_path) heartbeatBroadcast.file_path = payload.file_path;
      broadcastEvent(heartbeatBroadcast);
      if (payload.file_path) {
        const session = db.getSession(session_id);
        if (session) {
          const updateMsg = { type: 'session_update', session };
          if (session.project) {
            const conflicts = db.getActiveFileConflicts(session.project);
            if (conflicts.length > 0) updateMsg.file_conflicts = conflicts;
            schedulePulseRegeneration(session.project, 10000);
          }
          const msg = JSON.stringify(updateMsg);
          for (const client of dashboardClients) {
            try { if (client.readyState === 1) client.send(msg); } catch { /* client gone */ }
          }
        }
      }
      return reply.status(204).send();
    }

    // 4. Log full event
    db.insertEvent({
      session_id,
      event,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      raw: JSON.stringify(payload),
    });

    // 5. Broadcast to dashboard
    const session = db.getSession(session_id);
    broadcastEvent({
      event, session_id,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      cwd: payload.cwd,
      timestamp: payload.timestamp,
      label: session?.label,
      auto_approved: autoApproved || undefined,
    });
    if (session) broadcastSessionUpdate(session);

    // 5b. Trigger pulse regeneration for SessionStart/Stop events with a project
    if ((event === 'SessionStart' || event === 'Stop') && session?.project) {
      schedulePulseRegeneration(session.project, 2000);
    }

    // 6. Web Push notification for permission requests (skip auto-approved — resolved silently).
    if (!autoApproved && event === 'PermissionRequest') {
      const label = session?.label || session_id.slice(0, 12);
      sendPushNotification(
        `Permission needed — ${label}`,
        `Tool: ${payload.tool_name || 'unknown'}`,
        `permission-${session_id}`,
        `/?session=${encodeURIComponent(session_id)}`,
      ).catch(() => {});
    }

    // For PermissionRequest: return the auto-approve decision so the hook script
    // can output {"decision":"approve"} to stdout, telling Claude Code directly.
    if (event === 'PermissionRequest') {
      return reply.status(200).send({ auto_approve: autoApproved });
    }

    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────
  // REST: Sessions CRUD
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions', async () => db.getAllSessions());

  fastify.get('/api/sessions/history', async (request) => {
    const { project, q, from, to, limit, offset } = request.query;
    return db.searchSessions({
      project, q,
      from_date: from,
      to_date: to,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
  });

  fastify.get('/api/sessions/:id', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return session;
  });

  fastify.patch('/api/sessions/:id', async (request, reply) => {
    const { label, tmux_target, project, pulse_enabled } = request.body || {};
    if (label !== undefined && (typeof label !== 'string' || label.length > 256)) {
      return reply.status(400).send({ error: 'Label must be a string under 256 characters' });
    }
    if (tmux_target !== undefined && (typeof tmux_target !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tmux_target))) {
      return reply.status(400).send({ error: 'Invalid tmux target name' });
    }
    if (project !== undefined && (typeof project !== 'string' || project.length > 128)) {
      return reply.status(400).send({ error: 'Project must be a string under 128 characters' });
    }
    if (pulse_enabled !== undefined && ![0, 1].includes(pulse_enabled)) {
      return reply.status(400).send({ error: 'pulse_enabled must be 0 or 1' });
    }
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    db.updateSession(request.params.id, { label, tmux_target, project, pulse_enabled });
    const updated = db.getSession(request.params.id);
    broadcastSessionUpdate(updated);
    return updated;
  });

  // ──────────────────────────────────────────────
  // REST: Launch new session
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/launch', async (request, reply) => {
    const { label, cwd, initialPrompt, project, autoApprove, skipPermissions, cli_type } = request.body || {};

    // Input validation
    if (label && (typeof label !== 'string' || label.length > 256)) {
      return reply.status(400).send({ error: 'Label must be a string under 256 characters' });
    }
    if (cwd && (typeof cwd !== 'string' || cwd.length > 1024)) {
      return reply.status(400).send({ error: 'Working directory path too long' });
    }
    if (initialPrompt && (typeof initialPrompt !== 'string' || initialPrompt.length > 10_000)) {
      return reply.status(400).send({ error: 'Initial prompt too long (max 10,000 characters)' });
    }
    if (autoApprove !== undefined && !['full', 'readonly', 'none'].includes(autoApprove)) {
      return reply.status(400).send({ error: "autoApprove must be 'full', 'readonly', or 'none'" });
    }
    if (project && (typeof project !== 'string' || project.length > 128)) {
      return reply.status(400).send({ error: 'Project must be a string under 128 characters' });
    }
    if (cli_type && !['claude', 'gemini', 'codex'].includes(cli_type)) {
      return reply.status(400).send({ error: "cli_type must be 'claude', 'gemini', or 'codex'" });
    }

    try {
      // Inject pulse context into the prompt if a project is specified
      let promptWithPulse = initialPrompt;
      if (project && initialPrompt) {
        const pulseText = pulse.getPulseForPrompt(project);
        if (pulseText.trim()) {
          promptWithPulse = `[Project context — auto-generated by Control Center]\n${pulseText}\n[End project context]\n\n${initialPrompt}`;
        }
      }
      const tmuxTarget = ptyManager.createTmuxSession({
        label,
        cwd: cwd || process.env.HOME,
        initialPrompt: promptWithPulse,
        skipPermissions: !!skipPermissions,
        cli_type: cli_type || 'claude',
      });

      // Start headless PTY capture immediately so scrollback is captured from session start
      setTimeout(() => ptyManager.startCapture(tmuxTarget), 1000);

      // Store label/project/autoApprove so the SessionStart hook handler can apply them when auto-linking
      const autoApproveDbVal = autoApprove === 'none' ? 0 : autoApprove === 'readonly' ? 2 : 1;
      pendingLabels.set(tmuxTarget, {
        label,
        project: project || undefined,
        autoApproveDbVal,
        createdAt: Date.now(),
      });
      return { success: true, tmux_target: tmuxTarget, label };
    } catch (err) {
      return reply.status(500).send({ error: `Failed to create session: ${err.message}` });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Send input to a session's tmux pane
  // SECURITY: Uses tmux load-buffer + paste-buffer to avoid shell injection.
  // The text never touches a shell interpreter.
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/:id/input', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session?.tmux_target) return reply.status(400).send({ error: 'No tmux target linked' });
    const { text } = request.body || {};
    if (!text) return reply.status(400).send({ error: 'Missing text' });
    if (typeof text !== 'string' || text.length > 1_000_000) {
      return reply.status(400).send({ error: 'Text too large (max 1MB)' });
    }

    try {
      const target = session.tmux_target;
      // Validate tmux target to prevent injection
      if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
        return reply.status(400).send({ error: 'Invalid tmux target' });
      }
      // Use a unique named buffer to avoid race conditions between concurrent requests.
      // execFileSync bypasses the shell entirely — no injection possible.
      const buf = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      execFileSync('tmux', ['load-buffer', '-b', buf, '-'], { input: text, timeout: 10_000 });
      execFileSync('tmux', ['paste-buffer', '-t', target, '-b', buf, '-d'], { timeout: 10_000 });
      execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 10_000 });
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Kill a session (stops tmux + marks stopped)
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/:id/kill', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    if (session.tmux_target) {
      try {
        execFileSync('tmux', ['kill-session', '-t', session.tmux_target], { timeout: 5_000 });
      } catch { /* already gone — continue to update DB */ }
    }

    db.updateStatus(request.params.id, 'stopped');
    const updated = db.getSession(request.params.id);
    broadcastSessionUpdate(updated);

    // Notify dashboard if a todo was linked to this session
    const todo = db.getTodoBySessionId(request.params.id);
    if (todo) {
      const msg = JSON.stringify({ type: 'todo_session_stopped', todo_id: todo.id, session_id: request.params.id });
      for (const client of dashboardClients) {
        try { if (client.readyState === 1) client.send(msg); } catch {}
      }
    }

    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────
  // REST: Grant permission (resolves the hook's long-poll)
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/:id/grant-permission', async (request, reply) => {
    const sid = request.params.id;
    const session = db.getSession(sid);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Send "1\n" to the tmux pane to answer the TUI permission prompt.
    // Claude Code shows the prompt in the terminal regardless of hook stdout output,
    // so we must send the keystroke directly.
    if (session.tmux_target && /^[a-zA-Z0-9_-]+$/.test(session.tmux_target)) {
      try {
        // Permission prompt defaults to "Yes" — just press Enter to confirm
        execFileSync('tmux', ['send-keys', '-t', session.tmux_target, 'Enter'], { timeout: 5_000 });
      } catch { /* tmux paste failed — long-poll resolution still clears waiting state */ }
    }

    // Resolve hook long-poll if the hook is waiting
    const resolve = pendingPermissions.get(sid);
    if (resolve) {
      resolve();
      pendingPermissions.delete(sid);
    }

    // Update status and broadcast
    db.updateStatus(sid, 'active');
    db.clearPendingPermission(sid);
    const updated = db.getSession(sid);
    broadcastSessionUpdate(updated);

    return reply.status(204).send();
  });

  // Long-poll endpoint: the hook script calls this and blocks until the user
  // clicks Grant (or until the 50s timeout, whichever comes first).
  fastify.get('/api/sessions/:id/permission-decision', async (request, reply) => {
    const sid = request.params.id;
    const waitMs = clampInt(request.query.timeout, 50_000, 0, 50_000);

    return new Promise((resolve) => {
      const timer = waitMs > 0
        ? setTimeout(() => {
            pendingPermissions.delete(sid);
            resolve({ status: 'pending' });
          }, waitMs)
        : null;

      pendingPermissions.set(sid, () => {
        if (timer) clearTimeout(timer);
        pendingPermissions.delete(sid);
        resolve({ status: 'granted' });
      });

      if (waitMs === 0) {
        if (timer) clearTimeout(timer);
        pendingPermissions.delete(sid);
        resolve({ status: 'pending' });
      }
    });
  });

  // ──────────────────────────────────────────────
  // REST: tmux scrollback capture (for history view)
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/scrollback', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!session.tmux_target) return reply.status(400).send({ error: 'No tmux target linked' });
    // Return cleaned PTY output — strips alternate screen, cursor positioning, and
    // screen clear sequences so the scrollback renders correctly in a read-only xterm.js.
    const data = ptyManager.getCleanScrollback(session.tmux_target);
    if (data === null) return reply.status(404).send({ error: 'No active PTY bridge' });
    return { data };
  });

  fastify.get('/api/sessions/:id/terminal-capture', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!session.tmux_target) return reply.status(400).send({ error: 'No tmux target linked' });
    // Already validated to [a-zA-Z0-9_-] on write; belt-and-suspenders here
    if (!/^[a-zA-Z0-9_-]+$/.test(session.tmux_target)) {
      return reply.status(400).send({ error: 'Invalid tmux target' });
    }
    try {
      // -p: print to stdout  -S -10000: go 10000 lines into scrollback history
      // -e: preserve ANSI escape sequences (colors) when ?ansi=1 query param
      const useAnsi = request.query.ansi === '1';
      const args = useAnsi
        ? ['capture-pane', '-p', '-e', '-S', '-10000', '-t', session.tmux_target]
        : ['capture-pane', '-p', '-S', '-10000', '-t', session.tmux_target];
      const text = execFileSync('tmux', args, { encoding: 'utf-8', timeout: 10_000 });
      return { text };
    } catch (err) {
      return reply.status(500).send({ error: `tmux capture failed: ${err.message}` });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Transcript preview (last assistant text)
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/preview', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session?.transcript) return reply.status(404).send({ error: 'No transcript' });
    const text = getLastAssistantText(session.transcript);
    return { text };
  });

  // ──────────────────────────────────────────────
  // REST: Structured transcript
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/transcript', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!session.transcript) return reply.status(404).send({ error: 'No transcript' });

    const limit = clampInt(request.query.limit, 100, 1, 1000);
    const before = request.query.before || null;

    // Scale read size based on requested limit
    const baseBytes = limit * 1024;
    const maxBytes = before ? baseBytes * 4 : baseBytes;

    const allEntries = readTranscriptStructured(session.transcript, maxBytes);
    const fileSize = getTranscriptSize(session.transcript);
    const readFull = maxBytes >= fileSize;

    let entries;
    if (before) {
      const filtered = allEntries.filter(e => e.timestamp && e.timestamp < before);
      entries = filtered.slice(-limit);
    } else {
      entries = allEntries.slice(-limit);
    }

    // hasMore: true if we didn't read the entire file (there may be older entries)
    const hasMore = !readFull || (before ? allEntries.some(e => e.timestamp && e.timestamp < before && !entries.includes(e)) : allEntries.length > limit);

    return { entries, hasMore };
  });

  // ──────────────────────────────────────────────
  // REST: AI summary (DeepSeek, 90s cache)
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/summary', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!config.aiSummaryEnabled || !config.deepseekApiKey || !session.transcript) return { summary: null };

    const cached = summaryCache.get(request.params.id);
    if (cached && Date.now() - cached.generatedAt < 90_000) return { summary: cached.summary };

    try {
      const summary = await generateSummary(session.transcript);
      if (summary) summaryCache.set(request.params.id, { summary, generatedAt: Date.now() });
      return { summary: summary || null };
    } catch (err) {
      fastify.log.warn(`Summary generation failed for ${request.params.id}: ${err.message}`);
      return { summary: null };
    }
  });

  // ──────────────────────────────────────────────
  // REST: Server info (used by frontend for protection logic)
  // ──────────────────────────────────────────────

  fastify.get('/api/info', async () => ({ serverCwd: __dirname, aiSummaryEnabled: config.aiSummaryEnabled }));

  fastify.get('/api/stats', async () => db.getStats());

  // ──────────────────────────────────────────────
  // REST: Version check + self-update
  // ──────────────────────────────────────────────

  fastify.get('/api/version', async () => {
    const latest = await fetchLatestVersion();
    return {
      current: LOCAL_VERSION,
      latest: latest || null,
      updateAvailable: latest ? isNewerVersion(LOCAL_VERSION, latest) : false,
    };
  });

  fastify.post('/api/update', async (request, reply) => {
    const updateScript = join(__dirname, 'update.sh');
    if (!existsSync(updateScript)) {
      return reply.status(500).send({ error: 'update.sh not found' });
    }
    execFile('bash', [updateScript], { cwd: __dirname, timeout: 120_000 }, (err) => {
      if (err) console.error('[update] failed:', err.message);
    });
    return { status: 'updating' };
  });

  fastify.post('/api/sessions/cleanup-zombies', async () => {
    const stoppedIds = cleanupZombies();
    for (const id of stoppedIds) {
      const updated = db.getSession(id);
      if (updated) broadcastSessionUpdate(updated);
    }
    return { cleaned: stoppedIds.length };
  });

  // ──────────────────────────────────────────────
  // REST: File edits per session
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/files', async (request) => {
    const files = db.getFilesBySession(request.params.id);
    return { files };
  });

  // ──────────────────────────────────────────────
  // REST: Snapshot diff & revert
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/snapshot-diff', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!session.snapshot_hash || !session.cwd) return reply.status(404).send({ error: 'No snapshot available' });
    try {
      const changes = snapshots.diff(session.cwd, session.snapshot_hash);
      return changes;
    } catch (err) {
      return reply.status(500).send({ error: `Snapshot diff failed: ${err.message}` });
    }
  });

  fastify.post('/api/sessions/:id/revert', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (session.status !== 'stopped') return reply.status(400).send({ error: 'Session must be stopped before reverting' });
    if (!session.snapshot_hash) return reply.status(400).send({ error: 'No snapshot available' });
    try {
      const files = snapshots.restore(session.cwd, session.snapshot_hash);
      return { reverted: true, files };
    } catch (err) {
      return reply.status(500).send({ error: `Revert failed: ${err.message}` });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Events
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/events', async (request) => {
    const limit = clampInt(request.query.limit, 50, 1, 1000);
    const offset = clampInt(request.query.offset, 0, 0, 100_000);
    return db.getSessionEvents(request.params.id, limit, offset);
  });

  fastify.get('/api/events', async (request) => {
    const limit = clampInt(request.query.limit, 100, 1, 1000);
    return db.getRecentEvents(limit);
  });

  // ──────────────────────────────────────────────
  // REST: tmux discovery
  // ──────────────────────────────────────────────

  fastify.get('/api/tmux-sessions', async () => ptyManager.listTmuxSessions());

  // ──────────────────────────────────────────────
  // REST: Project presets (machine-local, stored in data/projects.json)
  // ──────────────────────────────────────────────

  fastify.get('/api/projects', async () => readProjects());

  fastify.put('/api/projects', async (request, reply) => {
    const projects = request.body;
    if (!Array.isArray(projects)) return reply.status(400).send({ error: 'Expected array' });
    for (const p of projects) {
      if (!p.name || typeof p.name !== 'string' || !p.cwd || typeof p.cwd !== 'string') {
        return reply.status(400).send({ error: 'Each project needs name and cwd' });
      }
    }
    writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2) + '\n');
    return projects;
  });

  // ──────────────────────────────────────────────
  // REST: Project Pulse
  // ──────────────────────────────────────────────

  fastify.get('/api/projects/:name/pulse', async (request) => {
    return pulse.generatePulse(request.params.name);
  });

  fastify.put('/api/projects/:name/pulse/notes', async (request, reply) => {
    const { notes } = request.body || {};
    if (notes !== undefined && typeof notes !== 'string') {
      return reply.status(400).send({ error: 'notes must be a string' });
    }
    pulse.setUserNotes(request.params.name, notes || '');
    return { ok: true };
  });

  fastify.get('/api/projects/:name/pulse/prompt', async (request) => {
    return { text: pulse.getPulseForPrompt(request.params.name) };
  });

  // ──────────────────────────────────────────────
  // REST: Session templates (stored in data/templates.json)
  // ──────────────────────────────────────────────

  fastify.get('/api/templates', async () => readTemplates());

  fastify.post('/api/templates', async (request, reply) => {
    const { name, label, cwd, project, autoApprove, prompt } = request.body || {};
    if (!name || typeof name !== 'string' || name.length > 128) {
      return reply.status(400).send({ error: 'name is required (max 128 chars)' });
    }
    const templates = readTemplates();
    const t = {
      id: Date.now().toString(36),
      name: name.trim(),
      label: (label || '').trim(),
      cwd: (cwd || '').trim(),
      project: (project || '').trim(),
      autoApprove: autoApprove || 'full',
      prompt: (prompt || '').trim(),
    };
    templates.push(t);
    writeTemplates(templates);
    return reply.status(201).send(t);
  });

  fastify.put('/api/templates/:id', async (request, reply) => {
    const { name, label, cwd, project, autoApprove, prompt } = request.body || {};
    const templates = readTemplates();
    const idx = templates.findIndex(t => t.id === request.params.id);
    if (idx === -1) return reply.status(404).send({ error: 'Template not found' });
    if (name !== undefined) templates[idx].name = name.trim();
    if (label !== undefined) templates[idx].label = label.trim();
    if (cwd !== undefined) templates[idx].cwd = cwd.trim();
    if (project !== undefined) templates[idx].project = project.trim();
    if (autoApprove !== undefined) templates[idx].autoApprove = autoApprove;
    if (prompt !== undefined) templates[idx].prompt = prompt.trim();
    writeTemplates(templates);
    return templates[idx];
  });

  fastify.delete('/api/templates/:id', async (request, reply) => {
    const templates = readTemplates();
    const idx = templates.findIndex(t => t.id === request.params.id);
    if (idx === -1) return reply.status(404).send({ error: 'Template not found' });
    templates.splice(idx, 1);
    writeTemplates(templates);
    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────
  // REST: Todos
  // ──────────────────────────────────────────────

  fastify.get('/api/todos', async (request, reply) => {
    const { project } = request.query || {};
    if (!project) return reply.status(400).send({ error: 'project query parameter is required' });
    return { todos: db.getTodosByProject(project) };
  });

  fastify.post('/api/todos', async (request, reply) => {
    const { project, title, details, priority } = request.body || {};
    if (!project || typeof project !== 'string') return reply.status(400).send({ error: 'project is required' });
    if (!title || typeof title !== 'string') return reply.status(400).send({ error: 'title is required' });
    const todo = db.insertTodo(project, title, details, priority);
    return reply.status(201).send(todo);
  });

  fastify.patch('/api/todos/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid todo id' });
    const existing = db.getTodoById(id);
    if (!existing) return reply.status(404).send({ error: 'Todo not found' });
    const { title, details, status, priority } = request.body || {};
    db.updateTodo(id, { title, details, status, priority });
    return { ok: true };
  });

  fastify.delete('/api/todos/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid todo id' });
    const existing = db.getTodoById(id);
    if (!existing) return reply.status(404).send({ error: 'Todo not found' });
    db.deleteTodo(id);
    return { ok: true };
  });

  fastify.post('/api/todos/:id/launch', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid todo id' });
    const todo = db.getTodoById(id);
    if (!todo) return reply.status(404).send({ error: 'Todo not found' });

    // Resolve project CWD
    const projects = readProjects();
    const preset = projects.find(p => p.name === todo.project);
    let cwd = preset?.cwd;
    if (!cwd) {
      const sessions = db.getSessionsByProject(todo.project);
      cwd = sessions?.[0]?.cwd;
    }
    if (!cwd) {
      return reply.status(400).send({ error: 'Cannot determine CWD for project. Add it to project presets.' });
    }

    const { skipPermissions } = request.body || {};

    // Build launch prompt
    let initialPrompt = `You are a skilled software engineer working on the "${todo.project}" project.
You have been assigned a specific task to complete.

Before writing any code:
1. Read the project's CLAUDE.md file to understand conventions, architecture, and rules.
2. Read .control-center/pulse.md if it exists for awareness of other active sessions.
3. Identify and read the files most relevant to this task.
4. Formulate a clear, concise implementation plan.
5. Present your plan and wait for approval before proceeding.

After receiving approval, implement the changes methodically:
- Make the minimal changes needed to accomplish the task.
- Run existing tests if applicable (check CLAUDE.md for test commands).
- Do not modify files unrelated to the task.

## Task: ${todo.title}
${todo.details || ''}

Begin by reading CLAUDE.md and the relevant source files, then present your implementation plan.`;

    // Inject pulse context if available
    const pulseText = pulse.getPulseForPrompt(todo.project);
    if (pulseText.trim()) {
      initialPrompt = `[Project context — auto-generated by Control Center]\n${pulseText}\n[End project context]\n\n${initialPrompt}`;
    }

    try {
      const tmuxTarget = ptyManager.createTmuxSession({
        label: todo.title,
        cwd,
        initialPrompt,
        skipPermissions: !!skipPermissions,
      });

      // Start headless PTY capture immediately
      setTimeout(() => ptyManager.startCapture(tmuxTarget), 1000);

      // Mark todo as in_progress immediately so the UI updates right away
      // (linkTodoSession will re-set this when SessionStart arrives — idempotent)
      db.updateTodo(todo.id, { status: 'in_progress' });

      pendingLabels.set(tmuxTarget, {
        label: todo.title,
        project: todo.project,
        autoApproveDbVal: 1,
        todoId: todo.id,
        createdAt: Date.now(),
      });

      return { success: true, tmux_target: tmuxTarget, todo_id: todo.id };
    } catch (err) {
      return reply.status(500).send({ error: `Failed to launch session: ${err.message}` });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Web Push subscriptions
  // ──────────────────────────────────────────────

  fastify.get('/api/push/vapid-public-key', async () => ({
    publicKey: config.vapidPublicKey,
    enabled: config.pushEnabled,
  }));

  fastify.post('/api/push/subscribe', async (request, reply) => {
    if (!config.pushEnabled) return reply.status(503).send({ error: 'Push not configured' });
    const { endpoint, keys } = request.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.status(400).send({ error: 'Invalid subscription object' });
    }
    db.upsertPushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
    return reply.status(201).send({ ok: true });
  });

  fastify.delete('/api/push/unsubscribe', async (request, reply) => {
    const { endpoint } = request.body || {};
    if (!endpoint) return reply.status(400).send({ error: 'Missing endpoint' });
    db.deletePushSubscription(endpoint);
    return reply.status(204).send();
  });

  // Periodically clean up stale pending labels (if SessionStart hook never fired)
  const labelCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [target, entry] of pendingLabels) {
      if (now - entry.createdAt > PENDING_LABEL_TTL_MS) pendingLabels.delete(target);
    }
  }, PENDING_LABEL_TTL_MS);
  labelCleanupTimer.unref(); // don't keep process alive for cleanup

  // SPA fallback — serve index.html for non-API/WS routes
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });

  return fastify;
}

// ──────────────────────────────────────────────
// Start server when run directly (not imported by tests)
// ──────────────────────────────────────────────

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = await buildServer();

  // Zombie cleanup on startup: mark sessions as stopped if their tmux target
  // is gone and they haven't had a heartbeat in 4+ hours.
  {
    const stopped = cleanupZombies();
    if (stopped.length > 0) console.log(`[startup] Marked ${stopped.length} zombie session(s) as stopped`);
  }

  // Auto-cleanup: delete stopped sessions older than configured days
  if (config.sessionCleanupDays > 0) {
    const runCleanup = () => {
      const result = db.deleteStoppedSessionsOlderThan(config.sessionCleanupDays);
      if (result.changes > 0) {
        console.log(`[cleanup] Deleted ${result.changes} stopped session(s) older than ${config.sessionCleanupDays} days`);
        // Cascade: clean up orphaned rows from related tables
        db.default.prepare('DELETE FROM file_edits WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
        db.default.prepare('DELETE FROM todos WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT session_id FROM sessions)').run();
      }
    };
    runCleanup(); // run once on startup
    setInterval(runCleanup, 24 * 60 * 60 * 1000); // then daily
  }

  // Usage stats heartbeat (daily)
  if (config.telemetryEnabled && config.telemetryUrl) {
    const LOCAL_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
    let gitUser = '';
    try { gitUser = execSync('git config user.name', { encoding: 'utf-8', timeout: 3000 }).trim(); } catch {}

    const sendHeartbeat = () => {
      const sessions = db.getActiveSessions();
      const payload = JSON.stringify({
        type: 'heartbeat',
        git_user: gitUser,
        hostname: hostname(),
        version: LOCAL_VERSION,
        sessions: sessions.length,
        dashboard_open: dashboardClients.size > 0,
        uptime_hours: Math.round(process.uptime() / 3600),
      });
      fetch(config.telemetryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    };

    // First heartbeat after 60s, then every 24h
    setTimeout(sendHeartbeat, 60_000);
    setInterval(sendHeartbeat, 24 * 60 * 60 * 1000);
  }

  // Graceful shutdown: kill PTY bridges, close DB
  const closeGracefully = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down...`);
    ptyManager.shutdown();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => closeGracefully('SIGINT'));
  process.on('SIGTERM', () => closeGracefully('SIGTERM'));

  await server.listen({ port: config.port, host: config.host });
  console.log(`Control Center running at http://localhost:${config.port}`);
}
