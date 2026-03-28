import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Pulse, PulseEntry } from '../types';
import './PulsePanel.css';

interface PulsePanelProps {
  project: string;
  onClose: () => void;
}

// ─── Entry type badges ───

const ENTRY_TYPE_BADGES: Record<string, { icon: string; label: string }> = {
  briefing:    { icon: '\u{1F4CB}', label: 'Briefing' },
  file_change: { icon: '\u{1F4DD}', label: 'File' },
  status:      { icon: '\u{2139}\uFE0F', label: 'Status' },
  user_note:   { icon: '\u{1F464}', label: 'Note' },
  compaction:  { icon: '\u{1F9F9}', label: 'Compacted' },
};

function entryBadge(type: string) {
  const b = ENTRY_TYPE_BADGES[type] || { icon: '\u{2022}', label: type };
  return b;
}

// ─── Relative time ───

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Source label for an entry ───

function sourceLabel(entry: PulseEntry): string {
  if (entry.entry_type === 'user_note') return 'You';
  if (entry.entry_type === 'compaction') return 'System';
  return entry.session_label || entry.session_id || 'System';
}

export function PulsePanel({ project, onClose }: PulsePanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const { pulseVersion } = useWebSocket();

  // ─── Pulse list state ───
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ─── Entries for active tab ───
  const [entries, setEntries] = useState<PulseEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);

  // ─── User note input ───
  const [noteText, setNoteText] = useState('');
  const [noteSending, setNoteSending] = useState(false);

  // ─── Backward-compat notes for Main pulse ───
  const [legacyNotes, setLegacyNotes] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const legacyNotesInitialized = useRef(false);

  // ─── Create pulse dialog ───
  const [showCreate, setShowCreate] = useState(false);
  const [newPulseName, setNewPulseName] = useState('');
  const [newPulseDesc, setNewPulseDesc] = useState('');

  // ─── Edit/delete state ───
  const [editingPulse, setEditingPulse] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // ─── Dream state ───
  const [dreaming, setDreaming] = useState(false);

  // ─── Load pulses ───
  const loadPulses = useCallback(async () => {
    try {
      const data = await api.getProjectPulses(project);
      setPulses(data);
      // Auto-select Main tab if nothing selected
      if (!activeTab || !data.find(p => p.id === activeTab)) {
        const main = data.find(p => p.is_main);
        if (main) setActiveTab(main.id);
        else if (data.length > 0) setActiveTab(data[0].id);
      }
    } catch {
      // API might not exist yet; fall back gracefully
      setPulses([]);
    } finally {
      setLoading(false);
    }
  }, [project, activeTab]);

  // Initial load + refresh on pulseVersion
  useEffect(() => {
    loadPulses();
  }, [project, pulseVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load entries for active tab ───
  const loadEntries = useCallback(async (pulseId: string) => {
    setEntriesLoading(true);
    try {
      const data = await api.getPulseEntries(pulseId, 100);
      setEntries(data);
    } catch {
      setEntries([]);
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab) loadEntries(activeTab);
  }, [activeTab, pulseVersion, loadEntries]);

  // ─── Legacy notes for Main pulse (backward compat) ───
  const activePulse = pulses.find(p => p.id === activeTab);
  const isMainTab = activePulse?.is_main === 1;

  useEffect(() => {
    if (isMainTab && !legacyNotesInitialized.current) {
      api.getPulse(project).then(data => {
        setLegacyNotes(data.userNotes || '');
        legacyNotesInitialized.current = true;
      }).catch(() => {});
    }
  }, [isMainTab, project]);

  useEffect(() => {
    legacyNotesInitialized.current = false;
  }, [project]);

  const handleLegacyNotesChange = useCallback((value: string) => {
    setLegacyNotes(value);
    setSaveState('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await api.updatePulseNotes(project, value);
        setSaveState('saved');
      } catch {
        setSaveState('idle');
      }
    }, 1000);
  }, [project]);

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, []);

  // ─── Add user note entry ───
  const handleAddNote = useCallback(async () => {
    if (!noteText.trim() || !activeTab) return;
    setNoteSending(true);
    try {
      await api.addPulseEntry(activeTab, { content: noteText.trim(), entry_type: 'user_note' });
      setNoteText('');
      loadEntries(activeTab);
    } catch { /* ignore */ }
    setNoteSending(false);
  }, [noteText, activeTab, loadEntries]);

  // ─── Create pulse ───
  const handleCreatePulse = useCallback(async () => {
    if (!newPulseName.trim()) return;
    try {
      const p = await api.createPulse(project, {
        name: newPulseName.trim(),
        description: newPulseDesc.trim() || undefined,
      });
      setShowCreate(false);
      setNewPulseName('');
      setNewPulseDesc('');
      setActiveTab(p.id);
      loadPulses();
    } catch { /* ignore */ }
  }, [newPulseName, newPulseDesc, project, loadPulses]);

  // ─── Edit pulse name ───
  const handleSaveEdit = useCallback(async () => {
    if (!editingPulse || !editName.trim()) return;
    try {
      await api.updatePulseMetadata(editingPulse, { name: editName.trim() });
      setEditingPulse(null);
      loadPulses();
    } catch { /* ignore */ }
  }, [editingPulse, editName, loadPulses]);

  // ─── Delete pulse ───
  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deletePulse(id);
      setConfirmDelete(null);
      if (activeTab === id) {
        const main = pulses.find(p => p.is_main);
        setActiveTab(main?.id || null);
      }
      loadPulses();
    } catch { /* ignore */ }
  }, [activeTab, pulses, loadPulses]);

  // ─── Dream ───
  const handleDream = useCallback(async () => {
    if (!activeTab) return;
    setDreaming(true);
    try {
      await api.triggerDream(activeTab);
    } catch { /* ignore */ }
    setDreaming(false);
  }, [activeTab]);

  // ─── Keyboard & overlay ───
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

  return (
    <div className="pulse-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="pulse-panel">
        {/* ─── Header ─── */}
        <div className="pulse-header">
          <h2>Pulse — {project}</h2>
          <div className="pulse-header-actions">
            <button
              className="pulse-btn pulse-btn-small"
              onClick={() => setShowCreate(true)}
              title="New topic pulse"
            >
              + New Pulse
            </button>
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
        </div>

        {/* ─── Tabs ─── */}
        {!loading && pulses.length > 0 && (
          <div className="pulse-tabs">
            {pulses.map(p => (
              <button
                key={p.id}
                className={`pulse-tab ${p.id === activeTab ? 'pulse-tab-active' : ''}`}
                onClick={() => setActiveTab(p.id)}
                title={p.description || p.name}
              >
                {p.is_main ? 'Main' : p.name}
                {p.entry_count > 0 && (
                  <span className="pulse-tab-count">{p.entry_count}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ─── Content ─── */}
        <div className="pulse-content">
          {loading ? (
            <div className="pulse-loading">Loading pulses...</div>
          ) : !activePulse ? (
            <div className="pulse-loading">No pulses found. Create one to get started.</div>
          ) : (
            <>
              {/* Pulse meta / actions bar */}
              <div className="pulse-actions-bar">
                {activePulse.description && (
                  <span className="pulse-description">{activePulse.description}</span>
                )}
                <div className="pulse-actions-right">
                  <button
                    className="pulse-btn pulse-btn-small"
                    onClick={handleDream}
                    disabled={dreaming}
                    title="Consolidate entries into a summary"
                  >
                    {dreaming ? 'Dreaming...' : 'Dream'}
                  </button>
                  {!activePulse.is_main && (
                    <>
                      <button
                        className="pulse-btn pulse-btn-small"
                        onClick={() => {
                          setEditingPulse(activePulse.id);
                          setEditName(activePulse.name);
                        }}
                        title="Edit pulse name"
                      >
                        Edit
                      </button>
                      <button
                        className="pulse-btn pulse-btn-small pulse-btn-danger"
                        onClick={() => setConfirmDelete(activePulse.id)}
                        title="Delete this pulse"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Entry list */}
              <div className="pulse-entries-section">
                {entriesLoading && entries.length === 0 ? (
                  <div className="pulse-loading">Loading entries...</div>
                ) : entries.length === 0 ? (
                  <div className="pulse-empty">No entries yet. Add a note below or wait for agent activity.</div>
                ) : (
                  <div className="pulse-entries-list">
                    {entries.map(entry => {
                      const badge = entryBadge(entry.entry_type);
                      return (
                        <div key={entry.id} className="pulse-entry">
                          <div className="pulse-entry-header">
                            <span className="pulse-entry-badge" title={badge.label}>
                              {badge.icon}
                            </span>
                            <span className="pulse-entry-source">{sourceLabel(entry)}</span>
                            <span className="pulse-entry-type">{badge.label}</span>
                            <span className="pulse-entry-time">{relativeTime(entry.created_at)}</span>
                          </div>
                          <div className="pulse-entry-content">{entry.content}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Legacy notes section (Main tab only) */}
              {isMainTab && (
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
                    value={legacyNotes}
                    onChange={e => handleLegacyNotesChange(e.target.value)}
                    placeholder="Add your notes here..."
                  />
                </div>
              )}

              {/* Note input */}
              <div className="pulse-input-section">
                <input
                  className="pulse-note-input"
                  type="text"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddNote(); } }}
                  placeholder="Add a note to this pulse..."
                  disabled={noteSending}
                />
                <button
                  className="pulse-btn pulse-btn-primary"
                  onClick={handleAddNote}
                  disabled={noteSending || !noteText.trim()}
                >
                  {noteSending ? '...' : 'Add'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* ─── Create Pulse Dialog ─── */}
        {showCreate && (
          <div className="pulse-dialog-overlay" onClick={() => setShowCreate(false)}>
            <div className="pulse-dialog" onClick={e => e.stopPropagation()}>
              <h3>New Pulse</h3>
              <input
                className="pulse-dialog-input"
                type="text"
                placeholder="Pulse name"
                value={newPulseName}
                onChange={e => setNewPulseName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreatePulse(); }}
                autoFocus
              />
              <input
                className="pulse-dialog-input"
                type="text"
                placeholder="Description (optional)"
                value={newPulseDesc}
                onChange={e => setNewPulseDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreatePulse(); }}
              />
              <div className="pulse-dialog-actions">
                <button className="pulse-btn" onClick={() => setShowCreate(false)}>Cancel</button>
                <button
                  className="pulse-btn pulse-btn-primary"
                  onClick={handleCreatePulse}
                  disabled={!newPulseName.trim()}
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Edit Pulse Name Dialog ─── */}
        {editingPulse && (
          <div className="pulse-dialog-overlay" onClick={() => setEditingPulse(null)}>
            <div className="pulse-dialog" onClick={e => e.stopPropagation()}>
              <h3>Edit Pulse</h3>
              <input
                className="pulse-dialog-input"
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(); }}
                autoFocus
              />
              <div className="pulse-dialog-actions">
                <button className="pulse-btn" onClick={() => setEditingPulse(null)}>Cancel</button>
                <button
                  className="pulse-btn pulse-btn-primary"
                  onClick={handleSaveEdit}
                  disabled={!editName.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Delete Confirmation Dialog ─── */}
        {confirmDelete && (
          <div className="pulse-dialog-overlay" onClick={() => setConfirmDelete(null)}>
            <div className="pulse-dialog" onClick={e => e.stopPropagation()}>
              <h3>Delete Pulse</h3>
              <p className="pulse-dialog-text">
                Delete "{pulses.find(p => p.id === confirmDelete)?.name}"? This removes all entries and cannot be undone.
              </p>
              <div className="pulse-dialog-actions">
                <button className="pulse-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button
                  className="pulse-btn pulse-btn-danger"
                  onClick={() => handleDelete(confirmDelete)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
