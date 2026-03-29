import { useRef, useEffect, useCallback, useState } from 'react';
import { api } from '../api';
import { useVoiceInput } from '../hooks/useVoiceInput';
import './InputBar.css';

interface InputBarProps {
  sessionId: string;
  mode: 'transcript' | 'terminal';
  terminalWs?: WebSocket | null;
  onSendMessage?: (text: string) => void;
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
  );
}

export function InputBar({ sessionId, mode, terminalWs, onSendMessage }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const spaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaceHeldRef = useRef(false);

  // Voice: send through the same pipeline as typed input
  const voiceSend = useCallback((text: string) => {
    if (mode === 'terminal' && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data: text + '\n' }));
    } else if (mode === 'transcript' && onSendMessage) {
      onSendMessage(text);
    }
  }, [mode, terminalWs, onSendMessage]);

  const {
    isListening, isSupported,
    transcript: voiceTranscript, interimText,
    toggle: toggleVoice, clearTranscript
  } = useVoiceInput({ onSend: voiceSend });

  // Focus textarea on mount — only for transcript mode.
  // In terminal mode, xterm.js should have focus for keyboard input.
  useEffect(() => {
    if (mode === 'transcript') {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Sync voice transcript into the textarea while listening
  useEffect(() => {
    if (isListening) {
      setValue(voiceTranscript);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 80) + 'px';
      }
    }
  }, [isListening, voiceTranscript]);

  // Stop voice when session changes (InputBar stays mounted across session switches)
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId;
      if (isListening) toggleVoice();
    }
  }, [sessionId, isListening, toggleVoice]);

  // Auto-grow textarea
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
  }, []);

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
    if (mode === 'terminal' && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data: text + '\n' }));
    } else if (mode === 'transcript' && onSendMessage) {
      onSendMessage(text);
    }
    setValue('');
    if (isListening) clearTranscript();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, mode, terminalWs, onSendMessage, isListening, clearTranscript]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Space hold: activate voice when input is empty, not already listening, first press only
    if (e.key === ' ' && !e.repeat && !isListening && value.trim() === '') {
      spaceHeldRef.current = true;
      spaceTimerRef.current = setTimeout(() => {
        if (spaceHeldRef.current) {
          setValue(''); // Clear accumulated spaces from the hold
          toggleVoice();
          spaceHeldRef.current = false;
        }
      }, 2000);
    }
  }, [handleSend, isListening, value, toggleVoice]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ' ') {
      spaceHeldRef.current = false;
      if (spaceTimerRef.current) {
        clearTimeout(spaceTimerRef.current);
        spaceTimerRef.current = null;
      }
    }
  }, []);

  // Cleanup space timer on unmount
  useEffect(() => {
    return () => {
      if (spaceTimerRef.current) clearTimeout(spaceTimerRef.current);
    };
  }, []);

  // Quick action handlers
  const handleCtrlC = useCallback(() => sendRaw('\x03'), [sendRaw]);
  const handleTab = useCallback(() => sendRaw('\t'), [sendRaw]);
  const handleUp = useCallback(() => sendRaw('\x1b[A'), [sendRaw]);
  const handleDown = useCallback(() => sendRaw('\x1b[B'), [sendRaw]);

  const placeholder = isListening
    ? 'Listening\u2026 say "send message" to send'
    : mode === 'terminal'
      ? 'Type or hold Space to dictate\u2026'
      : 'Send input or hold Space to dictate\u2026';

  return (
    <>
      <div className="input-bar-quick">
        <button onClick={handleCtrlC} title="Send Ctrl+C">Ctrl+C</button>
        <button onClick={handleTab} title="Send Tab">Tab</button>
        <button onClick={handleUp} title="Arrow Up">{'\u2191'}</button>
        <button onClick={handleDown} title="Arrow Down">{'\u2193'}</button>
      </div>
      {isListening && interimText && (
        <div className="voice-interim">{interimText}</div>
      )}
      <div className="input-bar">
        <textarea
          ref={textareaRef}
          className="input-bar-textarea"
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          placeholder={placeholder}
        />
        {isSupported && (
          <button
            className={`input-bar-mic${isListening ? ' listening' : ''}`}
            onClick={toggleVoice}
            title={isListening ? 'Stop voice input' : 'Start voice input (or hold Space)'}
          >
            {isListening ? <StopIcon /> : <MicIcon />}
          </button>
        )}
        <button className="input-bar-send" onClick={handleSend}>
          Send
        </button>
      </div>
    </>
  );
}
