// ─── Database models (match server responses) ───

export interface Session {
  session_id: string;
  cwd: string;
  model: string;
  transcript: string | null;
  tmux_target: string | null;
  status: 'active' | 'waiting_permission' | 'stopped';
  label: string | null;
  project: string | null;
  auto_approve: number;
  pending_tool: string | null;
  pending_tool_input: string | null;
  created_at: string;
  updated_at: string;
  // Joined from heartbeats
  last_tool: string | null;
  last_heartbeat: string | null;
  tool_count: number;
  // Added in later phases (optional until then)
  cli_type?: 'claude' | 'gemini' | 'codex';
  snapshot_hash?: string | null;
  pulse_enabled?: number;
  files?: FileEdit[];
  conflicts?: string[];
}

export interface SessionEvent {
  id: number;
  session_id: string;
  event: string;
  tool_name: string | null;
  tool_input: string | null;
  created_at: string;
  // Enrichments from server
  auto_approved?: boolean;
  // Display helpers (joined from session)
  label?: string;
  session_cwd?: string;
  cwd?: string;
  timestamp?: string;
}

export interface FileEdit {
  file_path: string;
  tool_name: string;
  last_edited: string;
}

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'system';
  subtype?: 'task_notification' | 'compact' | 'local_command';
  content: string;
  detail?: string;
  status?: string;
  tool_name?: string;
  tool_input_summary?: string;
  tool_input_full?: string;
  tool_result?: string;
  is_error?: boolean;
  timestamp?: string;
  stop_reason?: string;
}

export interface ContextUsage {
  used: number;
  output: number;
  contextWindow: number | null;
}

export interface Todo {
  id: number;
  project: string;
  title: string;
  details: string;
  status: 'pending' | 'in_progress' | 'done';
  priority: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PulseDocument {
  markdown: string;
  userNotes: string;
}

export interface ProjectPreset {
  name: string;
  cwd: string;
}

export interface SessionTemplate {
  id: string;
  name: string;
  label?: string;
  cwd?: string;
  project?: string;
  autoApprove?: number;
  prompt?: string;
}

export interface ServerInfo {
  serverCwd: string;
  aiSummaryEnabled: boolean;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export interface Stats {
  totalSessions: number;
  sessionsThisWeek: number;
  totalEvents: number;
  mostUsedTool: string | null;
  avgDurationMinutes: number;
  aiSummaryCalls: number;
  aiCostUsd: number;
}

// ─── WebSocket messages ───

export type WSIncoming =
  | { type: 'init'; sessions: Session[]; recentEvents: SessionEvent[] }
  | { type: 'session_update'; session: Session }
  | { type: 'event'; event: string; session_id: string; tool_name?: string; tool_input?: string; timestamp?: string; auto_approved?: boolean }
  | { type: 'transcript_update'; session_id: string; entries: TranscriptEntry[]; turnComplete?: boolean; contextUsage?: ContextUsage }
  | { type: 'todo_session_stopped'; todo_id: number; session_id: string };

export type WSOutgoing =
  | { type: 'subscribe_transcript'; session_id: string }
  | { type: 'unsubscribe_transcript' };

// ─── Derived UI types ───

export type StatusClass = 'active' | 'idle' | 'waiting' | 'stopped';
