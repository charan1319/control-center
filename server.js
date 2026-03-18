import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import config from './config.js';
import * as db from './db.js';
import * as ptyManager from './pty-manager.js';
import * as notifier from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      // Auto-link tmux target by matching cwd
      const tmuxSessions = ptyManager.listTmuxSessions();
      const match = tmuxSessions.find(ts => ts.cwd === payload.cwd);
      if (match) {
        db.updateSession(session_id, { tmux_target: match.name });
      }
    }

    // 2. Update session status
    if (event === 'Stop') {
      db.updateStatus(session_id, 'stopped');
    } else if (event === 'PermissionRequest') {
      db.updateStatus(session_id, 'waiting_permission');
    }

    // 3. Handle heartbeats (lightweight — skip event log)
    if (event === 'Heartbeat') {
      db.upsertHeartbeat({ session_id, tool_name: payload.tool_name });
      // Ensure session exists even if we missed SessionStart
      db.upsertSession({ session_id, cwd: null, model: null, transcript: null });
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

    // 6. Notify via OpenClaw for high-priority events
    if (event === 'Stop' || event === 'PermissionRequest') {
      notifier.send(payload).catch(() => {});
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
    const { label, tmux_target } = request.body || {};
    const session = db.getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    db.updateSession(request.params.id, { label, tmux_target });
    const updated = db.getSession(request.params.id);
    broadcastSessionUpdate(updated);
    return updated;
  });

  // ──────────────────────────────────────────────
  // REST: Launch new session
  // ──────────────────────────────────────────────

  fastify.post('/api/sessions/launch', async (request, reply) => {
    const { label, cwd, initialPrompt } = request.body || {};
    try {
      const tmuxTarget = ptyManager.createTmuxSession({
        label,
        cwd: cwd || process.env.HOME,
        initialPrompt,
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

    try {
      const target = session.tmux_target;
      // Validate tmux target to prevent injection
      if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
        return reply.status(400).send({ error: 'Invalid tmux target' });
      }
      // Use load-buffer from stdin + paste-buffer to avoid any shell escaping issues
      execSync(`tmux load-buffer -`, { input: text + '\n' });
      execSync(`tmux paste-buffer -t ${target}`);
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────
  // REST: Events
  // ──────────────────────────────────────────────

  fastify.get('/api/sessions/:id/events', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    return db.getSessionEvents(request.params.id, limit, offset);
  });

  fastify.get('/api/events', async (request) => {
    const limit = parseInt(request.query.limit || '100', 10);
    return db.getRecentEvents(limit);
  });

  // ──────────────────────────────────────────────
  // REST: tmux discovery
  // ──────────────────────────────────────────────

  fastify.get('/api/tmux-sessions', async () => ptyManager.listTmuxSessions());

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
