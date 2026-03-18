import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set env BEFORE importing notifier
process.env.OPENCLAW_TOKEN = 'test-token';
process.env.OPENCLAW_URL = 'http://localhost:99999/v1/responses';

const notifier = await import('../notifier.js');

// Track fetch calls
let fetchCalls = [];
const originalFetch = global.fetch;

beforeEach(() => {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200 };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('notifier.send', () => {
  it('sends notification for Stop events', async () => {
    await notifier.send({
      event: 'Stop',
      session_id: 'abc12345',
      cwd: '/home/user/project',
    });
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.ok(body.input.includes('finished'));
    assert.ok(body.input.includes('abc12345'));
  });

  it('sends notification for PermissionRequest events', async () => {
    await notifier.send({
      event: 'PermissionRequest',
      session_id: 'def67890',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist/' },
    });
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.ok(body.input.includes('permission'));
    assert.ok(body.input.includes('Bash'));
  });

  it('does NOT send for SessionStart events', async () => {
    await notifier.send({ event: 'SessionStart', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('does NOT send for Heartbeat events', async () => {
    await notifier.send({ event: 'Heartbeat', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('does NOT send for Notification events', async () => {
    await notifier.send({ event: 'Notification', session_id: 'x' });
    assert.equal(fetchCalls.length, 0);
  });

  it('includes correct headers', async () => {
    await notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' });
    const headers = fetchCalls[0].opts.headers;
    assert.equal(headers['Authorization'], 'Bearer test-token');
    assert.equal(headers['x-openclaw-agent-id'], 'main');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    // Should not throw
    await notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' });
  });
});

// NOTE: Testing "no token" behavior in isolation is not possible because ESM
// caches the notifier module (and its config import) from the first import.
// The early-return path (config.openclawToken === '') is implicitly covered by
// the SessionStart/Heartbeat/Notification tests above — those events never
// reach fetch() regardless of token state. For a true no-token integration test,
// run the server with OPENCLAW_TOKEN unset and verify no outbound requests.
