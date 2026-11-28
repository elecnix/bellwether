// Who watches a pane on this machine. A parent here watches its children
// through this machine's registry. A parent on another machine that adopted a
// pane here leaves a claim in this machine's relay records, because its own
// registry sits on its own machine. Both count, so this machine's daemon is
// the one place that can answer for its panes, whichever machine asks.
import { AuthorityConflict, heldByAdoption, judgeHolders, type PaneHolder } from './authority.ts';
import { LOCAL_HOST } from './machine.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import { watchersOfPane } from './registry.ts';
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

/**
 * The panes that children started by parents on other machines say hello
 * from, by connection. A started child holds its pane while its own adapter
 * stays connected to this daemon from it, and no longer: its harness may end
 * and herdr may reuse the pane id while the parent's relay-cleanup fails, so
 * a pane written on its relay record could outlive the child. The map lives
 * in memory, because only a live connection proves the child still runs
 * there, and an adapter says hello again after every hand-over (issue #244).
 */
const startedPanes = new Map<object, { childId: string; paneId: string }>();

/** A child's adapter said hello from a pane, with the child id its start gave it. */
export function childSaidHello(connection: object, childId: string, paneId: string): void {
  startedPanes.set(connection, { childId, paneId });
}

/** A connection that said hello closed. */
export function childLeft(connection: object): void {
  startedPanes.delete(connection);
}

function registrySource(found: { parent: ParentRecord; child: ChildRecord }): PaneHolder {
  return { source: 'registry', parentId: found.parent.id, childId: found.child.id, name: found.child.name, ...(found.child.session ? { session: found.child.session.value } : {}) };
}

/**
 * The parent whose registry on this machine lists a live child in a pane on a
 * host. Two parents that both list it disagree, and this throws
 * AuthorityConflict with both named, because nothing here can tell which one
 * herdr's pane still belongs to (issue #279).
 */
export function registryHolderOf(host: string, paneId: string): { parent: ParentRecord; child: ChildRecord } | undefined {
  const found = watchersOfPane(host, paneId);
  if (found.length < 2) return found[0];
  const judged = judgeHolders(host, paneId, found.map(registrySource));
  if (judged.kind === 'contested') throw new AuthorityConflict(judged.reason, judged.holders);
  return found[0];
}

/**
 * The holder of a pane on this machine, if any, from every source that can
 * say: the registries of parents here, the claims parents on other machines
 * adopted it by, and the live connections of children those parents started
 * here. An adoption's claim for another session than the pane's holder runs
 * is stale and counts for nothing. A claim also yields to a child a parent
 * here started, whose pane Bellwether opened after any claim on its id, and
 * to a started child whose adapter is connected from the pane now (issue
 * #244), because that connection proves what runs there. Any other pair of holders disagrees,
 * and this throws AuthorityConflict with both named (issue #279).
 */
export function claimantOf(paneId: string): Claimant | undefined {
  const records = listRelayRecords().filter((entry) => !entry.retiredAt);
  // A child a parent on another machine started holds its pane as an adopted one does (issue #244).
  const live = new Set([...startedPanes.values()].filter((entry) => entry.paneId === paneId).map((entry) => entry.childId));
  const started = records.filter((entry) => !entry.adopted && live.has(entry.childId));
  const registry = watchersOfPane(LOCAL_HOST, paneId);
  // A pane a parent here started was opened by Bellwether after any claim on its id, so that claim is stale.
  const startedHere = registry.some((found) => !heldByAdoption(found.child));
  const adopted = started.length || startedHere ? [] : records.filter((entry) => entry.adopted && entry.paneId === paneId);
  const sources: PaneHolder[] = [
    ...registry.map(registrySource),
    ...[...started, ...adopted].map((record): PaneHolder => ({ source: 'claim', parentId: record.parentId, childId: record.childId, name: record.name, ...(record.adopted ? { adopted: true } : {}), ...(record.session ? { session: record.session } : {}) })),
  ];
  const judged = judgeHolders(LOCAL_HOST, paneId, sources);
  if (judged.kind === 'none') return undefined;
  if (judged.kind === 'contested') throw new AuthorityConflict(judged.reason, judged.holders);
  const holder = judged.holder;
  if (holder.source === 'registry') return { where: 'here', parentId: holder.parentId, childId: holder.childId, name: holder.name };
  const record = records.find((entry) => entry.childId === holder.childId && entry.parentId === holder.parentId);
  return record ? { where: 'away', record } : undefined;
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
  // a parent started holds its pane only while its adapter is connected from
  // it, and a new session there after a /clear is still that child.
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
