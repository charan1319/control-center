import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import type { TeamTemplate, TeamInstance } from '../types';
import './TeamPanel.css';

interface TeamPanelProps {
  project: string;
  onClose: () => void;
}

// ─── Duration formatting ───

function formatDuration(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diff = Math.max(0, end - start);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

// ─── Status badge ───

const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  active:    { color: 'var(--color-success)', label: 'Active' },
  completed: { color: 'var(--color-primary)', label: 'Completed' },
  failed:    { color: 'var(--ctp-red)',       label: 'Failed' },
};

export function TeamPanel({ project, onClose }: TeamPanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const { pulseVersion } = useWebSocket();

  // ─── Teams state ───
  const [teams, setTeams] = useState<TeamInstance[]>([]);
  const [loading, setLoading] = useState(true);

  // ─── Templates state ───
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // ─── Launch form state ───
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [objective, setObjective] = useState('');
  const [launching, setLaunching] = useState(false);

  // ─── Load teams ───
  const loadTeams = useCallback(async () => {
    try {
      const data = await api.getTeams(project);
      setTeams(data.teams);
    } catch {
      setTeams([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  // ─── Load templates ───
  const loadTemplates = useCallback(async () => {
    try {
      const data = await api.getTeamTemplates();
      setTemplates(data);
    } catch {
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadTeams();
    loadTemplates();
  }, [loadTeams, loadTemplates]);

  // Refresh on pulseVersion changes (team_launched / team_completed bump this)
  useEffect(() => {
    if (!loading) loadTeams();
  }, [pulseVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Launch team ───
  const handleLaunch = useCallback(async () => {
    if (!selectedTemplate || !objective.trim()) return;
    setLaunching(true);
    try {
      await api.launchTeam(selectedTemplate, { objective: objective.trim(), project });
      setObjective('');
      setSelectedTemplate('');
      loadTeams();
    } catch {
      /* ignore */
    } finally {
      setLaunching(false);
    }
  }, [selectedTemplate, objective, project, loadTeams]);

  // ─── Stop team ───
  const handleStop = useCallback(async (id: string) => {
    try {
      await api.stopTeam(id);
      loadTeams();
    } catch {
      /* ignore */
    }
  }, [loadTeams]);

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

  // ─── Separate active vs completed teams ───
  const activeTeams = teams.filter(t => t.status === 'active');
  const pastTeams = teams.filter(t => t.status !== 'active');

  return (
    <div className="team-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="team-panel">
        {/* ─── Header ─── */}
        <div className="team-header">
          <h2>Teams — {project}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="team-content">
          {/* ─── Launch form ─── */}
          <div className="team-launch-section">
            <div className="team-launch-label">Launch a Team</div>
            <select
              className="team-select"
              value={selectedTemplate}
              onChange={e => setSelectedTemplate(e.target.value)}
              disabled={templatesLoading || templates.length === 0}
            >
              <option value="">
                {templatesLoading ? 'Loading templates...' : templates.length === 0 ? 'No templates available' : 'Select a template...'}
              </option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <input
              className="team-objective-input"
              type="text"
              value={objective}
              onChange={e => setObjective(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleLaunch(); } }}
              placeholder="What should this team do?"
              disabled={launching}
            />
            <button
              className="team-btn team-btn-primary"
              onClick={handleLaunch}
              disabled={launching || !selectedTemplate || !objective.trim()}
            >
              {launching ? 'Launching...' : 'Launch'}
            </button>
          </div>

          {/* ─── Team list ─── */}
          <div className="team-list-section">
            {loading ? (
              <div className="team-loading">Loading teams...</div>
            ) : teams.length === 0 ? (
              <div className="team-empty">No teams yet. Select a template and launch one above.</div>
            ) : (
              <>
                {/* Active teams */}
                {activeTeams.length > 0 && (
                  <div className="team-group">
                    <div className="team-group-label">Active</div>
                    {activeTeams.map(team => (
                      <TeamCard key={team.id} team={team} templates={templates} onStop={handleStop} />
                    ))}
                  </div>
                )}

                {/* Past teams */}
                {pastTeams.length > 0 && (
                  <div className="team-group">
                    <div className="team-group-label">Recent</div>
                    {pastTeams.map(team => (
                      <TeamCard key={team.id} team={team} templates={templates} onStop={handleStop} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Team Card sub-component ───

function TeamCard({ team, templates, onStop }: {
  team: TeamInstance;
  templates: TeamTemplate[];
  onStop: (id: string) => void;
}) {
  const style = STATUS_STYLES[team.status] || STATUS_STYLES.active;
  const templateName = templates.find(t => t.id === team.template_id)?.name || 'Unknown template';

  return (
    <div className="team-card">
      <div className="team-card-top">
        <div className="team-card-info">
          <span className="team-card-name">{templateName}</span>
          <span className="team-card-status" style={{ color: style.color }}>
            {style.label}
          </span>
        </div>
        <span className="team-card-duration">
          {formatDuration(team.created_at, team.completed_at)}
        </span>
      </div>
      <div className="team-card-objective">{team.objective}</div>
      {team.summary && (
        <div className="team-card-summary">{team.summary}</div>
      )}
      {team.status === 'active' && (
        <div className="team-card-actions">
          <button
            className="team-btn team-btn-small team-btn-danger"
            onClick={() => onStop(team.id)}
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
