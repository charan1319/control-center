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
