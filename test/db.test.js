import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set up temp database BEFORE importing db (ESM evaluates imports eagerly)
const tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
process.env.CC_DB_PATH = join(tmpDir, 'test.sqlite');

const db = await import('../db.js');

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('db: sessions', () => {
  it('upsertSession creates a new session', () => {
    db.upsertSession({ session_id: 's1', cwd: '/tmp', model: 'claude-sonnet-4-6', transcript: '/path/t.jsonl' });
    const s = db.getSession('s1');
    assert.equal(s.session_id, 's1');
    assert.equal(s.cwd, '/tmp');
    assert.equal(s.model, 'claude-sonnet-4-6');
    assert.equal(s.status, 'active');
  });

  it('upsertSession updates on conflict (does not overwrite with null)', () => {
    db.upsertSession({ session_id: 's1', cwd: null, model: null, transcript: null });
    const s = db.getSession('s1');
    assert.equal(s.cwd, '/tmp');         // preserved from first insert
    assert.equal(s.model, 'claude-sonnet-4-6'); // preserved
    assert.equal(s.status, 'active');    // reset to active
  });

  it('updateStatus changes session status', () => {
    db.updateStatus('s1', 'stopped');
    assert.equal(db.getSession('s1').status, 'stopped');
  });

  it('updateSession sets label and tmux_target', () => {
    db.updateSession('s1', { label: 'my-session', tmux_target: 'cc-0' });
    const s = db.getSession('s1');
    assert.equal(s.label, 'my-session');
    assert.equal(s.tmux_target, 'cc-0');
  });

  it('updateSession partial update preserves other fields', () => {
    db.updateSession('s1', { label: 'renamed' });
    const s = db.getSession('s1');
    assert.equal(s.label, 'renamed');
    assert.equal(s.tmux_target, 'cc-0'); // preserved
  });

  it('getAllSessions returns sessions with heartbeat join', () => {
    db.upsertSession({ session_id: 's2', cwd: '/home', model: 'opus', transcript: null });
    const all = db.getAllSessions();
    assert.ok(all.length >= 2);
    assert.ok(all.some(s => s.session_id === 's1'));
    assert.ok(all.some(s => s.session_id === 's2'));
  });

  // FIXED: better-sqlite3 .get() returns undefined (not null) for missing rows
  it('getSession returns undefined for missing session', () => {
    const s = db.getSession('nonexistent');
    assert.equal(s, undefined);
  });
});

describe('db: events', () => {
  it('insertEvent creates an event', () => {
    db.insertEvent({ session_id: 's1', event: 'SessionStart', tool_name: null, tool_input: null, raw: '{}' });
    db.insertEvent({ session_id: 's1', event: 'Stop', tool_name: 'Bash', tool_input: '{"command":"exit"}', raw: '{}' });
    const events = db.getSessionEvents('s1', 50, 0);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'Stop');     // most recent first
    assert.equal(events[1].event, 'SessionStart');
  });

  it('getSessionEvents paginates correctly', () => {
    const page1 = db.getSessionEvents('s1', 1, 0);
    const page2 = db.getSessionEvents('s1', 1, 1);
    assert.equal(page1.length, 1);
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('getRecentEvents returns events across sessions', () => {
    db.insertEvent({ session_id: 's2', event: 'SessionStart', tool_name: null, tool_input: null, raw: '{}' });
    const recent = db.getRecentEvents(100);
    assert.ok(recent.length >= 3);
    assert.ok(recent.some(e => e.session_id === 's1'));
    assert.ok(recent.some(e => e.session_id === 's2'));
  });
});

describe('db: heartbeats', () => {
  it('upsertHeartbeat creates a heartbeat', () => {
    db.upsertHeartbeat({ session_id: 's1', tool_name: 'Bash' });
    const s = db.getSession('s1');
    assert.equal(s.last_tool, 'Bash');
    assert.ok(s.last_heartbeat); // not null
  });

  it('upsertHeartbeat updates on conflict', () => {
    db.upsertHeartbeat({ session_id: 's1', tool_name: 'Write' });
    const s = db.getSession('s1');
    assert.equal(s.last_tool, 'Write'); // updated
  });
});
