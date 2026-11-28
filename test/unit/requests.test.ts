// Tier 1: the requests state machine (step 4 of docs/design-matrix.md). One
// case per phase and per transition, then one per defect the family produced
// on the night of 27 to 28 November 2026, each showing the owner closes it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACT_BOUND_MS,
  IN_DOUBT_BOUND_MS,
  IN_FLIGHT,
  RESTART_DEFER_MS,
  TRANSITIONS,
  crossingBegun,
  crossingEnded,
  crossingInFlight,
  crossingPhase,
  crossingStep,
  next,
  relayRequestAnswered,
  relayRequestSaved,
  requestLines,
  requestsInFlight,
  restartAnswered,
  restartArmed,
  restartDisarmed,
  restartFailedEnds,
  restartInFlight,
  restartPhase,
  restartRanSince,
  restartRequested,
  restartStalled,
  restartTaken,
  teleportAnswered,
  teleportArmed,
  teleportInFlight,
  teleportPhase,
  teleportRequested,
  teleportStalled,
  waitStatusSeen,
  withoutCrossing,
  type RequestPhase,
  type RestartHolder,
} from '../../src/core/requests.ts';
import type { RelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord, Crossing, ParentRecord } from '../../src/core/types.ts';

const T0 = Date.parse('2026-11-28T10:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const bound = (ms = RESTART_DEFER_MS) => ({ paneId: 'w1:p1', until: at(ms) });

function child(extra: Partial<ChildRecord> = {}): ChildRecord {
  return { id: 'c1', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p1', host: 'local', depth: 1, startedAt: at(-60_000), lastStatus: 'working', ...extra } as ChildRecord;
}

function waiting(): RestartHolder {
  const holder: RestartHolder = {};
  assert.ok(restartRequested(holder, at(0), bound()));
  return holder;
}

function mark(extra: Partial<Crossing> = {}): Crossing {
  return { from: 'local', to: 'box', since: at(0), until: at(15 * 60_000), verb: 'move', daemon: 'd-1', stage: 'checked', state: 'live', ...extra };
}

// The phases.

test('a record that never asked is in no phase, and nothing is in flight', () => {
  assert.equal(restartPhase({}), 'none');
  assert.equal(teleportPhase(child()), 'none');
  assert.equal(crossingPhase(child()), 'none');
  assert.deepEqual(requestsInFlight([{ id: 'p', children: [child()] } as unknown as ParentRecord]), []);
});

test('requested: a request with no wait carries the default bound from its own time', () => {
  const holder = { restartRequestedAt: at(0) };
  assert.equal(restartPhase(holder), 'requested');
  const item = restartInFlight(holder, 'session p', 'session p');
  assert.equal(item?.until, at(RESTART_DEFER_MS));
  assert.match(item?.owner ?? '', /no daemon waits on it/);
});

test('waiting: the bound is the one the request was recorded with', () => {
  const holder = waiting();
  assert.equal(restartPhase(holder), 'waiting');
  assert.deepEqual(holder.restartWait, { paneId: 'w1:p1', until: at(RESTART_DEFER_MS) });
  assert.equal(restartInFlight(holder, 'w', 's')?.until, at(RESTART_DEFER_MS));
});

test('acted: the act took the request, and its bound is the act bound from that moment', () => {
  const holder = waiting();
  assert.ok(restartTaken(holder, 'w1:p1', T0 + 1000));
  assert.equal(restartPhase(holder), 'acted');
  assert.equal(holder.restartRequestedAt, undefined);
  assert.equal(holder.restartWait?.until, at(1000 + ACT_BOUND_MS));
  assert.equal(holder.restartWait?.acting, at(1000));
});

test('answered: the act ran, and the request leaves nothing behind', () => {
  const holder = waiting();
  restartTaken(holder, 'w1:p1', T0);
  assert.ok(restartAnswered(holder, at(2000)));
  assert.equal(restartPhase(holder), 'answered');
  assert.deepEqual({ ...holder }, { restartedAt: at(2000) });
});

test('stalled: the reason, the request time and the pane stay until the next request', () => {
  const holder = waiting();
  assert.ok(restartStalled(holder, 'the turn never ended', at(5000)));
  assert.equal(restartPhase(holder), 'stalled');
  assert.deepEqual(holder.restartStalled, { at: at(5000), requestedAt: at(0), paneId: 'w1:p1', reason: 'the turn never ended' });
  assert.ok(restartRequested(holder, at(6000), bound(6000 + RESTART_DEFER_MS)));
  assert.equal(holder.restartStalled, undefined, 'a new request clears the old stall');
});

test('a restart after a stall makes the stall old news', () => {
  const holder = waiting();
  restartStalled(holder, 'refused', at(5000));
  restartAnswered(holder, at(9000));
  assert.equal(restartPhase(holder), 'answered');
});

test('failed: the incarnation mark reads as failed once the request ended', () => {
  const holder: RestartHolder & { restartFailed?: unknown } = waiting();
  restartTaken(holder, 'w1:p1', T0);
  assert.ok(restartFailedEnds(holder));
  (holder as { restartFailed?: unknown }).restartFailed = { at: at(3000), oldPane: 'w1:p1', error: 'no session', reopen: 'x' };
  assert.equal(restartPhase(holder), 'failed');
  assert.equal(holder.restartWait, undefined);
});

test('in-doubt: a lost far answer carries a bound and names the relay link as its owner', () => {
  const holder = { restartInDoubt: { host: 'box', requestId: 'r-1', at: at(0), oldPane: 'w2:p1', error: 'connection closed' } } as RestartHolder;
  assert.equal(restartPhase(holder), 'in-doubt');
  const item = restartInFlight(holder, 'w', 's');
  assert.equal(item?.until, at(IN_DOUBT_BOUND_MS));
  assert.match(item?.owner ?? '', /relay link to box/);
});

// The transitions.

test('the table refuses every move it does not list, and the record stays as it was', () => {
  const holder = waiting();
  const before = JSON.stringify(holder);
  assert.equal(restartRequested(holder, at(1), bound()), false, 'a second request while one waits');
  assert.equal(JSON.stringify(holder), before);
  const answered: RestartHolder = { restartedAt: at(0) };
  assert.equal(restartTaken(answered, 'w1:p1'), false, 'nothing to take');
  assert.equal(restartStalled(answered, 'x'), false, 'nothing to give up');
  assert.equal(restartDisarmed(answered), false);
  assert.deepEqual({ ...answered }, { restartedAt: at(0) });
});

test('every phase has a row, and every event a move leads to is a phase', () => {
  const phases: (RequestPhase | 'none')[] = ['none', 'requested', 'waiting', 'acted', 'answered', 'stalled', 'failed', 'in-doubt'];
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...phases].sort());
  for (const row of Object.values(TRANSITIONS)) for (const to of Object.values(row)) assert.ok(phases.includes(to as never));
  assert.equal(next('waiting', 'take'), 'acted');
  assert.equal(next('acted', 'take'), undefined);
  assert.equal(next('stalled', 'stall'), undefined);
});

test('disarm: a daemon that stops mid-wait leaves the request for its next start', () => {
  const holder = waiting();
  assert.ok(restartDisarmed(holder));
  assert.equal(restartPhase(holder), 'requested');
  assert.ok(restartArmed(holder, bound(10 * 60_000)), 'the next daemon arms it with a full bound');
  assert.equal(holder.restartWait?.until, at(10 * 60_000));
});

test('status: herdr status lands on the wait, for doctor and a second call', () => {
  const holder = waiting();
  waitStatusSeen(holder.restartWait, 'working', at(10));
  assert.equal(holder.restartWait?.status, 'working');
  assert.match(restartInFlight(holder, 'w', 's')?.owner ?? '', /herdr reports it working since/);
});

test('a route change rides on the request and goes with it', () => {
  const holder: RestartHolder = {};
  restartRequested(holder, at(0), bound(), { via: 'example-router' });
  assert.deepEqual(holder.restartRoute, { via: 'example-router' });
  restartTaken(holder, 'w1:p1');
  assert.equal(holder.restartRoute, undefined);
});

test('restartRanSince tells a request the record shows ran from one that did not', () => {
  assert.equal(restartRanSince({ restartRequestedAt: at(0), restartedAt: at(1) }), true);
  assert.equal(restartRanSince({ restartRequestedAt: at(1), restartedAt: at(0) }), false);
});

test('a teleport moves through requested, waiting, acted and answered', () => {
  const record = child();
  assert.ok(teleportRequested(record, { at: at(0), machine: 'box' }, bound()));
  assert.equal(teleportPhase(record), 'waiting');
  assert.equal(teleportInFlight(record, 'w')?.until, at(RESTART_DEFER_MS));
  assert.equal(teleportRequested(record, { at: at(1), machine: 'other' }, bound()), false, 'one teleport at a time');
  crossingBegun(record, mark({ verb: 'teleport' }));
  assert.equal(teleportPhase(record), 'acted');
  assert.equal(teleportInFlight(record, 'w')?.until, at(15 * 60_000), 'the crossing bounds the act');
  assert.equal(crossingInFlight(record, 'w'), undefined, 'listed once, under the teleport');
  crossingEnded(record, { ran: true });
  assert.equal(teleportPhase(record), 'none');
  assert.equal(record.teleportRequest, undefined);
});

test('a teleport that gives up keeps its machine and request time', () => {
  const record = child();
  teleportRequested(record, { at: at(0), machine: 'box' }, bound());
  assert.ok(teleportStalled(record, 'the turn never ended', 'w1:p1', at(9)));
  assert.equal(teleportPhase(record), 'stalled');
  assert.deepEqual(record.teleportStalled, { at: at(9), requestedAt: at(0), paneId: 'w1:p1', machine: 'box', reason: 'the turn never ended' });
  assert.equal(teleportAnswered(record), true, 'an answer with nothing asked changes nothing');
  assert.ok(record.teleportStalled);
});

test('a crossing writes its steps only from the daemon that runs it', () => {
  const record = child();
  crossingBegun(record, mark());
  assert.equal(crossingStep(record, 'd-other', { stage: 'copied' }), false);
  assert.equal(record.moving?.stage, 'checked');
  assert.ok(crossingStep(record, 'd-1', { stage: 'copied' }));
  assert.equal(record.moving?.stage, 'copied');
  assert.equal(withoutCrossing(record).moving, undefined);
  assert.ok(record.moving, 'the copy, not the record, loses the mark');
});

test('a relay record keeps a request until the parent takes or refuses it, and only for its own receipt', () => {
  const record = { childId: 'c1' } as RelayRecord;
  relayRequestSaved(record, 'teleportRequest', { at: at(0), receipt: 'r-1', machine: 'box' });
  relayRequestAnswered(record, 'teleportRequest', 'r-other');
  assert.ok(record.teleportRequest);
  relayRequestAnswered(record, 'teleportRequest', 'r-1', 'refused: unknown machine');
  assert.equal(record.teleportRequest?.refused, 'refused: unknown machine');
  relayRequestSaved(record, 'retireRequest', { at: at(0), receipt: 'r-2' });
  relayRequestAnswered(record, 'retireRequest', 'r-2');
  assert.equal(record.retireRequest, undefined);
});

// Doctor.

test('doctor prints each request in flight with its bound and owner, and fails one past its bound', () => {
  const parent = { id: 'p', children: [child({ moving: mark() })] } as unknown as ParentRecord;
  const fresh = requestLines(requestsInFlight([parent]), T0 + 60_000);
  assert.deepEqual(fresh, [`info  request: crossing of worker (child c1 of p), acted since ${at(0)}, ends by ${at(15 * 60_000)}. Owner: the move run by daemon d-1, at step checked; a daemon that starts after it stopped finishes or undoes it.`]);
  const [late] = requestLines(requestsInFlight([parent]), T0 + 16 * 60_000);
  assert.match(late ?? '', /^fail  request: crossing of worker \(child c1 of p\), acted since \S+, outlived its bound \S+\. Its owner, the move run by daemon d-1/);
});

test('every phase in flight has a bound doctor can read', () => {
  const holders: RestartHolder[] = [{ restartRequestedAt: at(0) }, waiting(), (() => { const h = waiting(); restartTaken(h, 'w1:p1', T0); return h; })(), { restartInDoubt: { host: 'box', requestId: 'r', at: at(0), oldPane: '' } } as RestartHolder];
  for (const holder of holders) {
    const item = restartInFlight(holder, 'w', 's');
    assert.ok(item && IN_FLIGHT.includes(item.phase), `${restartPhase(holder)} is in flight`);
    assert.ok(Number.isFinite(Date.parse(item.until)), `${item.phase} has a bound`);
  }
});

// The defects.

test('#220: a request with nothing waiting on it still has a deadline, and doctor fails it once past', () => {
  // The record an older daemon left: restartRequestedAt, no restartWait, hours old.
  const parent = { id: 'lead', restartRequestedAt: '2026-11-28T02:38:18.961Z', children: [] } as unknown as ParentRecord;
  const [line] = requestLines(requestsInFlight([parent]), Date.parse('2026-11-28T08:00:00.000Z'));
  assert.match(line ?? '', /^fail  request: restart of session lead, requested since 2026-11-28T02:38:18\.961Z, outlived its bound 2026-11-28T02:43:18\.961Z/);
});

test('#228: an act that refuses after the wait ends the request with its reason, so nothing is left without an owner', () => {
  const holder = waiting();
  waitStatusSeen(holder.restartWait, 'idle', at(100));
  assert.ok(restartStalled(holder, 'the restart did not run: pane w1:p1 now holds another session.', at(200)));
  assert.equal(restartPhase(holder), 'stalled');
  assert.equal(holder.restartRequestedAt, undefined);
  assert.equal(holder.restartWait, undefined);
  assert.equal(restartInFlight(holder, 'w', 's'), undefined);
});

test('a wait armed again by a new daemon carries the new bound, never the one that ended with the old daemon', () => {
  // Before the owner, the parent's service armed a far child's teleport and kept the old wait.until, so doctor read a bound long past while a wait ran.
  const record = child();
  teleportRequested(record, { at: at(0), machine: 'box' }, bound());
  assert.ok(teleportArmed(record, { paneId: 'w1:p1', until: at(60 * 60_000) }));
  assert.equal(teleportInFlight(record, 'w')?.until, at(60 * 60_000));
});

test('a crossing a new daemon undid ends the teleport request it served, so no second teleport is armed', () => {
  // Before the owner, recover-crossing deleted the mark and left teleportRequest, which the next service armed again.
  const record = child();
  teleportRequested(record, { at: at(0), machine: 'box' }, bound());
  crossingBegun(record, mark({ verb: 'teleport', daemon: 'gone' }));
  crossingEnded(record, { ran: false, reason: 'the daemon that ran the teleport stopped part of the way' });
  assert.equal(record.teleportRequest, undefined);
  assert.equal(teleportPhase(record), 'stalled');
  assert.match(record.teleportStalled?.reason ?? '', /stopped part of the way/);
});
