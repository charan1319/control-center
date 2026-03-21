import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Temp database for test isolation
const tmpDir = mkdtempSync(join(tmpdir(), 'cc-api-test-'));
process.env.CC_DB_PATH = join(tmpDir, 'test.sqlite');
process.env.CC_PORT = '0';           // won't actually listen
const { buildServer } = await import('../server.js');

let app;

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/hooks', () => {
  it('rejects missing event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: 'x' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing session_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Stop' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('SessionStart creates session and returns 204', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: 'test-1',
        cwd: '/tmp/proj',
        model: 'claude-sonnet-4-6',
        transcript_path: '/tmp/t.jsonl',
        tmux_session: 'cc-test',
      },
    });
    assert.equal(res.statusCode, 204);
  });

  it('Stop sets session status back to active (not stopped — kill API does that)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Stop', session_id: 'test-1', cwd: '/tmp/proj' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.json().status, 'active');
  });

  it('PermissionRequest updates session status to waiting_permission', async () => {
    // Re-activate first
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'SessionStart', session_id: 'test-1', cwd: '/tmp/proj', tmux_session: 'cc-test' },
    });

    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'PermissionRequest',
        session_id: 'test-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.json().status, 'waiting_permission');
  });

  it('Heartbeat returns 204 and does not create an event record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { event: 'Heartbeat', session_id: 'test-1', tool_name: 'Bash' },
    });
    assert.equal(res.statusCode, 204);

    // Heartbeats should NOT appear in events
    const eventsRes = await app.inject({ method: 'GET', url: '/api/sessions/test-1/events' });
    const events = eventsRes.json();
    assert.ok(!events.some(e => e.event === 'Heartbeat'));
  });
});

describe('GET /api/sessions', () => {
  it('returns an array of sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    const sessions = res.json();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 1);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns 404 for missing session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('returns session details', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().session_id, 'test-1');
    assert.equal(res.json().cwd, '/tmp/proj');
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('updates label', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/test-1',
      payload: { label: 'my-task' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().label, 'my-task');
  });

  it('updates tmux_target', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/test-1',
      payload: { tmux_target: 'cc-5' },
    });
    assert.equal(res.json().tmux_target, 'cc-5');
  });

  it('returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/nonexistent',
      payload: { label: 'x' },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/events', () => {
  it('returns recent events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('respects limit parameter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=1' });
    assert.ok(res.json().length <= 1);
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('returns events for a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1/events' });
    assert.equal(res.statusCode, 200);
    const events = res.json();
    assert.ok(Array.isArray(events));
    assert.ok(events.every(e => e.session_id === 'test-1'));
  });
});

describe('GET /api/tmux-sessions', () => {
  it('returns an array (may be empty in test env)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmux-sessions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });
});

describe('GET /api/sessions/:id/transcript', () => {
  const transcriptPath = join(tmpDir, 'test-transcript.jsonl');

  before(async () => {
    // Create a test transcript JSONL file
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Hello, build a feature' }] }, timestamp: '2026-03-20T01:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Let me think about this...' }, { type: 'text', text: 'I will help you build that.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo.js' }, id: 'tu1' }] }, timestamp: '2026-03-20T01:00:01Z' }),
      JSON.stringify({ type: 'tool_result', content: [{ text: 'file content here' }], tool_use_id: 'tu1', timestamp: '2026-03-20T01:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done reading the file.' }] }, timestamp: '2026-03-20T01:00:03Z' }),
    ];
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    // Create a session with the transcript path
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: 'transcript-test-1',
        cwd: '/tmp/proj',
        model: 'claude-sonnet-4-6',
        transcript_path: transcriptPath,
        tmux_session: 'cc-transcript-test',
      },
    });
  });

  it('returns 404 for missing session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent/transcript' });
    assert.equal(res.statusCode, 404);
  });

  it('returns structured transcript entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/transcript-test-1/transcript' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.length > 0);
    assert.ok(typeof body.hasMore === 'boolean');
  });

  it('returns correct entry types from transcript', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/transcript-test-1/transcript' });
    const { entries } = res.json();
    const types = entries.map(e => e.type);
    assert.ok(types.includes('user'));
    assert.ok(types.includes('assistant'));
    assert.ok(types.includes('thinking'));
    assert.ok(types.includes('tool_use'));
    assert.ok(types.includes('tool_result'));
  });

  it('tool_use entries have tool_name and tool_input_summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/transcript-test-1/transcript' });
    const { entries } = res.json();
    const toolUse = entries.find(e => e.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.tool_name, 'Read');
    assert.equal(toolUse.tool_input_summary, '/tmp/foo.js');
    assert.ok(toolUse.tool_input_full);
  });

  it('respects limit parameter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/transcript-test-1/transcript?limit=2' });
    const { entries } = res.json();
    assert.ok(entries.length <= 2);
  });

  it('returns 404 for session without transcript', async () => {
    // Create a session without a transcript path
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: 'no-transcript-session',
        cwd: '/tmp/empty',
        tmux_session: 'cc-no-transcript',
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/no-transcript-session/transcript' });
    assert.equal(res.statusCode, 404);
  });
});

describe('Snapshot diff & revert', () => {
  it('GET /api/sessions/:id/snapshot-diff returns 404 for session without snapshot', async () => {
    // test-1 was created earlier but has no snapshot_hash (snapshots require real git)
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-1/snapshot-diff' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error.includes('No snapshot'));
  });

  it('GET /api/sessions/:id/snapshot-diff returns 404 for nonexistent session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent/snapshot-diff' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'Session not found');
  });

  it('POST /api/sessions/:id/revert returns 400 for active session', async () => {
    // test-1 is active (from earlier tests), so revert should fail
    const sessionRes = await app.inject({ method: 'GET', url: '/api/sessions/test-1' });
    // Ensure it's not stopped
    assert.notEqual(sessionRes.json().status, 'stopped');

    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-1/revert' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Session must be stopped before reverting');
  });

  it('POST /api/sessions/:id/revert returns 400 for session without snapshot', async () => {
    // Create a stopped session without a snapshot
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: 'revert-test-1',
        cwd: '/tmp/revert-proj',
        tmux_session: 'cc-revert-test',
      },
    });
    // Kill it to make it stopped
    await app.inject({ method: 'POST', url: '/api/sessions/revert-test-1/kill' });

    const res = await app.inject({ method: 'POST', url: '/api/sessions/revert-test-1/revert' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'No snapshot available');
  });

  it('POST /api/sessions/:id/revert returns 404 for nonexistent session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nonexistent/revert' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'Session not found');
  });
});

describe('File edit tracking', () => {
  const FILE_SESSION = 'file-edit-test-1';
  const FILE_SESSION_2 = 'file-edit-test-2';

  before(async () => {
    // Create two sessions in the same project
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: FILE_SESSION,
        cwd: '/tmp/proj-files',
        tmux_session: 'cc-file-1',
      },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${FILE_SESSION}`,
      payload: { project: 'file-test-project' },
    });

    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'SessionStart',
        session_id: FILE_SESSION_2,
        cwd: '/tmp/proj-files',
        tmux_session: 'cc-file-2',
      },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${FILE_SESSION_2}`,
      payload: { project: 'file-test-project' },
    });
  });

  it('Heartbeat with file_path records a file edit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'Heartbeat',
        session_id: FILE_SESSION,
        tool_name: 'Write',
        file_path: '/tmp/proj-files/src/index.js',
      },
    });
    assert.equal(res.statusCode, 204);
  });

  it('GET /api/sessions/:id/files returns file edits for a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${FILE_SESSION}/files` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.files));
    assert.ok(body.files.length >= 1);
    const entry = body.files.find(f => f.file_path === '/tmp/proj-files/src/index.js');
    assert.ok(entry);
    assert.equal(entry.tool_name, 'Write');
    assert.ok(entry.last_edited);
  });

  it('GET /api/sessions/:id/files returns empty array for session with no edits', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent-file-session/files' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { files: [] });
  });

  it('Heartbeat without file_path does not record a file edit', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'Heartbeat',
        session_id: FILE_SESSION,
        tool_name: 'Read',
      },
    });

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${FILE_SESSION}/files` });
    const body = res.json();
    // Should still only have the one Write edit, not a Read entry
    assert.ok(!body.files.some(f => f.tool_name === 'Read'));
  });

  it('detects file conflicts when two sessions edit the same file in same project', async () => {
    // Second session edits the same file
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'Heartbeat',
        session_id: FILE_SESSION_2,
        tool_name: 'Edit',
        file_path: '/tmp/proj-files/src/index.js',
      },
    });

    // Verify both sessions have the file
    const res1 = await app.inject({ method: 'GET', url: `/api/sessions/${FILE_SESSION}/files` });
    assert.ok(res1.json().files.some(f => f.file_path === '/tmp/proj-files/src/index.js'));

    const res2 = await app.inject({ method: 'GET', url: `/api/sessions/${FILE_SESSION_2}/files` });
    assert.ok(res2.json().files.some(f => f.file_path === '/tmp/proj-files/src/index.js'));
  });
});
