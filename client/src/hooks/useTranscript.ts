import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { api } from '../api';
import type { TranscriptEntry } from '../types';

export function useTranscript(sessionId: string | null) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { sendMessage, connectionStatus, transcriptVersion, getTranscriptUpdates } = useWebSocket();

  // Fetch transcript via HTTP — independent of WebSocket status
  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setError(null);
      return;
    }

    // Clear stale state from previous session
    setEntries([]);
    setError(null);
    setLoading(true);

    let cancelled = false;

    api.getTranscript(sessionId, 100)
      .then(data => {
        if (cancelled) return;
        setEntries(data.entries);
        setHasMore(data.hasMore);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  // Subscribe to live transcript updates via WebSocket (separate from fetch)
  useEffect(() => {
    if (!sessionId || connectionStatus !== 'connected') return;

    sendMessage({ type: 'subscribe_transcript', session_id: sessionId });

    return () => {
      sendMessage({ type: 'unsubscribe_transcript' });
    };
  }, [sessionId, connectionStatus, sendMessage]);

  // Listen for transcript_update messages
  useEffect(() => {
    if (!sessionId) return;
    const updates = getTranscriptUpdates(sessionId);
    if (updates.length > 0) {
      const newEntries = updates.flat();
      setEntries(prev => [...prev, ...newEntries]);
    }
  }, [sessionId, transcriptVersion, getTranscriptUpdates]);

  const loadOlder = useCallback(async () => {
    if (!sessionId || !entries.length) return;
    const oldest = entries[0];
    try {
      const older = await api.getTranscript(sessionId, 100, oldest.timestamp);
      if (older.entries.length) {
        setEntries(prev => [...older.entries, ...prev]);
      }
      setHasMore(older.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, entries]);

  return { entries, loading, error, loadOlder, hasMore };
}
