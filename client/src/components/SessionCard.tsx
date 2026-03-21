import React, { useState, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api';
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
  serverInfo: ServerInfo;
  onSelect: () => void;
  recentEvents: SessionEvent[];
}

function SessionCardInner({ session, isSelected, serverInfo, onSelect, recentEvents }: SessionCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [linkTmuxOpen, setLinkTmuxOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);

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
    } catch {
      // handled by WS update
    }
  }, [session.session_id]);

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

  const handleTerminal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect();
  }, [onSelect]);

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

  return (
    <div
      className={`session-card status-${statusClass}${isSelected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <div className="card-header">
        <span className={`indicator ${statusClass}`} />
        <span className="card-label" title={label}>{escapeHtml(label)}</span>
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

      <div className="card-actions">
        {statusClass === 'waiting' && session.tmux_target && (
          <button className="btn-grant" onClick={handleGrant}>
            Grant
          </button>
        )}
        {session.tmux_target ? (
          <button className="btn-terminal" onClick={handleTerminal}>
            Terminal
          </button>
        ) : (
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
    prev.isSelected === next.isSelected
  );
});
