// Depth: how many generations deep a Bellwether tree may grow, and how a child
// that reaches its ceiling asks for more, up the chain.
//
// Each child record holds its ceiling, `maxDepth`: the deepest generation its
// own descendants may sit at. A child at depth d spawns only while d + 1 is at
// most its ceiling. The tree's true ceiling sits on the record of the session
// that started the tree, the one at depth 0. A grant raises one child's ceiling
// to its depth plus the levels granted, never past the granter's own ceiling
// and never past the tree's. A granter without the room forwards the request
// to its own parent, and the answer settles the whole chain on the way back.
import crypto from 'node:crypto';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { readRelayRecord } from './relay-records.ts';
import { childOfCaller, localParentOf, writeReport } from './report.ts';
import { readParent, updateChild } from './registry.ts';
import type { CallerIdentity, ChildRecord, DepthRequest, ParentRecord } from './types.ts';

/** How deep a tree grows when nobody said otherwise. */
export const DEFAULT_MAX_DEPTH = 2;

export const REQUEST_DEPTH_TOOL = 'agent_request_depth';
export const GRANT_DEPTH_TOOL = 'agent_grant_depth';

/** The two ways forward when no grant comes: the sentence that makes a refusal useful. */
export const ALTERNATIVES = 'Carry on at the depth you have: do the work with fewer children, or ask the person through parent_report with needs-input.';

export function newDepthRequestId(): string {
  return `dq-${crypto.randomBytes(6).toString('hex')}`;
}

/** A child's ceiling. A record from before ceilings were kept has the default. */
export function ceilingOf(child: Pick<ChildRecord, 'maxDepth'>): number {
  return child.maxDepth ?? DEFAULT_MAX_DEPTH;
}

/**
 * The child record a session is in its own parent's registry, when this
 * machine holds that registry: by the child id its hello carried, or by the
 * caller's identity.
 */
export function ownChildRecord(session: ParentRecord, caller: CallerIdentity = {}): { parent: ParentRecord; child: ChildRecord } | undefined {
  const id = session.childId ?? caller.childId;
  if (id) {
    const found = localParentOf(id);
    if (found) return found;
  }
  if (session.depth === 0) return undefined;
  return caller.paneId || caller.childId ? childOfCaller(caller) : undefined;
}

/**
 * The tree a session sits in, as far as this machine can see: the depth-0
 * session at the top and its ceiling, or, when an ancestor's registry lives
 * on another machine, nothing.
 */
export function treeOf(session: ParentRecord, caller: CallerIdentity = {}): { root: ParentRecord; ceiling: number } | undefined {
  let current: ParentRecord = session;
  let identity = caller;
  for (let hops = 0; hops < 64; hops += 1) {
    if (current.depth === 0) return { root: current, ceiling: current.maxDepth ?? DEFAULT_MAX_DEPTH };
    const up = ownChildRecord(current, identity);
    if (!up) return undefined;
    current = up.parent;
    identity = {};
  }
  return undefined;
}

/**
 * How deep a session's descendants may go: the tree's ceiling for the depth-0
 * session, its own child record's ceiling for any other, and, for a child
 * whose parent's registry is on another machine, the ceiling its spawn put in
 * its environment.
 */
export function sessionCeiling(session: ParentRecord, caller: CallerIdentity = {}): number {
  if (session.depth === 0) return session.maxDepth ?? DEFAULT_MAX_DEPTH;
  const own = ownChildRecord(session, caller);
  if (own) return ceilingOf(own.child);
  return session.maxDepth ?? DEFAULT_MAX_DEPTH;
}

/** What a spawn may give its child, and what to say when it gives less than was asked. */
export function childCeiling(session: ParentRecord, asked: number | undefined, caller: CallerIdentity = {}): { ceiling: number; spawnerCeiling: number; note?: string } {
  if (session.depth === 0) {
    // The depth-0 session gives the tree its ceiling: max_depth on its spawn sets it.
    const ceiling = asked ?? DEFAULT_MAX_DEPTH;
    return { ceiling, spawnerCeiling: ceiling };
  }
  const own = sessionCeiling(session, caller);
  if (asked === undefined) return { ceiling: own, spawnerCeiling: own };
  if (asked <= own) return { ceiling: asked, spawnerCeiling: own };
  return { ceiling: own, spawnerCeiling: own, note: `max_depth ${asked} is past this session's own ceiling of ${own}, so the child got ${own}. Ask for more with ${REQUEST_DEPTH_TOOL}.` };
}

/** The sentence a spawn that would go too deep fails with. */
export function tooDeep(session: ParentRecord, ceiling: number, name: string): string {
  const base = `Bellwether is ${ceiling} level${ceiling === 1 ? '' : 's'} deep already, so ${name} would go one level too far.`;
  if (session.depth === 0) return `${base} Raise max_depth on the spawn if that is what you want.`;
  return `${base} Ask your parent for more with ${REQUEST_DEPTH_TOOL}, naming the work that needs it. ${ALTERNATIVES}`;
}

/** Raise the tree's ceiling to what a depth-0 spawn asked, never lower it. */
export function raiseTree(record: ParentRecord, asked: number | undefined): number | undefined {
  if (record.depth !== 0) return undefined;
  const now = record.maxDepth ?? DEFAULT_MAX_DEPTH;
  const next = Math.max(now, asked ?? DEFAULT_MAX_DEPTH);
  return next === record.maxDepth ? undefined : next;
}

/** Who a session is, for a grant's audit line and the messages a child reads. */
function sessionLabel(session: ParentRecord, caller: CallerIdentity = {}): string {
  const own = ownChildRecord(session, caller);
  if (own) return own.child.name;
  return session.depth === 0 ? `the depth-0 session ${session.id}` : `session ${session.id}`;
}

function plural(levels: number): string {
  return levels === 1 ? '1 level' : `${levels} levels`;
}

/** The refusal a request gets when it would take the tree past the ceiling it was given. */
function treeRefusal(tree: { root: ParentRecord; ceiling: number }, wanted: number): string {
  return `This tree was given a ceiling of depth ${tree.ceiling} by its depth-0 session ${tree.root.id}, and depth ${wanted} is past it, so nobody in the tree can grant it. Only the person can change that, by having the depth-0 session spawn with a higher max_depth. ${ALTERNATIVES}`;
}

/** How a grant reaches a child. The tool layer prompts the child's pane through herdr's agent.prompt. */
export type Tell = (child: ChildRecord, text: string) => Promise<void>;

/**
 * agent_request_depth: record the request on the caller's child record, and
 * put it in the parent's spool, where it arrives as a report. It never waits.
 */
export function requestDepth(caller: CallerIdentity, levels: number, reason: string): string {
  if (!Number.isInteger(levels) || levels < 1) throw new Error(`${REQUEST_DEPTH_TOOL} needs levels, a whole number of 1 or more.`);
  if (!reason.trim()) throw new Error(`${REQUEST_DEPTH_TOOL} needs a reason: one sentence naming the work that needs the levels.`);
  const found = childOfCaller(caller);
  if (!found) {
    if (caller.childId && readRelayRecord(caller.childId)) {
      return `Your parent runs on another machine, and a depth request does not cross machines, so nothing was asked. ${ALTERNATIVES}`;
    }
    return `This session is the depth-0 session of its tree, or a session no Bellwether parent started, so it has no parent to ask. The depth-0 session sets the tree's ceiling itself, with max_depth on agent_spawn.`;
  }
  const { parent, child } = found;
  const wanted = child.depth + levels;
  const ceiling = ceilingOf(child);
  if (wanted <= ceiling) return `You may already spawn down to depth ${ceiling}, which covers depth ${wanted}. Nothing was asked.`;
  const request: DepthRequest = { id: newDepthRequestId(), levels, ceiling: wanted, reason: oneLine(reason), at: new Date().toISOString(), state: 'pending' };
  const tree = treeOf(parent);
  if (tree && wanted > tree.ceiling) {
    const refusal = treeRefusal(tree, wanted);
    updateChild(parent.id, child.id, (entry) => {
      entry.depthRequests = [...(entry.depthRequests ?? []), { ...request, state: 'refused', decidedAt: request.at, decidedBy: 'the tree ceiling', refusal }];
    });
    return `Request ${request.id} refused at once. ${refusal}`;
  }
  updateChild(parent.id, child.id, (entry) => {
    entry.depthRequests = [...(entry.depthRequests ?? []), request];
  });
  writeReport({ parentId: parent.id, parentPaneId: parent.paneId, childId: child.id, childName: child.name, paneId: child.paneId || caller.paneId, status: 'needs-input', text: requestEvent(parent, child, request) });
  return `Asked your parent for ${plural(levels)} more, to depth ${wanted}, as request ${request.id}. Carry on with what you can do at your current ceiling of depth ${ceiling}; you will get a message with the answer, granted or refused.`;
}

/** The report a parent reads for a request. */
function requestEvent(parent: ParentRecord, child: ChildRecord, request: DepthRequest, onBehalf?: { name: string; depth: number; reason: string }): string {
  const allowance = sessionCeiling(parent);
  const head = onBehalf
    ? `${child.name} forwards a depth request from its child ${onBehalf.name} (depth ${onBehalf.depth}), who needs depth ${request.ceiling}: ${onBehalf.reason}`
    : `${child.name} asks for ${plural(request.levels)} more depth, to depth ${request.ceiling}: ${request.reason}`;
  const room = parent.depth === 0 ? `This tree's ceiling is depth ${allowance}.` : `You can grant up to depth ${allowance} yourself, and a grant past that goes on to your own parent.`;
  return [`${head}`, `Request ${request.id}. ${room} Answer with ${GRANT_DEPTH_TOOL} child ${child.name} levels ${request.ceiling - child.depth}, or levels 0 to refuse.`].join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface GrantInput {
  child: ChildRecord;
  levels: number;
  requestId?: string;
  reason?: string;
}

/**
 * agent_grant_depth, run for the session `sessionId` about one of its
 * children. Levels 0 refuses. A grant within the session's own ceiling lands
 * at once; one past it goes on to the session's parent as a request of its
 * own, and lands when that parent grants.
 */
export async function grantDepth(sessionId: string, caller: CallerIdentity, input: GrantInput, tell: Tell): Promise<string> {
  if (!Number.isInteger(input.levels) || input.levels < 0) throw new Error(`${GRANT_DEPTH_TOOL} needs levels, a whole number: 0 refuses, and n lets the child's descendants reach its depth plus n.`);
  const session = readParent(sessionId);
  if (!session) throw new Error(`No Bellwether registry for ${sessionId}.`);
  if (hostOf(input.child) !== LOCAL_HOST) return `${input.child.name} runs on machine ${hostOf(input.child)}, and a depth grant does not cross machines, so nothing changed.`;
  const child = session.children.find((entry) => entry.id === input.child.id) ?? input.child;
  const open = (child.depthRequests ?? []).filter((entry) => entry.state === 'pending' || entry.state === 'forwarded');
  let request = input.requestId ? (child.depthRequests ?? []).find((entry) => entry.id === input.requestId) : open[open.length - 1];
  if (input.requestId && !request) throw new Error(`${child.name} has no depth request ${input.requestId}.`);
  if (request && request.state !== 'pending' && request.state !== 'forwarded') return `Request ${request.id} from ${child.name} was already ${request.state}.`;
  if (request?.state === 'forwarded') return `Request ${request.id} from ${child.name} already went to this session's parent as ${request.forwardedAs ?? 'a request of its own'}, and settles when that parent answers.`;
  const by = sessionLabel(session, caller);

  if (input.levels === 0) {
    if (!request) return `${child.name} has no open depth request to refuse.`;
    const refusal = `${by} refused your request ${request.id} for depth ${request.ceiling}. ${ALTERNATIVES}`;
    await settle(session.id, child.id, request.id, { granted: false, by, refusal }, tell);
    return `Refused ${child.name}'s request ${request.id}, and told it so, with its two ways forward.`;
  }

  const wanted = child.depth + input.levels;
  if (wanted <= ceilingOf(child)) return `${child.name} may already spawn down to depth ${ceilingOf(child)}, so nothing changed.`;
  if (!request) {
    request = { id: newDepthRequestId(), levels: input.levels, ceiling: wanted, reason: oneLine(input.reason ?? `granted by ${by} without a request`), at: new Date().toISOString(), state: 'pending' };
    const made = request;
    updateChild(session.id, child.id, (entry) => {
      entry.depthRequests = [...(entry.depthRequests ?? []), made];
    });
  }
  const tree = treeOf(session, caller);
  if (tree && wanted > tree.ceiling) {
    const refusal = treeRefusal(tree, wanted);
    await settle(session.id, child.id, request.id, { granted: false, by: 'the tree ceiling', refusal }, tell);
    return `Depth ${wanted} is past the tree's ceiling of ${tree.ceiling}, so ${child.name}'s request ${request.id} was refused, and ${child.name} was told what would have to change.`;
  }
  const allowance = sessionCeiling(session, caller);
  if (wanted <= allowance) {
    await settle(session.id, child.id, request.id, { granted: true, by, ceiling: wanted, levels: input.levels, reason: input.reason }, tell);
    return `Granted: ${child.name} may now spawn down to depth ${wanted}, and was told so. The grant is on its record.`;
  }
  return forward(session, caller, child, request, wanted, tell);
}

/** Send a request this session cannot grant on to its own parent. */
async function forward(session: ParentRecord, caller: CallerIdentity, child: ChildRecord, request: DepthRequest, wanted: number, tell: Tell): Promise<string> {
  const own = ownChildRecord(session, caller);
  if (!own) {
    const remote = session.depth !== 0;
    const refusal = remote
      ? `Your request ${request.id} needs depth ${wanted}, past what ${sessionLabel(session, caller)} may grant, and its parent runs on another machine, which a depth request does not reach. ${ALTERNATIVES}`
      : treeRefusal({ root: session, ceiling: sessionCeiling(session) }, wanted);
    await settle(session.id, child.id, request.id, { granted: false, by: sessionLabel(session, caller), refusal }, tell);
    return `Depth ${wanted} is past this session's ceiling, and there is no parent here to forward to, so ${child.name}'s request ${request.id} was refused and ${child.name} was told why.`;
  }
  const { parent: up, child: self } = own;
  const upstream: DepthRequest = {
    id: newDepthRequestId(),
    levels: wanted - self.depth,
    ceiling: wanted,
    reason: oneLine(`${self.name} asks on behalf of ${child.name}: ${request.reason}`),
    at: new Date().toISOString(),
    state: 'pending',
    onBehalfOf: { parentId: session.id, childId: child.id, requestId: request.id, name: child.name },
  };
  updateChild(up.id, self.id, (entry) => {
    entry.depthRequests = [...(entry.depthRequests ?? []), upstream];
  });
  updateChild(session.id, child.id, (entry) => {
    const mine = entry.depthRequests?.find((item) => item.id === request.id);
    if (mine) {
      mine.state = 'forwarded';
      mine.forwardedAs = upstream.id;
    }
  });
  writeReport({ parentId: up.id, parentPaneId: up.paneId, childId: self.id, childName: self.name, paneId: self.paneId, status: 'needs-input', text: requestEvent(up, self, upstream, { name: child.name, depth: child.depth, reason: request.reason }) });
  return `Depth ${wanted} is past this session's own ceiling of ${sessionCeiling(session, caller)}, so the request went on to this session's parent as ${upstream.id}, with a line saying ${child.name} asks and why. ${child.name} gets the answer when it lands.`;
}

type Decision = { granted: true; by: string; ceiling: number; levels: number; reason?: string } | { granted: false; by: string; refusal: string };

/**
 * Record a decision on one request, tell the child, and settle the request
 * this one was forwarded for, all the way down the chain.
 */
async function settle(sessionId: string, childId: string, requestId: string, decision: Decision, tell: Tell): Promise<void> {
  const at = new Date().toISOString();
  let before = 0;
  let request: DepthRequest | undefined;
  const child = updateChild(sessionId, childId, (entry) => {
    request = entry.depthRequests?.find((item) => item.id === requestId);
    if (!request) return;
    before = ceilingOf(entry);
    request.decidedAt = at;
    request.decidedBy = decision.by;
    if (decision.granted) {
      const ceiling = Math.max(before, decision.ceiling);
      request.state = ceiling > before ? 'granted' : 'refused';
      if (ceiling > before) {
        entry.maxDepth = ceiling;
        entry.depthGrants = [...(entry.depthGrants ?? []), { at, by: decision.by, requestId, levels: ceiling - entry.depth, from: before, to: ceiling, reason: decision.reason ? oneLine(decision.reason) : request.reason }];
      } else {
        request.refusal = `${decision.by} could grant no deeper than depth ${decision.ceiling}, which you already have. ${ALTERNATIVES}`;
      }
    } else {
      request.state = 'refused';
      request.refusal = decision.refusal;
    }
  });
  if (!child || !request) return;
  const message = request.state === 'granted'
    ? `Bellwether: ${decision.by} granted your depth request ${requestId}. You may now spawn children down to depth ${ceilingOf(child)} (you are at depth ${child.depth}). Grant reason on record: ${request.reason}`
    : `Bellwether: your depth request ${requestId} was refused. ${request.refusal ?? ALTERNATIVES}`;
  await tell(child, message);
  if (!request.onBehalfOf) return;
  // This request carried one from further down: settle that one too.
  const below = request.onBehalfOf;
  const holder = readParent(below.parentId);
  const waiting = holder?.children.find((entry) => entry.id === below.childId)?.depthRequests?.find((entry) => entry.id === below.requestId);
  if (!waiting) return;
  if (request.state === 'granted') {
    await settle(below.parentId, below.childId, below.requestId, { granted: true, by: `${child.name}, with depth granted by ${decision.by}`, ceiling: Math.min(waiting.ceiling, ceilingOf(child)), levels: waiting.levels }, tell);
  } else {
    await settle(below.parentId, below.childId, below.requestId, { granted: false, by: decision.by, refusal: `${child.name} forwarded it up the chain, and it went no further: ${request.refusal ?? ALTERNATIVES}` }, tell);
  }
}

/** One child's depth line and grant history, for agent_list. */
export function describeDepth(child: ChildRecord): string[] {
  const lines: string[] = [];
  const open = (child.depthRequests ?? []).filter((entry) => entry.state === 'pending' || entry.state === 'forwarded');
  for (const entry of open) lines.push(`${child.name}: depth request ${entry.id} for depth ${entry.ceiling} is ${entry.state}${entry.forwardedAs ? ` as ${entry.forwardedAs}` : ''}: ${entry.reason}`);
  for (const grant of child.depthGrants ?? []) lines.push(`${child.name}: ceiling raised from depth ${grant.from} to ${grant.to} by ${grant.by} at ${grant.at} (request ${grant.requestId}): ${grant.reason}`);
  return lines;
}
