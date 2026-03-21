import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import './PulsePanel.css';

interface PulsePanelProps {
  project: string;
  onClose: () => void;
}

/** Simple markdown-to-HTML renderer (no library needed) */
function renderMarkdown(md: string): string {
  if (!md) return '';

  const paragraphs = md.split(/\n\n+/);
  const rendered: string[] = [];

  for (const block of paragraphs) {
    const lines = block.split('\n');
    let inList = false;
    const parts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trimStart();

      // Headings
      if (trimmed.startsWith('## ')) {
        if (inList) { parts.push('</ul>'); inList = false; }
        parts.push(`<h3>${applyInline(trimmed.slice(3))}</h3>`);
        continue;
      }
      if (trimmed.startsWith('# ')) {
        if (inList) { parts.push('</ul>'); inList = false; }
        parts.push(`<h2>${applyInline(trimmed.slice(2))}</h2>`);
        continue;
      }

      // List items
      if (trimmed.startsWith('- ')) {
        if (!inList) { parts.push('<ul>'); inList = true; }
        parts.push(`<li>${applyInline(trimmed.slice(2))}</li>`);
        continue;
      }

      // Plain text line
      if (inList) { parts.push('</ul>'); inList = false; }
      if (trimmed) {
        parts.push(`<p>${applyInline(trimmed)}</p>`);
      }
    }

    if (inList) parts.push('</ul>');
    rendered.push(parts.join(''));
  }

  return rendered.join('');
}

/** Apply inline formatting: **bold** */
function applyInline(text: string): string {
  // Escape HTML entities first
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return s;
}

export function PulsePanel({ project, onClose }: PulsePanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesInitialized = useRef(false);

  const fetcher = useMemo(
    () => () => api.getPulse(project),
    [project]
  );

  const { data: pulseData, loading } = useApi(fetcher, {
    refreshInterval: 30000,
  });

  // Initialize notes from fetched data (only on first load)
  useEffect(() => {
    if (pulseData && !notesInitialized.current) {
      setNotes(pulseData.userNotes || '');
      notesInitialized.current = true;
    }
  }, [pulseData]);

  // Reset initialization flag when project changes
  useEffect(() => {
    notesInitialized.current = false;
  }, [project]);

  // Debounced auto-save for notes
  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    setSaveState('saving');

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(async () => {
      try {
        await api.updatePulseNotes(project, value);
        setSaveState('saved');
      } catch {
        setSaveState('idle');
      }
    }, 1000);
  }, [project]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Escape to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const markdownHtml = pulseData ? renderMarkdown(pulseData.markdown) : '';

  return (
    <div className="pulse-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="pulse-panel">
        <div className="pulse-header">
          <h2>Pulse — {project}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="pulse-content">
          <div className="pulse-markdown-section">
            {loading && !pulseData ? (
              <div className="pulse-loading">Loading pulse...</div>
            ) : (
              <div
                className="pulse-markdown"
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            )}
          </div>

          <div className="pulse-notes-section">
            <div className="pulse-notes-header">
              <span className="pulse-notes-label">Notes</span>
              {saveState === 'saving' && (
                <span className="pulse-save-indicator saving">Saving...</span>
              )}
              {saveState === 'saved' && (
                <span className="pulse-save-indicator saved">Saved</span>
              )}
            </div>
            <textarea
              className="pulse-notes-textarea"
              value={notes}
              onChange={e => handleNotesChange(e.target.value)}
              placeholder="Add your notes here..."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
