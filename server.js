import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import config from './config.js';
import * as db from './db.js';
import * as ptyManager from './pty-manager.js';
import * as notifier from './notifier.js';

const PROJECTS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'projects.json');

// ──────────────────────────────────────────────
// Transcript helpers
// ──────────────────────────────────────────────

function readTranscriptTail(filePath, maxBytes = 32768) {
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

function getLastAssistantText(filePath) {
  const turns = readTranscriptTail(filePath, 16384);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].type !== 'assistant') continue;
    const content = turns[i].message?.content;
    if (!Array.isArray(content)) continue;
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock?.text?.trim()) return textBlock.text.trim().slice(0, 300);
  }
  return null;
}

// ──────────────────────────────────────────────
// AI summary (DeepSeek)
// ──────────────────────────────────────────────

const summaryCache = new Map(); // session_id → { summary, generatedAt }

async function generateSummary(transcript) {
  const turns = readTranscriptTail(transcript, 32768);
  if (turns.length === 0) return null;

  const messages = [];
  for (const turn of turns.slice(-20)) {
    const role = turn.type === 'user' ? 'user' : 'assistant';
    const c = turn.message?.content;
    let content = '';
    if (typeof c === 'string') {
      content = c;
    } else if (Array.isArray(c)) {
      content = c.map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[${b.name}: ${JSON.stringify(b.input || {}).slice(0, 80)}]`;
        return '';
      }).filter(Boolean).join(' ');
    }
    if (content.trim()) messages.push({ role, content: content.slice(0, 600) });
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
          content: 'You monitor AI coding sessions. Given the recent conversation, write 2-3 terse sentences: (1) what task is being worked on, (2) current status/what just happened, (3) whether user input is needed. Be specific. No headers.',
        },
        ...messages,
      ],
      max_tokens: 120,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error(`DeepSeek API error: ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ──────────────────────────────────────────────
// Auto-approve permissions
// ──────────────────────────────────────────────

function shouldAutoApprove(payload) {
  const toolName = payload.tool_name || '';
  if (config.autoApproveTools.includes(toolName)) return true;

  if (toolName === 'Bash' && config.autoApproveBashPattern) {
    try {
      const input = typeof payload.tool_input === 'string'
        ? JSON.parse(payload.tool_input)
        : (payload.tool_input || {});
      const command = (input.command || '').trimStart();
      if (command && new RegExp(config.autoApproveBashPattern).test(command)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function readProjects() {
  try { return JSON.parse(readFileSync(PROJECTS_PATH, 'utf8')); } catch { return []; }
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
// Build server (exported for tests)
// ──────────────────────────────────────────────

export async function buildServer(opts = {}) {
  const fastify = Fastify({ logger: opts.logger ?? true });

  // ──────────────────────────────────────────────
  // Plugins (registration order matters)
  // ──────────────────────────────────────────────

  await fastify.register(fastifyWebSocket);

  await fastify.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  // ──────────────────────────────────────────────
  // Pending labels from /api/sessions/launch
  // Maps tmux_target → label, consumed when SessionStart auto-links
  // ──────────────────────────────────────────────

  const pendingLabels = new Map();     // tmux_target → { label, createdAt }
  const PENDING_LABEL_TTL_MS = 60_000; // Auto-expire after 60s

  // ──────────────────────────────────────────────
  // WebSocket: Dashboard event stream
  // ──────────────────────────────────────────────

  const dashboardClients = new Set();

  fastify.get('/ws/events', { websocket: true }, (socket, request) => {
    dashboardClients.add(socket);

    // Send full current state on connect
    const sessions = db.getAllSessions();
    const recentEvents = db.getRecentEvents(50);
    socket.send(JSON.stringify({ type: 'init', sessions, recentEvents }));

    socket.on('close', () => dashboardClients.delete(socket));
    socket.on('error', () => dashboardClients.delete(socket));
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

  fastify.post('/api/hooks', async (request, reply) => {
    const payload = request.body;
    if (!payload || !payload.event || !payload.session_id) {
      return reply.status(400).send({ error: 'Missing event or session_id' });
    }

    const { event, session_id } = payload;

    // 1. Upsert session on SessionStart
    if (event === 'SessionStart') {
      db.upsertSession({
        session_id,
        cwd: payload.cwd,
        model: payload.model,
        transcript: payload.transcript_path,
      });
      // Auto-link tmux target by matching cwd, and apply any pending label from launch
      // Prefer the tmux session name reported by the hook (unambiguous),
      // fall back to CWD matching when Claude Code is not running inside tmux.
      const tmuxSessions = ptyManager.listTmuxSessions();
      const match = payload.tmux_session
        ? tmuxSessions.find(ts => ts.name === payload.tmux_session)
        : tmuxSessions.find(ts => ts.cwd === payload.cwd);
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
        });
        if (pending) pendingLabels.delete(match.name);
      }
    }

    // 2. Update session status (with auto-approve logic for PermissionRequest)
    let autoApproved = false;
    if (event === 'Stop') {
      db.updateStatus(session_id, 'stopped');
    } else if (event === 'PermissionRequest') {
      if (shouldAutoApprove(payload)) {
        const sess = db.getSession(session_id);
        if (sess?.tmux_target && /^[a-zA-Z0-9_-]+$/.test(sess.tmux_target)) {
          try {
            const buf = `cc-ap-${Date.now()}`;
            execFileSync('tmux', ['load-buffer', '-b', buf, '-'], { input: '1\n', timeout: 5_000 });
            execFileSync('tmux', ['paste-buffer', '-t', sess.tmux_target, '-b', buf, '-d'], { timeout: 5_000 });
            autoApproved = true;
          } catch { /* auto-approve failed — fall through to normal waiting */ }
        }
      }
      if (!autoApproved) {
        db.updateStatus(session_id, 'waiting_permission');
      }
    }

    // 3. Handle heartbeats (lightweight — skip event log)
    if (event === 'Heartbeat') {
      // Ensure session row exists for FK (uses INSERT ... ON CONFLICT DO NOTHING
      // so it won't overwrite status on existing sessions — avoids resetting
      // 'waiting_permission' back to 'active' if a late heartbeat arrives)
      db.ensureSession(session_id);
      db.upsertHeartbeat({ session_id, tool_name: payload.tool_name });
      broadcastEvent({ event, session_id, tool_name: payload.tool_name, timestamp: payload.timestamp });
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
    });
    if (session) broadcastSessionUpdate(session);

    // 6. Notify via OpenClaw for high-priority events, but only if the session
    // has been idle for 30+ seconds (skip when the user is actively watching).
    // Also skip auto-approved permissions — they resolved silently.
    if (!autoApproved && (event === 'Stop' || event === 'PermissionRequest')) {
      const lastHb = session?.last_heartbeat;
      const msAgo = lastHb
        ? Date.now() - new Date(lastHb.replace(' ', 'T') + 'Z').getTime()
        : Infinity;
      if (msAgo >= 30_000) {
        notifier.send(payload).catch(() => {});
      }
    }

    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────
  // REST: Sessions CRUD
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions', async () => db.getAllSessions());

  fastify.get('/api/sessions/:id', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return session;
  });

  fastify.patch('/api/sessions/:id', async (request, reply) => {
    const { label, tmux_target, project } = request.body || {};
    if (label !== undefined && (typeof label !== 'string' || label.length > 256)) {
      return reply.status(400).send({ error: 'Label must be a string under 256 characters' });
    }
    if (tmux_target !== undefined && (typeof tmux_target !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tmux_target))) {
      return reply.status(400).send({ error: 'Invalid tmux target name' });
    }
    if (project !== undefined && (typeof project !== 'string' || project.length > 128)) {
      return reply.status(400).send({ error: 'Project must be a string under 128 characters' });
    }
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    db.updateSession(request.params.id, { label, tmux_target, project });
    const updated = db.getSession(request.params.id);
    broadcastSessionUpdate(updated);
    return updated;
  });

  // ──────────────────────────────────────────────
  // REST: Launch new session
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/launch', async (request, reply) => {
    const { label, cwd, initialPrompt, project } = request.body || {};

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

    try {
      const tmuxTarget = ptyManager.createTmuxSession({
        label,
        cwd: cwd || process.env.HOME,
        initialPrompt,
      });
      // Store label so the SessionStart hook handler can apply it when auto-linking
      if (label || project) pendingLabels.set(tmuxTarget, { label, project: project || undefined, createdAt: Date.now() });
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
      execFileSync('tmux', ['load-buffer', '-b', buf, '-'], { input: text + '\n', timeout: 10_000 });
      execFileSync('tmux', ['paste-buffer', '-t', target, '-b', buf, '-d'], { timeout: 10_000 });
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
    return reply.status(204).send();
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
  // REST: AI summary (DeepSeek, 90s cache)
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/summary', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!config.deepseekApiKey || !session.transcript) return { summary: null };

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

  fastify.get('/api/info', async () => ({ serverCwd: __dirname }));

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

  // Periodically clean up stale pending labels (if SessionStart hook never fired)
  const labelCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [target, entry] of pendingLabels) {
      if (now - entry.createdAt > PENDING_LABEL_TTL_MS) pendingLabels.delete(target);
    }
  }, PENDING_LABEL_TTL_MS);
  labelCleanupTimer.unref(); // don't keep process alive for cleanup

  return fastify;
}

// ──────────────────────────────────────────────
// Start server when run directly (not imported by tests)
// ──────────────────────────────────────────────

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = await buildServer();

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
