// Tier 1: the authority family has one writer and one reader of `origin`
// (issue #279). The fields that say who may act on a child, `origin`,
// `adoptInDoubt`, `claimUnconfirmed`, `farRecordLost` and `replacedBy`, are written only in
// src/core/authority.ts, through its transitions. And `origin` is compared
// only there, because every comparison of it elsewhere was a policy decided
// on its own: the module answers each as a named question instead. These
// cases fail on a write or a comparison anywhere else. The typecheck holds
// the other half: ChildRecord declares each field readonly.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { AUTHORITY_FIELD_NAMES } from '../../src/core/authority.ts';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';
import fs from 'node:fs';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'authority.ts');

/** Fields of the same name on objects that are not child records, keyed by file and receiver. */
const NOT_A_CHILD: Record<string, string> = {
  'src/daemon/lock.ts record': "the daemon lock's record of how its daemon was installed",
  'src/daemon/lock.ts read': "the daemon lock's record of how its daemon was installed",
  'src/daemon/upgrade-status.ts input.lock': "the daemon lock's record of how its daemon was installed",
};

const SCANNER = ownerScanner({ owner: OWNER, fields: AUTHORITY_FIELD_NAMES, notMine: NOT_A_CHILD, literalTypes: ['ChildRecord'], compared: ['origin'] });

test('the scan flags each way a module could write an authority field, or compare origin, without the owner', () => {
  const rules = (source: string): string[] => SCANNER.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules("entry.origin = 'adopt';"), ['write']);
  assert.deepEqual(rules('delete entry.adoptInDoubt;'), ['write']);
  assert.deepEqual(rules('entry.replacedBy = id;'), ['write']);
  assert.deepEqual(rules('(entry as { farRecordLost?: unknown }).farRecordLost = lost;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("Object.assign(entry, { origin: 'spawn' });"), ['assign']);
  assert.deepEqual(rules('upsertChild(id, { ...child, adoptInDoubt: undefined });'), ['copy']);
  assert.deepEqual(rules("const child: ChildRecord = { id, name, origin: 'spawn' };"), ['literal']);
  assert.deepEqual(rules("if (child.origin === 'adopt') return;"), ['compare']);
  assert.deepEqual(rules("const adopted = 'adopt' !== entry.origin;"), ['compare'], 'the value first');
  assert.deepEqual(rules("return input?.origin == 'adopt';"), ['compare'], 'an optional chain');
});

test('the scan leaves reads, the transitions and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => SCANNER.scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('const why = refusal(child, "retire");'), []);
  assert.deepEqual(rules("const record: ChildRecord = { id, ...acquired('spawn') };"), [], 'a transition spread into a new record');
  assert.deepEqual(rules('if (child.farRecordLost) lines.push(line);'), [], 'a read that compares nothing');
  assert.deepEqual(rules("if (child.origin === 'adopt') return;", OWNER), []);
  assert.deepEqual(rules("if (record.origin === 'checkout') return;", 'src/daemon/lock.ts'), [], 'a field of the same name elsewhere');
});

test('no file but src/core/authority.ts writes an authority field or compares origin', () => {
  assert.deepEqual(
    SCANNER.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'ask src/core/authority.ts instead: mayAct-style refusal() for an act, a named question such as heldByAdoption for a policy, or a transition for a write (issue #279). A field of the same name on another kind of object goes in NOT_A_CHILD with the reason.',
  );
});

test('every exemption still names a write or comparison the scan would otherwise flag', () => {
  assert.deepEqual(SCANNER.staleExemptions(), [], 'these exemptions no longer name an authority write or an origin comparison, so remove them');
});

test('ChildRecord declares every authority field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.ok(body, 'ChildRecord was not found in src/core/types.ts');
  assert.deepEqual(AUTHORITY_FIELD_NAMES.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)), [], 'declare these fields readonly in ChildRecord');
});

test('the family covers the fields the design matrix names, and no other family owns them', () => {
  // docs/design-matrix.md, step 3, and claimUnconfirmed from issue #257, which answers the same question. A field leaves the family only by a change to this list and the module's table.
  assert.deepEqual([...AUTHORITY_FIELD_NAMES].sort(), ['adoptInDoubt', 'claimUnconfirmed', 'farRecordLost', 'origin', 'replacedBy']);
  for (const field of AUTHORITY_FIELD_NAMES) {
    assert.equal(LIFETIMES[field], 'child', `${field} describes the child across its runs, not one run`);
    assert.ok(!INCARNATION_FIELDS.includes(field as never), `${field} has two owners`);
  }
});
