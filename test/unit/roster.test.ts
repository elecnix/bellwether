// The roster line: one line, appended to an alert, about the parent's other
// children. It must say nothing when there is nothing to say, never repeat a
// child the alert names, carry one age, stay small next to the alert it rides
// on, and never repeat itself or arrive more than once in ten minutes
// (issue #146).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROSTER_INTERVAL_MS, rosterDue, rosterLine, rosterOf, type RosterChild } from '../../src/core/roster.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { createHerdrService, parentIdOf } from '../../src/daemon/service.ts';
import { composeBurst, composeEvent } from '../../src/integrations/alert.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function child(childId: string, state: RosterChild['state'], quietMinutes: number): RosterChild {
  return { childId, state, since: ago(quietMinutes) };
}

function entry(childId: string, event: OutboxEntry['event'], text: string, receipt = `r-${childId}`): OutboxEntry {
  return { receipt, childId, name: childId, kind: 'pi', paneId: 'w1:p1', event, text, at: ago(0), read: false };
}

// The alert sizes measured on this machine's delivered and queued alerts
// (14 of them): the median, and a short idle event near the low end.
const MEDIAN_ALERT = 1322;
const SHORT_ALERT = 217;
/** What the line adds to an alert: the line and the blank line before it. */
const added = (line: string): number => (line ? line.length + 2 : 0);

test('two children, one event: the line carries the other child and its state', () => {
  const roster = [child('build', 'working', 0), child('docs', 'idle', 12)];
  assert.equal(rosterLine(roster, ['build'], NOW), 'children 2: 1 idle 12m');
  assert.equal(rosterLine(roster, ['docs'], NOW), 'children 2: 1 working');
});

test('a child the alert names is never counted again', () => {
  const roster = [child('a', 'idle', 30), child('b', 'blocked', 3), child('c', 'idle', 40), child('d', 'working', 0), child('e', 'idle', 5)];
  assert.equal(rosterLine(roster, ['a', 'b', 'c'], NOW), 'children 5: 1 working, 1 idle 5m');
  assert.equal(rosterLine(roster, ['d', 'e'], NOW), 'children 5: 2 idle 40m, 1 blocked');
});

test('nothing to say gives no line: one child, or no other live child', () => {
  assert.equal(rosterLine([child('only', 'idle', 9)], ['only'], NOW), '');
  assert.equal(rosterLine([], ['gone'], NOW), '');
  assert.equal(rosterLine(undefined, ['x'], NOW), '');
});

test('one age only, on the state of the child quiet longest', () => {
  const roster = [child('fresh', 'idle', 2), child('stale', 'blocked', 95), child('dialog', 'blocked', 3), child('w', 'working', 0), child('u', 'unknown', 7)];
  assert.equal(rosterLine(roster, [], NOW), 'children 5: 1 working, 1 idle, 2 blocked 1h35m, 1 unknown');
  assert.equal(rosterLine(roster, [], NOW, { ages: false }), 'children 5: 1 working, 1 idle, 2 blocked, 1 unknown');
});

test('nine children, and any number: four entries at most, under a fifth of a median alert', () => {
  const nine = [child('w1', 'working', 0), child('w2', 'working', 0), ...Array.from({ length: 7 }, (_, index) => child(`q${index}`, index % 2 ? 'blocked' : 'idle', 10 + index * 7))];
  const line = rosterLine(nine, [], NOW);
  assert.equal(line, 'children 9: 2 working, 4 idle 52m, 3 blocked');
  // The worst case: every state present, three-digit counts, the longest age the line prints before days.
  const states: RosterChild['state'][] = ['working', 'idle', 'blocked', 'unknown'];
  const many = Array.from({ length: 999 }, (_, index) => child(`c${index}`, states[index % 4]!, index === 1 ? 23 * 60 + 59 : 1));
  const worst = rosterLine(many, [], NOW);
  assert.equal(worst, 'children 999: 250 working, 250 idle 23h59m, 250 blocked, 249 unknown');
  assert.equal(worst.split(', ').length, 4);
  assert.ok(added(worst) <= MEDIAN_ALERT / 5, `${added(worst)} characters is over a fifth of the median alert`);
  assert.ok(added(line) <= MEDIAN_ALERT / 5);
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
  assert.deepEqual(roster, [
    { childId: 'a', state: 'working', since: ago(1) },
    { childId: 'b', state: 'idle', since: ago(20) },
    { childId: 'c', state: 'blocked', since: ago(4) },
    { childId: 'd', state: 'idle', since: ago(6) },
  ]);
  assert.equal(rosterLine(roster, ['a'], NOW), 'children 4: 2 idle 20m, 1 blocked');
});

test('the first roster is due, and the same line is never due again', () => {
  const roster = [child('a', 'idle', 1), child('b', 'working', 0)];
  const first = rosterDue(roster, ['a'], undefined, NOW);
  assert.deepEqual(first, { at: new Date(NOW).toISOString(), line: 'children 2: 1 working' });
  const later = NOW + 3 * ROSTER_INTERVAL_MS;
  assert.equal(rosterDue(roster, ['a'], first, later), undefined, 'nothing changed');
  // A child that stays quiet longer changes only the age, which is not a change.
  const quiet = [child('a', 'working', 0), child('b', 'idle', 5)];
  const sent = rosterDue(quiet, ['a'], undefined, NOW)!;
  assert.equal(rosterDue([child('a', 'working', 0), child('b', 'idle', 50)], ['a'], sent, later), undefined);
});

test('a changed roster waits out the interval: an alert storm carries one line', () => {
  const first = rosterDue([child('a', 'idle', 1), child('b', 'working', 0)], ['a'], undefined, NOW)!;
  const changed = [child('a', 'idle', 1), child('b', 'idle', 0)];
  assert.equal(rosterDue(changed, ['a'], first, NOW + ROSTER_INTERVAL_MS - 1), undefined);
  assert.deepEqual(rosterDue(changed, ['a'], first, NOW + ROSTER_INTERVAL_MS), { at: new Date(NOW + ROSTER_INTERVAL_MS).toISOString(), line: 'children 2: 1 idle' });
  // Ten alerts in a minute from five children: one carries the line.
  let last: ReturnType<typeof rosterDue>;
  let lines = 0;
  for (let index = 0; index < 10; index++) {
    const storm = Array.from({ length: 5 }, (_, each) => child(`s${each}`, (index + each) % 3 ? 'idle' : 'working', each));
    const due = rosterDue(storm, [`s${index % 5}`], last, NOW + index * 6_000);
    if (due) {
      last = due;
      lines++;
    }
  }
  assert.equal(lines, 1);
  // Even when every alert in the storm is a short idle event, the one line adds under a fifth across the storm.
  const line = 'children 5: 2 working, 2 idle 4m, 1 blocked';
  assert.ok(added(line) / (10 * SHORT_ALERT) <= 1 / 5);
});

test('nothing to say is never due and spends nothing', () => {
  assert.equal(rosterDue([child('only', 'idle', 1)], ['only'], undefined, NOW), undefined);
  assert.equal(rosterDue([], [], undefined, NOW), undefined);
});

test('the daemon service keeps the last roster on the parent record, so a restarted daemon keeps the rule', (t) => {
  const hello = { harness: 'claude-code' as const, session: 'roster-gate', cwd: os.tmpdir(), host: 'local', depth: 0, herdrSocket: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-roster-')), 'none.sock') };
  const id = parentIdOf(hello);
  const record = emptyParent('claude-code', 'roster-gate', os.tmpdir(), { host: 'local' });
  const base = { kind: 'pi', harness: 'pi', host: 'local', depth: 1, startedAt: ago(60), lastBusyAt: ago(60), statusChangedAt: ago(1) };
  record.children = [
    { ...base, id: 'a', name: 'a', paneId: 'w1:p1', lastStatus: 'idle' },
    { ...base, id: 'b', name: 'b', paneId: 'w1:p2', lastStatus: 'working' },
  ] as unknown as ChildRecord[];
  saveParent(record);
  const first = createHerdrService(hello, id);
  t.after(() => first.stop());
  assert.equal(first.roster?.(['a'])?.length, 2);
  assert.equal(readParent(id)?.rosterSent?.line, 'children 2: 1 working');
  assert.equal(first.roster?.(['a']), undefined, 'the same line again');
  first.stop();
  const second = createHerdrService(hello, id);
  t.after(() => second.stop());
  assert.equal(second.roster?.(['b']), undefined, 'a changed line, inside the interval, after a restart');
});

// The texts below are what both adapters sent before the roster existed,
// character for character, produced by the compose functions on main before
// this change.
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
  const tail = '\nDone.\n\nchildren 2: 1 blocked 14m\n\nRead more with agent_read. Reply with agent_send.';
  assert.ok(pi.endsWith(tail), pi);
  assert.ok(claude.endsWith(tail), claude);
});
