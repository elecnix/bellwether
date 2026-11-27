// The outbox keeps one pending entry per child, merges a newer state into an
// older unread one, and settles an entry only when its receipt is read. Every
// case runs against a scratch home so nothing touches the operator's registry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Outbox, isSuperseded, newChildId, newReceipt } from '../../src/core/outbox.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-outbox-'));
  process.env['BELLWETHER_HOME'] = root;
  return root;
}

function offer(childId: string, event: OutboxEntry['event'], text = 'text'): Omit<OutboxEntry, 'receipt' | 'read'> {
  return { childId, name: childId, kind: 'pi', paneId: 'w1:p1', event, text, at: new Date(0).toISOString() };
}

test('a newer event replaces the older unread entry for the same child', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-one');
  const first = outbox.offer(offer('c1', 'idle'));
  const second = outbox.offer(offer('c1', 'blocked'));
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0]?.event, 'blocked');
  // The older entry keeps its receipt and is settled, so a client holding it
  // can be told to drop it.
  const settled = outbox.takeSettled();
  assert.deepEqual(settled.map((entry) => entry.receipt), [first.receipt]);
  assert.equal(settled[0]?.read, true);
  assert.equal(settled[0]?.supersededBy, second.receipt);
  assert.deepEqual(outbox.takeSettled(), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('two children hold two separate entries', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-two');
  outbox.offer(offer('c1', 'idle'));
  outbox.offer(offer('c2', 'idle'));
  assert.equal(outbox.pending().length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a read entry does not merge with a later one', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-three');
  const first = outbox.offer(offer('c1', 'idle'));
  outbox.markRead(first.receipt);
  outbox.offer(offer('c1', 'blocked'));
  assert.equal(outbox.pending().length, 1);
  assert.notEqual(outbox.pending()[0]?.receipt, first.receipt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a receipt marks its entry read once', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-four');
  const offered = outbox.offer(offer('c1', 'idle'));
  assert.equal(outbox.markRead(offered.receipt), true);
  assert.equal(outbox.markRead(offered.receipt), false);
  assert.equal(outbox.pending().length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unread entry survives a reload', () => {
  const root = scratch();
  const first = Outbox.load('parent-five');
  const offered = first.offer(offer('c1', 'report', 'the report'));
  first.save('parent-five');

  const second = Outbox.load('parent-five');
  assert.equal(second.pending().length, 1);
  assert.equal(second.pending()[0]?.receipt, offered.receipt);
  assert.equal(second.pending()[0]?.text, 'the report');
  fs.rmSync(root, { recursive: true, force: true });
});

test('adding the same receipt twice keeps one entry', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-six');
  const full: OutboxEntry = { ...offer(newChildId(), 'idle'), receipt: newReceipt(), read: false };
  outbox.add(full);
  outbox.add(full);
  assert.equal(outbox.all().length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('delivering an entry records a time without marking it read', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-seven');
  const offered = outbox.offer(offer('c1', 'idle'));
  outbox.markDelivered(offered.receipt, '2026-01-01T00:00:00.000Z');
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.all()[0]?.deliveredAt, '2026-01-01T00:00:00.000Z');
  fs.rmSync(root, { recursive: true, force: true });
});

test('dropping a child removes its entries and keeps the others', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-drop');
  outbox.offer(offer('ghost', 'blocked'));
  outbox.offer(offer('c2', 'idle'));
  assert.equal(outbox.drop('ghost'), true);
  assert.deepEqual(outbox.pending().map((entry) => entry.childId), ['c2']);
  assert.equal(outbox.drop('ghost'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

function child(overrides: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date(0).toISOString();
  return { id: 'c1', name: 'c1', kind: 'claude', harness: 'claude-code', paneId: 'w1:p1', startedAt: at, lastStatus: 'blocked', statusChangedAt: at, lastBusyAt: at, depth: 1, ...overrides };
}

function queuedBlocked(stateChangeSeq?: number): Omit<OutboxEntry, 'receipt' | 'read'> {
  return { ...offer('c1', 'blocked', 'The dialog: trust this folder?'), at: new Date(1_000).toISOString(), status: 'blocked', stateChangeSeq };
}

test('a queued blocked entry whose child has moved on is settled, not delivered', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-eight');
  const queued = outbox.offer(queuedBlocked(7));
  outbox.takeSettled();
  // Someone answered the dialog: herdr now reports the child working, at a
  // newer state_change_seq.
  const moved = child({ lastStatus: 'working', statusChangedAt: new Date(2_000).toISOString(), stateChangeSeq: 8 });
  const settled = outbox.settleSuperseded([moved]);
  assert.deepEqual(settled.map((entry) => entry.receipt), [queued.receipt]);
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.takeSettled()[0]?.read, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a queued blocked entry stays while its child is still blocked', () => {
  const root = scratch();
  const outbox = Outbox.load('parent-nine');
  outbox.offer(queuedBlocked(7));
  assert.deepEqual(outbox.settleSuperseded([child({ stateChangeSeq: 7 })]), []);
  assert.equal(outbox.pending().length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a state_change_seq that has not advanced does not supersede, even with another status', () => {
  const entry: OutboxEntry = { ...queuedBlocked(9), receipt: 'bw-1', read: false };
  assert.equal(isSuperseded(entry, child({ lastStatus: 'working', stateChangeSeq: 9 })), false);
  assert.equal(isSuperseded(entry, child({ lastStatus: 'working', stateChangeSeq: 10 })), true);
  // Without a seq on either side, the status alone decides.
  assert.equal(isSuperseded({ ...entry, stateChangeSeq: undefined }, child({ lastStatus: 'idle' })), true);
});

test('a stuck entry is superseded once the child moves, and a report or idle entry never is', () => {
  const stuck: OutboxEntry = { ...offer('c1', 'stuck'), at: new Date(1_000).toISOString(), receipt: 'bw-2', read: false };
  assert.equal(isSuperseded(stuck, child({ lastStatus: 'working', lastBusyAt: new Date(500).toISOString() })), false);
  assert.equal(isSuperseded(stuck, child({ lastStatus: 'working', lastBusyAt: new Date(2_000).toISOString() })), true);
  const idle: OutboxEntry = { ...offer('c1', 'idle'), receipt: 'bw-3', read: false };
  const report: OutboxEntry = { ...offer('c1', 'report'), receipt: 'bw-4', read: false };
  assert.equal(isSuperseded(idle, child({ lastStatus: 'working' })), false);
  assert.equal(isSuperseded(report, child({ lastStatus: 'working' })), false);
});
