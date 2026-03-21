import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import { useToast } from '../Toast';
import './ModalBase.css';
import './SnapshotDiffModal.css';

interface SnapshotDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
}

interface DiffData {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function SnapshotDiffModal({ isOpen, onClose, sessionId }: SnapshotDiffModalProps) {
  const { showToast } = useToast();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(false);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch diff on open
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setDiff(null);

    api.getSnapshotDiff(sessionId)
      .then(data => setDiff(data))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isOpen, sessionId]);

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

  const handleRevert = useCallback(async () => {
    setReverting(true);
    try {
      const result = await api.revertSession(sessionId);
      showToast(`Reverted ${result.files.length} file${result.files.length !== 1 ? 's' : ''}`, 'success');
      onClose();
    } catch (err) {
      showToast(`Revert failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setReverting(false);
    }
  }, [sessionId, onClose, showToast]);

  if (!isOpen) return null;

  const totalChanges = diff ? diff.added.length + diff.modified.length + diff.deleted.length : 0;
  const noChanges = diff && totalChanges === 0;

  return createPortal(
    <div className="modal-overlay snapshot-diff-modal" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Snapshot Diff</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="snapshot-loading">
              <div className="snapshot-spinner" />
              Loading diff...
            </div>
          )}

          {error && (
            <div className="snapshot-empty">
              Failed to load diff: {error}
            </div>
          )}

          {noChanges && (
            <div className="snapshot-empty">
              No changes detected since session started
            </div>
          )}

          {diff && !noChanges && (
            <>
              {diff.added.length > 0 && (
                <div className="snapshot-section">
                  <div className="snapshot-section-header added">
                    Added files ({diff.added.length})
                    <span className="snapshot-section-hint">will be deleted on revert</span>
                  </div>
                  <ul className="snapshot-file-list">
                    {diff.added.map(file => (
                      <li key={file} className="snapshot-file-item">
                        <span className="snapshot-file-icon added">+</span>
                        <span className="snapshot-file-path">{file}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {diff.modified.length > 0 && (
                <div className="snapshot-section">
                  <div className="snapshot-section-header modified">
                    Modified files ({diff.modified.length})
                    <span className="snapshot-section-hint">will be restored</span>
                  </div>
                  <ul className="snapshot-file-list">
                    {diff.modified.map(file => (
                      <li key={file} className="snapshot-file-item">
                        <span className="snapshot-file-icon modified">M</span>
                        <span className="snapshot-file-path">{file}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {diff.deleted.length > 0 && (
                <div className="snapshot-section">
                  <div className="snapshot-section-header deleted">
                    Deleted files ({diff.deleted.length})
                    <span className="snapshot-section-hint">will be restored</span>
                  </div>
                  <ul className="snapshot-file-list">
                    {diff.deleted.map(file => (
                      <li key={file} className="snapshot-file-item">
                        <span className="snapshot-file-icon deleted">-</span>
                        <span className="snapshot-file-path">{file}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-warning"
            onClick={handleRevert}
            disabled={loading || reverting || noChanges || !!error}
          >
            {reverting ? 'Reverting...' : 'Confirm Revert'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
