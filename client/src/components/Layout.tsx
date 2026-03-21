import { useState, useEffect, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api';
import { Header } from './Header';
import { SessionList } from './SessionList';
import { EventLog } from './EventLog';
import { NewSessionModal } from './modals/NewSessionModal';
import { SessionDetail } from './SessionDetail';
import type { ServerInfo } from '../types';
import './Layout.css';

interface LayoutProps {
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseDetail: () => void;
}

const fetchInfo = () => api.getInfo();

export function Layout({ selectedSessionId, onSelectSession, onCloseDetail }: LayoutProps) {
  const { sessions, recentEvents } = useWebSocket();
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  const { data: serverInfo } = useApi<ServerInfo>(fetchInfo);

  const resolvedServerInfo = useMemo<ServerInfo>(
    () => serverInfo || { serverCwd: '', aiSummaryEnabled: false },
    [serverInfo]
  );

  // Find the selected session object
  const selectedSession = useMemo(
    () => selectedSessionId ? sessions.find(s => s.session_id === selectedSessionId) ?? null : null,
    [sessions, selectedSessionId]
  );

  // Escape closes detail panel (but not if a modal is open)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && selectedSessionId && !newSessionOpen) {
        onCloseDetail();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSessionId, onCloseDetail, newSessionOpen]);

  const handleNewSession = useCallback(() => {
    setNewSessionOpen(true);
  }, []);

  return (
    <div className="layout">
      <Header onNewSession={handleNewSession} />

      <div className="layout-main">
        <div className={`layout-left${selectedSessionId ? ' has-selection' : ''}`}>
          <SessionList
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            serverInfo={resolvedServerInfo}
          />
          <EventLog
            recentEvents={recentEvents}
            onSelectSession={onSelectSession}
          />
        </div>

        {selectedSessionId && selectedSession && (
          <div className="layout-right">
            <div className="detail-panel">
              <SessionDetail
                session={selectedSession}
                onClose={onCloseDetail}
              />
            </div>
          </div>
        )}
      </div>

      {/* Mobile overlay backdrop */}
      {selectedSessionId && (
        <div className="layout-overlay" onClick={onCloseDetail} />
      )}

      <NewSessionModal
        isOpen={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
      />
    </div>
  );
}
