import { useState, useEffect } from 'react';
import { useSessions } from '../hooks/useSessions';
import { ProjectGroup } from './ProjectGroup';
import { SessionCard } from './SessionCard';
import type { ServerInfo } from '../types';
import './SessionList.css';

interface SessionListProps {
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  serverInfo: ServerInfo;
}

export function SessionList({ selectedSessionId, onSelectSession, serverInfo }: SessionListProps) {
  const { sessions, recentEvents, byProject, stoppedSessions } = useSessions();

  // 15s tick for age refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 15000);
    return () => clearInterval(t);
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="session-list">
        <div className="empty-state">
          <div className="empty-state-icon">&gt;_</div>
          <h3>No sessions yet</h3>
          <p>
            Claude Code sessions will appear here automatically when you start them.
            <br />
            Open a terminal and run <code>claude</code> in any project directory.
          </p>
        </div>
      </div>
    );
  }

  const hasActive = byProject.size > 0;

  return (
    <div className="session-list">
      <div className="sessions-grid">
        {hasActive ? (
          Array.from(byProject.entries()).map(([project, projectSessions]) => (
            <ProjectGroup
              key={project || '__ungrouped__'}
              projectName={project}
              sessions={projectSessions}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              serverInfo={serverInfo}
              recentEvents={recentEvents}
            />
          ))
        ) : (
          <div className="empty-state" style={{ padding: '30px 20px' }}>
            <div className="empty-state-icon">&gt;_</div>
            <h3>No active sessions</h3>
            <p>All sessions are stopped. Launch a new one to get started.</p>
          </div>
        )}

        {stoppedSessions.length > 0 && (
          <details className="stopped-section">
            <summary className="stopped-heading">
              Closed Sessions ({stoppedSessions.length})
            </summary>
            <div className="project-sessions stopped-sessions">
              {stoppedSessions.map(s => (
                <SessionCard
                  key={s.session_id}
                  session={s}
                  isSelected={s.session_id === selectedSessionId}
                  serverInfo={serverInfo}
                  onSelect={() => onSelectSession(s.session_id)}
                  recentEvents={recentEvents}
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
