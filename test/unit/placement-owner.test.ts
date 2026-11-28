// Tier 1: the placement family has one writer (step 6 of docs/design-matrix.md).
// The fields that say where a child's run sits, whether Bellwether made its
// workspace, when the record began and what herdr names the agent are written
// only in src/core/placement.ts, through its transitions. These cases fail
// when any other file in src/ assigns or deletes one of those fields, copies a
// record with one of them changed, or builds a child record that names one.
// The typecheck holds the other half: ChildRecord declares each field
// readonly, so a write through any alias fails there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AUTHORITY_FIELD_NAMES } from '../../src/core/authority.ts';
import { DELIVERY_FIELDS } from '../../src/core/delivery.ts';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';
import { PLACEMENT_FIELDS, firstPlacement, placementLost, restorePlacement, snapshotPlacement, tabLanded, workspaceSeen } from '../../src/core/placement.ts';
import { REQUEST_FIELDS } from '../../src/core/requests.ts';
import { TURN_FIELDS } from '../../src/core/turn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { ROOT, ownerScanner } from '../fixtures/field-owner.ts';

const OWNER = path.join('src', 'core', 'placement.ts');

/** Writes to a field of the same name on an object that is not a child record, each with its reason. */
const NOT_MINE: Record<string, string> = {
  'src/core/restart.ts parentRecord': 'a parent record keeps the workspace its own session runs in',
  'src/daemon/server.ts parentRecord': 'a parent record keeps the workspace its own session runs in',
};

const SCANNER = ownerScanner({ owner: OWNER, fields: PLACEMENT_FIELDS, notMine: NOT_MINE, literalTypes: ['ChildRecord'] });

function child(change: Partial<ChildRecord> = {}): ChildRecord {
  return { id: 'c1', name: 'example', kind: 'claude', harness: 'claude', paneId: 'p1', host: 'local', origin: 'spawn', startedAt: 'T0', lastStatus: 'idle', statusChangedAt: 'T0', lastBusyAt: 'T0', depth: 1, ...change } as ChildRecord;
}

test('the scan flags each way a module could write a placement field without the owner', () => {
  const rules = (source: string): string[] => SCANNER.scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('entry.workspaceId = tab.workspaceId;'), ['write']);
  assert.deepEqual(rules('delete moved.workspaceId;'), ['write']);
  assert.deepEqual(rules('if (opened.ownsWorkspace) entry.ownsWorkspace = true;'), ['write']);
  assert.deepEqual(rules('(entry as { agentName?: string }).agentName = name;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("entry['workspaceLabel'] = label;"), ['write']);
  assert.deepEqual(rules('Object.assign(entry, { ownsWorkspace: true });'), ['assign']);
  assert.deepEqual(rules('upsertChild(id, { ...child, workspaceId });'), ['copy']);
  assert.deepEqual(rules("const child: ChildRecord = { id, name, startedAt: now };"), ['literal']);
});

test('the scan leaves reads, the transitions and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => SCANNER.scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (child.ownsWorkspace && child.workspaceId) return;'), []);
  assert.deepEqual(rules('tabLanded(entry, opened);'), []);
  assert.deepEqual(rules('entry.workspaceId = id;', OWNER), []);
  assert.deepEqual(rules('parentRecord.workspaceId = workspace;', 'src/core/restart.ts'), [], 'a field of the same name on a parent record');
});

test('no file but src/core/placement.ts writes a placement field', () => {
  assert.deepEqual(
    SCANNER.scanAll().map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/placement.ts instead, such as firstPlacement, tabLanded, workspaceSeen or agentNamed. A field of the same name on another kind of object goes in NOT_MINE with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  assert.deepEqual(SCANNER.staleExemptions(), []);
});

test('ChildRecord declares every placement field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.ok(body, 'ChildRecord was not found in src/core/types.ts');
  assert.deepEqual(PLACEMENT_FIELDS.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body)), [], 'declare these fields readonly in ChildRecord');
});

test('the family covers the fields the design matrix names, and no other family owns them', () => {
  // docs/design-matrix.md, step 6.
  assert.deepEqual([...PLACEMENT_FIELDS].sort(), ['agentName', 'ownsWorkspace', 'startedAt', 'workspaceId', 'workspaceLabel']);
  const others = new Set<string>([...INCARNATION_FIELDS, ...DELIVERY_FIELDS, ...AUTHORITY_FIELD_NAMES, ...REQUEST_FIELDS, ...TURN_FIELDS]);
  for (const field of PLACEMENT_FIELDS) {
    assert.ok(!others.has(field), `${field} has two owners`);
    assert.equal(LIFETIMES[field], 'child', `${field} outlives one run`);
  }
});

test('a workspace a tab created is the child\'s to close, and it stays so while the child comes back to it', () => {
  const record = child();
  tabLanded(record, { workspaceId: 'w1', workspaceLabel: 'example', ownsWorkspace: true });
  assert.equal(record.ownsWorkspace, true);
  tabLanded(record, { workspaceId: 'w1', workspaceLabel: 'example' });
  assert.equal(record.ownsWorkspace, true, 'a restart into the same workspace keeps it');
  placementLost(record);
  assert.equal(record.workspaceId, undefined);
  assert.equal(record.ownsWorkspace, true, 'a move keeps the claim to a workspace of its own at the destination');
  assert.equal(record.workspaceLabel, 'example');
});

test('a workspace no tab of the child created is never the child\'s to close (issue #225)', () => {
  const landed = child({ ownsWorkspace: true, workspaceId: 'w1' } as Partial<ChildRecord>);
  tabLanded(landed, { workspaceId: 'w9' });
  assert.equal(landed.workspaceId, 'w9');
  assert.equal(landed.ownsWorkspace, undefined, 'a run in a workspace someone else made does not inherit the claim');

  const seen = child({ ownsWorkspace: true, workspaceId: 'w1' } as Partial<ChildRecord>);
  workspaceSeen(seen, 'w2');
  assert.equal(seen.ownsWorkspace, undefined, 'herdr shows the run elsewhere');

  const adopted = child({ ...firstPlacement({ at: 'T1', workspaceId: 'w3' }) });
  assert.equal(adopted.ownsWorkspace, undefined, 'an adoption never owns the pane\'s workspace');
  assert.equal(adopted.workspaceId, 'w3');

  const plain = child();
  tabLanded(plain, { workspaceId: 'w4' });
  assert.equal(plain.ownsWorkspace, undefined);
});

test('a resume that fails puts the placement back, field for field', () => {
  const record = child({ workspaceId: 'w1', workspaceLabel: 'old', ownsWorkspace: true } as Partial<ChildRecord>);
  const before = snapshotPlacement(record);
  tabLanded(record, { workspaceId: 'w2', workspaceLabel: 'new' });
  restorePlacement(record, before);
  assert.deepEqual([record.workspaceId, record.workspaceLabel, record.ownsWorkspace, record.startedAt], ['w1', 'old', true, 'T0']);
});
