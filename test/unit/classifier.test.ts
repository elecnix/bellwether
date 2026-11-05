// The classifier turns herdr states into child events, each with a settle time.
// It is a pure function of state, clock and observation, so every case here is
// driven by a hand-picked clock and nothing waits on a timer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, advance, initialState, isReady, markReported } from '../../src/core/classifier.ts';

const limits = { ...DEFAULT_LIMITS };

test('an idle child that goes busy inside the settle sends no event', () => {
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1 }, 0, limits);
  assert.equal(ready.event, undefined);
  assert.equal(advance(ready.state, { status: 'idle', completionSeq: 1 }, limits.idleMs - 1, limits).event, undefined);

  const busy = advance(ready.state, { status: 'working', busy: true }, limits.idleMs - 1, limits);
  assert.equal(busy.event, undefined);

  const nextTurn = advance(busy.state, { status: 'idle', completionSeq: 2 }, limits.idleMs, limits);
  assert.equal(nextTurn.event, undefined);
});

test('an idle child that stays idle past the settle fires once', () => {
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1 }, 0, limits).state;

  const fired = advance(ready, { status: 'idle', completionSeq: 1 }, limits.idleMs, limits);
  assert.equal(fired.event, 'idle');

  // The same finished turn does not fire a second time.
  assert.equal(advance(fired.state, { status: 'idle', completionSeq: 1 }, limits.idleMs * 3, limits).event, undefined);
});

test('a blocked child reports its dialog once, after its own settle', () => {
  const blocked = advance(initialState('working', 0), { status: 'blocked' }, 0, limits).state;
  assert.equal(advance(blocked, { status: 'blocked' }, limits.blockedMs - 1, limits).event, undefined);

  const fired = advance(blocked, { status: 'blocked' }, limits.blockedMs, limits);
  assert.equal(fired.event, 'blocked');

  // It stays blocked until someone answers, and the dialog is reported once.
  assert.equal(advance(fired.state, { status: 'blocked' }, limits.blockedMs * 4, limits).event, undefined);
});

test('a quiet working child fires stuck once per quiet period', () => {
  const fired = advance(initialState('working', 0), { status: 'working' }, limits.stuckMs, limits);
  assert.equal(fired.event, 'stuck');
  assert.equal(advance(fired.state, { status: 'working' }, limits.stuckMs * 2, limits).event, undefined);

  // Movement restarts the clock, so a later quiet stretch fires again.
  const moved = advance(fired.state, { status: 'working', busy: true }, limits.stuckMs * 2, limits);
  assert.equal(moved.event, undefined);
  assert.equal(advance(moved.state, { status: 'working' }, limits.stuckMs * 3, limits).event, 'stuck');
});

test('a new completionSeq opens a fresh turn', () => {
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1 }, 0, limits).state;
  const first = advance(ready, { status: 'idle', completionSeq: 1 }, limits.idleMs, limits);
  assert.equal(first.event, 'idle');

  const second = advance(first.state, { status: 'idle', completionSeq: 2 }, limits.idleMs + 1, limits);
  assert.equal(second.event, undefined);
  assert.equal(advance(second.state, { status: 'idle', completionSeq: 2 }, limits.idleMs * 2 + 1, limits).event, 'idle');
});

test('a report for the turn suppresses that turn idle event', () => {
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1 }, 0, limits).state;
  const reported = markReported(ready, 10);
  assert.equal(advance(reported, { status: 'idle', completionSeq: 1 }, limits.idleMs * 2, limits).event, undefined);
});

test('a status change into idle without a completionSeq still fires', () => {
  const ready = advance(initialState('working', 0), { status: 'idle' }, 0, limits).state;
  assert.equal(advance(ready, { status: 'idle' }, limits.idleMs, limits).event, 'idle');
});

test('isReady treats idle and done the same way', () => {
  assert.equal(isReady('idle'), true);
  assert.equal(isReady('done'), true);
  assert.equal(isReady('working'), false);
  assert.equal(isReady('blocked'), false);
});
