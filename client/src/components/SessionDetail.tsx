import { useState, useCallback, useRef } from 'react';
import { getStatusClass } from '../utils';
import { api } from '../api';
import { useToast } from './Toast';
import { TranscriptView } from './TranscriptView';
import { TerminalView } from './TerminalView';
import { InputBar } from './InputBar';
import type { Session } from '../types';
import './SessionDetail.css';

interface SessionDetailProps {
  session: Session;
  onClose: () => void;
}

type TabId = 'transcript' | 'terminal';

export function SessionDetail({ session, onClose }: SessionDetailProps) {
  const { showToast } = useToast();
  const hasTmux = !!session.tmux_target;
  const [activeTab, setActiveTab] = useState<TabId>('transcript');
  const terminalWsRef = useRef<WebSocket | null>(null);
  const [, forceUpdate] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);

  const statusClass = getStatusClass(session);
  const label = session.label || session.session_id.slice(0, 12);

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
      </div>

      {/* Content */}
      <div className="sd-content">
        {activeTab === 'transcript' && (
          <TranscriptView sessionId={session.session_id} session={session} queuedMessages={queuedMessages} />
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
          onMessageSent={(text) => {
            setQueuedMessages(prev => [...prev, text]);
            // Clear queued messages after 10s (transcript should have confirmed by then)
            setTimeout(() => setQueuedMessages(prev => prev.filter(m => m !== text)), 10000);
          }}
        />
      )}
    </div>
  );
}
