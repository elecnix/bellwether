// The roster line: one line, appended to an alert, about the parent's other
// children. It must say nothing when there is nothing to say, never repeat a
// child the alert names, stay under a cap, and stay small next to the alert it
// rides on (issue #146).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROSTER_CAP, rosterLine, rosterOf, type RosterChild } from '../../src/core/roster.ts';
import { composeBurst, composeEvent } from '../../src/integrations/alert.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function child(childId: string, state: RosterChild['state'], quietMinutes: number, name = childId): RosterChild {
  return { childId, name, state, since: ago(quietMinutes) };
}

function entry(childId: string, event: OutboxEntry['event'], text: string, receipt = `r-${childId}`): OutboxEntry {
  return { receipt, childId, name: childId, kind: 'pi', paneId: 'w1:p1', event, text, at: ago(0), read: false };
}

// A median alert today, measured on this machine's delivered and queued
// alerts (14 of them): about 1,320 characters. The bound is a fifth of it.
const MEDIAN_ALERT = 1320;
const BOUND = MEDIAN_ALERT / 5;

test('two children, one event: the line carries the other child and its state', () => {
  const roster = [child('build', 'working', 0), child('docs', 'idle', 12)];
  assert.equal(rosterLine(roster, ['build'], NOW), 'children 2: docs idle 12m');
  assert.equal(rosterLine(roster, ['docs'], NOW), 'children 2: 1 working');
});

test('a child the alert names is never listed again', () => {
  const roster = [child('a', 'idle', 30), child('b', 'blocked', 3), child('c', 'idle', 40), child('d', 'working', 0), child('e', 'idle', 5)];
  const line = rosterLine(roster, ['a', 'b', 'c'], NOW);
  assert.equal(line, 'children 5: 1 working, e idle 5m');
  for (const name of ['a', 'b', 'c']) assert.doesNotMatch(line, new RegExp(`\\b${name}\\b`));
});

test('nothing to say gives no line: one child, or no other live child', () => {
  assert.equal(rosterLine([child('only', 'idle', 9)], ['only'], NOW), '');
  assert.equal(rosterLine([], ['gone'], NOW), '');
  assert.equal(rosterLine(undefined, ['x'], NOW), '');
});

test('the quietest child comes first, with its age', () => {
  const roster = [child('fresh', 'idle', 2), child('stale', 'idle', 95), child('dialog', 'blocked', 3)];
  assert.equal(rosterLine(roster, [], NOW), 'children 3: stale idle 1h35m, dialog blocked 3m, fresh idle 2m');
});

test('nine children: the cap holds, the rest are counted, and the line stays under a fifth of a median alert', () => {
  const roster = [
    child('w1', 'working', 0),
    child('w2', 'working', 0),
    ...Array.from({ length: 7 }, (_, index) => child(`q${index}`, index % 2 ? 'blocked' : 'idle', 10 + index * 7, `roster-child-name-${index}`)),
  ];
  const line = rosterLine(roster, [], NOW);
  assert.equal(line, `children 9: 2 working, roster-child-name-6 idle 52m, roster-child-name-5 blocked 45m, roster-child-name-4 idle 38m, roster-child-name-3 blocked 31m, and 3 more`);
  assert.equal(line.split(', ').length - 2, ROSTER_CAP);
  assert.ok(line.length + 2 <= BOUND, `${line.length + 2} characters is over the bound of ${BOUND}`);
});

test('a long name is cut, so the worst case at the cap is bounded whatever the names', () => {
  const long = 'x'.repeat(200);
  const roster = Array.from({ length: 12 }, (_, index) => child(`c${index}`, 'blocked', 1000 + index, `${long}${index}`));
  const line = rosterLine([...roster, child('w', 'working', 0)], [], NOW);
  assert.match(line, /and 8 more$/);
  assert.ok(line.length + 2 <= BOUND, `${line.length + 2} characters is over the bound of ${BOUND}`);
});

test('the record decides the state: the newest status, an open dialog, and exited children left out', () => {
  const base = { kind: 'pi', harness: 'pi', host: 'local', depth: 1, startedAt: ago(60), lastBusyAt: ago(60) } as const;
  const records = [
    { ...base, id: 'a', name: 'a', paneId: 'w1:p1', lastStatus: 'working', statusChangedAt: ago(1) },
    { ...base, id: 'b', name: 'b', paneId: 'w1:p2', lastStatus: 'idle', statusChangedAt: ago(20), lastBusyAt: ago(25) },
    { ...base, id: 'c', name: 'c', paneId: 'w1:p3', lastStatus: 'idle', statusChangedAt: ago(9), prompt: { line: 'Allow?', source: 'pi', since: ago(4) } },
    { ...base, id: 'd', name: 'd', paneId: 'w1:p4', lastStatus: 'done', statusChangedAt: ago(7), lastBusyAt: ago(6) },
    { ...base, id: 'e', name: 'e', paneId: 'w1:p5', lastStatus: 'idle', statusChangedAt: ago(30), exitedAt: ago(29) },
  ] as unknown as ChildRecord[];
  const roster = rosterOf(records);
  assert.deepEqual(roster.map((entry) => [entry.childId, entry.state, entry.since]), [
    ['a', 'working', ago(1)],
    ['b', 'idle', ago(20)],
    ['c', 'blocked', ago(4)],
    ['d', 'idle', ago(6)],
  ]);
  assert.equal(rosterLine(roster, ['a'], NOW), 'children 4: b idle 20m, d idle 6m, c blocked 4m');
});

// The texts below are what both adapters sent before the roster existed,
// character for character, produced by the compose functions on main before
// this change. A parent with one child must keep receiving them.
test('a one-child parent: the pi text is unchanged, character for character', () => {
  const only = entry('solo', 'idle', 'solo finished its turn.');
  const before = '[bellwether]\nsolo (w1:p1) idle, a pi agent — receipt r-solo\nsolo finished its turn.\n\nRead more with agent_read. Reply with agent_send.';
  assert.equal(composeBurst([only], NOW, [child('solo', 'idle', 0)]), before);
  assert.equal(composeBurst([only], NOW, undefined), before);
  const burst = [entry('a', 'idle', 'A.'), entry('b', 'report', 'B.')];
  const beforeBurst = '[bellwether] 2 children changed\na (w1:p1) idle, a pi agent — receipt r-a\nA.\n\nb (w1:p1) report, a pi agent — receipt r-b\nB.\n\nRead more with agent_read. Reply with agent_send.';
  assert.equal(composeBurst(burst, NOW, [child('a', 'idle', 0), child('b', 'working', 0)]), beforeBurst);
});

test('a one-child parent: the Claude Code text is unchanged, character for character', () => {
  const only = entry('solo', 'exited', 'solo exited.');
  const before = '[bellwether] solo (w1:p1) exited, a pi agent — receipt r-solo\nsolo exited.\n\nRead more with agent_read. Reply with agent_send.';
  assert.equal(composeEvent(only, NOW, ''), before);
});

test('both adapters put the same line in the same place', () => {
  const roster = [child('build', 'idle', 1), child('docs', 'blocked', 14)];
  const line = rosterLine(roster, ['build'], NOW);
  const pi = composeBurst([entry('build', 'idle', 'Done.')], NOW, roster);
  const claude = composeEvent(entry('build', 'idle', 'Done.'), NOW, line);
  const tail = '\nDone.\n\nchildren 2: docs blocked 14m\n\nRead more with agent_read. Reply with agent_send.';
  assert.ok(pi.endsWith(tail), pi);
  assert.ok(claude.endsWith(tail), claude);
});
