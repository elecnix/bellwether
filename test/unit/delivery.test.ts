// Tier 1: the delivery state machine (issue #278). Every pair of phase and
// event runs through src/core/delivery.ts, and the table below pins which
// moves it accepts and where each lands. A read after an undelivered mark, a
// resend after a read and a second read of one message each have a row, so a
// new rule for when a message counts as delivered changes one row here and
// one entry in TRANSITIONS.
import assert from 'node:assert/strict';
import test from 'node:test';
import { briefState, childExited, deliveryState, messageRead, messageResent, messageSending, next, phaseOf, PHASES, relayAnswerLost, relayAnswered, toReplay, TRANSITIONS, type MessageEvent, type MessagePhase } from '../../src/core/delivery.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import type { BriefDelivery, ChildMessage, ChildRecord } from '../../src/core/types.ts';

const PHASE_LIST = Object.keys(PHASES) as MessagePhase[];
const EVENTS: MessageEvent[] = ['pushed', 'unanswered', 'relay-lost', 'relay-refused', 'relay-unknowable', 'held', 'refused', 'read', 'resent', 'carried', 'exited'];

/** Where each phase goes on each event; a dash is a refusal, and the record stays as it was. */
const EXPECTED: Record<MessagePhase, string> = {
  //                pushed       unanswered  relay-lost      relay-refused relay-unknowable held  refused      read  resent       carried      exited
  sending: /*   */ 'pushed       unanswered  relay-in-doubt  -             -                held  -            read  undelivered  undelivered  -',
  held: /*      */ 'pushed       -           -               -             -                -     -            read  undelivered  undelivered  undelivered',
  pushed: /*    */ 'pushed       -           -               -             -                -     undelivered  read  undelivered  undelivered  undelivered',
  unanswered: /**/ 'pushed       -           -               -             -                -     undelivered  read  undelivered  undelivered  undelivered',
  'relay-in-doubt': 'pushed      -           -               undelivered   relay-in-doubt   -     -            read  -            -            -',
  'typed-in-doubt': '-           -           -               -             -                -     -            -     -            undelivered  -',
  typed: /*     */ '-            -           -               -             -                -     -            -     -            undelivered  -',
  read: /*      */ 'read         -           -               -             -                -     -            -     -            -            -',
  undelivered: /**/ 'undelivered -           -               -             -                -     -            read  -            -            -',
};

test('every pair of phase and event lands where the table says, and every other pair is refused', () => {
  for (const phase of PHASE_LIST) {
    const row = EXPECTED[phase].trim().split(/\s+/);
    assert.equal(row.length, EVENTS.length, `row ${phase}`);
    EVENTS.forEach((event, index) => {
      const want = row[index] === '-' ? undefined : row[index];
      assert.equal(next(phase, event), want, `${phase} on ${event}`);
    });
  }
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...PHASE_LIST].sort(), 'the machine has a row for each phase');
});

test('each phase reads as one of seven words, and "in doubt" covers the three ways a message may have arrived', () => {
  assert.deepEqual([...new Set(PHASE_LIST.map((phase) => PHASES[phase].word))].sort(), ['held', 'in doubt', 'pushed', 'read', 'sending', 'typed', 'undelivered']);
  assert.deepEqual(PHASE_LIST.filter((phase) => PHASES[phase].word === 'in doubt'), ['unanswered', 'relay-in-doubt', 'typed-in-doubt']);
});

test('the phase comes from the stored fields, and a read wins over every other mark', () => {
  const base: ChildMessage = { id: 'm-1', at: '2026-11-28T00:00:00.000Z', path: 'session', preview: 'x' };
  assert.equal(phaseOf(base), 'sending');
  assert.equal(phaseOf({ ...base, via: 'claude-channel' }), 'pushed');
  assert.equal(phaseOf({ ...base, held: 'no session' }), 'held');
  assert.equal(phaseOf({ ...base, via: 'session', unanswered: 'no answer' }), 'unanswered');
  assert.equal(phaseOf({ ...base, relayInDoubt: 'lost' }), 'relay-in-doubt');
  assert.equal(phaseOf({ ...base, path: 'keystrokes' }), 'typed');
  assert.equal(phaseOf({ ...base, path: 'keystrokes', typedInDoubt: 'timeout' }), 'typed-in-doubt');
  assert.equal(phaseOf({ ...base, undelivered: 'exited' }), 'undelivered');
  // A record a 0.1.10 daemon wrote can hold a read beside a relay doubt.
  assert.equal(phaseOf({ ...base, readAt: '2026-11-28T00:00:01.000Z', relayInDoubt: 'lost' }), 'read');
});

function child(): ChildRecord {
  const at = '2026-11-28T00:00:00.000Z';
  return { id: 'child-a', name: 'a', kind: 'claude', harness: 'claude-code', paneId: 'w1:p1', host: LOCAL_HOST, origin: 'spawn', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 };
}

test('a refused move leaves the record as it was: a relay answer lost after the read, a resend after a read, a second read', () => {
  const record = child();
  messageSending(record, { id: 'm-1', at: '2026-11-28T00:00:00.000Z', text: 'hello', from: 'parent' });
  assert.equal(messageRead(record, 'm-1', '2026-11-28T00:00:01.000Z'), '2026-11-28T00:00:01.000Z');
  const settled = structuredClone(record.messages);
  assert.equal(relayAnswerLost(record, 'm-1', 'the relay lost its answer'), undefined);
  assert.equal(messageResent(record, 'm-1', 'went again'), undefined);
  assert.equal(messageRead(record, 'm-1', '2026-11-28T00:00:09.000Z'), undefined, 'a second read changes nothing');
  assert.deepEqual(record.messages, settled);
});

test('a read after an undelivered mark counts, and drops the mark and the text', () => {
  const record = child();
  messageSending(record, { id: 'm-1', at: '2026-11-28T00:00:00.000Z', text: 'brief', from: 'parent', brief: 1 });
  messageResent(record, 'm-1', 'brief 1 went again');
  assert.equal(phaseOf(record.messages![0]!), 'undelivered');
  messageRead(record, 'm-1', '2026-11-28T00:00:30.000Z');
  assert.deepEqual(record.messages, [{ id: 'm-1', at: '2026-11-28T00:00:00.000Z', path: 'session', preview: 'brief', brief: 1, readAt: '2026-11-28T00:00:30.000Z' }]);
});

test('a far machine that forgot the child leaves the message in doubt, without the text the relay would ask about again', () => {
  const record = child();
  messageSending(record, { id: 'm-1', at: '2026-11-28T00:00:00.000Z', text: 'hello', from: 'parent' });
  relayAnswerLost(record, 'm-1', 'the relay lost its answer');
  relayAnswered(record, 'm-1', { delivered: false, unknowable: true, why: 'machine box no longer holds the child' });
  assert.equal(phaseOf(record.messages![0]!), 'relay-in-doubt');
  assert.equal(record.messages![0]!.text, undefined);
});

test('an exit marks undelivered each message the session might still take, held ones included, and leaves a relay doubt alone', () => {
  const record = child();
  for (const id of ['m-held', 'm-pushed', 'm-relay']) messageSending(record, { id, at: '2026-11-28T00:00:00.000Z', text: id, from: 'parent' });
  const writable = record.messages as ChildMessage[];
  writable[0] = { ...writable[0]!, held: 'no session' };
  writable[1] = { ...writable[1]!, via: 'claude-channel' };
  relayAnswerLost(record, 'm-relay', 'lost');
  assert.deepEqual(toReplay(record).map((message) => message.id), ['m-held', 'm-pushed']);
  assert.deepEqual(childExited(record, 'the child exited').map((message) => message.id), ['m-held', 'm-pushed']);
  assert.deepEqual(record.messages!.map((message) => phaseOf(message)), ['undelivered', 'undelivered', 'relay-in-doubt']);
});

test('a brief is taken only on both signs, a read alone reads as read, and a late read of its message counts', () => {
  const pushed: BriefDelivery = { path: 'session', via: 'claude-channel', message: 'm-1', at: 't', receivedAt: 't' };
  assert.equal(deliveryState(undefined), 'unrecorded');
  assert.equal(deliveryState(pushed), 'pushed');
  assert.equal(deliveryState({ ...pushed, readAt: 't2' }), 'read');
  assert.equal(deliveryState({ ...pushed, readAt: 't2', takenAt: 't3', takenBy: 'turn' }), 'taken');
  assert.equal(deliveryState({ ...pushed, takenAt: 't2', takenBy: 'read' }), 'read', 'before 0.1.10, takenBy read meant a read receipt alone');
  assert.equal(deliveryState({ path: 'keystrokes', at: 't' }), 'typed');
  assert.equal(deliveryState({ path: 'launch', at: 't' }), 'launch');
  const late = { messages: [{ id: 'm-1', at: 't', path: 'session' as const, preview: 'x', readAt: 't9' }] };
  assert.equal(briefState(late, { delivery: pushed }), 'read');
  assert.equal(briefState({}, { delivery: pushed }), 'pushed');
});
