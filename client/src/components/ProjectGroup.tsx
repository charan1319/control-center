import { useState } from 'react';
import { projectColor } from '../utils';
import { SessionCard } from './SessionCard';
import { PulsePanel } from './PulsePanel';
import { TodoSection } from './TodoSection';
import type { Session, SessionEvent, ServerInfo } from '../types';
import './ProjectGroup.css';

interface ProjectGroupProps {
  projectName: string;
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  serverInfo: ServerInfo;
  recentEvents: SessionEvent[];
}

export function ProjectGroup({
  projectName,
  sessions,
  selectedSessionId,
  onSelectSession,
  serverInfo,
  recentEvents,
}: ProjectGroupProps) {
  const color = projectColor(projectName);
  const [pulseOpen, setPulseOpen] = useState(false);

  return (
    <div className="project-group">
      {projectName && (
        <div
          className="project-heading"
          style={color ? { color, borderLeftColor: color } : undefined}
        >
          {projectName}
          <button
            className="btn-pulse"
            onClick={() => setPulseOpen(true)}
          >
            Pulse
          </button>
        </div>
      )}
      {projectName && <TodoSection project={projectName} />}
      <div className="project-sessions">
        {sessions.map(s => (
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
      {pulseOpen && projectName && (
        <PulsePanel project={projectName} onClose={() => setPulseOpen(false)} />
      )}
    </div>
  );
}
