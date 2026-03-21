import { useEffect, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api';
import { Header } from './Header';
import { SessionList } from './SessionList';
import { EventLog } from './EventLog';
import type { ServerInfo } from '../types';
import './Layout.css';

interface LayoutProps {
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseDetail: () => void;
}

const fetchInfo = () => api.getInfo();

export function Layout({ selectedSessionId, onSelectSession, onCloseDetail }: LayoutProps) {
  const { recentEvents } = useWebSocket();

  const { data: serverInfo } = useApi<ServerInfo>(fetchInfo);

  const resolvedServerInfo = useMemo<ServerInfo>(
    () => serverInfo || { serverCwd: '', aiSummaryEnabled: false },
    [serverInfo]
  );

  // Escape closes detail panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && selectedSessionId) {
        onCloseDetail();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSessionId, onCloseDetail]);

  const handleNewSession = useCallback(() => {
    // New session modal will be wired in a later phase
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

        {selectedSessionId && (
          <div className="layout-right">
            <div className="detail-panel">
              <div className="detail-header">
                <span className="detail-title">Session Detail</span>
                <button className="detail-close" onClick={onCloseDetail}>
                  &times;
                </button>
              </div>
              <div className="detail-placeholder">
                <p>Terminal and session detail will be implemented in a later phase.</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile overlay backdrop */}
      {selectedSessionId && (
        <div className="layout-overlay" onClick={onCloseDetail} />
      )}
    </div>
  );
}
