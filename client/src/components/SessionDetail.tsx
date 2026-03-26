import { useState, useCallback, useRef, useEffect } from 'react';
import { getStatusClass } from '../utils';
import { api } from '../api';
import { useToast } from './Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { TranscriptView } from './TranscriptView';
import type { QueuedMessage } from './TranscriptView';
import { TerminalView } from './TerminalView';
import { InputBar } from './InputBar';
import type { Session, ContextUsage } from '../types';
import './SessionDetail.css';

interface SessionDetailProps {
  session: Session;
  onClose: () => void;
}

type TabId = 'transcript' | 'terminal';

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function SessionDetail({ session, onClose }: SessionDetailProps) {
  const { showToast } = useToast();
  const { transcriptVersion, getLatestContextUsage } = useWebSocket();
  const hasTmux = !!session.tmux_target;
  const [activeTab, setActiveTab] = useState<TabId>('transcript');
  const terminalWsRef = useRef<WebSocket | null>(null);
  const [, forceUpdate] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const nextQueueId = useRef(0);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

  // Fetch initial context usage
  useEffect(() => {
    setContextUsage(null);
    api.getTranscript(session.session_id, 1).then(data => {
      if (data.contextUsage) setContextUsage(data.contextUsage);
    }).catch(() => {});
  }, [session.session_id]);

  // Update from WS
  useEffect(() => {
    const latest = getLatestContextUsage(session.session_id);
    if (latest) setContextUsage(latest);
  }, [session.session_id, transcriptVersion, getLatestContextUsage]);

  const handleSendMessage = useCallback(async (text: string) => {
    const id = nextQueueId.current++;
    setQueuedMessages(prev => [...prev, { id, text, sent: false }]);
    setTimeout(() => setQueuedMessages(prev => prev.filter(m => m.id !== id)), 60000);
    try {
      await api.sendInput(session.session_id, text);
      setQueuedMessages(prev => prev.map(m => m.id === id ? { ...m, sent: true } : m));
    } catch {
      // Remove on failure — message was never delivered
      setQueuedMessages(prev => prev.filter(m => m.id !== id));
      showToast('Failed to send message', 'error');
    }
  }, [session.session_id, showToast]);

  const statusClass = getStatusClass(session);
  const label = session.label || session.session_id.slice(0, 12);

  const handleAutoApproveChange = useCallback(async (value: number) => {
    try {
      await api.patchSession(session.session_id, { auto_approve: value });
    } catch {
      showToast('Failed to update auto-approve', 'error');
    }
  }, [session.session_id, showToast]);

  const handleWsReady = useCallback((ws: WebSocket | null) => {
    terminalWsRef.current = ws;
    forceUpdate(n => n + 1);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-todo')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-todo');
    if (!raw) return;
    e.preventDefault();
    try {
      const todo = JSON.parse(raw);
      const text = `## Task: ${todo.title}${todo.details ? '\n' + todo.details : ''}`;
      await api.sendInput(session.session_id, text);
      showToast(`Sent "${todo.title}"`, 'success');
    } catch {
      showToast('Failed to send todo', 'error');
    }
  }, [session.session_id, showToast]);

  // On desktop, hide InputBar for terminal tab (xterm captures keyboard).
  // On mobile, show it always.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const showInputBar = activeTab === 'transcript' || isMobile;

  return (
    <div className="session-detail" onDragOver={handleDragOver} onDrop={handleDrop}>
      {/* Header */}
      <div className="sd-header">
        <span className="sd-label" title={session.session_id}>{label}</span>
        <span className={`sd-status-badge ${statusClass}`}>{statusClass}</span>
        <button className="sd-close" onClick={onClose}>&times;</button>
      </div>

      {/* Tab bar */}
      <div className="sd-tabs">
        <button
          className={`sd-tab${activeTab === 'transcript' ? ' active' : ''}`}
          onClick={() => setActiveTab('transcript')}
        >
          Chat
        </button>
        {hasTmux && (
          <button
            className={`sd-tab${activeTab === 'terminal' ? ' active' : ''}`}
            onClick={() => setActiveTab('terminal')}
          >
            Terminal
          </button>
        )}
        {session.status !== 'stopped' && (
          <select
            className="sd-auto-approve"
            value={session.auto_approve}
            onChange={e => handleAutoApproveChange(Number(e.target.value))}
            title="Permission auto-approve level"
          >
            <option value={0}>Manual</option>
            <option value={2}>Read-only</option>
            <option value={1}>Full auto</option>
          </select>
        )}
        {contextUsage && (
          <ContextMeter usage={contextUsage} />
        )}
      </div>

      {/* Content */}
      <div className="sd-content">
        {activeTab === 'transcript' && (
          <TranscriptView
            sessionId={session.session_id}
            session={session}
            queuedMessages={queuedMessages}
          />
        )}
        {activeTab === 'terminal' && hasTmux && (
          <TerminalView
            sessionId={session.session_id}
            tmuxTarget={session.tmux_target!}
            onWsReady={handleWsReady}
          />
        )}
      </div>

      {/* Input bar */}
      {showInputBar && (
        <InputBar
          sessionId={session.session_id}
          mode={activeTab}
          terminalWs={terminalWsRef.current}
          onSendMessage={handleSendMessage}
        />
      )}
    </div>
  );
}

function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { used, contextWindow } = usage;
  if (!contextWindow) {
    // No known window (e.g. unknown model) — just show used tokens
    return (
      <div className="sd-context-meter" title={`${used.toLocaleString()} input tokens used`}>
        <span className="sd-context-text">{formatTokenCount(used)}</span>
      </div>
    );
  }

  const pct = Math.min((used / contextWindow) * 100, 100);
  const barColor = pct > 80 ? 'var(--color-warning)' : pct > 50 ? 'var(--ctp-yellow)' : 'var(--color-success)';

  return (
    <div
      className="sd-context-meter"
      title={`${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    >
      <span className="sd-context-text">
        {formatTokenCount(used)}<span className="sd-context-sep">/</span>{formatTokenCount(contextWindow)}
      </span>
      <div className="sd-context-bar">
        <div className="sd-context-fill" style={{ width: `${pct}%`, background: barColor }} />
      </div>
    </div>
  );
}
