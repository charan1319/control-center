import { useCallback, useMemo } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSessions } from '../hooks/useSessions';
import { useApi } from '../hooks/useApi';
import { api } from '../api';
import type { Stats, VersionInfo } from '../types';
import './Header.css';

interface HeaderProps {
  onNewSession: () => void;
  onHistoryOpen: () => void;
}

const fetchStats = () => api.getStats();
const fetchVersion = () => api.getVersion();

export function Header({ onNewSession, onHistoryOpen }: HeaderProps) {
  const { connectionStatus } = useWebSocket();
  const { sessions, activeCount, waitingCount, idleCount } = useSessions();

  const { data: stats } = useApi<Stats>(fetchStats, { refreshInterval: 60000 });
  const { data: version } = useApi<VersionInfo>(fetchVersion);

  const statusClass = connectionStatus === 'connected' ? 'connected'
    : connectionStatus === 'reconnecting' ? 'reconnecting'
    : 'disconnected';

  const statusTitle = connectionStatus === 'connected' ? 'Connected'
    : connectionStatus === 'reconnecting' ? 'Reconnecting...'
    : 'Disconnected';

  const handleUpdate = useCallback(async () => {
    try {
      await api.triggerUpdate();
    } catch {
      // update.sh handles restart
    }
  }, []);

  const hasSessions = sessions.length > 0;

  const statsChips = useMemo(() => {
    if (!stats) return null;
    const chips: string[] = [];
    if (stats.totalSessions > 0) chips.push(`${stats.totalSessions} total`);
    if (stats.sessionsThisWeek > 0) chips.push(`${stats.sessionsThisWeek} this week`);
    if (stats.mostUsedTool) chips.push(`top tool: ${stats.mostUsedTool}`);
    if (stats.estimatedCostUsd > 0) chips.push(`~$${stats.estimatedCostUsd.toFixed(2)} est. API cost`);
    if (stats.totalInputTokens > 0 || stats.totalOutputTokens > 0) {
      const total = stats.totalInputTokens + stats.totalOutputTokens;
      const fmt = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : total >= 1_000 ? `${Math.round(total / 1_000)}K` : String(total);
      chips.push(`${fmt} tokens`);
    }
    return chips;
  }, [stats]);

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">
          <span className="header-title-accent">Control</span> Center
        </h1>
        <span
          className={`status-dot ${statusClass}`}
          title={statusTitle}
        />
      </div>
      <div className="header-right">
        <button className="btn-history" onClick={onHistoryOpen}>
          History
        </button>
        <button className="btn-new-session" onClick={onNewSession}>
          + New Session
        </button>
      </div>

      {/* Summary bar */}
      {hasSessions && (
        <div className="header-summary">
          <span className="sum-active">{activeCount} active</span>
          <span className="sum-sep">&middot;</span>
          <span className="sum-waiting">{waitingCount} waiting</span>
          <span className="sum-sep">&middot;</span>
          <span className="sum-idle">{idleCount} idle</span>
        </div>
      )}

      {/* Stats bar */}
      {statsChips && statsChips.length > 0 && (
        <div className="header-stats">
          {statsChips.map((chip, i) => (
            <span key={i}>
              {i > 0 && <span className="stat-sep">&middot;</span>}
              <span className="stat-chip">{chip}</span>
            </span>
          ))}
        </div>
      )}

      {/* Update banner */}
      {version?.updateAvailable && (
        <div className="update-banner">
          <span>
            Update available: v{version.current} &rarr; v{version.latest}
          </span>
          <button className="update-btn" onClick={handleUpdate}>
            Update Now
          </button>
        </div>
      )}

      {/* Connection banner */}
      {(connectionStatus === 'reconnecting' || connectionStatus === 'disconnected') && (
        <div className="connection-banner">
          <div className="banner-spinner" />
          <span>Reconnecting to server...</span>
        </div>
      )}
    </header>
  );
}
