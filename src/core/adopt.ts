// Adopting a pane. An agent started by hand, or by a script such as
// herdr-spawn.sh, never passed through agent_spawn, so no parent watches it.
// agent_adopt registers it as a child of this parent, and the watcher picks it
// up on its next pass like any spawned child.
//
// The pane can sit on another machine. The parent reads it from that
// machine's herdr, as it reads a remote child it spawned, and asks that
// machine's daemon to record the adoption over the relay connection it holds.
// That daemon knows both its own parents and the claims of parents on other
// machines, so it decides whether someone already watches the pane.
import type { HerdrClient, HerdrPane } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { claimantOf, decideClaim, type PaneClaim } from './pane-claims.ts';
import { removeRelayRecord } from './relay-records.ts';
import { readParent, updateChild, upsertChild, watcherOfPane } from './registry.ts';
import { clearRetirement } from './retire.ts';
import { herdrLink } from './spawn.ts';
import { harnessFor } from './harnesses/index.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import { resolveInactiveMs } from './inactivity.ts';
import type { SessionReach } from './adopted-session.ts';

export interface AdoptOptions {
  /** A pane id, or the name of a live agent, on the host. */
  target: string;
  host?: string;
  /** The handle to use for the child. Defaults to the agent's herdr name. */
  name?: string;
  stuckMinutes?: number;
  /**
   * For a pane on another machine: ask that machine's daemon to record the
   * adoption, which refuses a pane someone there already watches.
   */
  claim?: (host: string, claim: PaneClaim) => Promise<{ childId: string; held: boolean; session?: SessionReach; messages?: boolean }>;
}

export interface AdoptResult {
  child: ChildRecord;
  link: string;
  /** True when this parent already watched the pane. */
  already: boolean;
  /** For a pane on another machine: how its session can report, as that machine's daemon answered. Absent when that daemon predates the answer. */
  session?: SessionReach;
  /** For a pane on another machine: whether the adapter connected there takes a parent's message. Absent when none is connected, or that daemon predates the answer. */
  messages?: boolean;
  /** True when the pane's harness resumed the session of a child this parent adopted before, which comes back under its own id (issue #191). */
  revived?: boolean;
  /** The pane that ran the revived child's session before, when it is another pane. */
  from?: string;
  /** The id of that earlier child, when the pane's machine holds the session under another id instead, which stands for it from now on. */
  replaced?: string;
}

/** The claim that records an adopted child's pane on its machine, under the child id the parent holds. */
export function adoptionClaim(parentId: string, child: Pick<ChildRecord, 'id' | 'name' | 'kind' | 'paneId' | 'session'>): PaneClaim {
  return { parentId, childId: child.id, name: child.name, kind: child.kind, paneId: child.paneId, ...(child.session ? { session: child.session.value } : {}) };
}

/**
 * The child this parent adopted before on the session a pane now runs: the
 * same child, which comes back under its id rather than a new one (issue
 * #191). A pane id alone is not enough, because herdr reuses it for another
 * agent, so the session has to match. The pane need not: a session resumed by
 * hand in another pane is still that child (issue #211, item 7). A record in
 * that pane wins, then an exited one, then one that still shows the session
 * live in another pane, which herdr has just contradicted.
 */
export function resumableAdoption(parent: Pick<ParentRecord, 'children'>, host: string, paneId: string, session: string | undefined): ChildRecord | undefined {
  if (!session) return undefined;
  const same = parent.children.filter((child) => child.origin === 'adopt' && !child.replacedBy && (child.host ?? LOCAL_HOST) === host && child.session?.value === session);
  return same.filter((child) => child.paneId === paneId && child.exitedAt).at(-1) ?? same.filter((child) => child.exitedAt).at(-1) ?? same.filter((child) => child.paneId !== paneId).at(-1);
}

/**
 * Bring an exited adopted child back, as its harness now runs in its pane
 * again. The turns the pane finished while nobody watched are not news, so
 * the next event is the end of the next turn, as at the adoption.
 */
export function backInPane(entry: ChildRecord, pane: Pick<HerdrPane, 'agentStatus' | 'completionSeq' | 'tabId' | 'workspaceId' | 'cwd'>, now = new Date().toISOString()): void {
  delete entry.exitedAt;
  delete entry.exitCode;
  delete entry.reportPending;
  delete entry.harnessEnded;
  delete entry.tabClosedAt;
  delete entry.awaitsResume;
  clearRetirement(entry);
  entry.lastStatus = pane.agentStatus;
  entry.statusChangedAt = now;
  entry.lastBusyAt = now;
  entry.harnessSeenAt = now;
  entry.resumedAt = now;
  if (pane.tabId) entry.tabId = pane.tabId;
  if (pane.workspaceId) entry.workspaceId = pane.workspaceId;
  if (pane.cwd) entry.cwd = pane.cwd;
  if (pane.completionSeq !== undefined) {
    entry.completionSeq = pane.completionSeq;
    entry.turnNotified = { paneId: entry.paneId, seq: pane.completionSeq };
  }
}

/** Where a pane sits, in the words an error uses. */
function place(host: string): string {
  return host === LOCAL_HOST ? 'local' : `machine ${host}`;
}

export async function adoptPane(client: HerdrClient, parent: ParentRecord, options: AdoptOptions, signal?: AbortSignal): Promise<AdoptResult> {
  const host = options.host ?? LOCAL_HOST;
  const agents = await client.agentList(signal);
  const byPane = agents.find((pane) => pane.paneId === options.target);
  const byName = agents.filter((pane) => pane.name === options.target);
  if (!byPane && byName.length > 1) throw new Error(`More than one live agent on ${place(host)} is named ${options.target}. Adopt it by pane id: ${byName.map((pane) => pane.paneId).join(', ')}.`);
  const pane = byPane ?? byName[0];
  if (!pane || !pane.agent) {
    const panes = await client.paneList(signal).catch(() => []);
    const bare = panes.find((entry) => entry.paneId === options.target);
    if (bare) throw new Error(`Pane ${options.target} on ${place(host)} holds no agent herdr recognizes, so there is nothing to adopt.`);
    throw new Error(`No pane or live agent on ${place(host)} matches ${options.target}.`);
  }
  const entry = harnessFor(pane.agent);
  if (!entry) throw new Error(`Pane ${pane.paneId} on ${place(host)} runs ${pane.agent}, which is not an agent kind Bellwether supervises.`);
  if (host === LOCAL_HOST && pane.paneId === parent.paneId) throw new Error('A session cannot adopt its own pane.');

  const owner = watcherOfPane(host, pane.paneId);
  if (owner && owner.parent.id === parent.id) return { child: owner.child, link: herdrLink('pane', pane.paneId), already: true };
  if (owner) throw new Error(`Pane ${pane.paneId} on ${place(host)} is already a child of ${owner.parent.id} as ${owner.child.name}, so this session cannot adopt it.`);

  // The pane's harness may have resumed the session of a child this parent adopted before.
  const earlier = resumableAdoption(parent, host, pane.paneId, pane.agentSessionId);
  const name = options.name ?? earlier?.name ?? pane.name ?? pane.label ?? pane.paneId;
  let id = earlier?.id ?? newChildId();
  let reach: SessionReach | undefined;
  let messages: boolean | undefined;
  if (host === LOCAL_HOST) {
    // A parent on another machine may have adopted this pane: its claim sits in this machine's relay records.
    const holder = claimantOf(pane.paneId);
    const decision = decideClaim({ parentId: parent.id, paneId: pane.paneId, session: pane.agentSessionId }, holder);
    if (decision.kind === 'refuse') throw new Error(`Pane ${pane.paneId} on local cannot be adopted: ${decision.reason}.`);
    // A far claim whose session left the pane goes, as claimPane removes one,
    // so the pane's session answers to one parent (issue #211, item 6).
    if (decision.kind === 'take' && holder?.where === 'away') removeRelayRecord(holder.record.childId);
  } else {
    if (!options.claim) throw new Error(`This session holds no relay connection to machine ${host}, so it cannot ask that machine who watches pane ${pane.paneId}.`);
    let answer: { childId: string; held: boolean; session?: SessionReach; messages?: boolean };
    try {
      answer = await options.claim(host, { parentId: parent.id, childId: id, name, kind: pane.agent, paneId: pane.paneId, ...(pane.agentSessionId ? { session: pane.agentSessionId } : {}) });
    } catch (error) {
      throw new Error(`Pane ${pane.paneId} on machine ${host} cannot be adopted: ${(error as Error).message}.`.replace(/\.\.$/, '.'));
    }
    // The far daemon already held this pane for this parent, from an adoption whose record this machine lost: keep its child id.
    id = answer.childId;
    reach = answer.session;
    messages = answer.messages;
  }

  const now = new Date().toISOString();
  const extra = { ...(reach ? { session: reach } : {}), ...(messages === undefined ? {} : { messages }) };
  if (earlier && id === earlier.id) {
    const from = earlier.paneId !== pane.paneId ? earlier.paneId : undefined;
    updateChild(parent.id, earlier.id, (entry) => {
      // The session runs in this pane now, wherever it ran before.
      entry.paneId = pane.paneId;
      backInPane(entry, pane, now);
      entry.name = name;
    });
    const child = readParent(parent.id)?.children.find((entry) => entry.id === earlier.id) ?? earlier;
    return { child, link: herdrLink('pane', child.paneId), already: false, revived: true, ...(from ? { from } : {}), ...extra };
  }
  // The pane's machine holds the session under an id of its own, which stands for it from now on.
  const replaced = earlier?.id;
  if (replaced) {
    updateChild(parent.id, replaced, (entry) => {
      entry.replacedBy = id;
      delete entry.awaitsResume;
    });
  }
  const kind = pane.agent;
  const harness = entry.harness;
  // A remote child's transcript sits on its own machine's disk.
  const found = host === LOCAL_HOST ? entry.conversation.locate(pane.agentSessionId, pane.cwd) : undefined;
  const child: ChildRecord = {
    id,
    name,
    kind,
    harness,
    paneId: pane.paneId,
    tabId: pane.tabId,
    workspaceId: pane.workspaceId,
    host,
    origin: 'adopt',
    cwd: pane.cwd,
    startedAt: now,
    lastStatus: pane.agentStatus,
    statusChangedAt: now,
    completionSeq: pane.completionSeq,
    // The turns the pane finished before this parent adopted it are not news.
    // The first event is the end of the next turn, as for a spawned child.
    ...(pane.completionSeq === undefined ? {} : { turnNotified: { paneId: pane.paneId, seq: pane.completionSeq } }),
    session: pane.agentSessionId ? { kind: pane.agentSessionId.includes('/') ? 'path' : 'id', value: pane.agentSessionId } : undefined,
    transcript: found?.path,
    transcriptMissing: found?.missing,
    lastBusyAt: now,
    depth: parent.depth + 1,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
    inactiveMs: resolveInactiveMs(undefined),
  };
  upsertChild(parent.id, child);
  return { child, link: herdrLink('pane', child.paneId), already: false, ...extra, ...(replaced ? { replaced } : {}) };
}
