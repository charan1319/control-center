import { useMemo, useState, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';
import { getStatusClass, groupByProject } from '../utils';
import { api } from '../api';

export function useSessions() {
  const { sessions, recentEvents } = useWebSocket();
  const [projectOrder, setProjectOrder] = useState<string[]>([]);

  useEffect(() => {
    api.getProjects().then(projects => setProjectOrder(projects.map(p => p.name))).catch(() => {});
  }, []);

  const activeCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'active').length, [sessions]);
  const waitingCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'waiting').length, [sessions]);
  const idleCount = useMemo(() => sessions.filter(s => getStatusClass(s) === 'idle').length, [sessions]);
  const byProject = useMemo(() => groupByProject(sessions, projectOrder), [sessions, projectOrder]);
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
