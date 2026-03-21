import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import React from 'react';
import type { Session, SessionEvent, TranscriptEntry, WSIncoming, WSOutgoing } from '../types';

export interface TodoStopEvent {
  todo_id: number;
  session_id: string;
}

interface WebSocketState {
  sessions: Session[];
  recentEvents: SessionEvent[];
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  sendMessage: (msg: WSOutgoing) => void;
  transcriptVersion: number;
  getTranscriptUpdates: (sessionId: string) => TranscriptEntry[][];
  todoStopVersion: number;
  getTodoStopEvents: () => TodoStopEvent[];
}

const WebSocketContext = createContext<WebSocketState | null>(null);

export function useWebSocket(): WebSocketState {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return ctx;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recentEvents, setRecentEvents] = useState<SessionEvent[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [transcriptVersion, setTranscriptVersion] = useState(0);
  const [todoStopVersion, setTodoStopVersion] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  const wasConnected = useRef(false);
  const transcriptUpdates = useRef(new Map<string, TranscriptEntry[][]>());
  const todoStopEvents = useRef<TodoStopEvent[]>([]);

  const getTranscriptUpdates = useCallback((sessionId: string): TranscriptEntry[][] => {
    const updates = transcriptUpdates.current.get(sessionId) || [];
    transcriptUpdates.current.delete(sessionId);
    return updates;
  }, []);

  const getTodoStopEvents = useCallback((): TodoStopEvent[] => {
    const events = todoStopEvents.current;
    todoStopEvents.current = [];
    return events;
  }, []);

  const sendMessage = useCallback((msg: WSOutgoing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!mounted) return;

      if (wasConnected.current) {
        setConnectionStatus('reconnecting');
      }

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/events`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted) return;
        wasConnected.current = true;
        reconnectDelay.current = 1000;
        setConnectionStatus('connected');
      };

      ws.onmessage = (event) => {
        if (!mounted) return;
        let msg: WSIncoming;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case 'init':
            setSessions(msg.sessions);
            setRecentEvents(msg.recentEvents);
            break;

          case 'session_update':
            setSessions(prev => {
              const idx = prev.findIndex(s => s.session_id === msg.session.session_id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = msg.session;
                return next;
              }
              return [msg.session, ...prev];
            });
            break;

          case 'event':
            if (msg.event === 'Heartbeat') {
              // Update session in-place — preserve 'stopped' and 'waiting_permission'
              setSessions(prev => prev.map(s =>
                s.session_id === msg.session_id
                  ? { ...s, last_tool: msg.tool_name ?? s.last_tool, last_heartbeat: msg.timestamp ?? s.last_heartbeat, status: (s.status === 'stopped' || s.status === 'waiting_permission') ? s.status : 'active' }
                  : s
              ));
            } else if (msg.event === 'PermissionRequest' && !msg.auto_approved) {
              setSessions(prev => prev.map(s =>
                s.session_id === msg.session_id
                  ? { ...s, status: 'waiting_permission' as const, pending_tool: msg.tool_name ?? null, pending_tool_input: msg.tool_input ?? null }
                  : s
              ));
              setRecentEvents(prev => [msg as unknown as SessionEvent, ...prev].slice(0, 200));
            } else {
              setRecentEvents(prev => [msg as unknown as SessionEvent, ...prev].slice(0, 200));
            }
            break;

          case 'transcript_update': {
            const existing = transcriptUpdates.current.get(msg.session_id) || [];
            existing.push(msg.entries);
            transcriptUpdates.current.set(msg.session_id, existing);
            setTranscriptVersion(v => v + 1);
            break;
          }

          case 'todo_session_stopped':
            todoStopEvents.current.push({ todo_id: msg.todo_id, session_id: msg.session_id });
            setTodoStopVersion(v => v + 1);
            break;
        }
      };

      ws.onclose = () => {
        if (!mounted) return;
        wsRef.current = null;
        setConnectionStatus(wasConnected.current ? 'reconnecting' : 'disconnected');
        reconnectTimer = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const value: WebSocketState = {
    sessions,
    recentEvents,
    connectionStatus,
    sendMessage,
    transcriptVersion,
    getTranscriptUpdates,
    todoStopVersion,
    getTodoStopEvents,
  };

  return React.createElement(WebSocketContext.Provider, { value }, children);
}
