// Freeing a child, and a message between peers (issue #262). A parent frees a
// child: the child leaves the parent's registry for the parent's `freed`
// history, each side gets a peer entry that holds one token, the briefs go to
// the child's own record, and the child hears it in its session. From then on
// the parent hears nothing of the child's turns and takes none of its
// reports. Either one reaches the other with peer_send, which carries the
// pair's token to the daemon that holds the target's record.
//
// A child on another machine keeps the relay link its former parent's daemon
// holds, because that daemon is the only one that dials. Its own machine
// writes its record there (relay-free), and a message from it to its former
// parent waits in that machine's relay outbox, as a report did.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { acquired, refusal as authorityRefusal } from './authority.ts';
import { firstPlacement } from './placement.ts';
import { firstTurn } from './turn.ts';
import { withChildLock } from './child-lock.ts';
import { unreadBrief } from './brief-history.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { isMoving } from './move-plan.ts';
import { promptsDir } from './paths.ts';
import { addPeer, findPeer, newPeerToken, readPeerBook, sessionAddress, unknownPeer, verifyPeer, type PeerEntry } from './peers.ts';
import { localParentOf, writeReport } from './report.ts';
import { mutateParent, readParent } from './registry.ts';
import type { Inbox } from './send.ts';
import type { CallerIdentity, ChildBrief, ChildRecord, FreedChild, ParentRecord } from './types.ts';
import type { InboxMessage, RelayMessageAnswer } from '../daemon/protocol.ts';

export const FREE_TOOL = 'agent_free';
export const PEER_SEND_TOOL = 'peer_send';

/** What a parent's daemon asks the daemon on a far child's machine to record at a freeing. */
export interface RelayFreeAsk {
  parentId: string;
  childId: string;
  token: string;
  /** The former parent's address and name, which go in the freed child's book there. */
  by: string;
  byName: string;
  at: string;
  reason?: string;
}

export interface FreeHooks {
  inbox?: Inbox;
  /** Record the freeing on a far child's machine. Absent when the session holds no relay. */
  relayFree?: (host: string, ask: RelayFreeAsk) => Promise<void>;
  /** A message to a freed child on another machine, over the relay link. */
  relayPeer?: PeerHooks['relayPeer'];
  /** Drop what the parent's watcher holds for the child: its state and its unread events. */
  forget?: (childId: string) => void;
  log?: (message: string) => void;
}

/** The freed entry a name, id, pane or session names in a parent's history. */
export function freedEntry(record: Pick<ParentRecord, 'freed'> | undefined, target: string): FreedChild | undefined {
  return record?.freed?.find((entry) => entry.id === target || entry.name === target || entry.paneId === target || entry.session?.value === target);
}

/** What a parent hears when it names a child it freed as though it were still one. */
export function freedNotice(entry: FreedChild): string {
  return `${entry.name} was freed at ${entry.freedAt}: it is no longer this session's child but a peer at address ${entry.id}. Reach it with peer_send to ${entry.id}.`;
}

/** A session's name as its freed child reads it. */
function ownName(record: ParentRecord): string {
  const own = record.childId ? localParentOf(record.childId)?.child.name : undefined;
  return own ?? `${record.harness} session ${record.session}`;
}

/** Why a child cannot be freed now, or undefined. */
function refusal(child: ChildRecord): string | undefined {
  // Whether this parent may free the child at all is authority's to answer (issue #279).
  const refused = authorityRefusal(child, 'free');
  if (refused) return refused;
  if (child.exitedAt) return `${child.name} has exited, so there is no session for an address to reach. Resume it with agent_spawn and resume first.`;
  if (isMoving(child)) return `${child.name} is crossing to another machine. Free it once the crossing ends.`;
  if (child.restartRequestedAt) return `${child.name} has a restart pending. Free it once the restart ends.`;
  if (child.teleportRequest) return `${child.name} has a teleport pending. Free it once the teleport ends.`;
  if (child.retireRequestedAt) return `${child.name} asked to be retired, which its parent's daemon carries out once it exits. Freeing would leave that retirement with no owner.`;
  const brief = unreadBrief(child);
  if (brief) return `${child.name} has not read its brief (brief ${brief.n}, written at ${brief.at}), and nothing on its record shows it did: no report and no finished turn since. Freeing it now would leave a brief that nobody delivers. Free it once it has read the brief.`;
  return undefined;
}

/** The child in a registry a target names: its id, its name or its pane. */
function childNamed(record: ParentRecord, target: string): ChildRecord | undefined {
  return record.children.find((entry) => entry.id === target || entry.name === target || entry.paneId === target) ?? record.children.find((entry) => entry.agentName === target);
}

/**
 * Free one child of a parent session. Everything is checked before anything
 * is written, and a far child's machine records the freeing first, so a far
 * refusal leaves this side as it was.
 */
export async function freeChild(hooks: FreeHooks, parentId: string, caller: CallerIdentity, input: { child: string; reason?: string }): Promise<string> {
  const first = readParent(parentId);
  if (!first) throw new Error(`No Bellwether registry for ${parentId}.`);
  const known = freedEntry(first, input.child);
  if (known && !childNamed(first, input.child)) throw new Error(freedNotice(known));
  const target = childNamed(first, input.child);
  if (!target) throw new Error(`No child of this session matches "${input.child}". Call agent_list to see them.`);
  return withChildLock(
    target.id,
    `${target.name} (child ${target.id})`,
    'free',
    async () => {
      // Read again under the lock, so a resume, restart or move that ran first is seen.
      const record = readParent(parentId);
      const child = record ? childNamed(record, target.id) : undefined;
      if (!record || !child) throw new Error(`${target.name} left this session's registry before the freeing could take the lock.`);
      const why = refusal(child);
      if (why) throw new Error(why);
      const at = new Date().toISOString();
      const token = newPeerToken();
      const by = sessionAddress(record, caller.childId);
      const byName = ownName(record);
      const host = hostOf(child);
      const reason = input.reason?.trim() || undefined;

      // The child's own record, on its own machine.
      if (host === LOCAL_HOST) {
        addPeer({ address: child.id, name: child.name }, { address: by, name: byName, token, since: at, relation: 'former-parent', host: LOCAL_HOST, registryId: record.id }, { at, by, byName, ...(reason ? { reason } : {}), name: child.name, kind: child.kind, ...(child.cwd ? { cwd: child.cwd } : {}), ...(child.briefs?.length ? { briefs: child.briefs } : {}) });
      } else {
        if (!hooks.relayFree) throw new Error(`${child.name} runs on machine ${host}, and this session holds no relay link to record the freeing there.`);
        await hooks.relayFree(host, { parentId: record.id, childId: child.id, token, by, byName, at, ...(reason ? { reason } : {}) });
      }
      // The parent's entry for its former child.
      addPeer({ address: by, name: byName }, { address: child.id, name: child.name, token, since: at, relation: 'freed-child', host, kind: child.kind });
      // The child leaves the registry. Its history keeps who it was, and nothing of its briefs, events or reports.
      const entry: FreedChild = { id: child.id, name: child.name, kind: child.kind, harness: child.harness, host, ...(child.cwd ? { cwd: child.cwd } : {}), startedAt: child.startedAt, ...(child.session ? { session: child.session } : {}), paneId: child.paneId, freedAt: at, freedBy: by, ...(reason ? { reason } : {}) };
      mutateParent(record.id, (kept) => {
        kept.children = kept.children.filter((each) => each.id !== child.id);
        kept.freed = [...(kept.freed ?? []).filter((each) => each.id !== child.id), entry];
      });
      // A far child's brief is on its own machine: the copy here was the parent's.
      if (host !== LOCAL_HOST) removeBriefCopies(child.briefs);
      hooks.forget?.(child.id);
      hooks.log?.(`free: ${record.id} freed ${child.name} (${child.id})${host === LOCAL_HOST ? '' : ` on machine ${host}`}`);

      const lines = [
        `${child.name} is free: it left this session's registry and is now a peer at address ${child.id}. Its events no longer start your turns, its briefs went with it, and it reports to nobody.`,
        `Reach it with peer_send to ${child.id}. It reaches you at ${by}.`,
      ];
      const notice = `You were freed by ${byName} at ${at}${reason ? ` (${reason})` : ''}. You are no longer its child: it no longer hears your turns, holds your briefs or takes your reports, and parent_report is gone from your tools. You are a peer at address ${child.id}. Reach ${byName} with peer_send to ${by}, and it reaches you the same way.`;
      try {
        const told = await peerSend(hooks, { address: by, registryId: record.id, name: byName }, child.id, notice, 'Bellwether, for your former parent');
        lines.push(told.replace(/^Sent to [^:]+: /, 'It was told: '));
      } catch (error) {
        lines.push(`It was not told: ${(error as Error).message}`);
      }
      return lines.join('\n');
    },
    undefined,
    undefined,
    { action: 'freed' },
  );
}

/** Remove the parent's own copies of a far child's briefs, which sit under this machine's prompts directory. */
function removeBriefCopies(briefs: readonly ChildBrief[] | undefined): void {
  const dir = promptsDir();
  for (const brief of briefs ?? []) {
    if (!brief.file.startsWith(`${dir}/`)) continue;
    fs.rmSync(brief.file, { force: true });
  }
}

export interface PeerHooks {
  inbox?: Inbox;
  /** A message to a freed child on another machine, over the relay link, with the pair's token. */
  relayPeer?: (host: string, parentId: string, childId: string, message: InboxMessage, peer: { from: string; token: string }) => Promise<RelayMessageAnswer>;
}

/** Who sends a peer message: the sender's address, its registry id here, and its name. */
export interface PeerSelf {
  address: string;
  registryId: string;
  name: string;
}

/** A freed child's session, as the daemon's inbox addresses it. */
function sessionOf(entry: PeerEntry): ChildRecord {
  const at = new Date().toISOString();
  return { id: entry.address, name: entry.name, kind: entry.kind ?? 'claude', harness: entry.kind ?? 'claude', paneId: '', host: entry.host ?? LOCAL_HOST, ...acquired('spawn'), ...firstPlacement({ at }), lastStatus: 'idle', ...firstTurn({ at }), depth: 1 };
}

/**
 * Send a message to an address the sender's book holds. The daemon that holds
 * the target's record checks the pair's token: this one for a target on this
 * machine, the far one for a freed child there. A message to a former parent
 * on another machine goes through that machine's relay outbox instead, which
 * the daemon answers before this runs.
 */
export async function peerSend(hooks: PeerHooks, self: PeerSelf, to: string, text: string, from?: string): Promise<string> {
  const book = readPeerBook(self.address);
  const entry = findPeer(book, to);
  if (!book || !entry) throw new Error(unknownPeer(book, to));
  const id = `m-${crypto.randomBytes(4).toString('hex')}`;
  const at = new Date().toISOString();
  const message: InboxMessage = { id, from: from ?? `your peer ${self.name} (${self.address})`, text, at };
  if (entry.relation === 'freed-child') {
    let answer: RelayMessageAnswer;
    if ((entry.host ?? LOCAL_HOST) === LOCAL_HOST) {
      try {
        verifyPeer(entry.address, self.address, entry.token);
      } catch (error) {
        throw new Error(`${entry.name} did not get the message: ${(error as Error).message}. Nothing was sent.`);
      }
      if (!hooks.inbox) throw new Error(`No Bellwether daemon carries this call, so ${entry.name}'s session cannot be reached.`);
      answer = await hooks.inbox(self.registryId, sessionOf(entry), message);
    } else {
      if (!hooks.relayPeer) throw new Error(`${entry.name} runs on machine ${entry.host}, and this session holds no relay link to reach it.`);
      answer = await hooks.relayPeer(entry.host as string, self.registryId, entry.address, message, { from: self.address, token: entry.token });
    }
    // A peer's pane is not the sender's to type into, so a message the session did not take stops here.
    if (!answer.delivered) throw new Error(`${entry.name}'s session did not take the message: ${answer.reason}. Nothing was typed, because a peer's pane is not yours.`);
    if (answer.unanswered) return `Sent to ${entry.name}: pushed to ${entry.name}'s session as message ${id}, which ${answer.unanswered.replace(/^its session /, '')}. Nothing was typed.`;
    return `Sent to ${entry.name}: ${entry.name}'s session took it as message ${id}${answer.via && answer.via !== 'session' ? `, through ${answer.via}` : ''}.`;
  }
  // To a former parent on this machine: its daemon takes the message as an event for that session's next turn.
  if ((entry.host ?? '') !== LOCAL_HOST || !entry.registryId) throw new Error(`${entry.name} runs on another machine, and a message to it waits in this machine's relay outbox, which this call could not reach.`);
  try {
    verifyPeer(entry.address, self.address, entry.token);
  } catch (error) {
    throw new Error(`${entry.name} did not get the message: ${(error as Error).message}. Nothing was sent.`);
  }
  acceptPeerMessage(entry.registryId, { from: self.address, name: self.name, kind: readPeerBook(self.address)?.freed?.kind ?? 'agent', id }, text);
  return `Sent to ${entry.name} (${entry.address}) as message ${id}: it reaches that session as an event at its next turn.`;
}

/** Put a peer's message where a parent session's watcher reads it: the session's spool. */
export function acceptPeerMessage(registryId: string, peer: { from: string; name: string; kind: string; id: string }, text: string): void {
  writeReport({ parentId: registryId, childId: peer.from, childName: peer.name, status: 'progress', text, peer });
}
