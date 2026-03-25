import type {
  Session, SessionEvent, TranscriptEntry, FileEdit,
  Todo, PulseDocument, ProjectPreset, SessionTemplate,
  ServerInfo, VersionInfo, Stats,
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
  launchSession: (data: { label?: string; cwd?: string; initialPrompt?: string; project?: string; cli_type?: string; skipPermissions?: boolean }) =>
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
    return fetchJson<{ entries: TranscriptEntry[]; hasMore: boolean; turnComplete?: boolean }>(`/api/sessions/${id}/transcript${qs ? '?' + qs : ''}`);
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

  // Phase 2
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

  // Phase 3
  getPulse: (project: string) =>
    fetchJson<PulseDocument>(`/api/projects/${encodeURIComponent(project)}/pulse`),
  updatePulseNotes: (project: string, notes: string) =>
    put<{ ok: boolean }>(`/api/projects/${encodeURIComponent(project)}/pulse/notes`, { notes }),
  getTodos: (project: string) =>
    fetchJson<{ todos: Todo[] }>(`/api/todos?project=${encodeURIComponent(project)}`),
  createTodo: (data: { project: string; title: string; details?: string; priority?: number }) =>
    post<Todo>('/api/todos', data),
  updateTodo: (id: number, data: Partial<Todo>) =>
    patch<{ ok: boolean }>(`/api/todos/${id}`, data),
  deleteTodo: (id: number) =>
    del<{ ok: boolean }>(`/api/todos/${id}`),
  launchTodo: (id: number, skipPermissions?: boolean) =>
    post<{ success: boolean; tmux_target: string; todo_id: number }>(`/api/todos/${id}/launch`, { skipPermissions }),

  // Push notifications
  getVapidKey: () => fetchJson<{ publicKey: string; enabled: boolean }>('/api/push/vapid-public-key'),
  subscribePush: (sub: PushSubscriptionJSON) =>
    post<{ ok: boolean }>('/api/push/subscribe', sub),
  unsubscribePush: (endpoint: string) =>
    del<{ ok: boolean }>('/api/push/unsubscribe', { endpoint }),
};
