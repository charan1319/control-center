import { useState } from 'react';
import { projectColor } from '../utils';
import { SessionCard } from './SessionCard';
import { PulsePanel } from './PulsePanel';
import { TeamPanel } from './TeamPanel';
import { TodoSection } from './TodoSection';
import type { Session, SessionEvent, ServerInfo } from '../types';
import './ProjectGroup.css';

interface ProjectGroupProps {
  projectName: string;
  sessions: Session[];
  selectedSessionId: string | null;
  selectedRightId?: string | null;
  onSelectSession: (id: string) => void;
  onSelectRight?: (id: string) => void;
  serverInfo: ServerInfo;
  recentEvents: SessionEvent[];
}

export function ProjectGroup({
  projectName,
  sessions,
  selectedSessionId,
  selectedRightId,
  onSelectSession,
  onSelectRight,
  serverInfo,
  recentEvents,
}: ProjectGroupProps) {
  const color = projectColor(projectName);
  const [pulseOpen, setPulseOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

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
          <button
            className="btn-pulse"
            onClick={() => setTeamOpen(true)}
          >
            Teams
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
            isSelectedRight={s.session_id === selectedRightId}
            serverInfo={serverInfo}
            onSelect={() => onSelectSession(s.session_id)}
            onSelectRight={onSelectRight ? () => onSelectRight(s.session_id) : undefined}
            recentEvents={recentEvents}
          />
        ))}
      </div>
      {pulseOpen && projectName && (
        <PulsePanel project={projectName} onClose={() => setPulseOpen(false)} />
      )}
      {teamOpen && projectName && (
        <TeamPanel project={projectName} onClose={() => setTeamOpen(false)} />
      )}
    </div>
  );
}
