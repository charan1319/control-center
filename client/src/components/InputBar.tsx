import { useRef, useEffect, useCallback, useState } from 'react';
import { api } from '../api';
import './InputBar.css';

interface InputBarProps {
  sessionId: string;
  mode: 'transcript' | 'terminal';
  terminalWs?: WebSocket | null;
}

export function InputBar({ sessionId, mode, terminalWs }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-grow textarea
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
  }, []);

  const sendText = useCallback((text: string) => {
    if (mode === 'terminal' && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data: text + '\n' }));
    } else if (mode === 'transcript') {
      api.sendInput(sessionId, text).catch(() => {});
    }
  }, [mode, terminalWs, sessionId]);

  const sendRaw = useCallback((data: string) => {
    if (mode === 'terminal' && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data }));
    } else if (mode === 'transcript') {
      api.sendInput(sessionId, data).catch(() => {});
    }
  }, [mode, terminalWs, sessionId]);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    sendText(text);
    setValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, sendText]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Quick action handlers
  const handleCtrlC = useCallback(() => sendRaw('\x03'), [sendRaw]);
  const handleTab = useCallback(() => sendRaw('\t'), [sendRaw]);
  const handleUp = useCallback(() => sendRaw('\x1b[A'), [sendRaw]);
  const handleDown = useCallback(() => sendRaw('\x1b[B'), [sendRaw]);

  return (
    <>
      <div className="input-bar-quick">
        <button onClick={handleCtrlC} title="Send Ctrl+C">Ctrl+C</button>
        <button onClick={handleTab} title="Send Tab">Tab</button>
        <button onClick={handleUp} title="Arrow Up">{'\u2191'}</button>
        <button onClick={handleDown} title="Arrow Down">{'\u2193'}</button>
      </div>
      <div className="input-bar">
        <textarea
          ref={textareaRef}
          className="input-bar-textarea"
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={mode === 'terminal' ? 'Type command...' : 'Send input to session...'}
        />
        <button className="input-bar-send" onClick={handleSend}>
          Send
        </button>
      </div>
    </>
  );
}
