import { useState, useEffect, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api';
import { Header } from './Header';
import { SessionList } from './SessionList';
import { EventLog } from './EventLog';
import { HistoryView } from './HistoryView';
import { NewSessionModal } from './modals/NewSessionModal';
import { SessionDetail } from './SessionDetail';
import type { ServerInfo } from '../types';
import './Layout.css';

interface LayoutProps {
  selectedLeft: string | null;
  selectedRight: string | null;
  onSelectSession: (id: string) => void;
  onSelectRight: (id: string) => void;
  onCloseLeft: () => void;
  onCloseRight: () => void;
}

const fetchInfo = () => api.getInfo();

export function Layout({ selectedLeft, selectedRight, onSelectSession, onSelectRight, onCloseLeft, onCloseRight }: LayoutProps) {
  const { sessions, recentEvents } = useWebSocket();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { data: serverInfo } = useApi<ServerInfo>(fetchInfo);

  const resolvedServerInfo = useMemo<ServerInfo>(
    () => serverInfo || { serverCwd: '', aiSummaryEnabled: false },
    [serverInfo]
  );

  const selectedSessionLeft = useMemo(
    () => selectedLeft ? sessions.find(s => s.session_id === selectedLeft) ?? null : null,
    [sessions, selectedLeft]
  );

  const selectedSessionRight = useMemo(
    () => selectedRight ? sessions.find(s => s.session_id === selectedRight) ?? null : null,
    [sessions, selectedRight]
  );

  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1200;
  const hasAnySelection = !!(selectedLeft || selectedRight);
  const hasSplit = !!(selectedSessionLeft && selectedSessionRight && isDesktop);

  // Escape closes right panel first, then left
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !newSessionOpen) {
        if (selectedRight) {
          onCloseRight();
        } else if (selectedLeft) {
          onCloseLeft();
        } else if (historyOpen) {
          setHistoryOpen(false);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedLeft, selectedRight, onCloseLeft, onCloseRight, newSessionOpen, historyOpen]);

  const handleNewSession = useCallback(() => {
    setNewSessionOpen(true);
  }, []);

  const handleHistoryOpen = useCallback(() => {
    setHistoryOpen(true);
  }, []);

  const handleHistorySelect = useCallback((id: string) => {
    setHistoryOpen(false);
    onSelectSession(id);
  }, [onSelectSession]);

  return (
    <div className="layout">
      <Header onNewSession={handleNewSession} onHistoryOpen={handleHistoryOpen} />

      <div className="layout-main">
        <div className={`layout-left${hasAnySelection ? ' has-selection' : ''}${hasSplit ? ' has-split' : ''}`}>
          {historyOpen ? (
            <HistoryView
              onClose={() => setHistoryOpen(false)}
              onSelectSession={handleHistorySelect}
            />
          ) : (
            <>
              <SessionList
                selectedSessionId={selectedLeft}
                selectedRightId={selectedRight}
                onSelectSession={onSelectSession}
                onSelectRight={onSelectRight}
                serverInfo={resolvedServerInfo}
              />
              <EventLog
                recentEvents={recentEvents}
                onSelectSession={onSelectSession}
              />
            </>
          )}
        </div>

        {selectedSessionLeft && (
          <div className={`layout-right${hasSplit ? ' split' : ''}`}>
            <div className="detail-panel">
              <SessionDetail
                key={selectedSessionLeft.session_id}
                session={selectedSessionLeft}
                onClose={onCloseLeft}
              />
            </div>
          </div>
        )}

        {isDesktop && selectedSessionRight && (
          <div className="layout-right split">
            <div className="detail-panel">
              <SessionDetail
                key={selectedSessionRight.session_id}
                session={selectedSessionRight}
                onClose={onCloseRight}
              />
            </div>
          </div>
        )}
      </div>

      {/* Mobile overlay backdrop — only for single panel */}
      {hasAnySelection && !isDesktop && (
        <div className="layout-overlay" onClick={selectedRight ? onCloseRight : onCloseLeft} />
      )}

      <NewSessionModal
        isOpen={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
      />
    </div>
  );
}
