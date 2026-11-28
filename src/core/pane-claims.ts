// Who watches a pane on this machine. A parent here watches its children
// through this machine's registry. A parent on another machine that adopted a
// pane here leaves a claim in this machine's relay records, because its own
// registry sits on its own machine. Both count, so this machine's daemon is
// the one place that can answer for its panes, whichever machine asks.
import { LOCAL_HOST } from './machine.ts';
import { watcherOfPane } from './registry.ts';
import { RELAY_SCHEMA, listRelayRecords, removeRelayRecord, saveRelayRecord, updateRelayRecord, type RelayRecord } from './relay-records.ts';

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
  // A child a parent there started holds its pane as an adopted one does (issue #244).
  const record = listRelayRecords().find((entry) => !entry.retiredAt && entry.paneId === paneId);
  return record ? { where: 'away', record } : undefined;
}

/**
 * Record the pane that a child a parent on another machine started says
 * hello from, so that this machine knows who watches the pane.
 * `relay-register` runs before the child's tab opens, so its record names no
 * pane until the child's own adapter connects here. Another started child's
 * record that still names the pane gives it up: herdr reused the pane id, so
 * the pane runs this child now. An adopted child's record is left alone,
 * because an adopted session's adapter says hello without a child id.
 */
export function notePaneOfChild(childId: string, paneId: string): void {
  const record = listRelayRecords().find((entry) => entry.childId === childId);
  if (!record || record.adopted || record.retiredAt) return;
  for (const other of listRelayRecords()) {
    if (other.childId !== childId && !other.adopted && other.paneId === paneId) {
      updateRelayRecord(other.childId, (entry) => {
        delete entry.paneId;
      });
    }
  }
  if (record.paneId !== paneId) {
    updateRelayRecord(childId, (entry) => {
      entry.paneId = paneId;
    });
  }
}

/** A machine's refusal of a claim, because someone else holds the pane there: not a lost connection. */
export class ClaimRefused extends Error {}

export type ClaimDecision = { kind: 'take' } | { kind: 'held'; childId: string } | { kind: 'refuse'; reason: string };

/**
 * Whether a parent may adopt a pane, given who holds it now. A claim whose
 * session differs from the one in the pane now is stale: herdr reused the
 * pane id for another agent after the first one ended without its parent
 * hearing, and the old claim no longer stands for anything, even to the
 * parent that made it.
 */
export function decideClaim(claim: Pick<PaneClaim, 'parentId' | 'paneId' | 'session'>, holder: Claimant | undefined): ClaimDecision {
  if (!holder) return { kind: 'take' };
  if (holder.where === 'here') {
    if (holder.parentId === claim.parentId) return { kind: 'held', childId: holder.childId };
    return { kind: 'refuse', reason: `pane ${claim.paneId} is already a child of ${holder.parentId}, a parent on that machine, as ${holder.name}` };
  }
  const record = holder.record;
  // A stale claim stays stale whoever made it. The same parent's claim for a
  // session that left the pane names a child that ended: handing its id back
  // would make one child id stand for two sessions (issue #244). A child that
  // a parent started carries its id in its own adapter, so a new session in
  // its pane, after a /clear, is still that child, and its record names no
  // session to compare.
  if (record.adopted && claim.session && record.session && claim.session !== record.session) return { kind: 'take' };
  if (record.parentId === claim.parentId) return { kind: 'held', childId: record.childId };
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
