// Tier 1: the incarnation family has one writer (issue #277). The fields that
// describe one run of a child in one pane are written only in
// src/core/incarnation.ts, through its transitions, so the five ways a child
// comes back clear the same fields by construction. These cases fail when any
// other file in src/ assigns or deletes one of those fields, copies a record
// with one of them changed, or builds a child record that names one. The
// typecheck holds the other half: ChildRecord declares each field readonly,
// so a write through any alias fails there, and this scan catches the casts
// and copies the typecheck lets through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'incarnation.ts');

/**
 * Writes to a field of the same name on an object that is not a child record.
 * Each is keyed by file and receiver. A child record under one of these names
 * still fails the typecheck, because the fields are readonly.
 */
const NOT_A_CHILD: Record<string, string> = {
  'src/cli.ts process': 'the process exit code',
  'src/core/remote.ts this': 'a remote herdr client names its machine',
  'src/integrations/claude/transcript.ts this': 'a transcript reader keeps the session and directory it reads',
  'src/daemon/client.ts (this.parent as { session: string })': 'a daemon client keeps the session it says hello for',
  'src/daemon/relay-links.ts link': 'a relay link that is closing',
  'src/daemon/protocol.ts caller': 'the identity an adapter sends with a call',
  'src/daemon/server.ts info': 'the parent session a hello describes',
  'src/core/session-state.ts result': 'what a machine answers about a session path',
  'src/core/resume.ts next.brief': 'the brief a resume hands over',
  'src/core/spawn.ts brief': 'a brief on the spawn record',
  'src/core/classifier.ts next': "the classifier's own state for a child",
  'src/daemon/server.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
  'src/daemon/service.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
  'src/core/restart.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
};

const { scanSource, scanAll, staleExemptions } = ownerScanner({ owner: OWNER, fields: INCARNATION_FIELDS, notMine: NOT_A_CHILD, literalTypes: ['ChildRecord'] });

test('the scan flags each way a module could write an incarnation field without the owner', () => {
  const rules = (source: string): string[] => scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('entry.exitedAt = at;'), ['write']);
  assert.deepEqual(rules('c.paneId = pane;'), ['write'], 'any name for the record');
  assert.deepEqual(rules('delete record.harnessEnded;'), ['write']);
  assert.deepEqual(rules('entry.harnessSeenAt ??= now;'), ['write']);
  assert.deepEqual(rules('(entry as { paneId: string }).paneId = pane;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("entry['awaitsResume'] = at;"), ['write']);
  assert.deepEqual(rules('Object.assign(entry, { tabId });'), ['assign']);
  assert.deepEqual(rules("Reflect.set(entry, 'closing', value);"), ['assign']);
  assert.deepEqual(rules('upsertChild(id, { ...entry, host: target });'), ['copy']);
  assert.deepEqual(rules('const view = { ...child, session };'), ['copy'], 'a shorthand key');
  assert.deepEqual(rules("const child: ChildRecord = { id, name, paneId: '', host };"), ['literal']);
});

test('the scan leaves reads, comparisons, destructuring and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (entry.paneId === pane) return;'), []);
  assert.deepEqual(rules('const { paneId, ...rest } = entry;'), []);
  assert.deepEqual(rules('// entry.exitedAt = at;'), [], 'a comment');
  assert.deepEqual(rules("log('entry.exitedAt = at');"), [], 'a string');
  assert.deepEqual(rules('await client.request({ paneId: child.paneId });'), [], 'a request that is no record copy');
  assert.deepEqual(rules('entry.exitedAt = at;', OWNER), []);
  assert.deepEqual(rules('process.exitCode = 1;', 'src/cli.ts'), [], 'a field of the same name elsewhere');
});

test('no file but src/core/incarnation.ts writes an incarnation field', () => {
  const findings = scanAll();
  assert.deepEqual(
    findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/incarnation.ts instead (issue #277). A field of the same name on another kind of object goes in NOT_A_CHILD with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(staleExemptions(), [], 'these no longer write an incarnation field, so remove their exemptions');
});

test('ChildRecord declares every incarnation field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.ok(body, 'ChildRecord was not found in src/core/types.ts');
  const loose = INCARNATION_FIELDS.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body));
  assert.deepEqual(loose, [], 'declare these fields readonly in ChildRecord');
});

test('the family covers the fields the design matrix names', () => {
  // docs/design-matrix.md, step 1. A field leaves the family only by a change to this list and the table.
  const named = ['paneId', 'tabId', 'host', 'cwd', 'session', 'lastStatus', 'startingUntil', 'exitedAt', 'exitCode', 'harnessEnded', 'harnessSeenAt', 'tabClosedAt', 'paneEnd', 'reportPending', 'resumedAt', 'restartFailed', 'crossingFailed', 'awaitsResume', 'closing', 'restartInDoubt'];
  assert.deepEqual(named.filter((field) => !INCARNATION_FIELDS.includes(field as never)), []);
  assert.ok(Object.keys(LIFETIMES).length > INCARNATION_FIELDS.length, 'the table lists every field of ChildRecord, owned or not');
});
