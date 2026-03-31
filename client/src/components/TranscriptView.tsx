import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { useTranscript } from '../hooks/useTranscript';
import { api } from '../api';
import { formatToolDetail, getStatusClass } from '../utils';
import type { TranscriptEntry, Session } from '../types';
import './TranscriptView.css';

// ─── Inline text formatting (no markdown library) ───

const TOOL_ICONS: Record<string, string> = {
  Bash: '\u26a1', Edit: '\u270f\ufe0f', Write: '\u270f\ufe0f', MultiEdit: '\u270f\ufe0f', NotebookEdit: '\u270f\ufe0f',
  Read: '\ud83d\udc41', Glob: '\ud83d\udc41', Grep: '\ud83d\udd0d', LS: '\ud83d\udcc1',
  WebFetch: '\ud83c\udf10', WebSearch: '\ud83c\udf10',
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAssistantHtml(text: string): string {
  const escaped = escapeHtml(text);
  const parts: string[] = [];
  let remaining = escaped;

  // Split on triple-backtick code blocks first
  const codeBlockRe = /```(?:[a-zA-Z]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(escaped)) !== null) {
    // Process inline formatting for the text before this code block
    const before = escaped.slice(lastIndex, match.index);
    parts.push(formatInline(before));
    parts.push(`<pre><code>${match[1]}</code></pre>`);
    lastIndex = match.index + match[0].length;
  }

  // Process remaining text after last code block
  if (lastIndex < escaped.length) {
    parts.push(formatInline(escaped.slice(lastIndex)));
  }

  if (parts.length === 0) {
    return formatInline(remaining);
  }

  return parts.join('');
}

function formatInline(text: string): string {
  // Bold: **text**
  let result = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code: `text`
  result = result.replace(/`([^`]+?)`/g, '<code class="tx-inline-code">$1</code>');
  return result;
}

// ─── Diff rendering for edit tools ───

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function computeLineDiff(oldStr: string, newStr: string): { type: 'context' | 'add' | 'remove'; text: string }[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Find common prefix lines
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix lines (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const result: { type: 'context' | 'add' | 'remove'; text: string }[] = [];

  for (let i = 0; i < prefixLen; i++) result.push({ type: 'context', text: oldLines[i] });
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) result.push({ type: 'remove', text: oldLines[i] });
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) result.push({ type: 'add', text: newLines[i] });
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) result.push({ type: 'context', text: oldLines[i] });

  return result;
}

function DiffLines({ lines }: { lines: { type: 'context' | 'add' | 'remove'; text: string }[] }) {
  return (
    <div className="tx-diff">
      {lines.map((d, i) => (
        <div key={i} className={`tx-diff-line tx-diff-${d.type}`}>
          <span className="tx-diff-prefix">{d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '}</span>
          <span className="tx-diff-text">{d.text || '\u00a0'}</span>
        </div>
      ))}
    </div>
  );
}

function renderEditBody(toolInputFull: string, toolName: string) {
  try {
    const input = JSON.parse(toolInputFull);

    if (toolName === 'Write') {
      const content = input.content || '';
      const lines = content.split('\n').map((text: string) => ({ type: 'add' as const, text }));
      return <DiffLines lines={lines} />;
    }

    if (toolName === 'Edit') {
      const diff = computeLineDiff(input.old_string || '', input.new_string || '');
      return <DiffLines lines={diff} />;
    }

    if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      return (
        <div className="tx-diff">
          {input.edits.map((edit: { old_string?: string; new_string?: string }, ei: number) => {
            const diff = computeLineDiff(edit.old_string || '', edit.new_string || '');
            return (
              <div key={ei}>
                {ei > 0 && <div className="tx-diff-separator">{'\u00b7\u00b7\u00b7'}</div>}
                {diff.map((d, i) => (
                  <div key={i} className={`tx-diff-line tx-diff-${d.type}`}>
                    <span className="tx-diff-prefix">{d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '}</span>
                    <span className="tx-diff-text">{d.text || '\u00a0'}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      );
    }

    // Fallback for NotebookEdit or unexpected shapes
    return <pre>{toolInputFull}</pre>;
  } catch {
    return <pre>{toolInputFull}</pre>;
  }
}

// ─── Entry rendering ───

interface PairedEntry {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

function pairEntries(entries: TranscriptEntry[]): PairedEntry[] {
  // Filter out entries with empty content (these render as empty bars)
  const filtered = entries.filter(e => {
    if (e.type === 'tool_use') return true; // tool_use always has tool_name
    if (e.type === 'tool_result') return true; // tool_result paired with tool_use
    const content = typeof e.content === 'string' ? e.content.trim() : '';
    return content.length > 0;
  });

  const paired: PairedEntry[] = [];
  let i = 0;
  while (i < filtered.length) {
    const entry = filtered[i];
    if (entry.type === 'tool_use' && i + 1 < filtered.length && filtered[i + 1].type === 'tool_result') {
      paired.push({ entry, result: filtered[i + 1] });
      i += 2;
    } else if (entry.type === 'tool_result') {
      // Orphan tool_result — skip (shows as a stray bar otherwise)
      i += 1;
    } else {
      paired.push({ entry });
      i += 1;
    }
  }
  return paired;
}

function safeString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val == null) return '';
  return JSON.stringify(val, null, 2);
}

function renderEntry({ entry, result }: PairedEntry, index: number) {
  switch (entry.type) {
    case 'user':
      return (
        <div key={index} className="tx-entry tx-user">
          <span className="tx-user-prefix">{'\u276f'}</span>
          {safeString(entry.content)}
        </div>
      );

    case 'thinking':
      // Compact thinking indicator — Claude Code doesn't show full thinking text
      return (
        <div key={index} className="tx-entry tx-thinking-compact">
          Thought for a moment
        </div>
      );

    case 'assistant':
      return (
        <div
          key={index}
          className="tx-entry tx-assistant"
          dangerouslySetInnerHTML={{ __html: formatAssistantHtml(safeString(entry.content)) }}
        />
      );

    case 'tool_use': {
      const icon = TOOL_ICONS[entry.tool_name || ''] || '\u2699';
      return (
        <details key={index} className="tx-entry tx-tool">
          <summary>
            <span className="tx-tool-summary-inner">
              <span className="tx-tool-icon">{icon}</span>
              <span className="tx-tool-name">{entry.tool_name}</span>
              {entry.tool_input_summary && (
                <span className="tx-tool-summary">{entry.tool_input_summary}</span>
              )}
            </span>
          </summary>
          {entry.tool_input_full && (
            <div className="tx-tool-body">
              {EDIT_TOOLS.has(entry.tool_name || '')
                ? renderEditBody(entry.tool_input_full, entry.tool_name || '')
                : <pre>{safeString(entry.tool_input_full)}</pre>
              }
            </div>
          )}
          {result ? (
            <div className={`tx-tool-result${result.is_error ? ' tx-error' : ''}`}>
              {safeString(result.content)}
            </div>
          ) : (
            <div className="tx-tool-pending">
              <span className="tx-tool-pending-dot">{'\u2026'}</span> Running...
            </div>
          )}
        </details>
      );
    }

    case 'tool_result':
      // Orphan tool_result (not paired with tool_use)
      return (
        <div key={index} className={`tx-entry tx-tool-result${entry.is_error ? ' tx-error' : ''}`}>
          {safeString(entry.content)}
        </div>
      );

    case 'system': {
      // Skip empty system entries (local commands, pulse injections)
      if (!entry.content && !entry.detail) return null;

      const subtype = entry.subtype;

      // Task/subagent notification — collapsible with result detail
      if (subtype === 'task_notification') {
        const icon = entry.status === 'completed' ? '\u2705' : '\u26a0\ufe0f';
        if (entry.detail) {
          return (
            <details key={index} className="tx-entry tx-system-details tx-system-task">
              <summary>
                <span className="tx-system-summary-inner">
                  <span className="tx-system-icon">{icon}</span>
                  <span className="tx-system-text">{safeString(entry.content)}</span>
                </span>
              </summary>
              <div
                className="tx-system-detail-body"
                dangerouslySetInnerHTML={{ __html: formatAssistantHtml(safeString(entry.detail)) }}
              />
            </details>
          );
        }
        return (
          <div key={index} className="tx-entry tx-system tx-system-task">
            <span className="tx-system-icon">{icon}</span>
            <span className="tx-system-text">{safeString(entry.content)}</span>
          </div>
        );
      }

      // Compact continuation — collapsible with summary detail
      if (subtype === 'compact') {
        if (entry.detail) {
          return (
            <details key={index} className="tx-entry tx-system-details tx-system-compact">
              <summary>
                <span className="tx-system-summary-inner">
                  <span className="tx-system-icon">{'\ud83d\udce6'}</span>
                  <span className="tx-system-text">Context compacted</span>
                </span>
              </summary>
              <div
                className="tx-system-detail-body"
                dangerouslySetInnerHTML={{ __html: formatAssistantHtml(safeString(entry.detail)) }}
              />
            </details>
          );
        }
        return (
          <div key={index} className="tx-entry tx-system tx-system-compact">
            <span className="tx-system-icon">{'\ud83d\udce6'}</span>
            <span className="tx-system-text">Context compacted</span>
          </div>
        );
      }

      // Default system entry
      return (
        <div key={index} className="tx-entry tx-system">
          {safeString(entry.content)}
        </div>
      );
    }

    default:
      return null;
  }
}

// ─── TranscriptView component ───

export interface QueuedMessage {
  id: number;
  text: string;
  sent?: boolean;
}

interface TranscriptViewProps {
  sessionId: string;
  session?: Session;
  queuedMessages?: QueuedMessage[];
  hidden?: boolean;
}

export function TranscriptView({ sessionId, session, queuedMessages, hidden }: TranscriptViewProps) {
  const { entries, loading, error, loadOlder, hasMore, turnComplete, prependVersion } = useTranscript(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false); // synchronous guard — prevents concurrent loads
  const prevScrollHeightRef = useRef(0); // scrollHeight captured before loadOlder
  const prevEntriesLenRef = useRef(0);
  const prevHiddenRef = useRef(hidden);
  // Track entries count when each queued message was first seen (set via effect, read in useMemo)
  const queuedBaselinesRef = useRef<Map<number, number>>(new Map());

  // Record baseline entry count for new queued messages (runs after render, before next render)
  useEffect(() => {
    if (!queuedMessages?.length) {
      queuedBaselinesRef.current.clear();
      return;
    }
    for (const msg of queuedMessages) {
      if (!queuedBaselinesRef.current.has(msg.id)) {
        queuedBaselinesRef.current.set(msg.id, entries.length);
      }
    }
    // Clean up baselines for removed messages
    const activeIds = new Set(queuedMessages.map(m => m.id));
    for (const key of queuedBaselinesRef.current.keys()) {
      if (!activeIds.has(key)) queuedBaselinesRef.current.delete(key);
    }
  }, [queuedMessages, entries.length]);

  // Filter queued messages at render time — hide if matching user entry exists after baseline,
  // or if Claude completed a turn after a user entry appeared (handles content mismatch).
  const visibleQueued = useMemo(() => {
    if (!queuedMessages?.length) return [];
    return queuedMessages.filter(msg => {
      const baseline = queuedBaselinesRef.current.get(msg.id);
      if (baseline === undefined) return true; // baseline not yet set (first render), show it
      const needle = msg.text.slice(0, 50).trim();
      if (!needle) return false;
      let sawUserAfterBaseline = false;
      for (let i = baseline; i < entries.length; i++) {
        if (entries[i].type === 'user') {
          const content = typeof entries[i].content === 'string' ? entries[i].content : '';
          if (content.includes(needle)) return false; // exact match — delivered
          sawUserAfterBaseline = true;
        }
        // If a user entry appeared and Claude finished responding, message was processed
        // even if the content match failed (handles formatting differences)
        if (sawUserAfterBaseline && entries[i].stop_reason === 'end_turn') return false;
      }
      return true;
    });
  }, [entries, queuedMessages]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    setIsScrolledUp(!atBottom);

    // Scroll-up pagination — use ref for synchronous guard to prevent concurrent loads
    if (el.scrollTop < 50 && hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      prevScrollHeightRef.current = el.scrollHeight;
      loadOlder().catch(() => {
        // On error, clear guards so user can retry
        prevScrollHeightRef.current = 0;
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
    }
  }, [hasMore, loadOlder]);

  // Restore scroll position after entries are prepended.
  // useLayoutEffect fires synchronously after React commits DOM mutations,
  // guaranteeing scrollHeight reflects the new content (unlike requestAnimationFrame
  // which can fire before React commits, causing scroll jumps).
  // Only triggered by prependVersion — not by WS appends.
  useLayoutEffect(() => {
    if (!prevScrollHeightRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = 0;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
  }, [prependVersion]);

  // Auto-scroll to bottom when new entries arrive (if not scrolled up).
  // Skip during loadOlder to prevent interference with scroll restoration.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (entries.length > prevEntriesLenRef.current && !isScrolledUp && !loadingOlderRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    prevEntriesLenRef.current = entries.length;
  }, [entries.length, isScrolledUp]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && entries.length > 0) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom when becoming visible after tab switch (if user was following)
  useEffect(() => {
    if (prevHiddenRef.current && !hidden) {
      const el = containerRef.current;
      if (el && !isScrolledUp) {
        el.scrollTop = el.scrollHeight;
      }
    }
    prevHiddenRef.current = hidden;
  }, [hidden, isScrolledUp]);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setIsScrolledUp(false);
    }
  }, []);

  const paired = entries.length > 0 ? pairEntries(entries) : [];

  if (error) {
    return <div className="transcript-error" style={hidden ? { display: 'none' } : undefined}>Failed to load transcript: {error}</div>;
  }

  if (loading) {
    return (
      <div className="transcript-skeleton" style={hidden ? { display: 'none' } : undefined}>
        <div className="transcript-skeleton-bar" />
        <div className="transcript-skeleton-bar" />
        <div className="transcript-skeleton-bar" />
      </div>
    );
  }

  return (
    <>
      <div
        className="transcript-view"
        ref={containerRef}
        onScroll={handleScroll}
        style={hidden ? { display: 'none' } : undefined}
      >
        {loadingOlder && (
          <div className="transcript-top-loader">
            <div className="transcript-top-spinner" />
          </div>
        )}

        {paired.length === 0 && !session?.status?.startsWith('waiting') && (
          <div className="transcript-empty-inline">No transcript entries yet</div>
        )}

        {paired.map((p, i) => renderEntry(p, i))}

        {/* Queued messages — shown until real entry appears in transcript */}
        {visibleQueued.map((msg) => (
          <div key={`queued-${msg.id}`} className={`tx-entry tx-user${msg.sent ? '' : ' tx-queued'}`}>
            <span className="tx-user-prefix">{'\u276f'}</span>
            {msg.text}
          </div>
        ))}

        {/* Live status indicators */}
        {session && <LiveStatus session={session} entries={entries} hasQueuedInput={visibleQueued.length > 0} turnComplete={turnComplete} />}
      </div>

      {isScrolledUp && !hidden && (
        <button className="transcript-jump" onClick={jumpToLatest}>
          {'\u2193'} Jump to latest
        </button>
      )}
    </>
  );
}

// ─── Live status: thinking indicator + permission request ───

function LiveStatus({ session, entries, hasQueuedInput, turnComplete }: { session: Session; entries: TranscriptEntry[]; hasQueuedInput: boolean; turnComplete: boolean }) {
  const statusClass = getStatusClass(session);
  const [granting, setGranting] = useState(false);

  const handleGrant = useCallback(async () => {
    setGranting(true);
    try {
      await api.grantPermission(session.session_id);
    } catch { /* handled by WS */ }
    setGranting(false);
  }, [session.session_id]);

  // Permission request
  if (statusClass === 'waiting') {
    const toolDetail = session.pending_tool
      ? formatToolDetail(session.pending_tool, session.pending_tool_input)
      : 'a tool';

    return (
      <div className="tx-live-permission">
        <div className="tx-live-permission-icon">⏸</div>
        <div className="tx-live-permission-body">
          <div className="tx-live-permission-title">Permission requested</div>
          <div className="tx-live-permission-detail">{toolDetail}</div>
          <button
            className="tx-live-permission-grant"
            onClick={handleGrant}
            disabled={granting || !session.tmux_target}
          >
            {granting ? 'Granting...' : 'Grant Permission'}
          </button>
          {!session.tmux_target && (
            <div className="tx-live-permission-note">Link a tmux session to grant permissions</div>
          )}
        </div>
      </div>
    );
  }

  // Active indicator — turnComplete is the authoritative signal,
  // computed server-side from the JSONL tail and updated via WS entries.
  // Only show for 'active' sessions (recent heartbeat). Idle sessions
  // have no heartbeat for >120s, meaning no tool use — not actively working.
  if (statusClass === 'active') {
    // Model's last turn is complete — not thinking.
    if (turnComplete) return null;

    // Model is working — check last entry for "Working" vs "Thinking" display
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    if (last?.type === 'tool_use') {
      return (
        <div className="tx-live-thinking">
          <div className="tx-live-thinking-dots">
            <span /><span /><span />
          </div>
          <span className="tx-live-thinking-text">
            Working — {last.tool_name || 'tool'}
          </span>
        </div>
      );
    }

    return (
      <div className="tx-live-thinking">
        <div className="tx-live-thinking-dots">
          <span /><span /><span />
        </div>
        <span className="tx-live-thinking-text">Thinking...</span>
      </div>
    );
  }

  return null;
}
