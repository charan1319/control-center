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
  // Pulse evolution additions
  parent_session_id?: string | null;
  last_idle_signal?: string | null;
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

// ─── Pulse types ───

export interface Pulse {
  id: string;
  project: string;
  name: string;
  description: string;
  is_main: number;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PulseEntry {
  id: number;
  pulse_id: string;
  session_id: string | null;
  session_label?: string;
  entry_type: 'briefing' | 'file_change' | 'status' | 'user_note' | 'compaction';
  content: string;
  created_at: string;
}

export interface PulseMembership {
  session_id: string;
  pulse_id: string;
  pulse_name: string;
  is_main: number;
}

// ─── Team types ───

export interface TeamRole {
  name: string;
  description: string;
  agent_type: string;
  auto_approve: 'full' | 'readonly' | 'none';
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: TeamRole[] | string; // JSON string from DB or parsed array
  coordinator_prompt: string;
  project?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamInstance {
  id: string;
  template_id: string;
  project: string;
  lead_session_id: string | null;
  status: 'active' | 'completed' | 'failed';
  objective: string;
  summary?: string | null;
  created_at: string;
  completed_at?: string | null;
}

// ─── WebSocket messages ───

export type WSIncoming =
  | { type: 'init'; sessions: Session[]; recentEvents: SessionEvent[]; pulseMemberships?: PulseMembership[] }
  | { type: 'session_update'; session: Session }
  | { type: 'event'; event: string; session_id: string; tool_name?: string; tool_input?: string; timestamp?: string; auto_approved?: boolean }
  | { type: 'transcript_update'; session_id: string; entries: TranscriptEntry[]; turnComplete?: boolean; contextUsage?: ContextUsage }
  | { type: 'todo_session_stopped'; todo_id: number; session_id: string }
  // Pulse events
  | { type: 'pulse_entry'; pulse_id: string; entry: PulseEntry }
  | { type: 'pulse_update'; pulse: Pulse }
  | { type: 'pulse_deleted'; pulse_id: string }
  | { type: 'pulse_member_added'; pulse_id: string; session_id: string }
  | { type: 'pulse_member_removed'; pulse_id: string; session_id: string }
  // Subagent events
  | { type: 'subagent_started'; parent_session_id: string; session: Session }
  | { type: 'subagent_stopped'; parent_session_id: string; session_id: string }
  // Task events
  | { type: 'task_created'; session_id: string; task_subject: string }
  | { type: 'task_completed'; session_id: string; task_subject: string }
  // Team events
  | { type: 'team_launched'; team: TeamInstance }
  | { type: 'team_completed'; team_id: string; summary: string };

export type WSOutgoing =
  | { type: 'subscribe_transcript'; session_id: string }
  | { type: 'unsubscribe_transcript' };

// ─── Derived UI types ───

export type StatusClass = 'active' | 'idle' | 'waiting' | 'stopped';
