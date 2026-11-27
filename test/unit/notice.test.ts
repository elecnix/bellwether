// The order and the late note that both adapters put in front of the parent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LATE_AFTER_MS, byEventTime, lateNote } from '../../src/core/notice.ts';

test('entries come out oldest first, and equal times keep their order', () => {
  const entries = [
    { receipt: 'b', at: '2026-11-27T07:26:55.682Z' },
    { receipt: 'a', at: '2026-11-27T07:25:46.000Z' },
    { receipt: 'c1', at: '2026-11-27T07:29:40.000Z' },
    { receipt: 'c2', at: '2026-11-27T07:29:40.000Z' },
  ];
  assert.deepEqual(byEventTime(entries).map((entry) => entry.receipt), ['a', 'b', 'c1', 'c2']);
});

test('an event delivered within the threshold carries no note', () => {
  const at = '2026-11-27T07:25:46.000Z';
  assert.equal(lateNote({ at }, Date.parse(at) + LATE_AFTER_MS - 1), '');
});

test('a late event says how late, and when it happened', () => {
  const at = '2026-11-27T07:25:46.000Z';
  assert.equal(lateNote({ at }, Date.parse(at) + 274_000), ' (late by 4m34s: it happened at 07:25:46 UTC)');
  assert.equal(lateNote({ at }, Date.parse(at) + 2 * 3_600_000 + 5 * 60_000), ' (late by 2h05m: it happened at 07:25:46 UTC)');
});
