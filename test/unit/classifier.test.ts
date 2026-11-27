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
  // The inactive notice is a separate event and may fire in this quiet stretch;
  // this test is about stuck, which must not fire a second time.
  assert.notEqual(advance(fired.state, { status: 'working' }, limits.stuckMs * 2, limits).event, 'stuck');

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

test('a child idle on an open prompt reports blocked, not idle', () => {
  // pi's extension dialog leaves herdr reporting idle for the whole wait.
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1, prompt: 'Share usage totals?' }, 0, limits).state;
  assert.equal(advance(ready, { status: 'idle', completionSeq: 1, prompt: 'Share usage totals?' }, limits.blockedMs - 1, limits).event, undefined);
  const fired = advance(ready, { status: 'idle', completionSeq: 1, prompt: 'Share usage totals?' }, limits.blockedMs, limits);
  assert.equal(fired.event, 'blocked');
  // Past every settle time, the open prompt still owes no idle event.
  assert.equal(advance(fired.state, { status: 'idle', completionSeq: 1, prompt: 'Share usage totals?' }, limits.idleMs * 10, limits).event, undefined);
});

test('a child at its prompt after a finished turn reads idle', () => {
  const ready = advance(initialState('working', 0), { status: 'idle', completionSeq: 1 }, 0, limits).state;
  assert.equal(advance(ready, { status: 'idle', completionSeq: 1 }, limits.idleMs, limits).event, 'idle');
});

test('a child that answers its prompt and works on fires one idle, at the end of the turn', () => {
  const prompt = 'Do you want to proceed?';
  let state = advance(initialState('working', 0), { status: 'working', prompt }, 0, limits).state;
  const blocked = advance(state, { status: 'working', prompt }, limits.blockedMs, limits);
  assert.equal(blocked.event, 'blocked');
  state = blocked.state;

  // The operator answers. The prompt closes, and the child goes on working.
  const events: string[] = [];
  let now = limits.blockedMs + 1;
  for (const observation of [{ status: 'working' as const }, { status: 'working' as const, busy: true }, { status: 'idle' as const, completionSeq: 1 }]) {
    const step = advance(state, observation, now, limits);
    if (step.event) events.push(step.event);
    state = step.state;
    now += 1_000;
  }
  for (let at = now; at < now + limits.idleMs * 3; at += 1_000) {
    const step = advance(state, { status: 'idle', completionSeq: 1 }, at, limits);
    if (step.event) events.push(step.event);
    state = step.state;
  }
  assert.deepEqual(events, ['idle']);
});

test('a prompt that closes on an idle child restarts the idle settle, so answering it is not a finished turn', () => {
  const prompt = 'Share usage totals?';
  // A child first seen idle on a dialog, as a pi child is at its first-run question.
  let state = advance(initialState('unknown', 0), { status: 'idle', prompt }, 0, limits).state;
  const blocked = advance(state, { status: 'idle', prompt }, limits.idleMs * 2, limits);
  assert.equal(blocked.event, 'blocked');
  state = blocked.state;

  // Answered at t; the child starts its task within the settle time.
  const t = limits.idleMs * 3;
  const closed = advance(state, { status: 'idle' }, t, limits);
  assert.equal(closed.event, undefined);
  assert.equal(advance(closed.state, { status: 'idle' }, t + limits.idleMs - 1, limits).event, undefined);
  const working = advance(closed.state, { status: 'working', busy: true }, t + limits.idleMs - 1, limits);
  assert.equal(working.event, undefined);
  // The task ends, and its end is the one idle event.
  const done = advance(working.state, { status: 'idle', completionSeq: 1 }, t + limits.idleMs * 3, limits);
  assert.equal(done.event, undefined);
  const fired = advance(done.state, { status: 'idle', completionSeq: 1 }, t + limits.idleMs * 4, limits);
  assert.equal(fired.event, 'idle');
  assert.equal(advance(fired.state, { status: 'idle', completionSeq: 1 }, t + limits.idleMs * 9, limits).event, undefined);
});

test('an open prompt is not stuck however long it waits', () => {
  const prompt = 'Allow this tool?';
  let state = initialState('working', 0);
  const seen: string[] = [];
  for (let at = 0; at <= limits.stuckMs * 2; at += 60_000) {
    const step = advance(state, { status: 'working', prompt }, at, limits);
    if (step.event) seen.push(step.event);
    state = step.state;
  }
  assert.ok(!seen.includes('stuck'));
  assert.equal(seen.filter((event) => event === 'blocked').length, 1);
});
