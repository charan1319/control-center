import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranscript } from '../hooks/useTranscript';
import type { TranscriptEntry } from '../types';
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

// ─── Entry rendering ───

interface PairedEntry {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

function pairEntries(entries: TranscriptEntry[]): PairedEntry[] {
  const paired: PairedEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.type === 'tool_use' && i + 1 < entries.length && entries[i + 1].type === 'tool_result') {
      paired.push({ entry, result: entries[i + 1] });
      i += 2;
    } else if (entry.type === 'tool_result') {
      // Orphan tool_result — render as standalone
      paired.push({ entry });
      i += 1;
    } else {
      paired.push({ entry });
      i += 1;
    }
  }
  return paired;
}

function renderEntry({ entry, result }: PairedEntry, index: number) {
  switch (entry.type) {
    case 'user':
      return (
        <div key={index} className="tx-entry tx-user">
          <span className="tx-user-prefix">{'\u276f'}</span>
          {entry.content}
        </div>
      );

    case 'thinking':
      return (
        <details key={index} className="tx-entry tx-thinking">
          <summary>Thinking...</summary>
          <div className="tx-thinking-content">{entry.content}</div>
        </details>
      );

    case 'assistant':
      return (
        <div
          key={index}
          className="tx-entry tx-assistant"
          dangerouslySetInnerHTML={{ __html: formatAssistantHtml(entry.content) }}
        />
      );

    case 'tool_use': {
      const icon = TOOL_ICONS[entry.tool_name || ''] || '\u2699';
      return (
        <details key={index} className="tx-entry tx-tool">
          <summary>
            <span className="tx-tool-icon">{icon}</span>
            <span className="tx-tool-name">{entry.tool_name}</span>
            {entry.tool_input_summary && (
              <span className="tx-tool-summary">{entry.tool_input_summary}</span>
            )}
          </summary>
          {entry.tool_input_full && (
            <div className="tx-tool-body">
              <pre>{entry.tool_input_full}</pre>
            </div>
          )}
          {result ? (
            <div className={`tx-tool-result${result.is_error ? ' tx-error' : ''}`}>
              {result.content}
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
          {entry.content}
        </div>
      );

    case 'system':
      return (
        <div key={index} className="tx-entry tx-system">
          {entry.content}
        </div>
      );

    default:
      return null;
  }
}

// ─── TranscriptView component ───

interface TranscriptViewProps {
  sessionId: string;
}

export function TranscriptView({ sessionId }: TranscriptViewProps) {
  const { entries, loading, error, loadOlder, hasMore } = useTranscript(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const prevEntriesLenRef = useRef(0);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    setIsScrolledUp(!atBottom);

    // Scroll-up pagination
    if (el.scrollTop < 50 && hasMore && !loadingOlder) {
      setLoadingOlder(true);
      const prevHeight = el.scrollHeight;
      loadOlder().then(() => {
        // Restore scroll position after prepending
        requestAnimationFrame(() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight - prevHeight;
          }
          setLoadingOlder(false);
        });
      }).catch(() => {
        setLoadingOlder(false);
      });
    }
  }, [hasMore, loadOlder, loadingOlder]);

  // Auto-scroll to bottom when new entries arrive (if not scrolled up)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (entries.length > prevEntriesLenRef.current && !isScrolledUp) {
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

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setIsScrolledUp(false);
    }
  }, []);

  if (error) {
    return <div className="transcript-error">Failed to load transcript: {error}</div>;
  }

  if (loading) {
    return (
      <div className="transcript-skeleton">
        <div className="transcript-skeleton-bar" />
        <div className="transcript-skeleton-bar" />
        <div className="transcript-skeleton-bar" />
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className="transcript-empty">No transcript entries yet</div>;
  }

  const paired = pairEntries(entries);

  return (
    <>
      <div
        className="transcript-view"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {loadingOlder && (
          <div className="transcript-top-loader">
            <div className="transcript-top-spinner" />
          </div>
        )}

        {paired.map((p, i) => renderEntry(p, i))}
      </div>

      {isScrolledUp && (
        <button className="transcript-jump" onClick={jumpToLatest}>
          {'\u2193'} Jump to latest
        </button>
      )}
    </>
  );
}
