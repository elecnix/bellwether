// The outbox keeps one pending entry per child, merges a newer state into an
// older unread one, and settles an entry only when its receipt is read. Every
// case runs against a scratch home so nothing touches the operator's registry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Outbox, newChildId, newReceipt } from '../../src/core/outbox.ts';
import type { OutboxEntry } from '../../src/core/types.ts';

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
  outbox.offer(offer('c1', 'idle'));
  outbox.offer(offer('c1', 'blocked'));
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0]?.event, 'blocked');
  assert.equal(outbox.all().length, 1);
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
