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
const editSessionModal = document.getElementById('edit-session-modal');
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
          // Set active unless session is stopped — a heartbeat means a tool ran,
          // so permission was granted (clears waiting_permission). But don't
          // revive stopped sessions from stale heartbeats.
          if (s.status !== 'stopped') {
            s.status = 'active';
          }
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

function renderSessionCard(s) {
  const label = s.label || s.session_id.slice(0, 12);
  const statusClass = getStatusClass(s);
  const statusText = getStatusText(s);
  const detail = getDetailText(s);
  const isSelected = s.session_id === selectedSessionId;
  const safeId = escapeHtml(s.session_id);
  const isStopped = s.status === 'stopped';
  return `
    <div class="session-card status-${statusClass} ${isSelected ? 'selected' : ''}" data-id="${safeId}">
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
        <button class="btn-edit-session" data-id="${safeId}">Edit</button>
        ${(!isStopped || !!s.tmux_target) ? `<button class="btn-kill-session" data-id="${safeId}">Kill</button>` : ''}
      </div>
    </div>
  `;
}

function renderSessions() {
  if (sessions.length === 0) {
    sessionsGrid.innerHTML = '<div class="no-sessions">No sessions yet. Start Claude Code in a tmux pane, or click "+ New Session".</div>';
    return;
  }

  const active = sessions.filter(s => s.status !== 'stopped');
  const stopped = sessions
    .filter(s => s.status === 'stopped')
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

  let html = '';

  // Active sessions grouped by project
  if (active.length > 0) {
    const byProject = {};
    for (const s of active) {
      const group = s.project || '';
      if (!byProject[group]) byProject[group] = [];
      byProject[group].push(s);
    }
    const groups = Object.keys(byProject).sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    });
    for (const group of groups) {
      if (group) {
        html += `<div class="project-group">
          <div class="project-heading">${escapeHtml(group)}</div>
          <div class="project-sessions">${byProject[group].map(renderSessionCard).join('')}</div>
        </div>`;
      } else {
        html += `<div class="project-sessions">${byProject[group].map(renderSessionCard).join('')}</div>`;
      }
    }
  } else {
    html += '<div class="no-sessions">No active sessions. Click "+ New Session" to start one.</div>';
  }

  // Stopped sessions — collapsible section at the bottom, most recent first
  if (stopped.length > 0) {
    html += `
      <details class="stopped-section">
        <summary class="stopped-heading">Closed Sessions (${stopped.length})</summary>
        <div class="project-sessions stopped-sessions">
          ${stopped.map(renderSessionCard).join('')}
        </div>
      </details>`;
  }

  sessionsGrid.innerHTML = html;

  // Attach click handlers
  sessionsGrid.querySelectorAll('.btn-connect').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openTerminal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-link-tmux').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); showLinkTmuxModal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-edit-session').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); showEditSessionModal(btn.dataset.id); });
  });

  sessionsGrid.querySelectorAll('.btn-kill-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = sessions.find(s => s.session_id === btn.dataset.id);
      const name = s?.label || btn.dataset.id.slice(0, 8);
      if (!confirm(`Kill session "${name}"? This will stop the tmux session.`)) return;
      try {
        const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/kill`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert(`Kill failed: ${body.error || 'Unknown error'}`);
        }
      } catch { alert('Kill failed: network error'); }
    });
  });

  sessionsGrid.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => {
      const s = sessions.find(s => s.session_id === card.dataset.id);
      if (s?.tmux_target) openTerminal(card.dataset.id);
    });
  });
}

// ──────────────────────────────────────────────
// Edit session modal (label + project)
// ──────────────────────────────────────────────

let editTargetSessionId = null;

function showEditSessionModal(sessionId) {
  editTargetSessionId = sessionId;
  const s = sessions.find(s => s.session_id === sessionId);
  document.getElementById('es-label').value = s?.label || '';
  document.getElementById('es-project').value = s?.project || '';

  // Populate project datalist from known projects
  const projects = [...new Set(sessions.map(s => s.project).filter(Boolean))];
  document.getElementById('es-project-list').innerHTML = projects.map(p => `<option value="${escapeHtml(p)}">`).join('');

  editSessionModal.showModal();
}

document.getElementById('btn-cancel-edit').addEventListener('click', () => editSessionModal.close());

document.getElementById('btn-save-edit').addEventListener('click', async () => {
  const label = document.getElementById('es-label').value.trim();
  const project = document.getElementById('es-project').value.trim();
  const sid = editTargetSessionId;
  if (!sid) return;
  editSessionModal.close();
  try {
    const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || undefined, project: project }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Save failed: ${body.error || 'Unknown error'}`);
    }
  } catch { alert('Save failed: network error'); }
});

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
    // session_cwd comes from init (DB JOIN alias), cwd from broadcast events
    const label = ev.label || ev.session_cwd || ev.cwd || ev.session_id?.slice(0, 8) || '?';
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

  // Tear down existing terminal resources without hiding the panel
  // (avoids a visual flicker from hide → immediate show)
  window.removeEventListener('resize', handleWindowResize);
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  if (term) { term.dispose(); term = null; }
  fitAddon = null;

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

  // Double rAF: the first rAF fires before the browser has finished laying out
  // the newly-visible panel; the second fires after layout+paint, so the
  // container has real pixel dimensions when fitAddon.fit() is called.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (fitAddon) fitAddon.fit();
    if (term) term.focus();
  }));

  // Connect WebSocket to terminal relay
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(`${protocol}//${location.host}/ws/terminal/${encodeURIComponent(sessionId)}`);

  termWs.onopen = () => {
    // The initial fitAddon.fit() ran in rAF before the WebSocket was open,
    // so any resize message was dropped. Use proposeDimensions() here instead
    // of fit() — it returns the desired size without going through onResize,
    // so we always send even if the dimensions haven't changed.
    if (fitAddon && termWs?.readyState === 1) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        termWs.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    }
  };

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

const nsCwdPreset = document.getElementById('ns-cwd-preset');
const nsCwdCustom = document.getElementById('ns-cwd');

let projectPresets = [];

nsCwdPreset.addEventListener('change', () => {
  if (nsCwdPreset.value === '__custom__') {
    nsCwdCustom.classList.remove('hidden');
    nsCwdCustom.focus();
  } else {
    nsCwdCustom.classList.add('hidden');
    nsCwdCustom.value = '';
  }
});

async function loadProjectPresets() {
  try {
    const res = await fetchWithTimeout('/api/projects');
    projectPresets = await res.json();
    nsCwdPreset.innerHTML = projectPresets.map(p =>
      `<option value="${escapeHtml(p.cwd)}">${escapeHtml(p.name)}</option>`
    ).join('') + '<option value="__custom__">Custom path…</option>';
  } catch {
    projectPresets = [];
    nsCwdPreset.innerHTML = '<option value="__custom__">Custom path…</option>';
    nsCwdCustom.classList.remove('hidden');
  }
  // Reset custom input visibility
  nsCwdCustom.classList.toggle('hidden', nsCwdPreset.value !== '__custom__');
}

document.getElementById('btn-new-session').addEventListener('click', async () => {
  await loadProjectPresets();
  newSessionModal.showModal();
});

document.getElementById('btn-cancel-modal').addEventListener('click', () => {
  newSessionModal.close();
});

// FIXED: Use button click handler instead of form submit to avoid dialog auto-close on validation failure
document.getElementById('btn-launch').addEventListener('click', async () => {
  const launchBtn = document.getElementById('btn-launch');
  const label = document.getElementById('ns-label').value.trim();
  const presetVal = document.getElementById('ns-cwd-preset').value;
  const cwd = (presetVal === '__custom__' || !presetVal)
    ? document.getElementById('ns-cwd').value.trim()
    : presetVal;
  // Derive project name from the selected preset (empty for custom path)
  const project = (presetVal && presetVal !== '__custom__')
    ? (projectPresets.find(p => p.cwd === presetVal)?.name || undefined)
    : undefined;
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
        project: project || undefined,
        cwd: cwd || undefined,
        initialPrompt: initialPrompt || undefined,
      }),
    }, 30000);
    if (!res.ok) throw new Error((await res.json()).error);
    newSessionModal.close();
    // Reset fields
    document.getElementById('ns-label').value = '';
    document.getElementById('ns-cwd').value = '';
    document.getElementById('ns-cwd-preset').selectedIndex = 0;
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

async function linkTmuxTarget(sessionId, tmuxName) {
  const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tmux_target: tmuxName }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
}

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

  // Auto-link if exactly one tmux session matches this session's CWD
  const session = sessions.find(s => s.session_id === sessionId);
  if (session?.cwd) {
    const matches = tmuxSessions.filter(ts => ts.cwd === session.cwd);
    if (matches.length === 1) {
      try {
        await linkTmuxTarget(sessionId, matches[0].name);
      } catch (err) {
        alert(`Failed to link tmux session: ${err.message}`);
      }
      return; // no modal needed
    }
  }

  // Fall back to picker
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
          await linkTmuxTarget(linkTargetSessionId, opt.dataset.name);
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
// Terminal scroll: intercept mouse wheel to scroll the xterm viewport
// instead of forwarding events to the terminal app (which would send
// cursor-up/down key presses into the running Claude Code session).
// ──────────────────────────────────────────────

// capture: true ensures this fires before xterm's own wheel handler,
// which in application/alternate-screen mode converts scroll to cursor keys.
terminalContainer.addEventListener('wheel', (e) => {
  if (!term) return;
  e.preventDefault();
  e.stopPropagation();
  term.scrollLines(e.deltaY > 0 ? 3 : -3);
}, { passive: false, capture: true });

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

connectDashboardWS();
