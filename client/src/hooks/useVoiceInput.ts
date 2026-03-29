import { useState, useRef, useCallback, useEffect } from 'react';

// --- Web Speech API type declarations (not in all TS libs) ---

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

// --- Send-command detection ---

const SEND_COMMANDS = ['send message', 'send it', 'send that'];

function detectSendCommand(text: string): { found: boolean; cleaned: string } {
  const stripped = text.replace(/[.!?,;:\s]+$/, '');
  const lower = stripped.toLowerCase();
  for (const cmd of SEND_COMMANDS) {
    if (lower.endsWith(cmd)) {
      return { found: true, cleaned: stripped.slice(0, lower.length - cmd.length).trim() };
    }
  }
  return { found: false, cleaned: text };
}

// --- Hook ---

interface UseVoiceInputOptions {
  onSend: (text: string) => void;
}

export function useVoiceInput({ onSend }: UseVoiceInputOptions) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimText, setInterimText] = useState('');

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const shouldRestartRef = useRef(false);
  // Text carried over from previous recognition sessions (across auto-restarts on silence)
  const accumulatedRef = useRef('');
  // All final text from the *current* recognition session
  const lastSessionFinalRef = useRef('');
  // Ref-based callback to avoid stale closures
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  // Self-reference so onend can call startRecognition without closure issues
  const startRef = useRef<() => void>();

  const isSupported = getSpeechRecognition() !== null;

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    setIsListening(false);
    setInterimText('');
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
  }, []);

  const startRecognition = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR) return;

    // Always abort existing instance to prevent overlaps
    if (recognitionRef.current) {
      recognitionRef.current.onend = null; // prevent restart from old instance
      recognitionRef.current.abort();
    }

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      shouldRestartRef.current = true;
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let sessionFinal = '';
      let interim = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          sessionFinal += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      lastSessionFinalRef.current = sessionFinal;
      const full = (accumulatedRef.current + sessionFinal).trim();

      // Check for voice send command
      const { found, cleaned } = detectSendCommand(full);
      if (found) {
        if (cleaned) onSendRef.current(cleaned);
        // Reset all text state
        accumulatedRef.current = '';
        lastSessionFinalRef.current = '';
        setTranscript('');
        setInterimText('');
        // Abort + restart to get fresh results list (prevents stale finals reappearing)
        if (recognitionRef.current) recognitionRef.current.abort();
        return;
      }

      setTranscript(full);
      setInterimText(interim);
    };

    recognition.onend = () => {
      if (shouldRestartRef.current) {
        // Carry over finals from the session that just ended
        accumulatedRef.current = (accumulatedRef.current + lastSessionFinalRef.current).trim();
        lastSessionFinalRef.current = '';
        // Restart after brief delay to avoid rapid-fire restarts
        setTimeout(() => {
          if (shouldRestartRef.current) startRef.current?.();
        }, 200);
      } else {
        setIsListening(false);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Normal lifecycle events — not real errors
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      // User denied microphone access
      if (event.error === 'not-allowed') {
        shouldRestartRef.current = false;
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // Already started or other browser quirk — ignore
    }
  }, []); // No deps: all mutable values accessed via refs

  startRef.current = startRecognition;

  const toggle = useCallback(() => {
    if (isListening) {
      stop();
    } else {
      accumulatedRef.current = '';
      lastSessionFinalRef.current = '';
      setTranscript('');
      setInterimText('');
      startRecognition();
    }
  }, [isListening, stop, startRecognition]);

  const clearTranscript = useCallback(() => {
    accumulatedRef.current = '';
    lastSessionFinalRef.current = '';
    setTranscript('');
    setInterimText('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) recognitionRef.current.abort();
    };
  }, []);

  return { isListening, isSupported, transcript, interimText, toggle, start: startRecognition, stop, clearTranscript };
}
