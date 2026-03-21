import { useMemo } from 'react';
import { useWebSocket } from './useWebSocket';
import { getStatusClass, groupByProject } from '../utils';

export function useSessions() {
  const { sessions, recentEvents } = useWebSocket();

  const activeCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'active').length, [sessions]);
  const waitingCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'waiting').length, [sessions]);
  const idleCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'idle').length, [sessions]);
  const byProject = useMemo(() => groupByProject(sessions), [sessions]);
  const pendingSessions = useMemo(
    () => sessions
      .filter(s => s.status === 'waiting_permission')
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    [sessions]
  );
  const stoppedSessions = useMemo(
    () => sessions
      .filter(s => s.status === 'stopped')
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    [sessions]
  );

  return { sessions, recentEvents, activeCount, waitingCount, idleCount, byProject, pendingSessions, stoppedSessions };
}
