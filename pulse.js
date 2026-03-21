import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './db.js';

const PULSE_DIR = join(process.cwd(), 'data', 'pulse');
mkdirSync(PULSE_DIR, { recursive: true });

function pulseFilePath(project) {
  const safe = project.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(PULSE_DIR, `${safe}.json`);
}

export function getUserNotes(project) {
  try {
    const data = JSON.parse(readFileSync(pulseFilePath(project), 'utf8'));
    return data.userNotes || '';
  } catch { return ''; }
}

export function setUserNotes(project, notes) {
  const filePath = pulseFilePath(project);
  let data = {};
  try { data = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
  data.userNotes = notes;
  writeFileSync(filePath, JSON.stringify(data, null, 2));
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
  const pulse = generatePulse(project);
  const compact = pulse.markdown
    .replace(/^#+\s.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000);
  return compact;
}
