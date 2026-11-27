// Tier 1: the per-child lock and the socket-isolation guard, in a scratch root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHILD_LOCK_MAX_AGE_MS, ChildBusyError, childLockPath, withChildLock } from '../../src/core/child-lock.ts';
import { assertIsolated, isolate, LIVE_HERDR_SOCKET } from '../fixtures/isolated.ts';
import { LIVE_SOCKET } from '../fixtures/isolation.ts';

test('a second holder of a child lock is refused while the first works, and the lock is gone after', async (t) => {
  isolate(t);
  let release: () => void = () => {};
  const first = withChildLock('child-a', 'worker (child child-a)', 'resume of worker', () => new Promise<string>((resolve) => (release = () => resolve('done'))));
  await assert.rejects(
    withChildLock('child-a', 'worker (child child-a)', 'resume of worker', async () => 'never'),
    (error: unknown) => error instanceof ChildBusyError && /worker \(child child-a\) is already being brought back by another call \(process \d+, resume of worker/.test(error.message),
  );
  release();
  assert.equal(await first, 'done');
  assert.equal(fs.existsSync(childLockPath('child-a')), false);
  assert.equal(await withChildLock('child-a', 'worker', 'again', async () => 'taken'), 'taken');
});

test('a lock left by a dead process, or older than any resume, is taken over', async (t) => {
  isolate(t);
  const file = childLockPath('child-b');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999, at: Date.now(), purpose: 'crashed' }));
  assert.equal(await withChildLock('child-b', 'worker', 'resume', async () => 'ok', Date.now, () => false), 'ok');

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() - CHILD_LOCK_MAX_AGE_MS - 1, purpose: 'hung' }));
  assert.equal(await withChildLock('child-b', 'worker', 'resume', async () => 'ok'), 'ok');
});

test('a failed resume still releases its lock', async (t) => {
  isolate(t);
  await assert.rejects(
    withChildLock('child-c', 'worker', 'resume', async () => {
      throw new Error('herdr said no');
    }),
    /herdr said no/,
  );
  assert.equal(fs.existsSync(childLockPath('child-c')), false);
});

test('a test whose herdr socket resolves to the live one fails', (t) => {
  const { root } = isolate(t);
  assertIsolated(root);
  process.env['HERDR_SOCKET_PATH'] = LIVE_HERDR_SOCKET;
  assert.throws(() => assertIsolated(root), /resolves to the live socket/);
  delete process.env['HERDR_SOCKET_PATH'];
  process.env['BELLWETHER_DAEMON_SOCKET'] = LIVE_SOCKET;
  assert.throws(() => assertIsolated(root), /resolves to the live socket/);
});
