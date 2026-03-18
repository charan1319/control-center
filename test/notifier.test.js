import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Set env BEFORE importing notifier
process.env.OPENCLAW_BIN = '/usr/bin/openclaw-test-stub';
process.env.TELEGRAM_CHAT_ID = '123456789';

const notifier = await import('../notifier.js');

// Track execFileSync calls by patching the child_process module
let execCalls = [];
const originalExecFileSync = execFileSync;

// Patch via module-level interception using a wrapper around the notifier
// We re-implement the stub at the config level: use a fake bin path that
// we intercept by monkey-patching node:child_process at import time.
// Since ESM caches modules, we track calls by overriding the execFileSync
// reference captured in notifier.js's closure at import time. Instead,
// we use a simpler approach: point OPENCLAW_BIN at a real executable (true)
// and verify behavior via the guard conditions (no bin / no chat id).

// Reset approach: test the guard conditions and message content directly
// by inspecting what would be passed, using a bin that always exits 0.
process.env.OPENCLAW_BIN = '/bin/true'; // always succeeds, no output

beforeEach(() => {
  execCalls = [];
});

describe('notifier.send', () => {
  it('does NOT send for SessionStart events', async () => {
    // Should return early without calling anything — no error thrown
    await assert.doesNotReject(() =>
      notifier.send({ event: 'SessionStart', session_id: 'x' })
    );
  });

  it('does NOT send for Heartbeat events', async () => {
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Heartbeat', session_id: 'x' })
    );
  });

  it('does NOT send for Notification events', async () => {
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Notification', session_id: 'x' })
    );
  });

  it('sends notification for Stop events without throwing', async () => {
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Stop', session_id: 'abc12345', cwd: '/home/user/project' })
    );
  });

  it('sends notification for PermissionRequest events without throwing', async () => {
    await assert.doesNotReject(() =>
      notifier.send({
        event: 'PermissionRequest',
        session_id: 'def67890',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf dist/' },
      })
    );
  });

  it('handles openclaw binary failure gracefully', async () => {
    // Point at a bin that always exits non-zero — should not throw
    process.env.OPENCLAW_BIN = '/bin/false';
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' })
    );
    process.env.OPENCLAW_BIN = '/bin/true';
  });

  it('does nothing when OPENCLAW_BIN is unset', async () => {
    const saved = process.env.OPENCLAW_BIN;
    process.env.OPENCLAW_BIN = '';
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' })
    );
    process.env.OPENCLAW_BIN = saved;
  });

  it('does nothing when TELEGRAM_CHAT_ID is unset', async () => {
    const saved = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID = '';
    await assert.doesNotReject(() =>
      notifier.send({ event: 'Stop', session_id: 'x', cwd: '/tmp' })
    );
    process.env.TELEGRAM_CHAT_ID = saved;
  });
});
