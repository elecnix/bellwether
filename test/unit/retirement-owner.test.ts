// Tier 1: the retirement family has one writer (step 5 of
// docs/design-matrix.md). The fields that say a child asked to be retired,
// how far the cleanup got and how it ended are written only in
// src/core/retire.ts, so the module that takes the proofs is the one that
// says what was removed. These cases fail on a write anywhere else, and on
// an intent that leaves out a worktree the child has on another machine,
// the cause of a retirement that claimed a removal it did not perform (#273).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';
import { REQUEST_FIELDS } from '../../src/core/requests.ts';
import { RETIREMENT_FIELDS, intentFor } from '../../src/core/retire.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'retire.ts');

/** Writes to a field of the same name on an object that is not a child record, each with its reason. */
const NOT_MINE: Record<string, string> = {
  'src/cli.ts entry': "the far machine's relay record, kept retired while reports for the parent's daemon still wait",
};

const SCANNER = ownerScanner({ owner: OWNER, fields: RETIREMENT_FIELDS, notMine: NOT_MINE, literalTypes: ['ChildRecord'] });

test('the scan flags each way a module could write a retirement field without the owner', () => {
  const rules = (source: string): string[] => SCANNER.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('record.retireIntent = original.retireIntent;'), ['write']);
  assert.deepEqual(rules('delete entry.retireStage;'), ['write']);
  assert.deepEqual(rules('entry.retireRequestedAt ??= now;'), ['write']);
  assert.deepEqual(rules('upsertChild(id, { ...child, retireOutcome: undefined });'), ['copy']);
});

test('no file but src/core/retire.ts writes a retirement field', () => {
  assert.deepEqual(
    SCANNER.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call src/core/retire.ts instead: keepRetirement, clearRetirement, or the request and reap paths. A field of the same name on another kind of object goes in NOT_MINE with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(SCANNER.staleExemptions(), []);
});

test('ChildRecord declares every retirement field readonly', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.deepEqual(RETIREMENT_FIELDS.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)), []);
});

test('no other family owns a retirement field', () => {
  for (const field of RETIREMENT_FIELDS) {
    assert.equal(LIFETIMES[field], 'child');
    assert.ok(!INCARNATION_FIELDS.includes(field as never) && !REQUEST_FIELDS.includes(field as never), `${field} has two owners`);
  }
});

test('#273: every intent names the worktrees the child has on other machines, whichever path wrote it', () => {
  // The stop path wrote an intent without `far`, so its outcome read removed while the worktree on Vandenberg stayed.
  const child = { id: 'c', name: 'pr-tele-live', host: 'local', cwd: '/w/here', paneId: 'w1:p1', departures: [{ host: 'box', cwd: '/w/there', verb: 'teleport', at: '2026-11-28T00:00:00.000Z' }] } as unknown as ChildRecord;
  const written = intentFor(child, { worktree: '/w/here', repo: '/w/.git', branch: 'pr/x', reason: 'stopped by its parent' });
  assert.deepEqual(written.far, [{ host: 'box', worktree: '/w/there' }]);
  const named = intentFor(child, { worktree: '/w/here', far: [] });
  assert.deepEqual(named.far, [], 'a path that judged the far places keeps its own list');
});
