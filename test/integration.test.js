import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ──────────────────────────────────────────────
// Setup: isolated temp database
// ──────────────────────────────────────────────
const tmpDir = mkdtempSync(join(tmpdir(), 'cc-integration-'));
process.env.CC_DB_PATH = join(tmpDir, 'test.sqlite');
process.env.CC_PORT = '0';
process.env.OPENCLAW_TOKEN = '';

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

// ──────────────────────────────────────────────
// Helper: simulate a full Claude Code session lifecycle
// ──────────────────────────────────────────────
async function injectHook(payload) {
  return app.inject({ method: 'POST', url: '/api/hooks', payload });
}

// ──────────────────────────────────────────────
// Integration: Full session lifecycle
// ──────────────────────────────────────────────
describe('Integration: Full session lifecycle', () => {
  const sessionId = 'lifecycle-test-001';

  it('step 1: SessionStart creates session and auto-links', async () => {
    const res = await injectHook({
      event: 'SessionStart',
      session_id: sessionId,
      cwd: '/home/user/my-project',
      model: 'claude-sonnet-4-6',
      transcript_path: '/tmp/transcript.jsonl',
    });
    assert.equal(res.statusCode, 204);

    // Verify session was created
    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(sessionRes.statusCode, 200);
    const session = sessionRes.json();
    assert.equal(session.session_id, sessionId);
    assert.equal(session.status, 'active');
    assert.equal(session.cwd, '/home/user/my-project');
    assert.equal(session.model, 'claude-sonnet-4-6');
  });

  it('step 2: Heartbeats update session activity without creating events', async () => {
    // Send multiple heartbeats
    for (const tool of ['Bash', 'Write', 'Edit', 'Bash']) {
      const res = await injectHook({
        event: 'Heartbeat',
        session_id: sessionId,
        tool_name: tool,
      });
      assert.equal(res.statusCode, 204);
    }

    // Session should show last tool
    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const session = sessionRes.json();
    assert.equal(session.last_tool, 'Bash');
    assert.ok(session.last_heartbeat);

    // Heartbeats should NOT appear in events
    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const events = eventsRes.json();
    assert.ok(!events.some(e => e.event === 'Heartbeat'));
  });

  it('step 3: PermissionRequest changes status to waiting_permission', async () => {
    const res = await injectHook({
      event: 'PermissionRequest',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'npm install lodash' },
    });
    assert.equal(res.statusCode, 200); // PermissionRequest returns 200 with auto_approve decision

    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(sessionRes.json().status, 'waiting_permission');

    // Event should be logged
    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const events = eventsRes.json();
    assert.ok(events.some(e => e.event === 'PermissionRequest' && e.tool_name === 'Bash'));
  });

  it('step 4: SessionStart after permission re-activates session', async () => {
    // Simulates Claude Code restarting after permission granted
    const res = await injectHook({
      event: 'SessionStart',
      session_id: sessionId,
      cwd: '/home/user/my-project',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(res.statusCode, 204);

    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(sessionRes.json().status, 'active');
  });

  it('step 5: Notification event is logged correctly', async () => {
    const res = await injectHook({
      event: 'Notification',
      session_id: sessionId,
      source: 'claude',
    });
    assert.equal(res.statusCode, 204);

    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const events = eventsRes.json();
    assert.ok(events.some(e => e.event === 'Notification'));
  });

  it('step 6: Stop resets session to active (stopped only via kill API)', async () => {
    const res = await injectHook({
      event: 'Stop',
      session_id: sessionId,
      cwd: '/home/user/my-project',
    });
    assert.equal(res.statusCode, 204);

    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(sessionRes.json().status, 'active');
  });

  it('step 7: All events appear in global event log in correct order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=100' });
    const events = res.json();

    // Filter to our session
    const sessionEvents = events.filter(e => e.session_id === sessionId);

    // Most recent first
    assert.equal(sessionEvents[0].event, 'Stop');
    assert.equal(sessionEvents[1].event, 'Notification');
    // SessionStart appears twice (initial + reactivation)
    assert.equal(sessionEvents[2].event, 'SessionStart');
    assert.equal(sessionEvents[3].event, 'PermissionRequest');
    assert.equal(sessionEvents[4].event, 'SessionStart');
  });
});

// ──────────────────────────────────────────────
// Integration: Session management (rename, link, list)
// ──────────────────────────────────────────────
describe('Integration: Session management', () => {
  const sessionId = 'mgmt-test-001';

  before(async () => {
    await injectHook({
      event: 'SessionStart',
      session_id: sessionId,
      cwd: '/tmp/mgmt-test',
      model: 'claude-sonnet-4-6',
    });
  });

  it('rename session via PATCH', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      payload: { label: 'My Important Task' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().label, 'My Important Task');

    // Verify rename persisted
    const getRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(getRes.json().label, 'My Important Task');
  });

  it('rename again preserves tmux_target', async () => {
    // First link a tmux target
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      payload: { tmux_target: 'cc-0' },
    });

    // Now rename without specifying tmux_target
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      payload: { label: 'Renamed Again' },
    });
    assert.equal(res.json().label, 'Renamed Again');
    assert.equal(res.json().tmux_target, 'cc-0'); // preserved
  });

  it('link tmux session via PATCH', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      payload: { tmux_target: 'cc-5' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tmux_target, 'cc-5');
  });

  it('list sessions includes all sessions with heartbeat data', async () => {
    // Send a heartbeat first
    await injectHook({
      event: 'Heartbeat',
      session_id: sessionId,
      tool_name: 'Read',
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    const sessions = res.json();
    const s = sessions.find(s => s.session_id === sessionId);
    assert.ok(s, 'Session should appear in list');
    assert.equal(s.last_tool, 'Read');
    assert.ok(s.last_heartbeat);
  });
});

// ──────────────────────────────────────────────
// Integration: Input validation and error handling
// ──────────────────────────────────────────────
describe('Integration: Input validation', () => {
  it('rejects completely empty POST /api/hooks body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects POST /api/hooks with null body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'Content-Type': 'application/json' },
      payload: 'null',
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects PATCH with invalid tmux_target characters', async () => {
    // Create a session first
    await injectHook({ event: 'SessionStart', session_id: 'val-test-1', cwd: '/tmp' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/val-test-1',
      payload: { tmux_target: 'cc-0; rm -rf /' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('Invalid tmux target'));
  });

  it('rejects PATCH with overly long label', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/val-test-1',
      payload: { label: 'x'.repeat(300) },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects launch with overly long prompt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/launch',
      payload: { label: 'test', cwd: '/tmp', initialPrompt: 'x'.repeat(20000) },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('Initial prompt too long'));
  });

  it('rejects launch with overly long cwd', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/launch',
      payload: { label: 'test', cwd: '/tmp/' + 'a'.repeat(2000) },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects input with missing text', async () => {
    await injectHook({ event: 'SessionStart', session_id: 'input-test-1', cwd: '/tmp' });
    await app.inject({
      method: 'PATCH',
      url: '/api/sessions/input-test-1',
      payload: { tmux_target: 'cc-0' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/input-test-1/input',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('Missing text'));
  });

  it('rejects input to session without tmux_target', async () => {
    await injectHook({ event: 'SessionStart', session_id: 'no-tmux-1', cwd: '/tmp' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/no-tmux-1/input',
      payload: { text: 'hello' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('No tmux target'));
  });

  it('returns 404 for operations on non-existent session', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist' });
    assert.equal(getRes.statusCode, 404);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/does-not-exist',
      payload: { label: 'x' },
    });
    assert.equal(patchRes.statusCode, 404);
  });
});

// ──────────────────────────────────────────────
// Integration: Multiple concurrent sessions
// ──────────────────────────────────────────────
describe('Integration: Multiple concurrent sessions', () => {
  const sessionIds = ['multi-1', 'multi-2', 'multi-3'];

  before(async () => {
    // Create 3 sessions in different cwds
    for (let i = 0; i < sessionIds.length; i++) {
      await injectHook({
        event: 'SessionStart',
        session_id: sessionIds[i],
        cwd: `/tmp/project-${i}`,
        model: 'claude-sonnet-4-6',
      });
    }
  });

  it('all sessions appear in list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    const sessions = res.json();
    for (const sid of sessionIds) {
      assert.ok(sessions.some(s => s.session_id === sid), `Session ${sid} should be in list`);
    }
  });

  it('heartbeats update correct session only', async () => {
    await injectHook({ event: 'Heartbeat', session_id: 'multi-1', tool_name: 'Bash' });
    await injectHook({ event: 'Heartbeat', session_id: 'multi-2', tool_name: 'Write' });
    // multi-3 gets no heartbeat

    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    const sessions = res.json();

    const s1 = sessions.find(s => s.session_id === 'multi-1');
    const s2 = sessions.find(s => s.session_id === 'multi-2');
    const s3 = sessions.find(s => s.session_id === 'multi-3');

    assert.equal(s1.last_tool, 'Bash');
    assert.equal(s2.last_tool, 'Write');
    assert.equal(s3.last_tool, null);
  });

  it('Stop event on one session does not affect others', async () => {
    await injectHook({ event: 'Stop', session_id: 'multi-2', cwd: '/tmp/project-1' });

    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    const sessions = res.json();

    assert.equal(sessions.find(s => s.session_id === 'multi-1').status, 'active');
    assert.equal(sessions.find(s => s.session_id === 'multi-2').status, 'active');
    assert.equal(sessions.find(s => s.session_id === 'multi-3').status, 'active');
  });

  it('events are scoped to correct session', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/sessions/multi-1/events' });
    const res2 = await app.inject({ method: 'GET', url: '/api/sessions/multi-2/events' });

    assert.ok(res1.json().every(e => e.session_id === 'multi-1'));
    assert.ok(res2.json().every(e => e.session_id === 'multi-2'));

    // multi-2 should have both SessionStart and Stop events
    const events2 = res2.json();
    assert.ok(events2.some(e => e.event === 'SessionStart'));
    assert.ok(events2.some(e => e.event === 'Stop'));
  });

  it('global events contain events from all sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    const events = res.json();

    assert.ok(events.some(e => e.session_id === 'multi-1'));
    assert.ok(events.some(e => e.session_id === 'multi-2'));
    assert.ok(events.some(e => e.session_id === 'multi-3'));
  });
});

// ──────────────────────────────────────────────
// Integration: Heartbeat-only session (missed SessionStart)
// ──────────────────────────────────────────────
describe('Integration: Heartbeat without SessionStart', () => {
  it('heartbeat creates session if it does not exist', async () => {
    const res = await injectHook({
      event: 'Heartbeat',
      session_id: 'orphan-heartbeat',
      tool_name: 'Bash',
    });
    assert.equal(res.statusCode, 204);

    // Session should exist now (created by heartbeat handler)
    const sessionRes = await app.inject({ method: 'GET', url: '/api/sessions/orphan-heartbeat' });
    assert.equal(sessionRes.statusCode, 200);
    assert.equal(sessionRes.json().status, 'active');
    assert.equal(sessionRes.json().last_tool, 'Bash');
  });
});

// ──────────────────────────────────────────────
// Integration: Event pagination
// ──────────────────────────────────────────────
describe('Integration: Event pagination', () => {
  const sessionId = 'pagination-test';

  before(async () => {
    await injectHook({ event: 'SessionStart', session_id: sessionId, cwd: '/tmp' });
    // Create 10 events
    for (let i = 0; i < 10; i++) {
      await injectHook({
        event: 'Notification',
        session_id: sessionId,
        source: `event-${i}`,
      });
    }
  });

  it('default limit returns all events', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const events = res.json();
    assert.equal(events.length, 11); // 1 SessionStart + 10 Notifications
  });

  it('limit=3 returns exactly 3 events', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events?limit=3` });
    assert.equal(res.json().length, 3);
  });

  it('offset=5 skips first 5 events', async () => {
    const allRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    const pageRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events?limit=3&offset=5` });

    const allEvents = allRes.json();
    const pageEvents = pageRes.json();

    assert.equal(pageEvents.length, 3);
    assert.equal(pageEvents[0].id, allEvents[5].id);
  });

  it('global events respect limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=2' });
    assert.ok(res.json().length <= 2);
  });
});

// ──────────────────────────────────────────────
// Integration: Session reactivation patterns
// ──────────────────────────────────────────────
describe('Integration: Session reactivation', () => {
  const sessionId = 'reactivate-test';

  it('session stays active through multiple Stop/SessionStart cycles', async () => {
    // First run
    await injectHook({ event: 'SessionStart', session_id: sessionId, cwd: '/tmp/proj' });
    let s = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    assert.equal(s.status, 'active');

    // Stop — session remains active (not moved to closed)
    await injectHook({ event: 'Stop', session_id: sessionId });
    s = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    assert.equal(s.status, 'active');

    // Restart
    await injectHook({ event: 'SessionStart', session_id: sessionId, cwd: '/tmp/proj' });
    s = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    assert.equal(s.status, 'active');

    // Stop again
    await injectHook({ event: 'Stop', session_id: sessionId });
    s = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    assert.equal(s.status, 'active');

    // All lifecycle events should be logged
    const events = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` })).json();
    const eventTypes = events.map(e => e.event);
    assert.deepEqual(eventTypes, ['Stop', 'SessionStart', 'Stop', 'SessionStart']);
  });
});

// ──────────────────────────────────────────────
// Integration: tmux session discovery
// ──────────────────────────────────────────────
describe('Integration: tmux discovery', () => {
  it('returns array even when tmux is not running', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmux-sessions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });
});

// ──────────────────────────────────────────────
// Integration: Rapid-fire events (stress test)
// ──────────────────────────────────────────────
describe('Integration: Rapid-fire events', () => {
  it('handles 50 rapid heartbeats without errors', async () => {
    const sid = 'rapid-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp' });

    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(injectHook({
        event: 'Heartbeat',
        session_id: sid,
        tool_name: `Tool-${i}`,
      }));
    }
    const results = await Promise.all(promises);

    // All should succeed
    assert.ok(results.every(r => r.statusCode === 204));

    // Session should exist and have a heartbeat
    const sessionRes = await app.inject({ method: 'GET', url: `/api/sessions/${sid}` });
    assert.equal(sessionRes.statusCode, 200);
    assert.ok(sessionRes.json().last_heartbeat);
  });

  it('handles 20 rapid events without data loss', async () => {
    const sid = 'rapid-events-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp' });

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(injectHook({
        event: 'Notification',
        session_id: sid,
        source: `rapid-${i}`,
      }));
    }
    const results = await Promise.all(promises);
    assert.ok(results.every(r => r.statusCode === 204));

    // All events should be recorded (SessionStart + 20 Notifications)
    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/events?limit=100` });
    const events = eventsRes.json();
    assert.equal(events.length, 21);
  });
});

// ──────────────────────────────────────────────
// Integration: PermissionRequest with tool_input serialization
// ──────────────────────────────────────────────
describe('Integration: tool_input serialization', () => {
  it('stores object tool_input as JSON string', async () => {
    const sid = 'tool-input-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp' });
    await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /important', cwd: '/home/user' },
    });

    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/events` });
    const events = eventsRes.json();
    const permEvent = events.find(e => e.event === 'PermissionRequest');
    assert.ok(permEvent);

    // tool_input should be stored as JSON string
    const parsed = JSON.parse(permEvent.tool_input);
    assert.equal(parsed.command, 'rm -rf /important');
    assert.equal(parsed.cwd, '/home/user');
  });

  it('stores string tool_input as-is', async () => {
    const sid = 'tool-input-str-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp' });
    await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Write',
      tool_input: '/home/user/file.txt',
    });

    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/events` });
    const events = eventsRes.json();
    const permEvent = events.find(e => e.event === 'PermissionRequest');
    assert.equal(permEvent.tool_input, '/home/user/file.txt');
  });
});

// ──────────────────────────────────────────────
// Integration: Global events include session metadata
// ──────────────────────────────────────────────
describe('Integration: Global events with metadata', () => {
  it('global events include session label and cwd', async () => {
    const sid = 'metadata-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/meta' });
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sid}`,
      payload: { label: 'Meta Session' },
    });
    await injectHook({ event: 'Notification', session_id: sid });

    const res = await app.inject({ method: 'GET', url: '/api/events?limit=50' });
    const events = res.json();
    const notifEvent = events.find(e => e.session_id === sid && e.event === 'Notification');

    // Global events join with sessions table
    assert.ok(notifEvent);
    assert.equal(notifEvent.label, 'Meta Session');
    assert.equal(notifEvent.session_cwd, '/tmp/meta');
  });
});

// ──────────────────────────────────────────────
// Integration: Query parameter validation
// ──────────────────────────────────────────────
describe('Integration: Query parameter validation', () => {
  it('NaN limit defaults to safe value', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=abc' });
    assert.equal(res.statusCode, 200);
    const events = res.json();
    assert.ok(events.length <= 100); // default limit
  });

  it('negative limit is clamped to 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=-5' });
    assert.equal(res.statusCode, 200);
    const events = res.json();
    assert.ok(events.length <= 1);
  });

  it('excessive limit is capped at 1000', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=999999' });
    assert.equal(res.statusCode, 200);
    // Just verifying it doesn't crash — the cap prevents unbounded queries
  });

  it('NaN offset defaults to 0', async () => {
    const sid = 'qp-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp' });
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/events?offset=xyz` });
    assert.equal(res.statusCode, 200);
  });

  it('negative offset is clamped to 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?limit=5&offset=-10' });
    assert.equal(res.statusCode, 200);
  });
});

// ──────────────────────────────────────────────
// Integration: Heartbeat does not override waiting_permission
// ──────────────────────────────────────────────
describe('Integration: Heartbeat status transitions', () => {
  it('heartbeat after PermissionRequest transitions to active (permission granted)', async () => {
    const sid = 'heartbeat-perm-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/hp' });

    // Permission request
    await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    let s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'waiting_permission');

    // Heartbeat arrives → means permission was granted and tool ran
    await injectHook({ event: 'Heartbeat', session_id: sid, tool_name: 'Bash' });
    s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'active');
    assert.equal(s.last_tool, 'Bash');
  });

  it('heartbeat does NOT revive killed sessions', async () => {
    const sid = 'heartbeat-stop-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/hs' });
    // Only the Kill API sets status='stopped' (Stop event no longer does)
    await app.inject({ method: 'POST', url: `/api/sessions/${sid}/kill` });

    let s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'stopped');

    // Stale heartbeat arrives after session was killed → should stay stopped
    await injectHook({ event: 'Heartbeat', session_id: sid, tool_name: 'Write' });
    s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'stopped');
    assert.equal(s.last_tool, 'Write'); // heartbeat data still updated
  });

  it('heartbeat creates session if it does not exist', async () => {
    const newSid = 'heartbeat-create-test';
    await injectHook({ event: 'Heartbeat', session_id: newSid, tool_name: 'Bash' });

    const s = (await app.inject({ method: 'GET', url: `/api/sessions/${newSid}` })).json();
    assert.equal(s.status, 'active');
    assert.equal(s.last_tool, 'Bash');
  });
});

// ──────────────────────────────────────────────
// Integration: Grant permission (long-poll flow)
// ──────────────────────────────────────────────
describe('Integration: Grant permission', () => {
  it('grant-permission returns 404 for unknown session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/no-such-id/grant-permission', payload: {} });
    assert.equal(res.statusCode, 404);
  });

  it('grant-permission returns 204 when no hook is waiting', async () => {
    await injectHook({ event: 'SessionStart', session_id: 'grant-nowait', cwd: '/tmp' });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/grant-nowait/grant-permission', payload: {} });
    assert.equal(res.statusCode, 204);
  });

  it('permission-decision resolves immediately when grant arrives concurrently', async () => {
    await injectHook({ event: 'SessionStart', session_id: 'grant-concurrent', cwd: '/tmp' });

    // Start the long-poll with timeout=0 (returns instantly), then immediately grant.
    // We test the grant-then-poll order: grant fires, then poll sees no waiter → pending.
    // For the reverse (poll waits, grant resolves it), use a small non-zero timeout.
    const pollPromise = app.inject({
      method: 'GET',
      url: '/api/sessions/grant-concurrent/permission-decision?timeout=500',
    });
    // Yield to the event loop so the long-poll handler registers before we grant
    await new Promise(r => setImmediate(r));

    const grantRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/grant-concurrent/grant-permission',
      payload: {},
    });
    assert.equal(grantRes.statusCode, 204);

    const pollRes = await pollPromise;
    assert.equal(pollRes.statusCode, 200);
    assert.equal(pollRes.json().status, 'granted');
  });
});

// ──────────────────────────────────────────────
// Integration: Per-session auto-approve toggle
// ──────────────────────────────────────────────
describe('Integration: Per-session auto-approve toggle', () => {
  it('auto_approve enabled (default): Read tool is auto-approved', async () => {
    const sid = 'autoapprove-on-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-on' });

    const res = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Read',
      tool_input: { path: '/tmp/file.txt' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().auto_approve, true);

    // Status should stay active (not waiting_permission)
    const s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'active');
  });

  it('auto_approve disabled: Read tool is NOT auto-approved', async () => {
    const sid = 'autoapprove-off-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-off' });

    // Disable auto-approve for this session
    const { updateSession } = await import('../db.js');
    updateSession(sid, { auto_approve: 0 });

    const res = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Read',
      tool_input: { path: '/tmp/file.txt' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().auto_approve, false);

    // Status should be waiting_permission
    const s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'waiting_permission');
  });

  it('auto_approve disabled: Glob tool is NOT auto-approved', async () => {
    const sid = 'autoapprove-glob-off';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-glob' });

    const { updateSession } = await import('../db.js');
    updateSession(sid, { auto_approve: 0 });

    const res = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.js' },
    });
    assert.equal(res.json().auto_approve, false);

    const s = (await app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json();
    assert.equal(s.status, 'waiting_permission');
  });

  it('auto_approve no-edits (mode 2): Read and Bash are approved, Write is NOT', async () => {
    const sid = 'autoapprove-noedits-test';
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-ne' });

    const { updateSession } = await import('../db.js');
    updateSession(sid, { auto_approve: 2 });

    // Read → approved
    const readRes = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Read',
      tool_input: { path: '/tmp/x' },
    });
    assert.equal(readRes.json().auto_approve, true);

    // Reset for Bash test
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-ne' });
    updateSession(sid, { auto_approve: 2 });

    // Bash (safe read-only command) → approved in no-edits mode
    const bashRes = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
    });
    assert.equal(bashRes.json().auto_approve, true);

    // Reset for Write test
    await injectHook({ event: 'SessionStart', session_id: sid, cwd: '/tmp/ap-ne' });
    updateSession(sid, { auto_approve: 2 });

    // Write → NOT approved in no-edits mode
    const writeRes = await injectHook({
      event: 'PermissionRequest',
      session_id: sid,
      tool_name: 'Write',
      tool_input: { path: '/tmp/x', content: 'hi' },
    });
    assert.equal(writeRes.json().auto_approve, false);
  });

  it('launch endpoint rejects invalid autoApprove value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/launch',
      payload: { label: 'test', autoApprove: 'yes' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /autoApprove must be/);
  });
});
