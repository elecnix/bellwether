// Tier 1: the requests family has one writer (step 4 of docs/design-matrix.md).
// The fields that say someone asked for a restart, a teleport or a crossing,
// and that it has not finished, are written only in src/core/requests.ts,
// through its transitions, so no other module decides when a request is over.
// These cases fail on a write anywhere else. The typecheck holds the other
// half: ChildRecord, ParentRecord, RelayRecord, RestartWait and
// TeleportRequestRecord declare each owned field readonly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AUTHORITY_FIELD_NAMES } from '../../src/core/authority.ts';
import { DELIVERY_FIELDS } from '../../src/core/delivery.ts';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';
import { REQUEST_FIELDS } from '../../src/core/requests.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'requests.ts');

/** Writes to a field of the same name on an object that is not a record of the family, each with its reason. */
const NOT_MINE: Record<string, string> = {};

const SCANNER = ownerScanner({ owner: OWNER, fields: REQUEST_FIELDS, notMine: NOT_MINE, literalTypes: ['ChildRecord', 'ParentRecord', 'RelayRecord'] });

test('the scan flags each way a module could write a request field without the owner', () => {
  const rules = (source: string): string[] => SCANNER.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('entry.restartRequestedAt = at;'), ['write']);
  assert.deepEqual(rules('delete parentRecord.restartWait;'), ['write']);
  assert.deepEqual(rules('entry.teleportRequest = { at, machine };'), ['write']);
  assert.deepEqual(rules('(entry as { moving?: unknown }).moving = mark;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("record['retireRequest'] = kept;"), ['write']);
  assert.deepEqual(rules('Object.assign(entry, { restartStalled: stall });'), ['assign']);
  assert.deepEqual(rules('upsertChild(id, { ...child, moving: undefined });'), ['copy']);
  assert.deepEqual(rules('const child: ChildRecord = { id, name, restartedAt: at };'), ['literal']);
});

test('the scan leaves reads, the transitions and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => SCANNER.scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (child.restartRequestedAt && child.restartWait) return;'), []);
  assert.deepEqual(rules('restartStalled(entry, reason);'), []);
  assert.deepEqual(rules('entry.restartWait = wait;', OWNER), []);
});

test('no file but src/core/requests.ts writes a request field', () => {
  assert.deepEqual(
    SCANNER.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/requests.ts instead, such as restartRequested, restartStalled, teleportArmed or crossingEnded. A field of the same name on another kind of object goes in NOT_MINE with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(SCANNER.staleExemptions(), []);
});

test('the types declare every request field readonly, so the typecheck sees every alias', () => {
  const read = (file: string): string => fs.readFileSync(path.join(ROOT, 'src', 'core', file), 'utf8');
  const sources = read('types.ts') + read('relay-records.ts');
  const owned: Record<string, readonly string[]> = {
    ChildRecord: ['restartRequestedAt', 'restartRoute', 'restartWait', 'restartStalled', 'restartedAt', 'teleportRequest', 'teleportStalled', 'moving'],
    ParentRecord: ['restartRequestedAt', 'restartWait', 'restartStalled', 'restartedAt'],
    RelayRecord: ['retireRequest', 'teleportRequest'],
    RestartWait: ['until', 'paneId', 'status', 'statusSince', 'acting'],
    TeleportRequestRecord: ['at', 'machine', 'cwd', 'reason', 'wait'],
  };
  const loose: string[] = [];
  for (const [type, fields] of Object.entries(owned)) {
    const body = new RegExp(`export interface ${type} \\{([\\s\\S]*?)\\n\\}`).exec(sources)?.[1] ?? '';
    assert.ok(body, `${type} was not found`);
    for (const field of fields) if (!new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)) loose.push(`${type}.${field}`);
  }
  assert.deepEqual(loose, [], 'declare these fields readonly');
});

test('the family covers the fields the design matrix names, and no other family owns them', () => {
  // docs/design-matrix.md, step 4: teleportRequest, restartRequestedAt and moving, with every field that says a request has not finished.
  for (const field of ['teleportRequest', 'restartRequestedAt', 'moving', 'restartWait', 'restartStalled', 'teleportStalled']) assert.ok(REQUEST_FIELDS.includes(field as never), `${field} left the family`);
  const others = new Set<string>([...INCARNATION_FIELDS, ...DELIVERY_FIELDS, ...AUTHORITY_FIELD_NAMES]);
  for (const field of REQUEST_FIELDS) {
    assert.ok(!others.has(field), `${field} has two owners`);
    if (field in LIFETIMES) assert.equal(LIFETIMES[field as keyof typeof LIFETIMES], 'child', `${field} outlives one run: a request made in one run is answered in the next`);
  }
});
