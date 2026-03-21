import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

interface TerminalViewProps {
  sessionId: string;
  tmuxTarget: string;
  onWsReady?: (ws: WebSocket | null) => void;
}

export function TerminalView({ sessionId, tmuxTarget, onWsReady }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

  // Fit helper — safe to call anytime
  const doFit = useCallback(() => {
    const fit = fitRef.current;
    const ws = wsRef.current;
    if (!fit) return;
    try {
      fit.fit();
      const term = termRef.current;
      if (term && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {
      // fit can throw if container is hidden
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal
    const term = new Terminal({
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace',
      fontSize: window.innerWidth < 640 ? 12 : 14,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#45475a',
      },
      cursorBlink: true,
      scrollback: 5000,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);

    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      // addon may fail
    }

    term.open(container);

    // Initial fit after a frame
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      onWsReady?.(ws);
      // Send initial resize
      try {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch { /* ignore */ }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) {
          term.write(msg.data);
        }
      } catch {
        // Not JSON, write raw
        term.write(event.data);
      }
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onclose = () => {
      onWsReady?.(null);
    };

    // Terminal input -> WS
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // ResizeObserver for dynamic resizing
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        } catch { /* ignore */ }
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      onWsReady?.(null);
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'error') {
    return (
      <div className="terminal-view">
        <div className="terminal-error">
          Failed to connect to terminal for {tmuxTarget}. Is the tmux session still running?
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-view">
      {status === 'connecting' && (
        <div className="terminal-connecting">
          <div className="terminal-connecting-spinner" />
          Connecting to terminal...
        </div>
      )}
      <div
        className="terminal-container"
        ref={containerRef}
        style={{ display: status === 'connecting' ? 'none' : undefined }}
      />
    </div>
  );
}
