// Tier 1: who holds a pane on this machine, against a scratch home (issue
// #279). A pane has three sources that can name its holder: the registries of
// parents here, the claims of parents on other machines, and the live
// connections of children those parents started. Before this change,
// claimantOf took the first registry that named the pane and never looked
// at the claims, so two parents could each believe they held one pane. Two
// holders that disagree now throw AuthorityConflict, naming both, and every
// caller refuses: an adoption here, a far parent's adoption, and the hello of
// a session in that pane. A stale claim still yields, as it always has.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorityConflict, acquired } from '../../src/core/authority.ts';
import { adoptedParentOf } from '../../src/core/adopted-session.ts';
import { firstRun } from '../../src/core/incarnation.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { claimPane, claimantOf, registryHolderOf } from '../../src/core/pane-claims.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, removeRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord, ParentRecord } from '../../src/core/types.ts';

const AT = '2026-11-28T08:00:00.000Z';

function childIn(id: string, origin: 'spawn' | 'adopt', session: string, pane: string): ChildRecord {
  return {
    id,
    name: `worker-${id}`,
    kind: 'claude',
    harness: 'claude-code',
    ...firstRun({ paneId: pane, host: LOCAL_HOST, cwd: '/work', session: { kind: 'id', value: session }, status: 'idle' }),
    ...acquired(origin),
    startedAt: AT,
    statusChangedAt: AT,
    lastBusyAt: AT,
    depth: 1,
  };
}

function parentWith(session: string, child: ChildRecord): ParentRecord {
  const parent = emptyParent('claude-code', session, '/work');
  parent.children.push(child);
  return saveParent(parent);
}

function farClaim(childId: string, parentId: string, session: string, pane: string): void {
  saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: 'far-held', kind: 'claude', parentId, registeredAt: AT, paneId: pane, adopted: true, session });
}

function conflictOf(act: () => unknown): AuthorityConflict {
  try {
    act();
  } catch (error) {
    if (error instanceof AuthorityConflict) return error;
    throw error;
  }
  return assert.fail('expected an AuthorityConflict, and the call chose a holder');
}

test('a pane adopted here and claimed by a far parent on the same session is held by neither, and each caller names both', (t) => {
  const PANE = 'w1:p71';
  const parent = parentWith('S-parent-a', childIn('c-here', 'adopt', 'S-pane', PANE));
  farClaim('c-far', 'pi-far-parent', 'S-pane', PANE);
  t.after(() => removeRelayRecord('c-far'));

  const conflict = conflictOf(() => claimantOf(PANE));
  assert.match(conflict.message, new RegExp(`^Pane ${PANE} on this machine is held by two sources of authority that disagree: the registry of parent ${parent.id} on this machine, as child c-here \\(worker-c-here\\) on session S-pane, and the adoption claim of parent pi-far-parent on another machine, as child c-far \\(far-held\\) on session S-pane\\. Bellwether does not pick one\\.$`));
  assert.deepEqual(conflict.holders.map((holder) => holder.parentId).sort(), [parent.id, 'pi-far-parent'].sort());

  // A third parent elsewhere that asks for the pane is refused with the same reason, so the far daemon records the conflict.
  assert.throws(() => claimPane({ parentId: 'pi-third', childId: 'c-third', name: 'third', kind: 'claude', paneId: PANE, session: 'S-pane' }), AuthorityConflict);
  // The session in that pane answers to no parent: its report goes to neither.
  assert.equal(adoptedParentOf({ paneId: PANE, session: 'S-pane' }), undefined);
});

test("a far adoption's claim for a session the pane no longer runs is stale, and the parent here holds the pane", (t) => {
  const PANE = 'w1:p72';
  const parent = parentWith('S-parent-b', childIn('c-here', 'adopt', 'S-now', PANE));
  farClaim('c-far', 'pi-far-parent', 'S-before', PANE);
  t.after(() => removeRelayRecord('c-far'));
  assert.deepEqual(claimantOf(PANE), { where: 'here', parentId: parent.id, childId: 'c-here', name: 'worker-c-here' });
});

test('a far claim on a pane a parent here started yields, because Bellwether opened that pane after the claim', (t) => {
  const PANE = 'w1:p73';
  const parent = parentWith('S-parent-c', childIn('c-here', 'spawn', 'S-same', PANE));
  farClaim('c-far', 'pi-far-parent', 'S-same', PANE);
  t.after(() => removeRelayRecord('c-far'));
  assert.deepEqual(claimantOf(PANE), { where: 'here', parentId: parent.id, childId: 'c-here', name: 'worker-c-here' });
});

test('two parents here whose registries both list one live pane disagree, and the reason names both', () => {
  const PANE = 'w1:p74';
  const first = parentWith('S-parent-d', childIn('c-one', 'adopt', 'S-1', PANE));
  const second = parentWith('S-parent-e', childIn('c-two', 'adopt', 'S-2', PANE));
  const conflict = conflictOf(() => registryHolderOf(LOCAL_HOST, PANE));
  assert.match(conflict.message, new RegExp(`the registry of parent ${first.id} on this machine, as child c-one`));
  assert.match(conflict.message, new RegExp(`the registry of parent ${second.id} on this machine, as child c-two`));
  assert.match(conflictOf(() => claimantOf(PANE)).message, /Bellwether does not pick one\.$/);
});
