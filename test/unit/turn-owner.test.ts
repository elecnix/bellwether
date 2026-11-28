// Tier 1: the turn family has one writer (step 6 of docs/design-matrix.md).
// The fields that say what a child's turns left behind, from the last status
// change and the last activity to the turn the parent heard about, the
// conversation file and the tools the harness loads, are written only in
// src/core/turn.ts, through its transitions. These cases fail when any other
// file in src/ assigns or deletes one of those fields, copies a record with
// one of them changed, or builds a child record that names one. The
// typecheck holds the other half: ChildRecord declares each field readonly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AUTHORITY_FIELD_NAMES } from '../../src/core/authority.ts';
import { seqHere } from '../../src/core/classifier.ts';
import { DELIVERY_FIELDS } from '../../src/core/delivery.ts';
import { INCARNATION_FIELDS, LIFETIMES, runStarts } from '../../src/core/incarnation.ts';
import { REQUEST_FIELDS } from '../../src/core/requests.ts';
import { TURN_FIELDS, firstTurn, transcriptFound, transcriptLeft, turnNumbered, turnTold, turnsAlreadyDone } from '../../src/core/turn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'turn.ts');

/** Writes to a field of the same name on an object that is not a child record, each with its reason. */
const NOT_MINE: Record<string, string> = {
  'src/core/classifier.ts settled': "the classifier's own state for a child, which the watcher keeps in memory",
  'src/core/classifier.ts next': "the classifier's own state for a child, which the watcher keeps in memory",
  'src/core/remote.ts registration': 'what relay-register answers about the files it wrote on its machine',
  'src/integrations/claude/transcript.ts this': 'a transcript reader keeps the file it reads',
};

const SCANNER = ownerScanner({ owner: OWNER, fields: TURN_FIELDS, notMine: NOT_MINE, literalTypes: ['ChildRecord'] });

function child(change: Partial<ChildRecord> = {}): ChildRecord {
  return { id: 'c1', name: 'example', kind: 'claude', harness: 'claude', paneId: 'p1', host: 'local', origin: 'spawn', startedAt: 'T0', lastStatus: 'idle', statusChangedAt: 'T0', lastBusyAt: 'T0', depth: 1, ...change } as ChildRecord;
}

test('the scan flags each way a module could write a turn field without the owner', () => {
  const rules = (source: string): string[] => SCANNER.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('entry.lastBusyAt = now;'), ['write']);
  assert.deepEqual(rules('delete entry.turnBaseline;'), ['write']);
  assert.deepEqual(rules('entry.turnNotified = { paneId, seq };'), ['write']);
  assert.deepEqual(rules('(entry as { transcript?: string }).transcript = file;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("entry['completionSeq'] = seq;"), ['write']);
  assert.deepEqual(rules('Object.assign(entry, { toolSource });'), ['assign']);
  assert.deepEqual(rules('this.recordTranscript({ ...child, transcript: undefined }, session);'), ['copy']);
  assert.deepEqual(rules('const child: ChildRecord = { id, name, statusChangedAt: now };'), ['literal']);
});

test('the scan leaves reads, the transitions and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => SCANNER.scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (seq !== child.completionSeq) return;'), []);
  assert.deepEqual(rules('turnNumbered(entry, seq, at);'), []);
  assert.deepEqual(rules('entry.lastBusyAt = at;', OWNER), []);
  assert.deepEqual(rules('next.completionSeq = seq;', 'src/core/classifier.ts'), [], "the classifier's own state");
});

test('no file but src/core/turn.ts writes a turn field', () => {
  assert.deepEqual(
    SCANNER.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/turn.ts instead, such as statusChanged, busyAt, turnNumbered, turnTold or transcriptFound. A field of the same name on another kind of object goes in NOT_MINE with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(SCANNER.staleExemptions(), []);
});

test('ChildRecord declares every turn field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.ok(body, 'ChildRecord was not found in src/core/types.ts');
  assert.deepEqual(TURN_FIELDS.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)), [], 'declare these fields readonly in ChildRecord');
});

test('the family covers the fields the design matrix names, and no other family owns them', () => {
  // docs/design-matrix.md, step 6. completionPane, stateChangeSeq, turnBaseline and inactiveNotifiedFor answer the same question.
  for (const field of ['statusChangedAt', 'lastBusyAt', 'turnNotified', 'completionSeq', 'transcript', 'transcriptMissing', 'toolSource', 'completionPane', 'turnBaseline']) assert.ok(TURN_FIELDS.includes(field as never), `${field} left the family`);
  const others = new Set<string>([...INCARNATION_FIELDS, ...DELIVERY_FIELDS, ...AUTHORITY_FIELD_NAMES, ...REQUEST_FIELDS]);
  for (const field of TURN_FIELDS) {
    assert.ok(!others.has(field), `${field} has two owners`);
    assert.equal(LIFETIMES[field], 'child', `${field} outlives one run`);
  }
});

test('a turn number counts only in the pane that gave it, so a pane the child crossed into starts fresh (issue #271)', () => {
  const record = child();
  turnNumbered(record, 7, 'T1');
  assert.deepEqual([record.completionSeq, record.completionPane, record.lastBusyAt], [7, 'p1', 'T1']);
  assert.equal(seqHere(record), 7);
  runStarts(record, { paneId: 'p2', launchedAt: 'T2' });
  assert.equal(seqHere(record), undefined, 'herdr numbered turn 7 in p1, so p2 has finished no turn yet');
  turnNumbered(record, 1);
  assert.equal(seqHere(record), 1);
});

test('what the parent heard binds to its pane, and a crossing keeps a baseline until a turn there is told', () => {
  const record = child({ paneId: 'p2' } as Partial<ChildRecord>);
  turnTold(record, 'p2', { crossing: true, seq: undefined, baseline: { paneId: 'p2', seq: 3 } });
  assert.deepEqual([record.turnNotified, record.turnBaseline], [undefined, { paneId: 'p2', seq: 3 }]);
  turnTold(record, 'p2', { crossing: false, seq: 4, baseline: undefined });
  assert.deepEqual([record.turnNotified, record.turnBaseline], [{ paneId: 'p2', seq: 4 }, undefined]);
  turnTold(record, 'p2', { crossing: false, seq: undefined, baseline: undefined });
  assert.equal(record.turnNotified, undefined);
});

test('an adopted pane\'s finished turns are told at once, so the first event is the next turn', () => {
  assert.deepEqual(firstTurn({ at: 'T1', done: { paneId: 'p5', seq: 9 } }), { statusChangedAt: 'T1', lastBusyAt: 'T1', completionSeq: 9, turnNotified: { paneId: 'p5', seq: 9 } });
  assert.deepEqual(firstTurn({ at: 'T1', done: { paneId: 'p5', seq: undefined } }), { statusChangedAt: 'T1', lastBusyAt: 'T1' });
  const back = child({ paneId: 'p6' } as Partial<ChildRecord>);
  turnsAlreadyDone(back, 12);
  assert.deepEqual(back.turnNotified, { paneId: 'p6', seq: 12 });
});

test('a record holds a conversation file or the reason it has none, and a file of the session before stays only beside the reason', () => {
  const record = child();
  transcriptFound(record, { missing: 'not written yet' });
  assert.deepEqual([record.transcript, record.transcriptMissing], [undefined, 'not written yet']);
  transcriptFound(record, { path: '/tmp/a.jsonl' });
  assert.deepEqual([record.transcript, record.transcriptMissing], ['/tmp/a.jsonl', undefined]);
  transcriptFound(record, { missing: 'gone' });
  assert.deepEqual([record.transcript, record.transcriptMissing], ['/tmp/a.jsonl', undefined], 'the same session keeps its file');
  transcriptFound(record, { missing: 'new session' }, true);
  assert.deepEqual([record.transcript, record.transcriptMissing], ['/tmp/a.jsonl', 'new session']);
  transcriptLeft(record);
  assert.deepEqual([record.transcript, record.transcriptMissing], [undefined, undefined]);
});
