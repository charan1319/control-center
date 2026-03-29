import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { api } from '../api';
import type { TranscriptEntry, ContextUsage } from '../types';

export function useTranscript(sessionId: string | null) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [turnComplete, setTurnComplete] = useState(true);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const { sendMessage, connectionStatus, transcriptVersion, getTranscriptUpdates, getLatestContextUsage, getServerTurnComplete, refreshSession } = useWebSocket();

  // Fetch transcript via HTTP — independent of WebSocket status
  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setError(null);
      setTurnComplete(true);
      return;
    }

    // Clear stale state from previous session
    setEntries([]);
    setError(null);
    setLoading(true);
    setTurnComplete(true);
    setContextUsage(null);

    let cancelled = false;

    api.getTranscript(sessionId, 100)
      .then(data => {
        if (cancelled) return;
        setEntries(data.entries);
        setHasMore(data.hasMore);
        // Server computes this from the full file tail, not the entries window
        if (data.turnComplete !== undefined) setTurnComplete(data.turnComplete);
        if (data.contextUsage) setContextUsage(data.contextUsage);
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
      sendMessage({ type: 'unsubscribe_transcript', session_id: sessionId });
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

    // Server sends authoritative turnComplete with each transcript_update
    const serverTC = getServerTurnComplete(sessionId);
    if (serverTC !== null) setTurnComplete(serverTC);

    // Check for context usage updates (stored separately per session)
    const latestUsage = getLatestContextUsage(sessionId);
    if (latestUsage) setContextUsage(latestUsage);
  }, [sessionId, transcriptVersion, getTranscriptUpdates, getLatestContextUsage, getServerTurnComplete]);

  // Safety net: when the indicator is showing (turnComplete=false), periodically
  // re-check from the API. This catches missed WS updates (e.g. from reconnections
  // where the end_turn entry was written while the socket was down).
  // Also refreshes session status to catch missed permission request broadcasts.
  useEffect(() => {
    if (!sessionId || turnComplete || loading) return;
    const interval = setInterval(() => {
      api.getTranscript(sessionId, 1).then(data => {
        if (data.turnComplete) setTurnComplete(true);
      }).catch(() => {});
      // Also poll session status — catches permission requests that were missed
      // (e.g. hook curl failed but later succeeded on retry, or WS broadcast lost)
      refreshSession(sessionId);
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, turnComplete, loading, refreshSession]);

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

  return { entries, loading, error, loadOlder, hasMore, turnComplete, contextUsage };
}
