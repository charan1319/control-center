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
let termReconnectTimer = null;
let termReconnectAttempts = 0;
// Tracks which session's history fetch is in-flight (null = none).
// Using session ID instead of a boolean prevents a race where session A's
// finally-block clears the flag while session B's fetch is running.
let historyFetchSessionId = null;
let historyScrolledUp = false;
let historyLastFailTime = 0; // timestamp of last failed auto-fetch (for cooldown)

let serverInfo = { serverCwd: null };
let previewCache = new Map();  // session_id → { text, fetchedAt }
let summaryCache = new Map();  // session_id → { summary, fetchedAt }
let stats = null;

// ──────────────────────────────────────────────
// DOM references
// ──────────────────────────────────────────────

const summaryBar = document.getElementById('summary-bar');
const statsBar = document.getElementById('stats-bar');
const sessionsGrid = document.getElementById('sessions-grid');
const eventsList = document.getElementById('events-list');
const terminalPanel = document.getElementById('terminal-panel');
const terminalTitle = document.getElementById('terminal-title');
const terminalContainer = document.getElementById('terminal-container');
const connectionStatus = document.getElementById('connection-status');
const connectionBanner = document.getElementById('connection-banner');
const toastContainer = document.getElementById('toast-container');
const newSessionModal = document.getElementById('new-session-modal');
const editSessionModal = document.getElementById('edit-session-modal');
const linkTmuxModal = document.getElementById('link-tmux-modal');
const tmuxSessionList = document.getElementById('tmux-session-list');

// ──────────────────────────────────────────────
// Toast notifications
// ──────────────────────────────────────────────

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);
  // Auto-remove after animation ends (4.5s total: 4.2s visible + 0.3s fade)
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4500);
}

// ──────────────────────────────────────────────
// WebSocket — dashboard event stream
// ──────────────────────────────────────────────

let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;
let wsWasConnected = false; // tracks if we ever had a successful connection

function connectDashboardWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connecting/connected
  }

  // Show reconnecting state if this is a reconnection attempt
  if (wsWasConnected) {
    connectionStatus.className = 'status-dot reconnecting';
    connectionStatus.title = 'Reconnecting...';
    connectionBanner.classList.add('visible');
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/events`);

  ws.onopen = () => {
    const wasReconnect = wsWasConnected;
    wsWasConnected = true;
    connectionStatus.className = 'status-dot connected';
    connectionStatus.title = 'Connected';
    connectionBanner.classList.remove('visible');
    wsReconnectDelay = 1000; // Reset backoff on successful connect
    if (wasReconnect) {
      showToast('Connection restored', 'success');
    }
  };

  ws.onclose = () => {
    connectionStatus.className = wsWasConnected ? 'status-dot reconnecting' : 'status-dot disconnected';
    const delaySec = Math.round(wsReconnectDelay / 1000);
    connectionStatus.title = `Disconnected — reconnecting in ${delaySec}s...`;
    if (wsWasConnected) {
      connectionBanner.classList.add('visible');
    }
    setTimeout(connectDashboardWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
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
      refreshPreviews();
      refreshSummaries();
      refreshStats();
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
      scheduleRenderSessions();
      return;
    }

    if (msg.type === 'event') {
      if (msg.event === 'Heartbeat') {
        const s = sessions.find(s => s.session_id === msg.session_id);
        if (s) {
          s.last_tool = msg.tool_name;
          s.last_heartbeat = msg.timestamp || new Date().toISOString();
          // Only set active if not stopped or waiting for permission.
          // A heartbeat can arrive from a previous tool while the next tool
          // is still waiting for a PermissionRequest — don't clobber that.
          if (s.status !== 'stopped' && s.status !== 'waiting_permission') {
            s.status = 'active';
          }
          scheduleRenderSessions();
        }
        return;
      }

      // For non-auto-approved PermissionRequest: update status immediately so
      // the card turns red without waiting for the session_update broadcast.
      // The session_update that follows confirms/corrects the status.
      // Auto-approved permissions include auto_approved:true — skip those.
      if (msg.event === 'PermissionRequest' && !msg.auto_approved) {
        const s = sessions.find(s => s.session_id === msg.session_id);
        if (s && s.status !== 'stopped') {
          s.status = 'waiting_permission';
          scheduleRenderSessions();
        }
      }

      recentEvents.unshift(msg);
      if (recentEvents.length > 200) recentEvents.length = 200;
      scheduleRenderEvents();
    }
  };
}

// ──────────────────────────────────────────────
// Batched rendering — schedule with rAF so multiple WS messages
// arriving in the same frame only cause one DOM rebuild
// ──────────────────────────────────────────────

let _sessionsRafPending = false;
let _eventsRafPending = false;

function scheduleRenderSessions() {
  if (_sessionsRafPending) return;
  _sessionsRafPending = true;
  requestAnimationFrame(() => { _sessionsRafPending = false; renderSessions(); });
}

function scheduleRenderEvents() {
  if (_eventsRafPending) return;
  _eventsRafPending = true;
  requestAnimationFrame(() => { _eventsRafPending = false; renderEvents(); });
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

  // Session age
  const age = s.created_at ? timeAgo(s.created_at) : '';
  const toolCount = s.tool_count || 0;

  // Transcript preview + AI summary (from caches)
  const preview = previewCache.get(s.session_id)?.text || '';
  const summary = summaryCache.get(s.session_id)?.summary || '';
  const isActive = !isStopped;
  const showPreviewShimmer = isActive && !preview && s.transcript;
  const showSummaryShimmer = isActive && !summary && serverInfo.aiSummaryEnabled;

  // Kill button: protect server's own directory from accidental kill
  const isServerSession = serverInfo.serverCwd && s.cwd === serverInfo.serverCwd;
  const showKill = !isStopped || !!s.tmux_target;
  const killBtn = showKill
    ? `<button class="btn-kill-session${isServerSession ? ' btn-kill-protected' : ''}" data-id="${safeId}" title="${isServerSession ? 'Warning: this is the control center session' : 'Kill session'}">Kill</button>`
    : '';

  // Grant button: only on waiting sessions that have a linked tmux target
  const grantBtn = (statusClass === 'waiting' && s.tmux_target)
    ? `<button class="btn-grant" data-id="${safeId}" title="Approve permission request">✓ Grant</button>`
    : '';

  // Pending permission context — what is Claude asking to do?
  const pendingDetail = (statusClass === 'waiting' && s.pending_tool)
    ? formatToolDetail(s.pending_tool, s.pending_tool_input)
    : '';

  return `
    <div class="session-card status-${statusClass} ${isSelected ? 'selected' : ''}" data-id="${safeId}">
      <div class="card-header">
        <span class="indicator ${statusClass}"></span>
        <span class="card-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        ${age ? `<span class="card-age">${escapeHtml(age)}</span>` : ''}
      </div>
      <div class="card-meta-row">
        <span class="card-status">${statusText}</span>
        ${toolCount ? `<span class="card-tool-count">${toolCount} tool${toolCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
      ${pendingDetail ? `<div class="card-pending-detail" title="${escapeHtml(pendingDetail)}">${escapeHtml(pendingDetail)}</div>` : ''}
      ${!pendingDetail && detail ? `<div class="card-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
      ${preview ? `<div class="card-preview"><span class="card-preview-label">Claude</span>${escapeHtml(preview)}</div>` : (showPreviewShimmer ? '<div class="card-preview-loading"></div>' : '')}
      ${summary ? `<div class="card-summary">${escapeHtml(summary)}</div>` : (showSummaryShimmer ? '<div class="card-summary-loading"></div>' : '')}
      <div class="card-actions">
        ${grantBtn}
        ${s.tmux_target
          ? `<button class="btn-connect" data-id="${safeId}">Terminal</button>`
          : `<button class="btn-link-tmux" data-id="${safeId}">Link tmux</button>`}
        <button class="btn-edit-session" data-id="${safeId}">Edit</button>
        ${killBtn}
      </div>
    </div>
  `;
}

function renderSessions() {
  // Update summary bar
  const activeCount = sessions.filter(s => getStatusClass(s) === 'active').length;
  const waitingCount = sessions.filter(s => getStatusClass(s) === 'waiting').length;
  const idleCount = sessions.filter(s => getStatusClass(s) === 'idle').length;
  if (sessions.length > 0) {
    summaryBar.innerHTML = `
      <span class="sum-item sum-active">${activeCount} active</span>
      <span class="sum-sep">·</span>
      <span class="sum-item sum-waiting">${waitingCount} waiting</span>
      <span class="sum-sep">·</span>
      <span class="sum-item sum-idle">${idleCount} idle</span>
    `;
    summaryBar.classList.remove('hidden');
  } else {
    summaryBar.classList.add('hidden');
  }

  if (sessions.length === 0) {
    sessionsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&gt;_</div>
        <h3>No sessions yet</h3>
        <p>Claude Code sessions will appear here automatically when you start them.<br>
        Open a terminal and run <code>claude</code> in any project directory.</p>
        <button class="btn-launch-prominent" id="btn-empty-launch">+ Launch Session</button>
      </div>`;
    document.getElementById('btn-empty-launch')?.addEventListener('click', async () => {
      await Promise.all([loadProjectPresets(), loadTemplates()]).catch(() => {});
      nsTemplate.value = '';
      newSessionModal.showModal();
    });
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
        const color = projectColor(group);
        const colorAttr = color ? ` style="color:${color};border-left-color:${color}"` : '';
        html += `<div class="project-group">
          <div class="project-heading"${colorAttr}>${escapeHtml(group)}</div>
          <div class="project-sessions">${byProject[group].map(renderSessionCard).join('')}</div>
        </div>`;
      } else {
        html += `<div class="project-sessions">${byProject[group].map(renderSessionCard).join('')}</div>`;
      }
    }
  } else {
    html += `<div class="empty-state" style="padding:30px 20px">
      <div class="empty-state-icon">&gt;_</div>
      <h3>No active sessions</h3>
      <p>All sessions are stopped. Launch a new one to get started.</p>
      <button class="btn-launch-prominent" id="btn-empty-launch-active">+ Launch Session</button>
    </div>`;
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

  // Attach empty-state launch button handler (for the "no active" variant)
  document.getElementById('btn-empty-launch-active')?.addEventListener('click', async () => {
    await Promise.all([loadProjectPresets(), loadTemplates()]).catch(() => {});
    nsTemplate.value = '';
    newSessionModal.showModal();
  });

  // PWA badge: show count of sessions waiting for permission
  if ('setAppBadge' in navigator) {
    const waitingCount = sessions.filter(s => s.status === 'waiting_permission').length;
    if (waitingCount > 0) navigator.setAppBadge(waitingCount).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }

  // Attach click handlers
  sessionsGrid.querySelectorAll('.btn-grant').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/grant-permission`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showToast(`Grant failed: ${body.error || 'Unknown error'}`, 'error');
          btn.disabled = false;
          btn.textContent = '✓ Grant';
        }
      } catch {
        showToast('Grant failed: network error', 'error');
        btn.disabled = false;
        btn.textContent = '✓ Grant';
      }
    });
  });

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
      const isProtected = serverInfo.serverCwd && s?.cwd === serverInfo.serverCwd;
      const msg = isProtected
        ? `"${name}" is running in the control center directory.\nKilling it will end this Claude Code session (not the server itself).\nContinue?`
        : `Kill session "${name}"? This will stop the tmux session.`;
      if (!confirm(msg)) return;
      try {
        const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/kill`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showToast(`Kill failed: ${body.error || 'Unknown error'}`, 'error');
        } else {
          showToast(`Session "${name}" killed`, 'info');
        }
      } catch { showToast('Kill failed: network error', 'error'); }
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
      showToast(`Save failed: ${body.error || 'Unknown error'}`, 'error');
    }
  } catch { showToast('Save failed: network error', 'error'); }
});

function getStatusClass(session) {
  if (session.status === 'waiting_permission') return 'waiting';
  if (session.status === 'stopped') return 'stopped';
  if (session.status === 'active') {
    if (session.last_heartbeat) {
      // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" (space, no T/Z).
      // Replace space with T and append Z so Date.parse() treats it as UTC on all browsers.
      const ts = session.last_heartbeat.includes('T')
        ? session.last_heartbeat
        : session.last_heartbeat.replace(' ', 'T') + 'Z';
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

// Deterministic color from project name — Catppuccin Mocha palette
const PROJECT_COLORS = ['#cba6f7','#89b4fa','#a6e3a1','#fab387','#f38ba8','#f9e2af','#89dceb','#b4befe'];
function projectColor(name) {
  if (!name) return null;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
}

const TOOL_ICONS = {
  Bash: '⚡', Edit: '✏️', Write: '✏️', MultiEdit: '✏️', NotebookEdit: '✏️',
  Read: '👁', Glob: '👁', Grep: '🔍', LS: '📁',
  WebFetch: '🌐', WebSearch: '🌐',
};

function formatToolDetail(toolName, toolInput) {
  const icon = TOOL_ICONS[toolName] || '⚙';
  const fname = p => (p || '').split('/').pop() || p;
  try {
    const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    if (inp?.command) return `${icon} ${inp.command.trimStart().slice(0, 55)}`;
    if (inp?.file_path) return `${icon} ${fname(inp.file_path)}`;
    if (inp?.path) return `${icon} ${fname(inp.path)}`;
    if (inp?.pattern) return `${icon} ${inp.pattern.slice(0, 45)}`;
    if (inp?.query) return `${icon} ${inp.query.slice(0, 45)}`;
    if (inp?.url) return `${icon} ${inp.url.slice(0, 45)}`;
  } catch {}
  return `${icon} ${toolName}`;
}

function getDetailText(session) {
  if (session.last_tool) {
    const ev = recentEvents.find(e => e.session_id === session.session_id && e.tool_name === session.last_tool);
    if (ev) return formatToolDetail(ev.tool_name, ev.tool_input);
    return `${TOOL_ICONS[session.last_tool] || '⚙'} ${session.last_tool}`;
  }
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

  const rows = recentEvents.filter(ev => ev.event !== 'Stop').slice(0, 100).map(ev => {
    const time = ev.created_at || ev.timestamp || '';
    const timeStr = time ? formatTime(time) : '--:--';
    const label = ev.label || ev.session_cwd || ev.cwd || ev.session_id?.slice(0, 8) || '?';
    const detail = ev.auto_approved ? formatToolDetail(ev.tool_name, ev.tool_input) : getEventDetail(ev);
    const isPermission = ev.event === 'PermissionRequest';
    const isAutoApproved = !!ev.auto_approved;
    const s = sessions.find(s => s.session_id === ev.session_id);
    const clickable = !!s?.tmux_target;

    const eventLabel = isAutoApproved ? 'auto-approved' : escapeHtml(ev.event);
    const classes = [
      'event-row',
      isPermission && !isAutoApproved ? 'permission-request' : '',
      isAutoApproved ? 'auto-approved' : '',
      clickable ? 'clickable' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-session-id="${escapeHtml(ev.session_id || '')}">
        <span class="ev-time">${timeStr}</span>
        <span class="ev-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <span class="ev-event ${isAutoApproved ? 'AutoApproved' : escapeHtml(ev.event)}">${eventLabel}</span>
        <span class="ev-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </div>
    `;
  }).join('');

  eventsList.innerHTML = rows;

  eventsList.querySelectorAll('.event-row.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const s = sessions.find(s => s.session_id === row.dataset.sessionId);
      if (s?.tmux_target) openTerminal(s.session_id);
    });
  });
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

  // Dismiss history view when switching to a different session.
  // Clear content to prevent stale text flashing if auto-show fires quickly.
  terminalHistory.classList.add('hidden');
  terminalContainer.classList.remove('hidden');
  terminalHistoryContent.textContent = '';
  historyFetchSessionId = null;
  historyScrolledUp = false;
  historyLastFailTime = 0;

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
    fontSize: window.innerWidth < 640 ? 12 : 14,
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

  // Show connecting state briefly while xterm initializes
  terminalContainer.innerHTML = '<div class="terminal-connecting"><div class="connecting-spinner"></div>Connecting to terminal...</div>';

  // Use rAF so the "connecting" message renders before xterm takes over
  requestAnimationFrame(() => {
    if (!term) return;
    terminalContainer.innerHTML = '';
    term.open(terminalContainer);

    // Double rAF: the first rAF fires before the browser has finished laying out
    // the newly-visible panel; the second fires after layout+paint, so the
    // container has real pixel dimensions when fitAddon.fit() is called.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (fitAddon) fitAddon.fit();
      if (term) term.focus();
      // On mobile, scroll the terminal into view so user doesn't have to scroll manually
      if (window.innerWidth < 900) {
        terminalPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }));
  });

  termReconnectAttempts = 0;
  connectTerminalWs(sessionId);

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

function connectTerminalWs(sessionId) {
  if (termReconnectTimer) { clearTimeout(termReconnectTimer); termReconnectTimer = null; }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(`${protocol}//${location.host}/ws/terminal/${encodeURIComponent(sessionId)}`);

  termWs.onopen = () => {
    termReconnectAttempts = 0;
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

  let tmuxExited = false;
  termWs.onmessage = (e) => {
    // Guard: ignore messages if the user has switched to a different session.
    // Without this, queued messages from the old WebSocket (which is being closed
    // asynchronously) could write into the new session's terminal.
    if (!term || selectedSessionId !== sessionId) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') {
      term.write(msg.data);
    } else if (msg.type === 'exit') {
      tmuxExited = true;
      term.write('\r\n\x1b[31m[tmux session exited]\x1b[0m\r\n');
    } else if (msg.type === 'error') {
      term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    }
  };

  termWs.onclose = () => {
    // Don't reconnect if tmux exited cleanly, or if the user closed the terminal
    if (tmuxExited || !term || selectedSessionId !== sessionId) return;

    termReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, termReconnectAttempts - 1), 30_000);
    if (term) term.write(`\r\n\x1b[33m[Disconnected — reconnecting in ${Math.round(delay / 1000)}s]\x1b[0m\r\n`);
    termReconnectTimer = setTimeout(() => {
      if (!term || selectedSessionId !== sessionId) return;
      if (term) term.write('\x1b[33m[Reconnecting…]\x1b[0m\r\n');
      connectTerminalWs(sessionId);
    }, delay);
  };
}

function closeTerminal(keepSelection) {
  window.removeEventListener('resize', handleWindowResize);
  if (termReconnectTimer) { clearTimeout(termReconnectTimer); termReconnectTimer = null; }
  termReconnectAttempts = 0;
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  if (term) { term.dispose(); term = null; }
  fitAddon = null;
  terminalHistory.classList.add('hidden');
  terminalContainer.classList.remove('hidden');
  terminalHistoryContent.textContent = '';
  historyFetchSessionId = null;
  historyScrolledUp = false;
  terminalPanel.classList.add('hidden');
  if (!keepSelection) {
    selectedSessionId = null;
    renderSessions();
  }
}

function handleWindowResize() {
  // Only fit when terminal container is actually visible. If the history panel
  // is showing, terminalContainer has display:none — fitting it would resize
  // xterm to 0 columns/rows. hideHistoryPanel() calls fit() when dismissing.
  if (fitAddon && term && terminalHistory.classList.contains('hidden')) {
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

document.getElementById('btn-cleanup-zombies').addEventListener('click', async () => {
  const btn = document.getElementById('btn-cleanup-zombies');
  btn.disabled = true;
  try {
    const res = await fetchWithTimeout('/api/sessions/cleanup-zombies', { method: 'POST' });
    if (res.ok) {
      const { cleaned } = await res.json();
      refreshStats();
      if (cleaned === 0) {
        showToast('No stale sessions found', 'info');
      } else {
        showToast(`Cleaned up ${cleaned} session${cleaned !== 1 ? 's' : ''}`, 'success');
      }
    }
  } catch { /* ignore */ } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-new-session').addEventListener('click', async () => {
  await Promise.all([loadProjectPresets(), loadTemplates()]).catch(() => {});
  nsTemplate.value = '';
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
  const autoApprove = document.getElementById('ns-auto-approve').value; // 'full' | 'readonly' | 'none'
  const skipPermissions = document.getElementById('ns-skip-permissions').checked;

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
        autoApprove,
        skipPermissions: skipPermissions || undefined,
      }),
    }, 30000);
    if (!res.ok) throw new Error((await res.json()).error);
    newSessionModal.close();
    showToast(`Session "${label}" launched`, 'success');
    // Reset fields
    document.getElementById('ns-label').value = '';
    document.getElementById('ns-cwd').value = '';
    document.getElementById('ns-cwd-preset').selectedIndex = 0;
    document.getElementById('ns-prompt').value = '';
    document.getElementById('ns-auto-approve').selectedIndex = 0;
    document.getElementById('ns-skip-permissions').checked = false;
  } catch (err) {
    showToast(`Failed to launch: ${err.message}`, 'error');
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch';
  }
});

// ──────────────────────────────────────────────
// Session templates
// ──────────────────────────────────────────────

let templates = [];
const nsTemplate = document.getElementById('ns-template');
const templatesModal = document.getElementById('templates-modal');
const templatesList = document.getElementById('templates-list');
const templateEditForm = document.getElementById('template-edit-form');
const templatesModalFooter = document.getElementById('templates-modal-footer');

async function loadTemplates() {
  try {
    const res = await fetchWithTimeout('/api/templates');
    const data = await res.json();
    templates = Array.isArray(data) ? data : [];
  } catch { templates = []; }
  renderTemplateSelect();
}

function renderTemplateSelect() {
  nsTemplate.innerHTML = '<option value="">— No template —</option>' +
    templates.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
}

function applyTemplate(id) {
  const t = templates.find(t => t.id === id);
  if (!t) return;
  document.getElementById('ns-label').value = t.label || '';
  document.getElementById('ns-prompt').value = t.prompt || '';
  // Set auto-approve
  const aa = document.getElementById('ns-auto-approve');
  aa.value = t.autoApprove || 'full';
  // Set CWD preset
  if (t.cwd) {
    const opt = [...nsCwdPreset.options].find(o => o.value === t.cwd);
    if (opt) {
      nsCwdPreset.value = t.cwd;
      nsCwdCustom.classList.add('hidden');
    } else {
      nsCwdPreset.value = '__custom__';
      document.getElementById('ns-cwd').value = t.cwd;
      nsCwdCustom.classList.remove('hidden');
    }
  }
}

nsTemplate.addEventListener('change', () => {
  if (nsTemplate.value) applyTemplate(nsTemplate.value);
});

document.getElementById('btn-manage-templates').addEventListener('click', () => {
  document.getElementById('new-session-modal').close();
  openTemplatesModal();
});

// "Save as template" — saves current modal settings immediately after asking for a name
document.getElementById('btn-save-template').addEventListener('click', async () => {
  const label = document.getElementById('ns-label').value.trim();
  const name = prompt('Template name:', label || '');
  if (!name?.trim()) return;
  const presetVal = nsCwdPreset.value;
  const cwd = (presetVal === '__custom__' || !presetVal)
    ? document.getElementById('ns-cwd').value.trim()
    : presetVal;
  try {
    await fetchWithTimeout('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        label,
        cwd,
        project: presetVal && presetVal !== '__custom__'
          ? (projectPresets.find(p => p.cwd === presetVal)?.name || '')
          : '',
        autoApprove: document.getElementById('ns-auto-approve').value,
        prompt: document.getElementById('ns-prompt').value.trim(),
      }),
    });
    await loadTemplates();
    showToast('Template saved', 'success');
  } catch (err) {
    showToast(`Failed to save template: ${err.message}`, 'error');
  }
});

function openTemplatesModal() {
  renderTemplateList();
  templateEditForm.classList.add('hidden');
  templatesModalFooter.classList.remove('hidden');
  templatesModal.showModal();
}

function renderTemplateList() {
  if (templates.length === 0) {
    templatesList.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No templates yet. Create one to quickly reuse session configs.</p>';
    return;
  }
  templatesList.innerHTML = templates.map(t => `
    <div class="template-item" data-id="${escapeHtml(t.id)}">
      <div class="template-item-name">${escapeHtml(t.name)}</div>
      <div class="template-item-meta">${[t.cwd, t.autoApprove].filter(Boolean).join(' · ')}</div>
      <div class="template-item-actions">
        <button class="btn-template-edit" data-id="${escapeHtml(t.id)}">Edit</button>
        <button class="btn-template-delete" data-id="${escapeHtml(t.id)}">Delete</button>
      </div>
    </div>
  `).join('');

  templatesList.querySelectorAll('.btn-template-edit').forEach(btn => {
    btn.addEventListener('click', () => openTemplateForm(btn.dataset.id));
  });
  templatesList.querySelectorAll('.btn-template-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this template?')) return;
      await fetchWithTimeout(`/api/templates/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      await loadTemplates();
      renderTemplateList();
    });
  });
}

let editingTemplateId = null;

function openTemplateForm(id, prefill = {}) {
  editingTemplateId = id || null;
  const t = id ? templates.find(t => t.id === id) : prefill;
  document.getElementById('template-form-title').textContent = id ? 'Edit Template' : 'New Template';
  document.getElementById('te-name').value = t?.name || '';
  document.getElementById('te-label').value = t?.label || '';
  document.getElementById('te-cwd').value = t?.cwd || '';
  document.getElementById('te-project').value = t?.project || '';
  document.getElementById('te-auto-approve').value = t?.autoApprove || 'full';
  document.getElementById('te-prompt').value = t?.prompt || '';
  templatesList.classList.add('hidden');
  templatesModalFooter.classList.add('hidden');
  templateEditForm.classList.remove('hidden');
}

document.getElementById('btn-new-template').addEventListener('click', () => openTemplateForm(null));

document.getElementById('btn-template-form-cancel').addEventListener('click', () => {
  templateEditForm.classList.add('hidden');
  templatesList.classList.remove('hidden');
  templatesModalFooter.classList.remove('hidden');
});

document.getElementById('btn-template-form-save').addEventListener('click', async () => {
  const body = {
    name: document.getElementById('te-name').value.trim(),
    label: document.getElementById('te-label').value.trim(),
    cwd: document.getElementById('te-cwd').value.trim(),
    project: document.getElementById('te-project').value.trim(),
    autoApprove: document.getElementById('te-auto-approve').value,
    prompt: document.getElementById('te-prompt').value.trim(),
  };
  if (!body.name) { showToast('Template name is required', 'error'); return; }
  try {
    if (editingTemplateId) {
      await fetchWithTimeout(`/api/templates/${encodeURIComponent(editingTemplateId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } else {
      await fetchWithTimeout('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    }
    await loadTemplates();
    templateEditForm.classList.add('hidden');
    templatesList.classList.remove('hidden');
    templatesModalFooter.classList.remove('hidden');
    renderTemplateList();
  } catch (err) { showToast(`Failed to save: ${err.message}`, 'error'); }
});

document.getElementById('btn-close-templates').addEventListener('click', () => templatesModal.close());

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
    showToast('Failed to fetch tmux sessions', 'error');
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
        showToast(`Failed to link tmux session: ${err.message}`, 'error');
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
          showToast(`Failed to link tmux: ${err.message}`, 'error');
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
// History panel — tmux scrollback capture
// ──────────────────────────────────────────────

const terminalHistory = document.getElementById('terminal-history');
const terminalHistoryContent = document.getElementById('terminal-history-content');
const terminalHistoryLabel = document.getElementById('terminal-history-label');

function showHistoryPanel(text) {
  historyScrolledUp = false;
  terminalHistoryContent.textContent = text;
  terminalContainer.classList.add('hidden');
  terminalHistory.classList.remove('hidden');
  // rAF ensures layout is calculated before scrolling to bottom
  requestAnimationFrame(() => {
    terminalHistoryContent.scrollTop = terminalHistoryContent.scrollHeight;
  });
}

function hideHistoryPanel() {
  historyScrolledUp = false;
  terminalHistory.classList.add('hidden');
  terminalContainer.classList.remove('hidden');
  if (fitAddon) {
    requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
  }
}

// Auto-show history when user scrolls up while in alternate screen (TUI mode).
// Silent — no loading indicator, no alert on failure.
async function autoShowHistory() {
  if (historyFetchSessionId || !selectedSessionId) return;
  if (!terminalHistory.classList.contains('hidden')) return;
  // Brief cooldown after a failed fetch — prevents rapid-fire requests if tmux is dead.
  if (Date.now() - historyLastFailTime < 5000) return;
  const capturedSessionId = selectedSessionId;
  historyFetchSessionId = capturedSessionId;
  try {
    const res = await fetchWithTimeout(
      `/api/sessions/${encodeURIComponent(capturedSessionId)}/terminal-capture`,
    );
    if (!res.ok) { historyLastFailTime = Date.now(); return; }
    const { text } = await res.json();
    // Abort if user switched sessions while fetch was in-flight
    if (selectedSessionId !== capturedSessionId || !term) return;
    const lineCount = (text.match(/\n/g) || []).length;
    terminalHistoryLabel.textContent = `Scrollback history · ${lineCount.toLocaleString()} lines`;
    showHistoryPanel(text);
  } catch {
    historyLastFailTime = Date.now();
  } finally {
    // Only clear if this fetch is still the active one. If the user switched
    // sessions, openTerminal() already reset historyFetchSessionId to a new
    // value — don't clobber it.
    if (historyFetchSessionId === capturedSessionId) historyFetchSessionId = null;
  }
}

document.getElementById('btn-history').addEventListener('click', async () => {
  // Toggle: if history is already shown, go back to live
  if (!terminalHistory.classList.contains('hidden')) {
    hideHistoryPanel();
    return;
  }
  if (!selectedSessionId || historyFetchSessionId) return;
  const btn = document.getElementById('btn-history');
  const capturedSessionId = selectedSessionId;
  historyFetchSessionId = capturedSessionId;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const res = await fetchWithTimeout(
      `/api/sessions/${encodeURIComponent(capturedSessionId)}/terminal-capture`,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const { text } = await res.json();
    if (selectedSessionId !== capturedSessionId || !term) return;
    const lineCount = (text.match(/\n/g) || []).length;
    terminalHistoryLabel.textContent = `Scrollback history · ${lineCount.toLocaleString()} lines`;
    showHistoryPanel(text);
  } catch (err) {
    showToast(`Failed to load history: ${err.message}`, 'error');
  } finally {
    if (historyFetchSessionId === capturedSessionId) historyFetchSessionId = null;
    btn.disabled = false;
    btn.textContent = '⬆ History';
  }
});

document.getElementById('btn-close-history').addEventListener('click', hideHistoryPanel);

// Auto-dismiss: when user scrolls back to the bottom of the history panel,
// return to live terminal. Only fires after they've scrolled up first
// (prevents immediate dismiss on open, which starts scrolled to bottom).
terminalHistoryContent.addEventListener('scroll', () => {
  const el = terminalHistoryContent;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
  if (!atBottom) {
    historyScrolledUp = true;
  } else if (historyScrolledUp) {
    historyScrolledUp = false;
    hideHistoryPanel();
  }
});

// ──────────────────────────────────────────────
// Terminal input bar
// ──────────────────────────────────────────────

const terminalTextInput = document.getElementById('terminal-text-input');

function sendToTerminal(text) {
  if (termWs?.readyState === 1) {
    termWs.send(JSON.stringify({ type: 'input', data: text }));
  }
}

document.getElementById('btn-ctrl-c').addEventListener('click', () => {
  sendToTerminal('\x03');
  terminalTextInput.focus();
});
document.getElementById('btn-tab').addEventListener('click', () => {
  sendToTerminal('\t');
  terminalTextInput.focus();
});
document.getElementById('btn-arrow-up').addEventListener('click', () => {
  sendToTerminal('\x1b[A');
  terminalTextInput.focus();
});
document.getElementById('btn-arrow-down').addEventListener('click', () => {
  sendToTerminal('\x1b[B');
  terminalTextInput.focus();
});

terminalTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = terminalTextInput.value;
    terminalTextInput.value = '';
    sendToTerminal(val + '\r');
  }
});

document.getElementById('btn-terminal-send').addEventListener('click', () => {
  const val = terminalTextInput.value;
  terminalTextInput.value = '';
  sendToTerminal(val + '\r');
  terminalTextInput.focus();
});

// On mobile: tapping the terminal body focuses the input bar (brings up keyboard)
terminalContainer.addEventListener('touchend', (e) => {
  // Only focus input if the touch wasn't a scroll gesture
  if (e.changedTouches.length === 1 && term) {
    terminalTextInput.focus();
  }
}, { passive: true });

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
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr.replace(' ', 'T') + 'Z');
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
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────
// Auto-refresh heartbeat ages every 15s
// ──────────────────────────────────────────────

setInterval(scheduleRenderSessions, 15_000);

// ──────────────────────────────────────────────
// Terminal scroll: intercept mouse wheel to scroll the xterm viewport.
//
// Root cause of "scrolling randomly breaks": xterm.js uses two screen buffers.
// The NORMAL buffer has scrollback — scrollLines() works here.
// The ALTERNATE buffer (used by TUI apps like Claude Code while running) has no
// scrollback by design. scrollLines() is a no-op and the scroll event is silently
// swallowed, making it feel like scrolling stopped working.
//
// Fix: in normal-buffer mode, intercept scroll and call scrollLines(). In
// alternate-screen mode, scroll-up auto-fetches and shows the tmux scrollback
// history panel. Scroll-down in the history panel auto-dismisses back to live.
// ──────────────────────────────────────────────

// capture: true runs our handler BEFORE xterm's, which would otherwise convert
// scroll to cursor-key presses in alternate-screen mode.
terminalContainer.addEventListener('wheel', (e) => {
  if (!term) return;
  if (term.buffer.active.type !== 'normal') {
    // Alternate screen = TUI mode. Scrollback lives in the hidden normal buffer.
    // Scroll up → auto-fetch and show the history panel.
    if (e.deltaY < 0) {
      e.preventDefault();
      e.stopPropagation();
      autoShowHistory();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  // Pixel mode (Mac trackpad): 8px per line. Line/page mode: 3 lines per click.
  const lines = e.deltaMode === 0
    ? Math.round(e.deltaY / 8)
    : Math.sign(e.deltaY) * 3;
  if (lines !== 0) term.scrollLines(lines);
}, { passive: false, capture: true });

// Mobile touch scrolling — convert vertical swipes to xterm scroll lines.
// preventDefault() stops the browser from scrolling the page (which causes
// the canvas to glitch and content to disappear on mobile).
let _touchStartY = 0;
terminalContainer.addEventListener('touchstart', (e) => {
  _touchStartY = e.touches[0].clientY;
}, { passive: true });

terminalContainer.addEventListener('touchmove', (e) => {
  if (!term) return;
  if (term.buffer.active.type !== 'normal') {
    // dy positive = finger moved up (upward swipe = scroll up = want history).
    // Use same direction convention as the normal-buffer handler below.
    const dy = _touchStartY - e.touches[0].clientY;
    if (dy > 30) { // 30px threshold avoids accidental triggers
      e.preventDefault();
      autoShowHistory();
    }
    return;
  }
  e.preventDefault();
  const dy = _touchStartY - e.touches[0].clientY;
  _touchStartY = e.touches[0].clientY;
  const lines = Math.round(dy / 18); // ~18px per line
  if (lines !== 0) term.scrollLines(lines);
}, { passive: false });

// ──────────────────────────────────────────────
// Server info, transcript previews, AI summaries
// ──────────────────────────────────────────────

async function fetchServerInfo() {
  try {
    const res = await fetchWithTimeout('/api/info');
    if (res.ok) serverInfo = await res.json();
  } catch { /* non-critical */ }
}

async function refreshPreviews() {
  const active = sessions.filter(s => s.status !== 'stopped' && s.transcript !== null);
  for (const s of active) {
    try {
      const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(s.session_id)}/preview`);
      if (res.ok) {
        const { text } = await res.json();
        if (text) previewCache.set(s.session_id, { text, fetchedAt: Date.now() });
      }
    } catch { /* non-critical */ }
  }
  scheduleRenderSessions();
}

function renderStats() {
  if (!stats) { statsBar.classList.add('hidden'); return; }
  const { sessionsThisWeek, totalEvents, mostUsedTool, avgDurationMinutes, aiSummaryCalls, aiCostUsd } = stats;
  const parts = [
    `<span class="stat-chip">${sessionsThisWeek} session${sessionsThisWeek !== 1 ? 's' : ''} this week</span>`,
    `<span class="stat-sep">·</span>`,
    `<span class="stat-chip">${totalEvents.toLocaleString()} tool uses</span>`,
  ];
  if (mostUsedTool) {
    parts.push(`<span class="stat-sep">·</span>`);
    parts.push(`<span class="stat-chip">Top: ${escapeHtml(mostUsedTool)}</span>`);
  }
  if (avgDurationMinutes !== null) {
    const avgLabel = avgDurationMinutes >= 60
      ? `${Math.round(avgDurationMinutes / 60)}h avg`
      : `${avgDurationMinutes}m avg`;
    parts.push(`<span class="stat-sep">·</span>`);
    parts.push(`<span class="stat-chip">${avgLabel}</span>`);
  }
  if (aiSummaryCalls > 0) {
    const costLabel = aiCostUsd < 0.005 ? '<$0.01' : `$${aiCostUsd.toFixed(2)}`;
    parts.push(`<span class="stat-sep">·</span>`);
    parts.push(`<span class="stat-chip stat-ai">AI: ${aiSummaryCalls} calls · ~${costLabel}</span>`);
  }
  statsBar.innerHTML = parts.join('');
  statsBar.classList.remove('hidden');
}

async function refreshStats() {
  try {
    const res = await fetchWithTimeout('/api/stats');
    if (!res.ok) return;
    stats = await res.json();
    renderStats();
  } catch { /* non-critical */ }
}

async function refreshSummaries() {
  if (!serverInfo.aiSummaryEnabled) return;
  const active = sessions.filter(s => s.status !== 'stopped');
  for (const s of active) {
    const cached = summaryCache.get(s.session_id);
    if (cached && Date.now() - cached.fetchedAt < 85_000) continue;
    try {
      const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(s.session_id)}/summary`);
      if (res.ok) {
        const { summary } = await res.json();
        if (summary) summaryCache.set(s.session_id, { summary, fetchedAt: Date.now() });
      }
    } catch { /* non-critical */ }
  }
  scheduleRenderSessions();
}

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

fetchServerInfo();
connectDashboardWS();

// Refresh previews every 20s, summaries every 90s, stats every 60s
setInterval(refreshPreviews, 20_000);
setInterval(refreshSummaries, 90_000);
setInterval(refreshStats, 60_000);

// ──────────────────────────────────────────────
// Update banner
// ──────────────────────────────────────────────

let updateBannerDismissed = false;

async function checkForUpdate() {
  if (updateBannerDismissed) return;
  try {
    const res = await fetchWithTimeout('/api/version');
    if (!res.ok) return;
    const { current, latest, updateAvailable } = await res.json();
    if (!updateAvailable || !latest) {
      // Remove banner if update is no longer available (e.g. already updated)
      const existing = document.getElementById('update-banner');
      if (existing) existing.remove();
      return;
    }
    showUpdateBanner(current, latest);
  } catch { /* non-critical */ }
}

function showUpdateBanner(current, latest) {
  // Don't duplicate
  if (document.getElementById('update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';

  const text = document.createElement('span');
  text.textContent = `Update available: v${latest} \u2014 you're on v${current}`;

  const updateBtn = document.createElement('button');
  updateBtn.className = 'update-btn';
  updateBtn.textContent = 'Update now';
  updateBtn.addEventListener('click', async () => {
    if (!confirm('This will pull the latest code, install dependencies, and restart the server. Continue?')) return;
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating...';
    try {
      const res = await fetchWithTimeout('/api/update', { method: 'POST' }, 30000);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      showToast('Update started. The server will restart shortly.', 'success');
      // Replace banner text to indicate update in progress
      text.textContent = 'Updating... the page will reload when the server restarts.';
      updateBtn.remove();
    } catch (err) {
      showToast(`Update failed: ${err.message}`, 'error');
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update now';
    }
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'update-dismiss';
  dismissBtn.textContent = '\u00d7';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    updateBannerDismissed = true;
    banner.remove();
  });

  banner.appendChild(text);
  banner.appendChild(updateBtn);
  banner.appendChild(dismissBtn);

  // Insert after the connection banner
  const connectionBannerEl = document.getElementById('connection-banner');
  if (connectionBannerEl && connectionBannerEl.parentNode) {
    connectionBannerEl.parentNode.insertBefore(banner, connectionBannerEl.nextSibling);
  } else {
    // Fallback: insert at the top of body
    document.body.insertBefore(banner, document.body.firstChild);
  }
}

// Check on page load (delayed 5s), then every 30 minutes
setTimeout(checkForUpdate, 5000);
setInterval(checkForUpdate, 30 * 60 * 1000);

// ──────────────────────────────────────────────
// PWA: service worker + push notifications
// ──────────────────────────────────────────────

// Convert a URL-safe base64 VAPID public key to a Uint8Array for pushManager.subscribe
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

const notifBtn = document.getElementById('btn-notifications');

function updateNotifBtn() {
  if (!('Notification' in window)) { notifBtn.classList.add('notif-denied'); return; }
  if (Notification.permission === 'granted') notifBtn.classList.add('notif-granted');
  else if (Notification.permission === 'denied') notifBtn.classList.add('notif-denied');
}
updateNotifBtn();

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push notifications require HTTPS. Use your Tailscale URL.', 'info');
    return;
  }
  const permission = await Notification.requestPermission();
  updateNotifBtn();
  if (permission !== 'granted') return;

  try {
    const keyRes = await fetchWithTimeout('/api/push/vapid-public-key');
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled) { showToast('Push notifications are not configured on the server', 'info'); return; }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const res = await fetchWithTimeout('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    notifBtn.title = 'Push notifications enabled';
  } catch (err) {
    showToast(`Push notification setup failed: ${err.message}`, 'error');
  }
}

notifBtn.addEventListener('click', subscribeToPush);

// PWA service worker (only activates over HTTPS or localhost)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
