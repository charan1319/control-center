import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';

const PULSE_DIR = join(process.cwd(), 'data', 'pulse');

function sanitizeProject(project) {
  return project.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function mainPulseId(project) {
  return `main-${sanitizeProject(project)}`;
}

// ──────────────────────────────────────────────
// Lazy creation — ensures a main pulse exists for a project
// ──────────────────────────────────────────────

export function getOrCreateMainPulse(project) {
  if (!project) return null;
  const id = mainPulseId(project);
  db.insertPulseIgnore({ id, project, name: 'Main', description: '', is_main: 1 });
  return db.getPulse(id);
}

// ─────────���────────────────────────────────────
// Migration — run once on startup to migrate from data/pulse/*.json
// ──────────────────────────────────────────────

export function migrateFromFiles() {
  // Discover existing projects from two sources
  const projectsFromSessions = new Set();
  try {
    const rows = db.default.prepare('SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL').all();
    for (const r of rows) projectsFromSessions.add(r.project);
  } catch { /* empty db */ }

  const projectsFromFiles = new Set();
  try {
    const files = readdirSync(PULSE_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) projectsFromFiles.add(f.replace('.json', ''));
  } catch { /* no pulse dir */ }

  const allProjects = new Set([...projectsFromSessions, ...projectsFromFiles]);

  for (const project of allProjects) {
    const pulse = getOrCreateMainPulse(project);
    if (!pulse) continue;

    // Migrate user notes from JSON file
    const safe = sanitizeProject(project);
    const filePath = join(PULSE_DIR, `${safe}.json`);
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (data.userNotes && data.userNotes.trim()) {
        // Only migrate if no user_note entries exist yet for this pulse
        const existingCount = db.getPulseEntryCount(pulse.id);
        if (existingCount === 0) {
          db.insertPulseEntry({
            pulse_id: pulse.id,
            session_id: null,
            entry_type: 'user_note',
            content: data.userNotes,
          });
        }
      }
    } catch { /* file doesn't exist or invalid */ }

    // Auto-subscribe active sessions with pulse_enabled=1
    try {
      const sessions = db.default.prepare(
        'SELECT session_id FROM sessions WHERE project = ? AND pulse_enabled = 1 AND status != ?'
      ).all(project, 'stopped');
      for (const s of sessions) {
        db.addPulseMember(pulse.id, s.session_id);
      }
    } catch { /* ignore */ }
  }
}

// ─���───────────────────────���────────────────────
// Assemble pulse content from entries
// ──────────────────────────────────────────────

export function assemblePulseContent(pulseId, { charBudget = 6000 } = {}) {
  const pulse = db.getPulse(pulseId);
  if (!pulse) return '';

  const entries = db.getPulseEntriesAsc(pulseId);
  if (entries.length === 0) return '';

  let md = '';
  for (const e of entries) {
    const label = e.session_label || (e.session_id ? e.session_id.slice(0, 8) : 'System');
    const typeIcon = { briefing: '📋', file_change: '📁', status: '🔄', user_note: '📝', compaction: '📦' }[e.entry_type] || '';
    const line = `[${e.entry_type}] ${label}: ${e.content}\n`;
    md += line;
    if (md.length > charBudget) {
      md = md.slice(md.length - charBudget);
      break;
    }
  }

  return md;
}

/**
 * Assemble pulse context for a project (used at launch time).
 * Includes main pulse + live status headers.
 */
export function assembleProjectPulseContext(project) {
  if (!project) return '';

  const mainPulse = getOrCreateMainPulse(project);
  if (!mainPulse) return '';

  // Live status header: active agents + file conflicts
  const activeSessions = db.getSessionsByProject(project).filter(s => s.status !== 'stopped');
  const conflicts = db.getActiveFileConflicts(project);

  let header = '';
  if (activeSessions.length > 0) {
    header += 'Active agents:\n';
    for (const s of activeSessions) {
      const label = s.label || s.session_id.slice(0, 8);
      header += `- ${label}${s.last_tool ? ` (last: ${s.last_tool})` : ''}\n`;
    }
    header += '\n';
  }
  if (conflicts.length > 0) {
    header += 'File conflicts:\n';
    for (const c of conflicts) {
      header += `- ${c.file_path} edited by: ${c.session_ids}\n`;
    }
    header += '\n';
  }

  // Main pulse entries
  const mainContent = assemblePulseContent(mainPulse.id, { charBudget: 6000 });

  // Topic pulses for the project
  const allPulses = db.getPulsesByProject(project);
  const topicPulses = allPulses.filter(p => !p.is_main);
  let topicContent = '';
  for (const tp of topicPulses) {
    const content = assemblePulseContent(tp.id, { charBudget: 3000 });
    if (content.trim()) {
      topicContent += `\n--- ${tp.name} ---\n${content}`;
    }
  }

  const full = [header, mainContent, topicContent].filter(Boolean).join('\n').trim();
  return full.slice(0, 12000); // Hard cap
}

/**
 * Assemble pulse context for a specific session's subscribed pulses.
 * Used for mid-session refresh (sync-pulse).
 */
export function assembleSessionPulseContext(sessionId) {
  const pulses = db.getSessionPulses(sessionId);
  if (pulses.length === 0) return '';

  let result = '';
  for (const p of pulses) {
    const budget = p.is_main ? 6000 : 3000;
    const content = assemblePulseContent(p.id, { charBudget: budget });
    if (content.trim()) {
      result += `--- ${p.name} ---\n${content}\n`;
    }
  }
  return result.trim().slice(0, 12000);
}

// ──────────────────────────────────────────────
// Backward compatibility wrappers
// ───────────────────���──────────────────────────

export function getUserNotes(project) {
  const mainPulse = getOrCreateMainPulse(project);
  if (!mainPulse) return '';
  const entries = db.getPulseEntries(mainPulse.id, { limit: 1 });
  const note = entries.find(e => e.entry_type === 'user_note');
  return note?.content || '';
}

export function setUserNotes(project, notes) {
  const mainPulse = getOrCreateMainPulse(project);
  if (!mainPulse) return;
  db.deleteUserNotesByPulse(mainPulse.id);
  if (notes && notes.trim()) {
    db.insertPulseEntry({
      pulse_id: mainPulse.id,
      session_id: null,
      entry_type: 'user_note',
      content: notes,
    });
  }
}

export function generatePulse(project) {
  const activeSessions = db.getSessionsByProject(project).filter(s => s.status !== 'stopped');
  const recentFiles = db.getRecentFileEditsByProject(project, 30);
  const conflicts = db.getActiveFileConflicts(project);
  const userNotes = getUserNotes(project);

  let md = `# Project Pulse: ${project}\nUpdated: ${new Date().toISOString()}\n\n`;

  md += `## Active Agents\n`;
  if (activeSessions.length === 0) {
    md += `No active sessions.\n\n`;
  } else {
    for (const s of activeSessions) {
      const label = s.label || s.session_id.slice(0, 8);
      const lastTool = s.last_tool ? `Last: ${s.last_tool}` : '';
      md += `- **${label}**: ${lastTool}\n`;
    }
    md += '\n';
  }

  // Show recent pulse entries instead of raw file edits
  const mainPulse = getOrCreateMainPulse(project);
  if (mainPulse) {
    const recentEntries = db.getPulseEntries(mainPulse.id, { limit: 10 });
    if (recentEntries.length > 0) {
      md += `## Recent Knowledge\n`;
      for (const e of recentEntries.reverse()) {
        const label = e.session_label || 'System';
        md += `- [${e.entry_type}] ${label}: ${e.content.slice(0, 120)}\n`;
      }
      md += '\n';
    }
  }

  if (recentFiles.length > 0) {
    md += `## Recent File Changes\n`;
    for (const f of recentFiles.slice(0, 15)) {
      const sessionLabel = activeSessions.find(s => s.session_id === f.session_id)?.label || f.session_id.slice(0, 8);
      md += `- ${f.file_path} — ${sessionLabel}\n`;
    }
    md += '\n';
  }

  if (conflicts.length > 0) {
    md += `## Conflicts\n`;
    for (const c of conflicts) {
      md += `- ${c.file_path} is being edited by: ${c.session_ids}\n`;
    }
    md += '\n';
  }

  md += `## Notes\n${userNotes || '(No notes yet — add big-picture context, priorities, or warnings here.)'}\n`;

  return { markdown: md, userNotes };
}

export function getPulseForPrompt(project) {
  return assembleProjectPulseContext(project).slice(0, 3000);
}
