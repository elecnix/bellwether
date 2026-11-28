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
import { ClaimRefused, claimantOf, decideClaim, type PaneClaim } from './pane-claims.ts';
import { RelayAnswerLost } from './relay-answer.ts';
import { removeRelayRecord } from './relay-records.ts';
import { readParent, updateChild, upsertChild, watcherOfPane } from './registry.ts';
import { clearRetirement } from './retire.ts';
import { herdrLink } from './spawn.ts';
import { harnessFor } from './harnesses/index.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import { resolveInactiveMs } from './inactivity.ts';
import type { SessionReach } from './adopted-session.ts';
import { firstRun, runStarts, stopAwaiting } from './incarnation.ts';

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
  /** For a pane on another machine: the relay lost that machine's answer, so whether it recorded the claim is unknown, and why. */
  inDoubt?: string;
  /** The id of that earlier child, when the pane's machine holds the session under another id instead, which stands for it from now on. */
  replaced?: string;
  /** For a pane this parent already held on another machine: that machine had lost the claim, and holds it again (issue #219). */
  restored?: boolean;
  /** For a pane this parent already held on another machine: why that machine could not confirm the claim. */
  unconfirmed?: string;
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
 * live in another pane, which herdr has just contradicted. It reads how the
 * child first came to this parent, not how the parent holds it now: a child a
 * resume brought back is still the child this parent adopted on that session
 * (issue #256).
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
export function backInPane(entry: ChildRecord, pane: Pick<HerdrPane, 'paneId' | 'agentStatus' | 'completionSeq' | 'tabId' | 'workspaceId' | 'cwd'>, now = new Date().toISOString()): void {
  // Every field of the run before goes. herdr sees the harness run now, so
  // the start-window check has nothing left to find.
  runStarts(entry, { paneId: pane.paneId, ...(pane.tabId ? { tabId: pane.tabId } : {}), ...(pane.cwd ? { cwd: pane.cwd } : {}), status: pane.agentStatus, resumedAt: now, seenAt: now });
  clearRetirement(entry);
  // The process in the pane is not one Bellwether started, so runStarts, given no
  // launchedAt, leaves the parent holding the child by adoption again (issue #256).
  entry.statusChangedAt = now;
  entry.lastBusyAt = now;
  if (pane.workspaceId) entry.workspaceId = pane.workspaceId;
  if (pane.completionSeq !== undefined) {
    entry.completionSeq = pane.completionSeq;
    entry.turnNotified = { paneId: entry.paneId, seq: pane.completionSeq };
  }
}

/**
 * A pane this parent already holds. On another machine, the claim there is
 * the same fact stored twice, and that machine may have lost it, as after a
 * reboot: ask it again, so both records agree (issue #219).
 */
async function confirmHeld(parentId: string, child: ChildRecord, host: string, claim: AdoptOptions['claim']): Promise<AdoptResult> {
  const held: AdoptResult = { child, link: herdrLink('pane', child.paneId), already: true };
  if (host === LOCAL_HOST || !claim) return held;
  let answer: Awaited<ReturnType<NonNullable<AdoptOptions['claim']>>>;
  try {
    answer = await claim(host, adoptionClaim(parentId, child));
  } catch (error) {
    const why = (error as Error).message.replace(/\.$/, '');
    if (!(error instanceof ClaimRefused)) return { ...held, unconfirmed: why };
    updateChild(parentId, child.id, (entry) => {
      entry.farRecordLost = { at: entry.farRecordLost?.at ?? new Date().toISOString(), host, reason: why };
    });
    throw new Error(`Pane ${child.paneId} on machine ${host} is a child of this session as ${child.name}, but machine ${host} holds no record of that and refuses to take the claim back: ${why}.`);
  }
  if (answer.childId !== child.id) throw new Error(`Pane ${child.paneId} on machine ${host} is a child of this session as ${child.id}, but machine ${host} holds it for this session as child ${answer.childId}.`);
  if (child.farRecordLost || child.adoptInDoubt) {
    updateChild(parentId, child.id, (entry) => {
      delete entry.farRecordLost;
      delete entry.adoptInDoubt;
    });
  }
  const current = readParent(parentId)?.children.find((entry) => entry.id === child.id) ?? child;
  return { ...held, child: current, ...(answer.held ? {} : { restored: true }), ...(answer.session ? { session: answer.session } : {}), ...(answer.messages === undefined ? {} : { messages: answer.messages }) };
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
  if (owner && owner.parent.id === parent.id) return confirmHeld(parent.id, owner.child, host, options.claim);
  if (owner) throw new Error(`Pane ${pane.paneId} on ${place(host)} is already a child of ${owner.parent.id} as ${owner.child.name}, so this session cannot adopt it.`);

  // The pane's harness may have resumed the session of a child this parent adopted before.
  const earlier = resumableAdoption(parent, host, pane.paneId, pane.agentSessionId);
  const name = options.name ?? earlier?.name ?? pane.name ?? pane.label ?? pane.paneId;
  let id = earlier?.id ?? newChildId();
  let reach: SessionReach | undefined;
  let messages: boolean | undefined;
  let inDoubt: string | undefined;
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
    let answer: { childId: string; held: boolean; session?: SessionReach; messages?: boolean } | undefined;
    try {
      answer = await options.claim(host, { parentId: parent.id, childId: id, name, kind: pane.agent, paneId: pane.paneId, ...(pane.agentSessionId ? { session: pane.agentSessionId } : {}) });
    } catch (error) {
      // The request went out and its answer did not come back, so that machine
      // may have saved the claim. A record here keeps that claim from routing
      // the session's reports to a parent with no child, and the watcher asks
      // again to learn which it was (issue #211, item 6).
      if (!(error instanceof RelayAnswerLost)) throw new Error(`Pane ${pane.paneId} on machine ${host} cannot be adopted: ${(error as Error).message}.`.replace(/\.\.$/, '.'));
      inDoubt = error.message.trim().replace(/\.$/, '');
    }
    if (answer) {
      // The far daemon already held this pane for this parent, from an adoption whose record this machine lost: keep its child id.
      id = answer.childId;
      reach = answer.session;
      messages = answer.messages;
    }
  }
  const doubt = inDoubt ? { at: new Date().toISOString(), host, reason: inDoubt } : undefined;
  const doubtful = inDoubt ? { inDoubt } : {};

  const now = new Date().toISOString();
  const extra = { ...(reach ? { session: reach } : {}), ...(messages === undefined ? {} : { messages }) };
  if (earlier && id === earlier.id) {
    const from = earlier.paneId !== pane.paneId ? earlier.paneId : undefined;
    updateChild(parent.id, earlier.id, (entry) => {
      // The session runs in this pane now, wherever it ran before.
      backInPane(entry, pane, now);
      entry.name = name;
      if (doubt) entry.adoptInDoubt = doubt;
    });
    const child = readParent(parent.id)?.children.find((entry) => entry.id === earlier.id) ?? earlier;
    return { child, link: herdrLink('pane', child.paneId), already: false, revived: true, ...(from ? { from } : {}), ...extra, ...doubtful };
  }
  // The pane's machine holds the session under an id of its own, which stands for it from now on.
  const replaced = earlier?.id;
  if (replaced) {
    updateChild(parent.id, replaced, (entry) => {
      entry.replacedBy = id;
      stopAwaiting(entry);
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
    ...firstRun({ paneId: pane.paneId, tabId: pane.tabId, host, cwd: pane.cwd, session: pane.agentSessionId ? { kind: pane.agentSessionId.includes('/') ? 'path' : 'id', value: pane.agentSessionId } : undefined, status: pane.agentStatus }),
    workspaceId: pane.workspaceId,
    origin: 'adopt',
    startedAt: now,
    statusChangedAt: now,
    completionSeq: pane.completionSeq,
    // The turns the pane finished before this parent adopted it are not news.
    // The first event is the end of the next turn, as for a spawned child.
    ...(pane.completionSeq === undefined ? {} : { turnNotified: { paneId: pane.paneId, seq: pane.completionSeq } }),
    transcript: found?.path,
    transcriptMissing: found?.missing,
    lastBusyAt: now,
    depth: parent.depth + 1,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
    inactiveMs: resolveInactiveMs(undefined),
    ...(doubt ? { adoptInDoubt: doubt } : {}),
  };
  upsertChild(parent.id, child);
  return { child, link: herdrLink('pane', child.paneId), already: false, ...extra, ...(replaced ? { replaced } : {}), ...doubtful };
}
