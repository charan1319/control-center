import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api';
import { useToast } from '../Toast';
import type { Session, ProjectPreset } from '../../types';
import './ModalBase.css';
import './EditSessionModal.css';

interface EditSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session;
}

export function EditSessionModal({ isOpen, onClose, session }: EditSessionModalProps) {
  const { showToast } = useToast();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [label, setLabel] = useState(session.label || '');
  const [project, setProject] = useState(session.project || '');
  const [saving, setSaving] = useState(false);
  const [projectOptions, setProjectOptions] = useState<string[]>([]);

  // Reset form when session changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setLabel(session.label || '');
      setProject(session.project || '');
    }
  }, [isOpen, session.label, session.project]);

  // Load project presets for the datalist
  useEffect(() => {
    if (!isOpen) return;
    api.getProjects()
      .then((presets: ProjectPreset[]) => {
        setProjectOptions(presets.map(p => p.name));
      })
      .catch(() => setProjectOptions([]));
  }, [isOpen]);

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

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.patchSession(session.session_id, {
        label: label.trim() || undefined,
        project: project.trim(),
      });
      showToast('Session updated', 'success');
      onClose();
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [session.session_id, label, project, onClose, showToast]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Edit Session</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label">Label</label>
            <input
              className="modal-input"
              type="text"
              placeholder="Session label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              autoFocus
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">Project</label>
            <input
              className="modal-input"
              type="text"
              placeholder="Project name"
              value={project}
              onChange={e => setProject(e.target.value)}
              list="edit-project-options"
            />
            <datalist id="edit-project-options">
              {projectOptions.map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
