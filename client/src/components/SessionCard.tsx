import React, { useState, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from './Toast';
import {
  getStatusClass, getStatusText, getDetailText,
  formatToolDetail, timeAgo, escapeHtml,
} from '../utils';
import type { Session, SessionEvent, ServerInfo } from '../types';
import { EditSessionModal } from './modals/EditSessionModal';
import { LinkTmuxModal } from './modals/LinkTmuxModal';
import { SnapshotDiffModal } from './modals/SnapshotDiffModal';
import './SessionCard.css';

interface SessionCardProps {
  session: Session;
  isSelected: boolean;
  isSelectedRight?: boolean;
  serverInfo: ServerInfo;
  onSelect: () => void;
  onSelectRight?: () => void;
  recentEvents: SessionEvent[];
}

function SessionCardInner({ session, isSelected, isSelectedRight, serverInfo, onSelect, onSelectRight, recentEvents }: SessionCardProps) {
  const { showToast } = useToast();
  const { pulseMemberships } = useWebSocket();
  const [editOpen, setEditOpen] = useState(false);
  const [linkTmuxOpen, setLinkTmuxOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const sessionPulses = pulseMemberships.filter(m => m.session_id === session.session_id);
  const mainPulse = sessionPulses.find(m => m.is_main);
  const topicPulses = sessionPulses.filter(m => !m.is_main);

  const statusClass = getStatusClass(session);
  const statusText = getStatusText(session);
  const isStopped = session.status === 'stopped';
  const label = session.label || session.session_id.slice(0, 12);
  const age = session.created_at ? timeAgo(session.created_at) : '';
  const toolCount = session.tool_count || 0;

  const fetchPreview = useMemo(
    () => () => api.getPreview(session.session_id),
    [session.session_id]
  );
  const fetchSummary = useMemo(
    () => () => api.getSummary(session.session_id),
    [session.session_id]
  );

  const { data: previewData } = useApi(fetchPreview, {
    refreshInterval: 20000,
    enabled: !isStopped,
  });
  const { data: summaryData } = useApi(fetchSummary, {
    refreshInterval: 90000,
    enabled: serverInfo.aiSummaryEnabled && !isStopped,
  });

  const preview = previewData?.text || '';
  const summary = summaryData?.summary || '';
  const isActive = !isStopped;
  const showPreviewShimmer = isActive && !preview && !!session.transcript;
  const showSummaryShimmer = isActive && !summary && serverInfo.aiSummaryEnabled;

  const pendingDetail = statusClass === 'waiting' && session.pending_tool
    ? formatToolDetail(session.pending_tool, session.pending_tool_input)
    : '';
  const detail = !pendingDetail ? getDetailText(session, recentEvents) : '';

  const isServerSession = !!(serverInfo.serverCwd && session.cwd === serverInfo.serverCwd);
  const showKill = !isStopped || !!session.tmux_target;

  const handleGrant = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.grantPermission(session.session_id);
      showToast('Permission granted', 'success');
    } catch {
      showToast('Failed to grant permission', 'error');
    }
  }, [session.session_id, showToast]);

  const handleKill = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const name = session.label || session.session_id.slice(0, 8);
    const msg = isServerSession
      ? `"${name}" is running in the control center directory.\nKilling it will end this Claude Code session (not the server itself).\nContinue?`
      : `Kill session "${name}"? This will stop the tmux session.`;
    if (!window.confirm(msg)) return;
    try {
      await api.killSession(session.session_id);
    } catch {
      // handled by WS update
    }
  }, [session.session_id, session.label, isServerSession]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditOpen(true);
  }, []);

  const handleLinkTmux = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLinkTmuxOpen(true);
  }, []);

  const handleRevert = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSnapshotOpen(true);
  }, []);

  const handleBrief = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!mainPulse) return;
    try {
      await api.triggerBrief(session.session_id, mainPulse.pulse_id);
      showToast('Brief triggered', 'success');
    } catch {
      showToast('Failed to trigger brief', 'error');
    }
  }, [session.session_id, mainPulse, showToast]);

  const handleSync = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.syncPulse(session.session_id);
      showToast('Pulse synced', 'success');
    } catch {
      showToast('Failed to sync pulse', 'error');
    }
  }, [session.session_id, showToast]);

  const handleAutoApproveChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    try {
      await api.patchSession(session.session_id, { auto_approve: Number(e.target.value) });
    } catch {
      showToast('Failed to update auto-approve', 'error');
    }
  }, [session.session_id, showToast]);

  const canAcceptDrop = !isStopped && !!session.tmux_target;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!canAcceptDrop || !e.dataTransfer.types.includes('application/x-todo')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, [canAcceptDrop]);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData('application/x-todo');
    if (!raw) return;
    try {
      const todo = JSON.parse(raw);
      const text = `## Task: ${todo.title}${todo.details ? '\n' + todo.details : ''}`;
      await api.sendInput(session.session_id, text);
      showToast(`Sent "${todo.title}" to ${session.label || session.session_id.slice(0, 8)}`, 'success');
    } catch {
      showToast('Failed to send todo', 'error');
    }
  }, [session.session_id, session.label, showToast]);

  return (
    <div
      className={`session-card status-${statusClass}${isSelected ? ' selected' : ''}${isSelectedRight ? ' selected-right' : ''}${dragOver ? ' drop-target' : ''}`}
      onClick={(e) => {
        if (e.shiftKey && onSelectRight) {
          e.preventDefault();
          onSelectRight();
        } else {
          onSelect();
        }
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="card-header">
        <span className={`indicator ${statusClass}`} />
        <span className="card-label" title={label}>{escapeHtml(label)}</span>
        {session.cli_type === 'gemini' && (
          <span className="cli-badge cli-badge-gemini" title="Gemini CLI">G</span>
        )}
        {session.cli_type === 'codex' && (
          <span className="cli-badge cli-badge-codex" title="Codex CLI">X</span>
        )}
        {age && <span className="card-age">{age}</span>}
      </div>

      <div className="card-meta-row">
        <span className="card-status">{statusText}</span>
        {toolCount > 0 && (
          <span className="card-tool-count">
            {toolCount} tool{toolCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {pendingDetail && (
        <div className="card-pending-detail" title={pendingDetail}>
          {escapeHtml(pendingDetail)}
        </div>
      )}

      {!pendingDetail && detail && (
        <div className="card-detail" title={detail}>
          {escapeHtml(detail)}
        </div>
      )}

      {preview ? (
        <div className="card-preview">
          <span className="card-preview-label">Claude</span>
          {escapeHtml(preview)}
        </div>
      ) : showPreviewShimmer ? (
        <div className="card-preview-loading" />
      ) : null}

      {summary ? (
        <div className="card-summary">{escapeHtml(summary)}</div>
      ) : showSummaryShimmer ? (
        <div className="card-summary-loading" />
      ) : null}

      {statusClass === 'waiting' && session.tmux_target && session.cli_type !== 'codex' && (
        <div className="card-grant-row">
          <button className="btn-grant" onClick={handleGrant}>
            Grant Permission
          </button>
        </div>
      )}

      {sessionPulses.length > 0 && (
        <div className="card-pulse-badges">
          {mainPulse && (
            <span className="pulse-badge pulse-badge-main" title={`Main pulse: ${mainPulse.pulse_name || 'main'}`} />
          )}
          {topicPulses.slice(0, 3).map(p => (
            <span key={p.pulse_id} className="pulse-badge pulse-badge-topic" title={p.pulse_name}>
              {p.pulse_name}
            </span>
          ))}
          {topicPulses.length > 3 && (
            <span className="pulse-badge pulse-badge-overflow">+{topicPulses.length - 3}</span>
          )}
        </div>
      )}

      <div className="card-actions">
        {statusClass === 'waiting' && session.cli_type === 'codex' && (
          <span className="codex-approval-note" title="Codex approval policy is set at launch">
            Codex approval policy is set at launch
          </span>
        )}
        {!isStopped && (
          <select
            className="card-auto-approve"
            value={session.auto_approve}
            onChange={handleAutoApproveChange}
            onClick={e => e.stopPropagation()}
            title="Permission auto-approve level"
          >
            <option value={0}>Manual</option>
            <option value={2}>Read-only</option>
            <option value={1}>Full auto</option>
          </select>
        )}
        {!session.tmux_target && (
          <button className="btn-link-tmux" onClick={handleLinkTmux}>
            Link tmux
          </button>
        )}
        <button className="btn-edit" onClick={handleEdit}>
          Edit
        </button>
        {isStopped && session.snapshot_hash && (
          <button className="btn-revert" onClick={handleRevert}>
            Revert
          </button>
        )}
        {!isStopped && sessionPulses.length > 0 && (
          <button className="btn-brief" onClick={handleBrief} title="Trigger briefing from main pulse">
            Brief
          </button>
        )}
        {!isStopped && sessionPulses.length > 0 && (
          <button className="btn-sync" onClick={handleSync} title="Sync pulse context to session">
            Sync
          </button>
        )}
        {showKill && (
          <button
            className={`btn-kill${isServerSession ? ' btn-kill-protected' : ''}`}
            onClick={handleKill}
            title={isServerSession ? 'Warning: this is the control center session' : 'Kill session'}
          >
            Kill
          </button>
        )}
      </div>

      {editOpen && (
        <EditSessionModal
          isOpen={editOpen}
          onClose={() => setEditOpen(false)}
          session={session}
        />
      )}
      {linkTmuxOpen && (
        <LinkTmuxModal
          isOpen={linkTmuxOpen}
          onClose={() => setLinkTmuxOpen(false)}
          sessionId={session.session_id}
        />
      )}
      {snapshotOpen && (
        <SnapshotDiffModal
          isOpen={snapshotOpen}
          onClose={() => setSnapshotOpen(false)}
          sessionId={session.session_id}
        />
      )}
    </div>
  );
}

export const SessionCard = React.memo(SessionCardInner, (prev, next) => {
  return (
    prev.session.session_id === next.session.session_id &&
    prev.session.updated_at === next.session.updated_at &&
    prev.session.last_heartbeat === next.session.last_heartbeat &&
    prev.session.status === next.session.status &&
    prev.session.pending_tool === next.session.pending_tool &&
    prev.session.auto_approve === next.session.auto_approve &&
    prev.isSelected === next.isSelected &&
    prev.isSelectedRight === next.isSelectedRight
  );
});
