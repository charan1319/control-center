// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

let sessions = [];
let recentEvents = [];
let selectedSessionId = null;
let ws = null;
let termWs = null;
let term = null;
let fitAddon = null;

// ──────────────────────────────────────────────
// DOM references
// ──────────────────────────────────────────────

const sessionsGrid = document.getElementById('sessions-grid');
const eventsList = document.getElementById('events-list');
const terminalPanel = document.getElementById('terminal-panel');
const terminalTitle = document.getElementById('terminal-title');
const terminalContainer = document.getElementById('terminal-container');
const connectionStatus = document.getElementById('connection-status');
const newSessionModal = document.getElementById('new-session-modal');
const linkTmuxModal = document.getElementById('link-tmux-modal');
const tmuxSessionList = document.getElementById('tmux-session-list');

// ──────────────────────────────────────────────
// WebSocket — dashboard event stream
// ──────────────────────────────────────────────

let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;

function connectDashboardWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connecting/connected
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/events`);

  ws.onopen = () => {
    connectionStatus.className = 'status-dot connected';
    connectionStatus.title = 'Connected';
    wsReconnectDelay = 1000; // Reset backoff on successful connect
  };

  ws.onclose = () => {
    connectionStatus.className = 'status-dot disconnected';
    connectionStatus.title = `Disconnected — reconnecting in ${Math.round(wsReconnectDelay / 1000)}s...`;
    setTimeout(connectDashboardWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      console.warn('Received malformed WebSocket message, skipping');
      return;
    }

    if (msg.type === 'init') {
      sessions = msg.sessions || [];
      recentEvents = msg.recentEvents || [];
      renderSessions();
      renderEvents();
      return;
    }

    if (msg.type === 'session_update') {
      const idx = sessions.findIndex(s => s.session_id === msg.session.session_id);
      if (idx >= 0) sessions[idx] = msg.session;
      else sessions.unshift(msg.session);
      // Keep terminal title in sync when the selected session is renamed
      if (msg.session.session_id === selectedSessionId) {
        terminalTitle.textContent = msg.session.label || msg.session.session_id.slice(0, 12);
      }
      renderSessions();
      return;
    }

    if (msg.type === 'event') {
      if (msg.event === 'Heartbeat') {
        const s = sessions.find(s => s.session_id === msg.session_id);
        if (s) {
          s.last_tool = msg.tool_name;
          s.last_heartbeat = msg.timestamp || new Date().toISOString();
          s.status = 'active';
          renderSessions();
        }
        return;
      }

      recentEvents.unshift(msg);
      if (recentEvents.length > 200) recentEvents.length = 200;
      renderEvents();

      const s = sessions.find(s => s.session_id === msg.session_id);
      if (s) {
        if (msg.event === 'Stop') s.status = 'stopped';
        else if (msg.event === 'PermissionRequest') s.status = 'waiting_permission';
        else if (msg.event === 'SessionStart') s.status = 'active';
        renderSessions();
      }
    }
  };
}

// ──────────────────────────────────────────────
// Render: Session cards
// ──────────────────────────────────────────────

function renderSessions() {
  if (sessions.length === 0) {
    sessionsGrid.innerHTML = '<div class="no-sessions">No sessions yet. Start Claude Code in a tmux pane, or click "+ New Session".</div>';
    return;
  }

  sessionsGrid.innerHTML = sessions.map(s => {
    const label = s.label || s.session_id.slice(0, 12);
    const statusClass = getStatusClass(s);
    const statusText = getStatusText(s);
    const detail = getDetailText(s);
    const isSelected = s.session_id === selectedSessionId;

    const safeId = escapeHtml(s.session_id);
    return `
      <div class="session-card ${isSelected ? 'selected' : ''}" data-id="${safeId}">
        <div class="card-header">
          <span class="indicator ${statusClass}"></span>
          <span class="card-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        </div>
        <div class="card-status">${statusText}</div>
        ${detail ? `<div class="card-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
        <div class="card-actions">
          ${s.tmux_target
            ? `<button class="btn-connect" data-id="${safeId}">Terminal</button>`
            : `<button class="btn-link-tmux" data-id="${safeId}">Link tmux</button>`}
          <button class="btn-edit-label" data-id="${safeId}">Rename</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers
  sessionsGrid.querySelectorAll('.btn-connect').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openTerminal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-link-tmux').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); showLinkTmuxModal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-edit-label').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = btn.dataset.id;
      const current = sessions.find(s => s.session_id === sid)?.label || '';
      const newLabel = prompt('Session label:', current);
      if (newLabel !== null) {
        fetchWithTimeout(`/api/sessions/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
        }).then(res => {
          if (!res.ok) res.json().then(body => alert(`Rename failed: ${body.error || 'Unknown error'}`));
        }).catch(() => alert('Rename failed: network error'));
      }
    });
  });

  sessionsGrid.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => {
      const s = sessions.find(s => s.session_id === card.dataset.id);
      if (s?.tmux_target) openTerminal(card.dataset.id);
    });
  });
}

function getStatusClass(session) {
  if (session.status === 'waiting_permission') return 'waiting';
  if (session.status === 'stopped') return 'stopped';
  if (session.status === 'active') {
    if (session.last_heartbeat) {
      // SQLite datetime('now') produces UTC without T/Z. Normalize for Date parsing.
      const ts = session.last_heartbeat.includes('T') ? session.last_heartbeat : session.last_heartbeat + 'Z';
      const age = (Date.now() - new Date(ts).getTime()) / 1000;
      if (age > 120) return 'idle';
    }
    return 'active';
  }
  return 'stopped';
}

function getStatusText(session) {
  const cls = getStatusClass(session);
  if (cls === 'waiting') return 'Waiting for permission';
  if (cls === 'active') return `Active${session.last_heartbeat ? ' · ' + timeAgo(session.last_heartbeat) : ''}`;
  if (cls === 'idle') return `Idle · ${timeAgo(session.last_heartbeat)}`;
  return `Stopped${session.updated_at ? ' · ' + timeAgo(session.updated_at) : ''}`;
}

function getDetailText(session) {
  if (session.last_tool) return session.last_tool;
  if (session.cwd) return session.cwd;
  return '';
}

// ──────────────────────────────────────────────
// Render: Event log
// ──────────────────────────────────────────────

function renderEvents() {
  if (recentEvents.length === 0) {
    eventsList.innerHTML = '<div class="empty-events">No events yet.</div>';
    return;
  }

  eventsList.innerHTML = recentEvents.slice(0, 100).map(ev => {
    const time = ev.created_at || ev.timestamp || '';
    const timeStr = time ? formatTime(time) : '--:--';
    const label = ev.label || ev.session_cwd || ev.session_id?.slice(0, 8) || '?';
    const detail = getEventDetail(ev);
    const isPermission = ev.event === 'PermissionRequest';

    return `
      <div class="event-row ${isPermission ? 'permission-request' : ''}">
        <span class="ev-time">${timeStr}</span>
        <span class="ev-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <span class="ev-event ${escapeHtml(ev.event)}">${escapeHtml(ev.event)}</span>
        <span class="ev-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </div>
    `;
  }).join('');
}

function getEventDetail(ev) {
  if (ev.tool_name && ev.tool_input) {
    try {
      const input = typeof ev.tool_input === 'string' ? JSON.parse(ev.tool_input) : ev.tool_input;
      if (input.command) return `${ev.tool_name}: ${input.command.slice(0, 60)}`;
      if (input.file_path) return `${ev.tool_name}: ${input.file_path}`;
    } catch { /* ignore parse errors */ }
    return ev.tool_name;
  }
  if (ev.tool_name) return ev.tool_name;
  if (ev.cwd) return ev.cwd;
  return '';
}

// ──────────────────────────────────────────────
// Terminal connection
// ──────────────────────────────────────────────

function openTerminal(sessionId) {
  selectedSessionId = sessionId;
  renderSessions();
  closeTerminal(true); // Close existing but keep selectedSessionId

  const session = sessions.find(s => s.session_id === sessionId);
  terminalTitle.textContent = session?.label || sessionId.slice(0, 12);
  terminalPanel.classList.remove('hidden');

  // Create xterm.js instance
  // The CDN exposes Terminal as a global from @xterm/xterm
  term = new Terminal({
    fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace',
    fontSize: 14,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
    },
    cursorBlink: true,
    scrollback: 5000,
  });

  // The CDN exposes FitAddon as a global namespace with a FitAddon class inside
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch { /* addon may not have loaded */ }

  term.open(terminalContainer);

  // Small delay to ensure the container has dimensions before fitting
  requestAnimationFrame(() => {
    if (fitAddon) fitAddon.fit();
  });

  // Connect WebSocket to terminal relay
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);

  termWs.onmessage = (e) => {
    if (!term) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') {
      term.write(msg.data);
    } else if (msg.type === 'exit') {
      term.write('\r\n\x1b[31m[tmux session exited]\x1b[0m\r\n');
    } else if (msg.type === 'error') {
      term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    }
  };

  termWs.onclose = () => {
    if (term) term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
  };

  term.onData((data) => {
    if (termWs?.readyState === 1) {
      termWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (termWs?.readyState === 1) {
      termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  window.addEventListener('resize', handleWindowResize);
}

function closeTerminal(keepSelection) {
  window.removeEventListener('resize', handleWindowResize);
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  if (term) { term.dispose(); term = null; }
  fitAddon = null;
  terminalPanel.classList.add('hidden');
  if (!keepSelection) {
    selectedSessionId = null;
    renderSessions();
  }
}

function handleWindowResize() {
  if (fitAddon && term) {
    try { fitAddon.fit(); } catch {}
  }
}

// ──────────────────────────────────────────────
// New Session modal
// ──────────────────────────────────────────────

document.getElementById('btn-new-session').addEventListener('click', () => {
  newSessionModal.showModal();
});

document.getElementById('btn-cancel-modal').addEventListener('click', () => {
  newSessionModal.close();
});

// FIXED: Use button click handler instead of form submit to avoid dialog auto-close on validation failure
document.getElementById('btn-launch').addEventListener('click', async () => {
  const launchBtn = document.getElementById('btn-launch');
  const label = document.getElementById('ns-label').value.trim();
  const cwd = document.getElementById('ns-cwd').value.trim();
  const initialPrompt = document.getElementById('ns-prompt').value.trim();

  if (!label) {
    document.getElementById('ns-label').focus();
    return;
  }

  launchBtn.disabled = true;
  launchBtn.textContent = 'Launching...';
  try {
    const res = await fetchWithTimeout('/api/sessions/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: label || undefined,
        cwd: cwd || undefined,
        initialPrompt: initialPrompt || undefined,
      }),
    }, 30000);
    if (!res.ok) throw new Error((await res.json()).error);
    newSessionModal.close();
    // Reset fields
    document.getElementById('ns-label').value = '';
    document.getElementById('ns-cwd').value = '';
    document.getElementById('ns-prompt').value = '';
  } catch (err) {
    alert(`Failed to launch: ${err.message}`);
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch';
  }
});

// ──────────────────────────────────────────────
// Link tmux modal
// ──────────────────────────────────────────────

let linkTargetSessionId = null;

async function showLinkTmuxModal(sessionId) {
  linkTargetSessionId = sessionId;
  let tmuxSessions;
  try {
    const res = await fetchWithTimeout('/api/tmux-sessions');
    tmuxSessions = await res.json();
  } catch {
    alert('Failed to fetch tmux sessions. Is the server running?');
    return;
  }

  if (tmuxSessions.length === 0) {
    tmuxSessionList.innerHTML = '<div style="color: var(--text-muted); padding: 12px;">No tmux sessions found. Create one with: tmux new-session -d -s cc-0</div>';
  } else {
    tmuxSessionList.innerHTML = tmuxSessions.map(ts => `
      <div class="tmux-option" data-name="${escapeHtml(ts.name)}">
        <div class="tmux-name">${escapeHtml(ts.name)}</div>
        <div class="tmux-cwd">${escapeHtml(ts.cwd || 'unknown')}</div>
      </div>
    `).join('');

    tmuxSessionList.querySelectorAll('.tmux-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        try {
          const res = await fetchWithTimeout(`/api/sessions/${linkTargetSessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tmux_target: opt.dataset.name }),
          });
          if (!res.ok) throw new Error((await res.json()).error);
        } catch (err) {
          alert(`Failed to link tmux session: ${err.message}`);
        }
        linkTmuxModal.close();
      });
    });
  }

  linkTmuxModal.showModal();
}

document.getElementById('btn-cancel-link').addEventListener('click', () => {
  linkTmuxModal.close();
});

// Close terminal button
document.getElementById('btn-close-terminal').addEventListener('click', () => closeTerminal(false));

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

/**
 * Fetch with timeout. Throws on timeout or network failure.
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (isNaN(seconds)) return '';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────
// Auto-refresh heartbeat ages every 15s
// ──────────────────────────────────────────────

setInterval(() => renderSessions(), 15_000);

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

connectDashboardWS();
