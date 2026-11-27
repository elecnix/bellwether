// Who watches a pane on this machine. A parent here watches its children
// through this machine's registry. A parent on another machine that adopted a
// pane here leaves a claim in this machine's relay records, because its own
// registry sits on its own machine. Both count, so this machine's daemon is
// the one place that can answer for its panes, whichever machine asks.
import { LOCAL_HOST } from './machine.ts';
import { watcherOfPane } from './registry.ts';
import { RELAY_SCHEMA, listRelayRecords, removeRelayRecord, saveRelayRecord, type RelayRecord } from './relay-records.ts';

/** What a parent on another machine asks for when it adopts a pane here. */
export interface PaneClaim {
  parentId: string;
  /** The child id the parent will use when this machine has no claim of its own for it. */
  childId: string;
  name: string;
  kind: string;
  paneId: string;
  /** The harness session herdr reports in the pane, when it reports one. */
  session?: string;
}

/** Who holds a pane here: a parent on this machine, or a parent on another one through its claim. */
export type Claimant = { where: 'here'; parentId: string; childId: string; name: string } | { where: 'away'; record: RelayRecord };

/** The holder of a pane on this machine, if any. */
export function claimantOf(paneId: string): Claimant | undefined {
  const local = watcherOfPane(LOCAL_HOST, paneId);
  if (local) return { where: 'here', parentId: local.parent.id, childId: local.child.id, name: local.child.name };
  const record = listRelayRecords().find((entry) => entry.adopted && !entry.retiredAt && entry.paneId === paneId);
  return record ? { where: 'away', record } : undefined;
}

export type ClaimDecision = { kind: 'take' } | { kind: 'held'; childId: string } | { kind: 'refuse'; reason: string };

/**
 * Whether a parent may adopt a pane, given who holds it now. A claim whose
 * session differs from the one in the pane now is stale: herdr reused the
 * pane id for another agent after the first one ended without its parent
 * hearing, and the old claim no longer stands for anything.
 */
export function decideClaim(claim: Pick<PaneClaim, 'parentId' | 'paneId' | 'session'>, holder: Claimant | undefined): ClaimDecision {
  if (!holder) return { kind: 'take' };
  if (holder.where === 'here') {
    if (holder.parentId === claim.parentId) return { kind: 'held', childId: holder.childId };
    return { kind: 'refuse', reason: `pane ${claim.paneId} is already a child of ${holder.parentId}, a parent on that machine, as ${holder.name}` };
  }
  const record = holder.record;
  if (record.parentId === claim.parentId) return { kind: 'held', childId: record.childId };
  if (claim.session && record.session && claim.session !== record.session) return { kind: 'take' };
  return { kind: 'refuse', reason: `pane ${claim.paneId} is already a child of ${record.parentId}, a parent on another machine, as ${record.name}` };
}

/**
 * Answer a parent on another machine that adopts a pane here: record its
 * claim, or say who holds the pane. Returns the child id the claim stands
 * under, which is the parent's own one when it already held the pane.
 */
export function claimPane(claim: PaneClaim, now = new Date()): { childId: string; held: boolean } {
  const holder = claimantOf(claim.paneId);
  const decision = decideClaim(claim, holder);
  if (decision.kind === 'refuse') throw new Error(decision.reason);
  if (decision.kind === 'held') return { childId: decision.childId, held: true };
  // A stale claim goes, so the pane has one holder.
  if (holder?.where === 'away') removeRelayRecord(holder.record.childId);
  const record: RelayRecord = {
    schema: RELAY_SCHEMA,
    childId: claim.childId,
    name: claim.name,
    kind: claim.kind,
    parentId: claim.parentId,
    registeredAt: now.toISOString(),
    paneId: claim.paneId,
    adopted: true,
    ...(claim.session ? { session: claim.session } : {}),
  };
  saveRelayRecord(record);
  return { childId: claim.childId, held: false };
}
