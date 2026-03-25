import type { Session, StatusClass } from './types';

/** Parse SQLite datetime string (space-separated, no T/Z) to Date */
function parseDate(dateStr: string): Date {
  const s = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(s);
}

export function getStatusClass(session: Session): StatusClass {
  if (session.status === 'waiting_permission') return 'waiting';
  if (session.status === 'stopped') return 'stopped';
  if (session.status === 'active') {
    if (session.last_heartbeat) {
      const age = (Date.now() - parseDate(session.last_heartbeat).getTime()) / 1000;
      if (age > 120) return 'idle';
    }
    return 'active';
  }
  return 'stopped';
}

export function getStatusText(session: Session): string {
  const cls = getStatusClass(session);
  if (cls === 'waiting') return 'Waiting for permission';
  if (cls === 'active') return `Active${session.last_heartbeat ? ' \u00b7 ' + timeAgo(session.last_heartbeat) : ''}`;
  if (cls === 'idle') return `Idle \u00b7 ${timeAgo(session.last_heartbeat!)}`;
  return `Stopped${session.updated_at ? ' \u00b7 ' + timeAgo(session.updated_at) : ''}`;
}

const TOOL_ICONS: Record<string, string> = {
  Bash: '\u26a1', Edit: '\u270f\ufe0f', Write: '\u270f\ufe0f', MultiEdit: '\u270f\ufe0f', NotebookEdit: '\u270f\ufe0f',
  Read: '\ud83d\udc41', Glob: '\ud83d\udc41', Grep: '\ud83d\udd0d', LS: '\ud83d\udcc1',
  WebFetch: '\ud83c\udf10', WebSearch: '\ud83c\udf10',
};

export function formatToolDetail(toolName: string, toolInput: string | null): string {
  const icon = TOOL_ICONS[toolName] || '\u2699';
  const fname = (p: string) => p.split('/').pop() || p;
  try {
    const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    if (inp?.command) return `${icon} ${inp.command.trimStart().slice(0, 55)}`;
    if (inp?.file_path) return `${icon} ${fname(inp.file_path)}`;
    if (inp?.path) return `${icon} ${fname(inp.path)}`;
    if (inp?.pattern) return `${icon} ${inp.pattern.slice(0, 45)}`;
    if (inp?.query) return `${icon} ${inp.query.slice(0, 45)}`;
    if (inp?.url) return `${icon} ${inp.url.slice(0, 45)}`;
  } catch { /* ignore parse errors */ }
  return `${icon} ${toolName}`;
}

export function getDetailText(session: Session, recentEvents: { session_id: string; tool_name: string | null; tool_input: string | null }[]): string {
  if (session.last_tool) {
    const ev = recentEvents.find(e => e.session_id === session.session_id && e.tool_name === session.last_tool);
    if (ev && ev.tool_name) return formatToolDetail(ev.tool_name, ev.tool_input);
    return `${TOOL_ICONS[session.last_tool] || '\u2699'} ${session.last_tool}`;
  }
  if (session.cwd) return session.cwd;
  return '';
}

export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const d = parseDate(dateStr);
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

export function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  const d = parseDate(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PROJECT_COLORS = ['#cba6f7', '#89b4fa', '#a6e3a1', '#fab387', '#f38ba8', '#f9e2af', '#89dceb', '#b4befe'];

export function projectColor(name: string): string | null {
  if (!name) return null;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
}

export function groupByProject(sessions: Session[], projectOrder?: string[]): Map<string, Session[]> {
  const active = sessions.filter(s => s.status !== 'stopped');
  const groups = new Map<string, Session[]>();
  const ungrouped: Session[] = [];

  for (const s of active) {
    if (s.project) {
      const list = groups.get(s.project) || [];
      list.push(s);
      groups.set(s.project, list);
    } else {
      ungrouped.push(s);
    }
  }

  // Sort by projects.json order if available, then alphabetically for unknowns
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => {
    if (projectOrder) {
      const ia = projectOrder.indexOf(a);
      const ib = projectOrder.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
    }
    return a.localeCompare(b);
  }));

  // Ungrouped at the end
  if (ungrouped.length > 0) {
    sorted.set('', ungrouped);
  }

  return sorted;
}
