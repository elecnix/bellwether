// A lock is a file two releases may disagree about: a client of one release
// reads the lock a daemon of another wrote. Each side reads the fields it
// knows and passes over the rest, so neither refuses the other's lock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from '../../src/core/version.ts';
import { acquire, lockPath, readLock } from '../../src/daemon/lock.ts';

/**
 * readLock as the 0.1.4 release ships it, the one release on npm before the
 * lock named an entry point or a build. It stands for every older client.
 */
function readLockOf014(home: string): { pid: number; startedAt: number; protocol: number; version?: string; socket: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Partial<{ pid: number; startedAt: number; protocol: number; version: string; socket: string }>;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return undefined;
    const read: { pid: number; startedAt: number; protocol: number; version?: string; socket: string } = { pid: record.pid, startedAt: record.startedAt ?? 0, protocol: record.protocol ?? 0, socket: record.socket ?? '' };
    if (typeof record.version === 'string') read.version = record.version;
    return read;
  } catch {
    return undefined;
  }
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a lock this release writes for a hand-started daemon names its entry point, version and build', (t) => {
  const home = scratch(t);
  const socket = path.join(home, 'daemon.sock');
  const entry = path.join(home, 'main.ts');
  fs.writeFileSync(entry, '');
  assert.equal(acquire(home, socket, 1001, () => true, { entry, foreground: true }).kind, 'acquired');
  const lock = readLock(home);
  assert.equal(lock?.version, BELLWETHER_VERSION);
  assert.equal(lock?.build, BELLWETHER_BUILD_ID);
  assert.equal(lock?.entry, fs.realpathSync(entry));
  assert.equal(lock?.foreground, true);
  // A detached daemon leaves the foreground field out of its lock.
  fs.rmSync(lockPath(home));
  assert.equal(acquire(home, socket, 1002, () => true, { entry }).kind, 'acquired');
  assert.equal('foreground' in JSON.parse(fs.readFileSync(lockPath(home), 'utf8')), false);
});

test('an older client reads a newer lock without refusing it, and keeps the fields it knows', (t) => {
  const home = scratch(t);
  const socket = path.join(home, 'daemon.sock');
  assert.equal(acquire(home, socket, 1001, () => true, { entry: path.join(home, 'main.ts'), foreground: true }).kind, 'acquired');
  assert.deepEqual(readLockOf014(home), { pid: 1001, startedAt: readLock(home)?.startedAt, protocol: readLock(home)?.protocol, version: BELLWETHER_VERSION, socket });
});

test('this release reads a lock with a field from a later release, and a lock from an older one without the new fields', (t) => {
  const home = scratch(t);
  const socket = path.join(home, 'daemon.sock');
  fs.writeFileSync(lockPath(home), `${JSON.stringify({ pid: 1001, startedAt: 5, protocol: 9, version: '9.0.0', socket, build: 'abcdefabcdef', entry: '/x/main.js', origin: 'package', foreground: true, later: { field: 1 } })}\n`);
  assert.deepEqual(readLock(home), { pid: 1001, startedAt: 5, protocol: 9, version: '9.0.0', socket, build: 'abcdefabcdef', entry: '/x/main.js', origin: 'package', foreground: true });
  // A lock from `bellwether daemon` before this release: a version, and no entry point, build or foreground flag.
  fs.writeFileSync(lockPath(home), `${JSON.stringify({ pid: 1002, startedAt: 6, protocol: 4, version: '0.1.4', socket })}\n`);
  assert.deepEqual(readLock(home), { pid: 1002, startedAt: 6, protocol: 4, version: '0.1.4', socket });
});
