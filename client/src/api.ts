import type {
  Session, SessionEvent, TranscriptEntry, ContextUsage, FileEdit,
  Todo, PulseDocument, ProjectPreset, SessionTemplate,
  ServerInfo, VersionInfo, Stats,
  Pulse, PulseEntry, TeamTemplate, TeamInstance,
} from './types';

const BASE = '';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

function post<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetchJson<T>(url, init);
}

function put<T>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'DELETE' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetchJson<T>(url, init);
}

export const api = {
  // Sessions
  getSessions: () => fetchJson<Session[]>('/api/sessions'),
  getSession: (id: string) => fetchJson<Session>(`/api/sessions/${id}`),
  patchSession: (id: string, data: Partial<Pick<Session, 'label' | 'tmux_target' | 'project' | 'pulse_enabled' | 'auto_approve'>>) =>
    patch<Session>(`/api/sessions/${id}`, data),
  launchSession: (data: { label?: string; cwd?: string; initialPrompt?: string; project?: string; cli_type?: string }) =>
    post<{ success: boolean; tmux_target: string }>('/api/sessions/launch', data),
  sendInput: (id: string, text: string) =>
    post<{ ok: boolean }>(`/api/sessions/${id}/input`, { text }),
  killSession: (id: string) =>
    post<{ ok: boolean }>(`/api/sessions/${id}/kill`),
  grantPermission: (id: string) =>
    post<{ ok: boolean }>(`/api/sessions/${id}/grant-permission`),
  getPreview: (id: string) =>
    fetchJson<{ text: string | null }>(`/api/sessions/${id}/preview`),
  getSummary: (id: string) =>
    fetchJson<{ summary: string | null }>(`/api/sessions/${id}/summary`),
  getTranscript: (id: string, limit?: number, before?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const qs = params.toString();
    return fetchJson<{ entries: TranscriptEntry[]; hasMore: boolean; turnComplete?: boolean; contextUsage?: ContextUsage }>(`/api/sessions/${id}/transcript${qs ? '?' + qs : ''}`);
  },
  getSessionFiles: (id: string) =>
    fetchJson<{ files: FileEdit[] }>(`/api/sessions/${id}/files`),
  getEvents: (limit?: number) =>
    fetchJson<SessionEvent[]>(`/api/events${limit ? '?limit=' + limit : ''}`),
  getSessionEvents: (id: string, limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return fetchJson<SessionEvent[]>(`/api/sessions/${id}/events${qs ? '?' + qs : ''}`);
  },
  getTerminalCapture: (id: string) =>
    fetchJson<{ text: string }>(`/api/sessions/${id}/terminal-capture`),

  // Projects & Templates
  getProjects: () => fetchJson<ProjectPreset[]>('/api/projects'),
  putProjects: (projects: ProjectPreset[]) => put<{ ok: boolean }>('/api/projects', projects),
  getTemplates: () => fetchJson<SessionTemplate[]>('/api/templates'),
  createTemplate: (data: Partial<SessionTemplate>) => post<SessionTemplate>('/api/templates', data),
  updateTemplate: (id: string, data: Partial<SessionTemplate>) => put<SessionTemplate>(`/api/templates/${id}`, data),
  deleteTemplate: (id: string) => del<{ ok: boolean }>(`/api/templates/${id}`),

  // Info
  getTmuxSessions: () => fetchJson<string[]>('/api/tmux-sessions'),
  getInfo: () => fetchJson<ServerInfo>('/api/info'),
  getVersion: () => fetchJson<VersionInfo>('/api/version'),
  getStats: () => fetchJson<Stats>('/api/stats'),
  triggerUpdate: () => post<{ status: string }>('/api/update'),
  cleanupZombies: () => post<{ cleaned: number }>('/api/sessions/cleanup-zombies'),

  // Snapshots & History
  getSnapshotDiff: (id: string) =>
    fetchJson<{ added: string[]; modified: string[]; deleted: string[] }>(`/api/sessions/${id}/snapshot-diff`),
  revertSession: (id: string) =>
    post<{ reverted: boolean; files: string[] }>(`/api/sessions/${id}/revert`),
  searchHistory: (params: { project?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params.project) sp.set('project', params.project);
    if (params.q) sp.set('q', params.q);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    return fetchJson<{ sessions: Session[]; total: number }>(`/api/sessions/history?${sp}`);
  },

  // Pulse (backward compat)
  getPulse: (project: string) =>
    fetchJson<PulseDocument>(`/api/projects/${encodeURIComponent(project)}/pulse`),
  updatePulseNotes: (project: string, notes: string) =>
    put<{ ok: boolean }>(`/api/projects/${encodeURIComponent(project)}/pulse/notes`, { notes }),

  // Pulse CRUD
  getProjectPulses: (project: string) =>
    fetchJson<{ pulses: Pulse[] }>(`/api/projects/${encodeURIComponent(project)}/pulses`).then(r => r.pulses),
  createPulse: (project: string, data: { name: string; description?: string }) =>
    post<Pulse>(`/api/projects/${encodeURIComponent(project)}/pulses`, data),
  updatePulseMetadata: (id: string, data: { name?: string; description?: string }) =>
    patch<Pulse>(`/api/pulses/${id}`, data),
  deletePulse: (id: string) =>
    del<{ ok: boolean }>(`/api/pulses/${id}`),

  // Pulse entries
  getPulseEntries: (id: string, limit?: number, before?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const qs = params.toString();
    return fetchJson<{ entries: PulseEntry[] }>(`/api/pulses/${id}/entries${qs ? '?' + qs : ''}`).then(r => r.entries);
  },
  addPulseEntry: (id: string, data: { content: string; entry_type?: string }) =>
    post<PulseEntry>(`/api/pulses/${id}/entries`, data),
  deletePulseEntry: (pulseId: string, entryId: number) =>
    del<{ ok: boolean }>(`/api/pulses/${pulseId}/entries/${entryId}`),
  triggerDream: (id: string) =>
    post<{ ok: boolean }>(`/api/pulses/${id}/dream`),

  // Pulse members
  getPulseMembers: (id: string) =>
    fetchJson<Array<{ session_id: string; label: string; status: string }>>(`/api/pulses/${id}/members`),
  addPulseMember: (pulseId: string, sessionId: string) =>
    post<{ ok: boolean }>(`/api/pulses/${pulseId}/members`, { session_id: sessionId }),
  removePulseMember: (pulseId: string, sessionId: string) =>
    del<{ ok: boolean }>(`/api/pulses/${pulseId}/members/${sessionId}`),

  // Pulse content
  getPulseContent: (id: string) =>
    fetchJson<{ content: string }>(`/api/pulses/${id}/content`),
  getSessionPulseContext: (id: string) =>
    fetchJson<{ context: string }>(`/api/sessions/${id}/pulse-context`),

  // Briefing & Sync
  triggerBrief: (id: string, pulseId: string) =>
    post<{ ok: boolean }>(`/api/sessions/${id}/brief`, { pulse_id: pulseId }),
  syncPulse: (id: string) =>
    post<{ ok: boolean }>(`/api/sessions/${id}/sync-pulse`),

  // Todos
  getTodos: (project: string) =>
    fetchJson<{ todos: Todo[] }>(`/api/todos?project=${encodeURIComponent(project)}`),
  createTodo: (data: { project: string; title: string; details?: string; priority?: number }) =>
    post<Todo>('/api/todos', data),
  updateTodo: (id: number, data: Partial<Todo>) =>
    patch<{ ok: boolean }>(`/api/todos/${id}`, data),
  deleteTodo: (id: number) =>
    del<{ ok: boolean }>(`/api/todos/${id}`),
  launchTodo: (id: number) =>
    post<{ success: boolean; tmux_target: string; todo_id: number }>(`/api/todos/${id}/launch`, {}),

  // Push notifications
  getVapidKey: () => fetchJson<{ publicKey: string; enabled: boolean }>('/api/push/vapid-public-key'),
  subscribePush: (sub: PushSubscriptionJSON) =>
    post<{ ok: boolean }>('/api/push/subscribe', sub),
  unsubscribePush: (endpoint: string) =>
    del<{ ok: boolean }>('/api/push/unsubscribe', { endpoint }),

  // Team templates
  getTeamTemplates: () => fetchJson<TeamTemplate[]>('/api/team-templates'),
  createTeamTemplate: (data: { name: string; description?: string; roles: unknown; coordinator_prompt: string; project?: string }) =>
    post<TeamTemplate>('/api/team-templates', data),
  updateTeamTemplate: (id: string, data: Partial<TeamTemplate>) =>
    put<TeamTemplate>(`/api/team-templates/${id}`, data),
  deleteTeamTemplate: (id: string) =>
    del<{ ok: boolean }>(`/api/team-templates/${id}`),
  launchTeam: (templateId: string, data: { objective: string; project?: string }) =>
    post<TeamInstance>(`/api/team-templates/${templateId}/launch`, data),

  // Team instances
  getTeams: (project?: string) => {
    const qs = project ? `?project=${encodeURIComponent(project)}` : '';
    return fetchJson<{ teams: TeamInstance[] }>(`/api/teams${qs}`);
  },
  getTeam: (id: string) => fetchJson<TeamInstance>(`/api/teams/${id}`),
  stopTeam: (id: string) => post<{ ok: boolean }>(`/api/teams/${id}/stop`),
};
