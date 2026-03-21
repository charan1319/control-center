import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

// Standard xterm-256color palette — matches what Claude Code expects.
// Claude Code uses \e[40m (black bg) behind user input, which must be
// near-invisible on the dark background. Catppuccin's black (#45475a)
// was too bright, creating a visible muddy highlight.
const TERM_THEME = {
  background: '#11111b',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#45475a',
  selectionForeground: '#cdd6f4',
  black: '#181825',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#cdd6f4',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#ffffff',
};

const TERM_FONT = '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace';

// Build standard 256-color palette with a brighter user message highlight.
// Claude Code uses 48;5;237 for submitted user message backgrounds.
// Standard 237 = #3a3a3a which is too subtle on our #11111b bg.
function buildExtendedPalette(): string[] {
  const palette: string[] = [];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        palette.push(`#${[r, g, b].map(c => (c ? c * 40 + 55 : 0).toString(16).padStart(2, '0')).join('')}`);
  for (let i = 0; i < 24; i++) {
    const v = i * 10 + 8;
    palette.push(`#${v.toString(16).padStart(2, '0').repeat(3)}`);
  }
  // Brighten index 237: #3a3a3a → #313244 (Catppuccin surface0, visible but not jarring)
  palette[237 - 16] = '#45475a';
  return palette;
}
const EXTENDED_PALETTE = buildExtendedPalette();


interface TerminalViewProps {
  sessionId: string;
  tmuxTarget: string;
  onWsReady?: (ws: WebSocket | null) => void;
}

export function TerminalView({ sessionId, tmuxTarget, onWsReady }: TerminalViewProps) {
  const liveContainerRef = useRef<HTMLDivElement>(null);
  const scrollbackContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const scrollbackTermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const scrollbackFitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [showScrollback, setShowScrollback] = useState(false);
  const scrollbackFetching = useRef(false);
  const scrollbackLastFail = useRef(0);

  // Batched writes
  const writeBuf = useRef('');
  const writeRaf = useRef(0);
  const flushWrites = useCallback(() => {
    const term = termRef.current;
    if (term && writeBuf.current) term.write(writeBuf.current);
    writeBuf.current = '';
    writeRaf.current = 0;
  }, []);
  const batchWrite = useCallback((data: string) => {
    writeBuf.current += data;
    if (!writeRaf.current) writeRaf.current = requestAnimationFrame(flushWrites);
  }, [flushWrites]);

  const exitScrollback = useCallback(() => {
    setShowScrollback(false);
    // Clean up scrollback terminal
    if (scrollbackTermRef.current) {
      scrollbackTermRef.current.dispose();
      scrollbackTermRef.current = null;
    }
    if (scrollbackFitRef.current) scrollbackFitRef.current = null;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      termRef.current?.focus();
    });
  }, []);

  // Enter scrollback: fetch raw PTY buffer, render in a second xterm.js instance
  const enterScrollback = useCallback(async () => {
    if (scrollbackFetching.current || showScrollback) return;
    if (Date.now() - scrollbackLastFail.current < 5000) return;
    scrollbackFetching.current = true;
    try {
      // Fetch raw PTY scrollback buffer — for sessions launched from the dashboard,
      // this has the complete output stream from session start
      const res = await fetch(`/api/sessions/${sessionId}/scrollback`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { scrollbackLastFail.current = Date.now(); return; }
      const { data } = await res.json();
      if (!data) return;

      setShowScrollback(true);

      // Create scrollback terminal on next frame (after container is visible)
      requestAnimationFrame(() => {
        const container = scrollbackContainerRef.current;
        if (!container) return;

        const sbTerm = new Terminal({
          fontFamily: TERM_FONT,
          fontSize: window.innerWidth < 640 ? 12 : 14,
          theme: { ...TERM_THEME, extendedAnsi: EXTENDED_PALETTE },
          cursorBlink: false,
          disableStdin: true,
          scrollback: 50000,
        });
        scrollbackTermRef.current = sbTerm;

        const sbFit = new FitAddon();
        scrollbackFitRef.current = sbFit;
        sbTerm.loadAddon(sbFit);
        try { sbTerm.loadAddon(new WebLinksAddon()); } catch {}

        container.innerHTML = '';
        sbTerm.open(container);
        requestAnimationFrame(() => {
          try { sbFit.fit(); } catch {}
          // Write the raw PTY output stream — xterm.js renders all ANSI correctly
          sbTerm.write(data, () => {
            sbTerm.scrollToBottom();
          });
        });
      });
    } catch {
      scrollbackLastFail.current = Date.now();
    } finally {
      scrollbackFetching.current = false;
    }
  }, [sessionId, showScrollback]);

  // Dismiss scrollback on any keypress
  useEffect(() => {
    if (!showScrollback) return;
    const handler = (e: KeyboardEvent) => {
      // Don't dismiss on modifier keys alone
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      exitScrollback();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showScrollback, exitScrollback]);

  useEffect(() => {
    const container = liveContainerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: window.innerWidth < 640 ? 12 : 14,
      cursorBlink: true,
      scrollback: 10000,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);
    try { term.loadAddon(new WebLinksAddon()); } catch {}
    term.open(container);
    term.options.theme = { ...TERM_THEME, extendedAnsi: EXTENDED_PALETTE };
    // Force default foreground to white via OSC 10 — theme.foreground doesn't work in xterm.js 5.5
    term.write('\x1b]10;#cdd6f4\x07');
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      onWsReady?.(ws);
      try {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        // Force-set default foreground via OSC 10 — overrides any color state from scrollback replay
        term.write('\x1b]10;rgb:ff/ff/ff\x1b\\');
        term.focus();
      } catch {}
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) batchWrite(msg.data);
      } catch { batchWrite(event.data); }
    };
    ws.onerror = () => setStatus('error');
    ws.onclose = () => onWsReady?.(null);

    const inputDisposable = term.onData((data) => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ type: 'input', data }));
    });

    // Scroll interception
    const wheelHandler = (e: WheelEvent) => {
      if (!term) return;
      if (term.buffer.active.type !== 'normal') {
        if (e.deltaY < 0) {
          e.preventDefault();
          e.stopPropagation();
          enterScrollback();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const lines = e.deltaMode === 0 ? Math.round(e.deltaY / 8) : Math.sign(e.deltaY) * 3;
      if (lines !== 0) term.scrollLines(lines);
    };
    container.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    let touchStartY = 0;
    const touchStart = (e: TouchEvent) => { touchStartY = e.touches[0].clientY; };
    const touchMove = (e: TouchEvent) => {
      if (!term) return;
      if (term.buffer.active.type !== 'normal') {
        if (touchStartY - e.touches[0].clientY > 30) { e.preventDefault(); enterScrollback(); }
        return;
      }
      e.preventDefault();
      const dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      const lines = Math.round(dy / 18);
      if (lines !== 0) term.scrollLines(lines);
    };
    container.addEventListener('touchstart', touchStart, { passive: true });
    container.addEventListener('touchmove', touchMove, { passive: false });

    let resizeTimer: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fitAddon.fit(); } catch {}
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          try { w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
        }
      }, 150);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(resizeTimer);
      cancelAnimationFrame(writeRaf.current);
      writeBuf.current = '';
      container.removeEventListener('wheel', wheelHandler, { capture: true } as EventListenerOptions);
      container.removeEventListener('touchstart', touchStart);
      container.removeEventListener('touchmove', touchMove);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (scrollbackTermRef.current) { scrollbackTermRef.current.dispose(); scrollbackTermRef.current = null; }
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

      {/* Scrollback — second xterm.js instance, renders raw PTY output identically */}
      <div
        className="terminal-container terminal-scrollback"
        ref={scrollbackContainerRef}
        style={{ display: showScrollback ? undefined : 'none' }}
      />

      {/* Live terminal */}
      <div
        className="terminal-container"
        ref={liveContainerRef}
        onClick={() => termRef.current?.focus()}
        style={{ display: (status === 'connecting' || showScrollback) ? 'none' : undefined }}
      />
    </div>
  );
}
