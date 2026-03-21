import { useMemo } from 'react';
import { formatTime, escapeHtml } from '../utils';
import type { SessionEvent } from '../types';
import './EventLog.css';

interface EventLogProps {
  recentEvents: SessionEvent[];
  onSelectSession: (id: string) => void;
}

function getEventDetail(ev: SessionEvent): string {
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

function formatToolDetailForEvent(ev: SessionEvent): string {
  const TOOL_ICONS: Record<string, string> = {
    Bash: '\u26a1', Edit: '\u270f\ufe0f', Write: '\u270f\ufe0f', MultiEdit: '\u270f\ufe0f',
    Read: '\ud83d\udc41', Glob: '\ud83d\udc41', Grep: '\ud83d\udd0d', LS: '\ud83d\udcc1',
    WebFetch: '\ud83c\udf10', WebSearch: '\ud83c\udf10',
  };
  if (!ev.tool_name) return '';
  const icon = TOOL_ICONS[ev.tool_name] || '\u2699';
  try {
    const inp = typeof ev.tool_input === 'string' ? JSON.parse(ev.tool_input) : ev.tool_input;
    if (inp?.command) return `${icon} ${inp.command.trimStart().slice(0, 55)}`;
    if (inp?.file_path) return `${icon} ${(inp.file_path as string).split('/').pop()}`;
    if (inp?.path) return `${icon} ${(inp.path as string).split('/').pop()}`;
  } catch { /* ignore */ }
  return `${icon} ${ev.tool_name}`;
}

export function EventLog({ recentEvents, onSelectSession }: EventLogProps) {
  const displayEvents = useMemo(
    () => recentEvents
      .filter(ev => ev.event !== 'Stop')
      .slice(0, 200),
    [recentEvents]
  );

  if (displayEvents.length === 0) {
    return (
      <div className="event-log">
        <h2 className="event-log-title">Activity</h2>
        <div className="events-list">
          <div className="empty-events">No events yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="event-log">
      <h2 className="event-log-title">Activity</h2>
      <div className="events-list">
        {displayEvents.map(ev => {
          const time = ev.created_at || ev.timestamp || '';
          const timeStr = time ? formatTime(time) : '--:--';
          const label = ev.label || ev.session_cwd || ev.cwd || ev.session_id?.slice(0, 8) || '?';
          const isAutoApproved = !!ev.auto_approved;
          const isPermission = ev.event === 'PermissionRequest';
          const detail = isAutoApproved
            ? formatToolDetailForEvent(ev)
            : getEventDetail(ev);
          const eventLabel = isAutoApproved ? 'auto-approved' : ev.event;

          const rowClasses = [
            'event-row',
            isPermission && !isAutoApproved ? 'permission-request' : '',
            isAutoApproved ? 'auto-approved' : '',
            'clickable',
          ].filter(Boolean).join(' ');

          const eventClasses = [
            'ev-event',
            isAutoApproved ? 'ev-auto-approved' : `ev-${ev.event}`,
          ].join(' ');

          return (
            <div
              key={ev.id}
              className={rowClasses}
              onClick={() => ev.session_id && onSelectSession(ev.session_id)}
            >
              <span className="ev-time">{timeStr}</span>
              <span className="ev-label" title={label}>{escapeHtml(label)}</span>
              <span className={eventClasses}>{eventLabel}</span>
              <span className="ev-detail" title={detail}>{escapeHtml(detail)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
