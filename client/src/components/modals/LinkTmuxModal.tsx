import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import { useToast } from '../Toast';
import './ModalBase.css';
import './LinkTmuxModal.css';

// The server returns { name, cwd } objects, even though api.ts types it as string[].
// Define the actual shape here.
interface TmuxSessionInfo {
  name: string;
  cwd: string;
}

interface LinkTmuxModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
}

export function LinkTmuxModal({ isOpen, onClose, sessionId }: LinkTmuxModalProps) {
  const { showToast } = useToast();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);

  // Fetch tmux sessions on open
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    // Cast because server actually returns {name,cwd}[] not string[]
    (api.getTmuxSessions() as unknown as Promise<TmuxSessionInfo[]>)
      .then(sessions => {
        setTmuxSessions(sessions);
        setLoading(false);
      })
      .catch(() => {
        showToast('Failed to fetch tmux sessions', 'error');
        setTmuxSessions([]);
        setLoading(false);
      });
  }, [isOpen, showToast]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleLink = useCallback(async (tmuxName: string) => {
    setLinking(true);
    try {
      await api.patchSession(sessionId, { tmux_target: tmuxName });
      showToast(`Linked to ${tmuxName}`, 'success');
      onClose();
    } catch (err) {
      showToast(`Failed to link: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLinking(false);
    }
  }, [sessionId, onClose, showToast]);

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Link tmux Session</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="link-tmux-loading">Loading tmux sessions...</div>
          ) : tmuxSessions.length === 0 ? (
            <div className="link-tmux-empty">
              No tmux sessions found. Create one with: <code>tmux new-session -d -s cc-0</code>
            </div>
          ) : (
            <div className="link-tmux-list">
              {tmuxSessions.map(ts => (
                <div
                  key={ts.name}
                  className="link-tmux-item"
                  onClick={() => !linking && handleLink(ts.name)}
                >
                  <span className="link-tmux-name">{ts.name}</span>
                  <span className="link-tmux-cwd">{ts.cwd || 'unknown'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
