import { useState, useCallback, useRef } from 'react';
import { getStatusClass } from '../utils';
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
  const hasTmux = !!session.tmux_target;
  const [activeTab, setActiveTab] = useState<TabId>('transcript');
  const terminalWsRef = useRef<WebSocket | null>(null);
  const [, forceUpdate] = useState(0);

  const statusClass = getStatusClass(session);
  const label = session.label || session.session_id.slice(0, 12);

  const handleWsReady = useCallback((ws: WebSocket | null) => {
    terminalWsRef.current = ws;
    forceUpdate(n => n + 1);
  }, []);

  // On desktop, hide InputBar for terminal tab (xterm captures keyboard).
  // On mobile, show it always.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const showInputBar = activeTab === 'transcript' || isMobile;

  return (
    <div className="session-detail">
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
          Transcript
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
          <TranscriptView sessionId={session.session_id} />
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
        />
      )}
    </div>
  );
}
