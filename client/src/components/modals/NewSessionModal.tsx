import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api';
import { useToast } from '../Toast';
import type { ProjectPreset, SessionTemplate } from '../../types';
import './ModalBase.css';
import './NewSessionModal.css';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewSessionModal({ isOpen, onClose }: NewSessionModalProps) {
  const { showToast } = useToast();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [label, setLabel] = useState('');
  const [cwdPreset, setCwdPreset] = useState('');
  const [cwdCustom, setCwdCustom] = useState('');
  const [project, setProject] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [autoApprove, setAutoApprove] = useState(1);
  const [cliType, setCliType] = useState('claude');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [launching, setLaunching] = useState(false);

  const [projects, setProjects] = useState<ProjectPreset[]>([]);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);

  // Load projects and templates when modal opens
  useEffect(() => {
    if (!isOpen) return;
    api.getProjects().then(setProjects).catch(() => setProjects([]));
    api.getTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [isOpen]);

  // Set initial preset value once projects load
  useEffect(() => {
    if (projects.length > 0 && !cwdPreset) {
      setCwdPreset(projects[0].cwd);
      setProject(projects[0].name);
    }
  }, [projects, cwdPreset]);

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
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handlePresetChange = useCallback((value: string) => {
    setCwdPreset(value);
    if (value !== '__custom__') {
      const match = projects.find(p => p.cwd === value);
      if (match) setProject(match.name);
    }
  }, [projects]);

  const handleTemplateChange = useCallback((id: string) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find(tmpl => tmpl.id === id);
    if (!t) return;
    if (t.label) setLabel(t.label);
    if (t.prompt) setInitialPrompt(t.prompt);
    if (t.autoApprove !== undefined) setAutoApprove(t.autoApprove);
    if (t.cwd) {
      const matchingPreset = projects.find(p => p.cwd === t.cwd);
      if (matchingPreset) {
        setCwdPreset(t.cwd);
        setCwdCustom('');
        setProject(matchingPreset.name);
      } else {
        setCwdPreset('__custom__');
        setCwdCustom(t.cwd);
      }
    }
    if (t.project) setProject(t.project);
  }, [templates, projects]);

  const handleSaveTemplate = useCallback(async () => {
    const name = window.prompt('Template name:', label || '');
    if (!name?.trim()) return;
    const cwd = cwdPreset === '__custom__' ? cwdCustom : cwdPreset;
    try {
      await api.createTemplate({
        name: name.trim(),
        label,
        cwd: cwd || undefined,
        project: project || undefined,
        autoApprove,
        prompt: initialPrompt || undefined,
      });
      const fresh = await api.getTemplates();
      setTemplates(fresh);
      showToast('Template saved', 'success');
    } catch (err) {
      showToast(`Failed to save template: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [label, cwdPreset, cwdCustom, project, autoApprove, initialPrompt, showToast]);

  const handleLaunch = useCallback(async () => {
    if (!label.trim()) return;
    setLaunching(true);
    const cwd = cwdPreset === '__custom__' ? cwdCustom.trim() : cwdPreset;
    const resolvedProject = (cwdPreset !== '__custom__' && cwdPreset)
      ? (projects.find(p => p.cwd === cwdPreset)?.name || undefined)
      : undefined;
    try {
      await api.launchSession({
        label: label.trim() || undefined,
        cwd: cwd || undefined,
        initialPrompt: initialPrompt.trim() || undefined,
        project: resolvedProject || project.trim() || undefined,
        cli_type: cliType,
        skipPermissions: skipPermissions || undefined,
      });
      showToast(`Session "${label.trim()}" launched`, 'success');
      // Reset form
      setLabel('');
      setCwdPreset(projects.length > 0 ? projects[0].cwd : '');
      setCwdCustom('');
      setProject(projects.length > 0 ? projects[0].name : '');
      setInitialPrompt('');
      setAutoApprove(1);
      setSkipPermissions(false);
      setTemplateId('');
      onClose();
    } catch (err) {
      showToast(`Failed to launch: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLaunching(false);
    }
  }, [label, cwdPreset, cwdCustom, projects, project, initialPrompt, cliType, skipPermissions, onClose, showToast]);

  if (!isOpen) return null;

  const showCustomCwd = cwdPreset === '__custom__' || projects.length === 0;

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>New Session</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {/* Template selector */}
          <div className="new-session-template-row">
            <div className="modal-field">
              <label className="modal-label">Template</label>
              <select
                className="modal-select"
                value={templateId}
                onChange={e => handleTemplateChange(e.target.value)}
              >
                <option value="">-- No template --</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <button
              className="modal-btn modal-btn-secondary modal-btn-small"
              onClick={handleSaveTemplate}
              title="Save current form values as a template"
            >
              Save as template
            </button>
          </div>

          {/* Label */}
          <div className="modal-field">
            <label className="modal-label">Label *</label>
            <input
              className="modal-input"
              type="text"
              placeholder="e.g. Feature X"
              value={label}
              onChange={e => setLabel(e.target.value)}
              autoFocus
            />
          </div>

          {/* CWD */}
          <div className="modal-field">
            <label className="modal-label">Working Directory</label>
            {projects.length > 0 ? (
              <select
                className="modal-select"
                value={cwdPreset}
                onChange={e => handlePresetChange(e.target.value)}
              >
                {projects.map(p => (
                  <option key={p.cwd} value={p.cwd}>{p.name}</option>
                ))}
                <option value="__custom__">Custom path...</option>
              </select>
            ) : null}
            {showCustomCwd && (
              <input
                className="modal-input new-session-cwd-custom"
                type="text"
                placeholder="/path/to/project"
                value={cwdCustom}
                onChange={e => setCwdCustom(e.target.value)}
              />
            )}
          </div>

          {/* Project name */}
          <div className="modal-field">
            <label className="modal-label">Project Name</label>
            <input
              className="modal-input"
              type="text"
              placeholder="Auto-filled from preset"
              value={project}
              onChange={e => setProject(e.target.value)}
            />
          </div>

          {/* Initial prompt */}
          <div className="modal-field">
            <label className="modal-label">Initial Prompt</label>
            <textarea
              className="modal-textarea"
              placeholder="What should Claude work on?"
              value={initialPrompt}
              onChange={e => setInitialPrompt(e.target.value)}
              rows={3}
            />
          </div>

          {/* Auto-approve + CLI type row */}
          <div className="modal-row">
            <div className="modal-field">
              <label className="modal-label">Auto-approve</label>
              <select
                className="modal-select"
                value={autoApprove}
                onChange={e => setAutoApprove(Number(e.target.value))}
              >
                <option value={1}>Full</option>
                <option value={2}>No Edits</option>
                <option value={0}>None</option>
              </select>
            </div>
            <div className="modal-field">
              <label className="modal-label">CLI Type</label>
              <select
                className="modal-select"
                value={cliType}
                onChange={e => setCliType(e.target.value)}
              >
                <option value="claude">Claude Code</option>
                <option value="gemini">Gemini CLI</option>
                <option value="codex">Codex CLI</option>
              </select>
            </div>
          </div>

          {/* Skip permissions */}
          <div className="modal-checkbox-row">
            <input
              type="checkbox"
              id="ns-skip-perms"
              checked={skipPermissions}
              onChange={e => setSkipPermissions(e.target.checked)}
            />
            <label className="modal-checkbox-label" htmlFor="ns-skip-perms">
              Skip permissions (dangerously)
            </label>
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleLaunch}
            disabled={launching || !label.trim()}
          >
            {launching ? 'Launching...' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  );
}
