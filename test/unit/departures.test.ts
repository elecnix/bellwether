// Issue #241: a child that moves more than once keeps every place it left.
// Before, the record kept one `movedFrom`, and each move overwrote it, so a
// child that went A to B to C left a worktree on A that no record named.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { departuresOf, dropDeparture, recordDeparture } from '../../src/core/departures.ts';
import { registryPath } from '../../src/core/paths.ts';
import { readParent } from '../../src/core/registry.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { isolate } from '../fixtures/isolated.ts';

function child(extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = '2026-11-28T05:00:00.000Z';
  return { id: 'c-1', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p1', host: 'local', cwd: '/a/feat', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra };
}

/** What a move does to the record: point it at the new place, then note the place it left. */
function move(record: ChildRecord, to: { host: string; cwd: string }, at: string, verb: 'move' | 'teleport' = 'move'): void {
  const from = { host: record.host ?? 'local', cwd: record.cwd };
  record.host = to.host;
  record.cwd = to.cwd;
  recordDeparture(record, { host: from.host, at, ...(from.cwd ? { cwd: from.cwd } : {}), verb, reason: `to ${to.host}` });
}

test('a record from an older daemon, with one movedFrom object and no list, reads as one departure', () => {
  const old = child({ host: 'b', cwd: '/b/feat', movedFrom: { host: 'local', at: '2026-11-27T00:00:00.000Z', cwd: '/a/feat' } });
  assert.deepEqual(departuresOf(old), [{ host: 'local', at: '2026-11-27T00:00:00.000Z', cwd: '/a/feat' }]);
  assert.deepEqual(departuresOf(child()), [], 'a child that never moved left nothing');
});

test('a child that goes A to B to C keeps both places it left, oldest first, and movedFrom names the last for an older daemon', () => {
  const record = child();
  move(record, { host: 'b', cwd: '/b/feat' }, '2026-11-28T05:01:00.000Z');
  move(record, { host: 'c', cwd: '/c/feat' }, '2026-11-28T05:02:00.000Z', 'teleport');
  assert.deepEqual(departuresOf(record).map((entry) => [entry.host, entry.cwd, entry.verb]), [
    ['local', '/a/feat', 'move'],
    ['b', '/b/feat', 'teleport'],
  ]);
  assert.equal(record.movedFrom?.host, 'b', 'an older daemon reads the last move where it always did');
  assert.equal(record.movedFrom?.cwd, '/b/feat');
});

test('the list starts from an older daemon\'s single movedFrom, so a move after an upgrade keeps the first place too', () => {
  const record = child({ host: 'b', cwd: '/b/feat', movedFrom: { host: 'local', at: '2026-11-27T00:00:00.000Z', cwd: '/a/feat' } });
  move(record, { host: 'c', cwd: '/c/feat' }, '2026-11-28T05:02:00.000Z');
  assert.deepEqual(departuresOf(record).map((entry) => entry.host), ['local', 'b']);
});

test('a move an older daemon made after a newer one wrote the list still counts', () => {
  const record = child({ host: 'c', cwd: '/c/feat' });
  move(record, { host: 'b', cwd: '/b/feat' }, '2026-11-28T05:01:00.000Z');
  // An older daemon took the record over and moved the child on, writing only movedFrom.
  record.movedFrom = { host: 'b', at: '2026-11-28T05:02:00.000Z', cwd: '/b/feat' };
  assert.deepEqual(departuresOf(record).map((entry) => entry.host), ['c', 'b']);
});

test('the list stays bounded: a child that goes back and forth keeps one entry per place, and coming back to a place drops it', () => {
  const record = child();
  for (let round = 0; round < 5; round += 1) {
    move(record, { host: 'b', cwd: '/b/feat' }, `2026-11-28T05:0${round}:00.000Z`);
    move(record, { host: 'local', cwd: '/a/feat' }, `2026-11-28T05:0${round}:30.000Z`);
  }
  assert.deepEqual(departuresOf(record).map((entry) => entry.host), ['b'], 'the child runs at /a/feat again, so that place is not left');
  move(record, { host: 'c', cwd: '/c/feat' }, '2026-11-28T06:00:00.000Z');
  assert.deepEqual(departuresOf(record).map((entry) => entry.host), ['b', 'local']);
});

test('a retired worktree drops its entry, and movedFrom with it when it named that place', () => {
  const record = child();
  move(record, { host: 'b', cwd: '/b/feat' }, '2026-11-28T05:01:00.000Z');
  move(record, { host: 'c', cwd: '/c/feat' }, '2026-11-28T05:02:00.000Z');
  dropDeparture(record, 'local', '/a/feat');
  assert.deepEqual(departuresOf(record).map((entry) => entry.host), ['b']);
  assert.equal(record.movedFrom?.host, 'b');
  dropDeparture(record, 'b', '/b');
  assert.deepEqual(departuresOf(record), [], 'an entry whose directory sits inside the removed worktree goes too');
  assert.equal(record.movedFrom, undefined, 'an older daemon must not drain or retire a place the list dropped');
});

test('a registry file an older daemon wrote, with only movedFrom, reads without error', (t) => {
  isolate(t, 'bellwether-departures-');
  const file = registryPath('claude-code-old');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { schema: 2, id: 'claude-code-old', harness: 'claude-code', session: 'old', host: 'local', cwd: '/work', depth: 0, updatedAt: '2026-11-27T00:00:00.000Z', children: [child({ host: 'b', cwd: '/b/feat', movedFrom: { host: 'local', at: '2026-11-27T00:00:00.000Z', cwd: '/a/feat' } })] };
  fs.writeFileSync(file, JSON.stringify(old));
  const read = readParent('claude-code-old');
  assert.ok(read, 'the file reads');
  const [only] = read.children;
  assert.ok(only);
  assert.deepEqual(departuresOf(only).map((entry) => [entry.host, entry.cwd]), [['local', '/a/feat']]);
});
