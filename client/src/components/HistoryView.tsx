import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';
import { getStatusClass, projectColor, timeAgo } from '../utils';
import type { Session } from '../types';
import './HistoryView.css';

interface HistoryViewProps {
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

const PAGE_SIZE = 50;

export function HistoryView({ onClose, onSelectSession }: HistoryViewProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [project, setProject] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [results, setResults] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  // Known projects — collected from results
  const [knownProjects, setKnownProjects] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search query by 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Fetch results whenever filters change (reset offset)
  useEffect(() => {
    setOffset(0);
    setResults([]);
    fetchResults(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, project, fromDate, toDate]);

  const fetchResults = useCallback(async (fetchOffset: number, replace: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const data = await api.searchHistory({
        q: debouncedQuery || undefined,
        project: project || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: PAGE_SIZE,
        offset: fetchOffset,
      });

      if (controller.signal.aborted) return;

      if (replace) {
        setResults(data.sessions);
      } else {
        setResults(prev => [...prev, ...data.sessions]);
      }
      setTotal(data.total);

      // Collect unique project names
      const newProjects = new Set(knownProjects);
      for (const s of data.sessions) {
        if (s.project) newProjects.add(s.project);
      }
      if (newProjects.size > knownProjects.length) {
        setKnownProjects(Array.from(newProjects).sort());
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // silently fail — user will see empty results
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setInitialLoad(false);
      }
    }
  }, [debouncedQuery, project, fromDate, toDate, knownProjects]);

  // Also fetch projects from the projects API on mount
  useEffect(() => {
    api.getProjects().then(presets => {
      setKnownProjects(prev => {
        const merged = new Set(prev);
        for (const p of presets) merged.add(p.name);
        return Array.from(merged).sort();
      });
    }).catch(() => { /* ignore */ });
  }, []);

  const handleLoadMore = useCallback(() => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    fetchResults(newOffset, false);
  }, [offset, fetchResults]);

  const handleClearFilters = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setProject('');
    setFromDate('');
    setToDate('');
  }, []);

  const hasMore = results.length < total;
  const hasFilters = !!(query || project || fromDate || toDate);

  const formatDate = useCallback((dateStr: string) => {
    if (!dateStr) return '';
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }, []);

  return (
    <div className="history-view">
      <div className="history-header">
        <h2>Session History</h2>
        <button className="history-close" onClick={onClose} title="Close history">
          &times;
        </button>
      </div>

      <div className="history-search">
        <input
          type="text"
          placeholder="Search sessions by label, project, or ID..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="history-filters">
        <select value={project} onChange={e => setProject(e.target.value)}>
          <option value="">All projects</option>
          {knownProjects.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input
          type="date"
          value={fromDate}
          onChange={e => setFromDate(e.target.value)}
          title="From date"
          placeholder="From"
        />
        <input
          type="date"
          value={toDate}
          onChange={e => setToDate(e.target.value)}
          title="To date"
          placeholder="To"
        />
        {hasFilters && (
          <button className="history-clear-btn" onClick={handleClearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {!initialLoad && (
        <div className="history-count">
          {results.length} of {total} result{total !== 1 ? 's' : ''}
        </div>
      )}

      {initialLoad && loading ? (
        <div className="history-loading">
          <div className="spinner" />
          Loading...
        </div>
      ) : results.length === 0 && !loading ? (
        <div className="history-empty">
          {hasFilters ? 'No sessions match your filters.' : 'No session history found.'}
        </div>
      ) : (
        <div className="history-results">
          {results.map(session => (
            <HistoryRow
              key={session.session_id}
              session={session}
              formatDate={formatDate}
              onClick={() => onSelectSession(session.session_id)}
            />
          ))}
        </div>
      )}

      {hasMore && !initialLoad && (
        <div className="history-load-more">
          <button onClick={handleLoadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

interface HistoryRowProps {
  session: Session;
  formatDate: (d: string) => string;
  onClick: () => void;
}

function HistoryRow({ session, formatDate, onClick }: HistoryRowProps) {
  const statusClass = getStatusClass(session);
  const label = session.label || session.session_id.slice(0, 12);
  const toolCount = session.tool_count || 0;
  const color = session.project ? projectColor(session.project) : null;

  return (
    <div className="history-row" onClick={onClick}>
      <span className={`history-row-dot ${statusClass}`} />
      <div className="history-row-main">
        <span className="history-row-label" title={label}>{label}</span>
        <div className="history-row-meta">
          {session.project && (
            <span className="history-row-project">
              <span
                className="history-row-project-dot"
                style={color ? { background: color } : undefined}
              />
              {session.project}
            </span>
          )}
          <span>{formatDate(session.created_at)}</span>
          {session.created_at && (
            <span>{timeAgo(session.created_at)}</span>
          )}
        </div>
      </div>
      {toolCount > 0 && (
        <span className="history-row-tools">
          {toolCount} tool{toolCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}
