// Teleporting a child to another machine, live or stopped, under the same
// child id (issue #226). Bellwether is responsible for three things and no
// more: it starts the agent at the destination, in a directory that exists
// there, resuming its session; it proves the agent is alive; and it tells the
// agent it was teleported, as the first input its session reads. Whoever asks
// for the teleport prepares the destination: the folder, the worktree and any
// program the agent needs. Bellwether never copies a worktree.
//
// The steps are carry.ts's, which agent_move shares. A teleport's own policy
// accepts a stopped child, refuses a destination it cannot tell the child at
// and an adopted child, hands the child its notice, and records the teleport
// on the child and in teleport.log. A notice the model does not take leaves
// the agent running at the destination, says so, and keeps the notice for
// the session's next hello.
import { noticeOf, noticeState, noticeTaken } from './delivery.ts';
import { authorityFor } from './authority.ts';
import path from 'node:path';
import { carryChild, where, type CarryDeps, type CarryPolicy, type CarryRequest } from './carry.ts';
import { harnessFor } from './harnesses/index.ts';
import type { MoveStage } from './move-plan.ts';
import { bellwetherHome } from './paths.ts';
import { updateChild } from './registry.ts';
import type { NoticeOutcome } from './resume.ts';
import { machineLabel, teleportNotice } from './teleport-notice.ts';
import { teleportRefusals, type TeleportEntry, type TeleportNoticeRecord, type TeleportState } from './teleport-plan.ts';
import type { CallerIdentity, ChildRecord, ParentRecord } from './types.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { pickTarget } from './move-plan.ts';
import { childOfCaller } from './report.ts';
import { readParent } from './registry.ts';
import { RESTART_DEFER_MS, noteStatus, waitForTurnEnd, type RestartHooks } from './restart.ts';
import type { RegisterRemote } from './spawn.ts';
import { statusSeen } from './incarnation.ts';
import { statusChanged } from './turn.ts';
import { teleportAnswered, teleportArmed, teleportRequested, teleportStalled } from './requests.ts';

export function teleportLogPath(): string {
  return path.join(bellwetherHome(), 'teleport.log');
}

export type TeleportRequest = CarryRequest;

export interface TeleportDeps extends CarryDeps {
  /** Who asked: the child's parent, or the child itself. The notice says which. */
  requester?: 'parent' | 'self';
  /** Why a destination machine cannot put a message into the child's session, when it cannot: its Bellwether predates relay-message, or no relay connection reaches it. */
  inbound?: (host: string, kind: string) => Promise<string | undefined>;
}

export interface TeleportResult {
  child: ChildRecord;
  state: TeleportState;
  from: { host: string; cwd: string };
  to: { host: string; cwd: string };
  sessionFile: string;
  bytes: number;
  notice: TeleportNoticeRecord;
  /** What stayed on the source because the caller accepted the loss, one line each. */
  leftBehind: string[];
  link: string;
}

/** A teleport that never started, with every reason. Nothing was touched. */
export class TeleportRefusedError extends Error {
  readonly reasons: string[];

  constructor(childName: string, target: string, reasons: string[]) {
    super(`Bellwether refused to teleport ${childName} to ${where(target)}:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`);
    this.name = 'TeleportRefusedError';
    this.reasons = reasons;
  }
}

/** A teleport that started and was undone. The message says where the child is now. */
export class TeleportFailedError extends Error {
  readonly stage: MoveStage;
  readonly restoredPane?: string;

  constructor(message: string, stage: MoveStage, restoredPane?: string) {
    super(message);
    this.name = 'TeleportFailedError';
    this.stage = stage;
    this.restoredPane = restoredPane;
  }
}

/** Why the destination cannot take the notice into the session, or undefined when it can. */
async function inboundGap(deps: TeleportDeps, target: string, kind: string): Promise<string | undefined> {
  if (!deps.inbox) return 'this call holds no connection to any agent session, so the notice has nowhere to go';
  const entry = harnessFor(kind);
  if (!entry) return `Bellwether has no harness entry for kind ${kind}`;
  if (entry.inbox.via === 'none') return entry.inbox.reason;
  return deps.inbound?.(target, kind);
}

/** The notice as the record keeps it, which `src/core/delivery.ts` writes. */
export const noticeRecord = noticeOf;

export async function teleportChild(deps: TeleportDeps, parentId: string, request: TeleportRequest): Promise<TeleportResult> {
  const policy: CarryPolicy = {
    verb: 'teleport',
    refuse: teleportRefusals,
    early: async (child, target) => {
      const gap = await inboundGap(deps, target, child.kind);
      return gap ? { inbound: gap } : {};
    },
    notice: (places) => teleportNotice({ from: { machine: machineLabel(places.source), cwd: places.sourceCwd }, to: { machine: machineLabel(places.target), cwd: places.targetCwd }, at: places.at, requester: deps.requester ?? 'parent', ...(places.reason ? { reason: places.reason } : {}), state: places.state }),
    refused: (name, target, reasons) => new TeleportRefusedError(name, target, reasons),
    failed: (message, stage, restoredPane) => new TeleportFailedError(message, stage, restoredPane),
    logPath: teleportLogPath,
    outcome: (notice) => (noticeTaken(notice) ? 'teleported' : 'teleported-untold'),
  };
  const result = await carryChild(deps, parentId, request, policy);
  const told = noticeRecord(result.notice);
  const doneAt = new Date().toISOString();
  const entry: TeleportEntry = {
    at: result.at,
    by: result.by,
    ...(request.reason ? { reason: request.reason } : {}),
    state: result.state,
    from: result.from,
    to: result.to,
    sessionFile: result.sessionFile,
    bytes: result.bytes,
    notice: told,
    alive: { at: told.takenAt ?? doneAt, proof: told.takenAt ? 'took-notice' : 'detected' },
  };
  const saved = updateChild(parentId, result.child.id, (record) => {
    record.teleports = [...(record.teleports ?? []), entry];
  });
  const child = saved ?? { ...result.child, teleports: [...(result.child.teleports ?? []), entry] };
  return { child, state: result.state, from: { host: result.from.host, cwd: result.from.cwd }, to: { host: result.to.host, cwd: result.to.cwd }, sessionFile: result.sessionFile, bytes: result.bytes, notice: told, leftBehind: result.leftBehind, link: result.link };
}

/** The reply to agent_teleport. Its first line says whether the child was told, because a child that was not told needs the caller's attention. */
export function teleportReply(result: TeleportResult): string[] {
  const name = result.child.name;
  const told = result.notice.takenAt;
  const lead = told
    ? `${name} teleported from ${where(result.from.host)} to ${where(result.to.host)}, as the same child ${result.child.id}, resumed its session in pane ${result.child.paneId}, and its model read the notice and began a turn on it at ${told}.`
    : `${name} runs on ${where(result.to.host)} in pane ${result.child.paneId}, as the same child ${result.child.id}, but Bellwether did not see it take the notice that it was teleported: ${(result.notice.undelivered ?? 'no reason was recorded').replace(/\.$/, '')}. The notice is never typed, and its session is offered it when it next connects.`;
  return [
    lead,
    ...(result.state === 'stopped' ? [`${name} was stopped on ${where(result.from.host)}, which agent_move refuses, and it runs now.`] : []),
    `Its session crossed as ${result.bytes} bytes and was verified at ${result.sessionFile}, in ${result.to.cwd}. The worktree, the shell jobs and any file outside the session stayed on ${where(result.from.host)}.`,
    ...(result.leftBehind.length ? ['Left behind, as accept_loss allowed:', ...result.leftBehind.map((line) => `- ${line}`)] : []),
    `herdr link: ${result.link}`,
  ];
}

/** How long doctor reports a teleport that went as it should. */
const RECENT_MS = 24 * 3_600_000;

/**
 * doctor's lines for teleports: `info` for one in the last day, and `warn`
 * while a teleported child has not read its notice, or herdr's detection is
 * the only proof that it runs.
 */
export function teleportLines(parents: Pick<ParentRecord, 'children'>[], now = Date.now()): string[] {
  const lines: string[] = [];
  for (const child of parents.flatMap((parent) => parent.children)) {
    const asked = child.teleportRequest;
    if (asked) lines.push(`info  teleport: ${child.name} asked at ${asked.at} to teleport itself to ${where(asked.machine)} once its turn ends${asked.wait ? `, waiting on pane ${asked.wait.paneId} until ${asked.wait.until}` : ''}.`);
    const stalled = child.teleportStalled;
    if (stalled) lines.push(`warn  teleport: ${child.name}'s request to teleport itself${stalled.machine ? ` to ${where(stalled.machine)}` : ''}, made at ${stalled.requestedAt ?? stalled.at}, did not run: ${stalled.reason.replace(/\.$/, '')}.`);
    const last = child.teleports?.at(-1);
    if (!last) continue;
    const notice = noticeState(child, last.notice);
    const trip = `${child.name} went from ${where(last.from.host)} (${last.from.cwd}) to ${where(last.to.host)} (${last.to.cwd}) at ${last.at}`;
    if (notice.state === 'not seen') lines.push(`warn  teleport: ${trip}, and has not read the notice that it was teleported: ${(last.notice.undelivered ?? 'no reason was recorded').replace(/\.$/, '')}. Its session is offered the notice when it next connects.`);
    else if (Date.parse(last.at) > now - RECENT_MS) lines.push(`info  teleport: ${trip}, and ${notice.state === 'taken' ? 'read the notice and began a turn on it' : 'read the notice'} at ${notice.at}.`);
  }
  return lines;
}

/** What a child asks for when it teleports itself. */
export interface SelfTeleportRequest {
  machine?: string;
  cwd?: string;
  reason?: string;
  kind?: string;
}

/** The crossing's deps for a child, given the parent whose registry lists it: its relay registration is that parent's. */
export type SelfTeleportDeps = Omit<TeleportDeps, 'registerRemote' | 'by' | 'requester'> & { registerFor?: (parentId: string) => RegisterRemote | undefined };

function seconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * A child teleports itself (issue #226). The request goes on the child's
 * record and the reply goes first; the daemon acts once the child's turn
 * ends, within the bound a self-restart waits under, because a teleport
 * never cuts a turn short and a child that asks is in the middle of one. The
 * crossing runs as the child's parent, and the notice says the child asked.
 */
export async function requestSelfTeleport(deps: SelfTeleportDeps, caller: CallerIdentity, request: SelfTeleportRequest, hooks: RestartHooks): Promise<string> {
  if (!caller.childId) throw new Error('agent_teleport needs a child, or a session Bellwether started as a child: this session sent no child id, so there is nothing to teleport. Name the child to teleport with child.');
  const found = childOfCaller(caller);
  if (!found) throw new Error(`agent_teleport was called for child ${caller.childId}, which no registry on this machine holds, and this machine holds no relay record that names its parent either, so the request has nowhere to go. Ask your parent with parent_report to teleport you. Nothing was recorded.`);
  const { parent, child } = found;
  const timeoutMs = hooks.deferTimeoutMs ?? RESTART_DEFER_MS;
  const reply = await recordSelfTeleport(parent.id, child, request, deps.knownHosts, timeoutMs);
  hooks.defer?.(`teleport:${child.id}`, () => deferredSelfTeleport(deps, parent.id, child.id, request, hooks));
  return reply;
}

/**
 * The parent's side of a teleport a child asked for from the machine it runs
 * on, which crossed the relay because that machine holds no record of it
 * (issue #226). The request goes on the child's record here, where the
 * parent's service waits for the child's turn to end on that machine's herdr
 * and then teleports it. The answer goes back to the child in the relay-ack.
 * A refusal throws, and its message is the answer.
 */
export async function acceptTeleportFromAfar(parentId: string, childId: string, request: SelfTeleportRequest, knownHosts: () => Promise<string[]>, timeoutMs = RESTART_DEFER_MS): Promise<string> {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  if (!child) throw new TeleportRefusedError(childId, request.machine ?? 'another machine', [`the daemon of parent ${parentId} holds no child ${childId}`]);
  return `The daemon of parent ${parentId}, which holds your record, took the request.\n${await recordSelfTeleport(parentId, child, request, knownHosts, timeoutMs)}`;
}

/** Start the wait for a teleport the record asks for, in the service of the parent whose registry lists the child. */
export function armTeleportFor(deps: SelfTeleportDeps, parentId: string, childId: string, hooks: RestartHooks): boolean {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const asked = child?.teleportRequest;
  if (!child || !asked) return false;
  // The wait starts again with a full bound, so the record never shows the bound of a wait that ended with its daemon.
  updateChild(parentId, childId, (entry) => {
    teleportArmed(entry, { paneId: child.paneId, until: new Date(Date.now() + (hooks.deferTimeoutMs ?? RESTART_DEFER_MS)).toISOString() });
  });
  hooks.defer?.(`teleport:${childId}`, () => deferredSelfTeleport(deps, parentId, childId, { ...(asked.reason ? { reason: asked.reason } : {}) }, hooks));
  return true;
}

/**
 * Refuse what the record alone can refuse, so the child hears it in the reply
 * rather than after its turn, then write the request on the child's record
 * and return the reply.
 */
async function recordSelfTeleport(parentId: string, child: ChildRecord, request: SelfTeleportRequest, knownHosts: () => Promise<string[]>, timeoutMs: number): Promise<string> {
  const source = hostOf(child);
  const machine = request.machine?.trim();
  // The saved machines are read only when the request names none: a named destination needs no herdr here to resolve it.
  const target = machine ? (machine === 'local' ? LOCAL_HOST : machine) : pickTarget(await knownHosts(), source);
  const cwd = request.cwd?.trim() || child.cwd;
  const early = teleportRefusals({ childName: child.name, harness: child.harness, status: 'idle', state: 'live', ...authorityFor(child, 'teleport', target), source, target, hasSession: Boolean(child.session), ...(child.route ? { route: child.route.name } : {}) });
  if (early.length) throw new TeleportRefusedError(child.name, target, early);
  const now = Date.now();
  let recorded = false;
  updateChild(parentId, child.id, (entry) => {
    recorded = teleportRequested(entry, { at: new Date(now).toISOString(), machine: target, ...(cwd ? { cwd } : {}), ...(request.reason ? { reason: request.reason } : {}) }, { until: new Date(now + timeoutMs).toISOString(), paneId: child.paneId });
  });
  const pending = readParent(parentId)?.children.find((entry) => entry.id === child.id)?.teleportRequest;
  if (!recorded) throw new TeleportRefusedError(child.name, target, [`a teleport to machine ${machineLabel(pending?.machine ?? target)} asked at ${pending?.at ?? 'an earlier time'} is already under way${pending?.wait ? `, and it waits until ${pending.wait.until}` : ''}, so this request was not recorded`]);
  return [
    `${child.name} is teleported to machine ${machineLabel(target)}, directory ${cwd ?? '(its current directory)'}, once this turn ends, within ${seconds(timeoutMs)}. Bellwether then stops this session and resumes it there under the same child id, and your next input there is the notice that says where you came from.`,
    `Prepare the directory before your turn ends: Bellwether carries the conversation, never the worktree or the shell jobs. When the turn does not end within the bound, or the teleport is refused when it would run, nothing moves, and your record and bellwether doctor say why.`,
  ].join('\n');
}

/** The deferred half: wait for the child's turn to end, then teleport it as its parent. */
async function deferredSelfTeleport(deps: SelfTeleportDeps, parentId: string, childId: string, request: SelfTeleportRequest, hooks: RestartHooks): Promise<void> {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const asked = child?.teleportRequest;
  if (!child || !asked) return;
  const timeoutMs = hooks.deferTimeoutMs ?? RESTART_DEFER_MS;
  const stall = (reason: string): void => {
    updateChild(parentId, childId, (entry) => {
      teleportStalled(entry, reason, child.paneId);
    });
    hooks.log?.(`self-teleport of ${child.name} (child ${childId}) did not run: ${reason}`);
  };
  try {
    const client = await deps.clientFor(hostOf(child));
    const onStatus = noteStatus((change) =>
      updateChild(parentId, childId, (entry) => {
        if (entry.teleportRequest?.wait) change(entry.teleportRequest.wait);
      }),
    );
    await waitForTurnEnd(client, child.name, { paneId: child.paneId, ...(child.tabId ? { tabId: child.tabId } : {}) }, { timeoutMs, freshOnly: true, readAtDeadline: true, signal: hooks.signal, onStatus });
  } catch (error) {
    // A daemon that stops mid-wait leaves the request for its next start.
    if (hooks.signal?.aborted) return;
    const status = readParent(parentId)?.children.find((entry) => entry.id === childId)?.teleportRequest?.wait?.status;
    const message = (error as Error).message;
    stall(/ wait; /.test(message) ? `${child.name} did not end its turn within ${seconds(timeoutMs)}${status ? `, and herdr last reported it ${status}` : ''}, so nothing moved. Ask again once it is idle, or ask your parent to teleport you.` : `the wait for ${child.name}'s turn to end failed, so nothing moved: ${message}`);
    return;
  }
  if (!readParent(parentId)?.children.find((entry) => entry.id === childId)?.teleportRequest) return;
  // herdr just reported the turn over. The watcher records that only after its
  // settle time, and the crossing refuses a child its record still calls
  // working, so the record takes the status the wait saw.
  updateChild(parentId, childId, (entry) => {
    const seen = entry.teleportRequest?.wait?.status;
    if (entry.lastStatus !== 'working' && entry.lastStatus !== 'blocked') return;
    statusSeen(entry, seen === 'done' ? 'done' : 'idle');
    statusChanged(entry, new Date().toISOString());
  });
  try {
    const { registerFor, ...rest } = deps;
    const registerRemote = registerFor?.(parentId);
    await teleportChild({ ...rest, ...(registerRemote ? { registerRemote } : {}), by: 'self', requester: 'self' }, parentId, { child: childId, machine: asked.machine, ...(asked.cwd ? { cwd: asked.cwd } : {}), ...(asked.reason ? { reason: asked.reason } : {}), ...(request.kind ? { kind: request.kind } : {}) });
    updateChild(parentId, childId, (entry) => {
      teleportAnswered(entry);
    });
  } catch (error) {
    stall(`the teleport did not run: ${(error as Error).message}`);
  }
}

/**
 * Arm again a teleport this session asked for itself and a stopped daemon
 * never ran: the request is on the child's record, and the session that
 * reconnects is the child's own, so its service starts the wait afresh.
 */
export function armPendingTeleports(deps: SelfTeleportDeps, session: Pick<ParentRecord, 'childId' | 'paneId'>, hooks: RestartHooks): boolean {
  if (!session.childId) return false;
  const found = childOfCaller({ childId: session.childId });
  const asked = found?.child.teleportRequest;
  if (!found || !asked) return false;
  const timeoutMs = hooks.deferTimeoutMs ?? RESTART_DEFER_MS;
  updateChild(found.parent.id, found.child.id, (entry) => {
    teleportArmed(entry, { until: new Date(Date.now() + timeoutMs).toISOString(), paneId: found.child.paneId });
  });
  hooks.defer?.(`teleport:${found.child.id}`, () => deferredSelfTeleport(deps, found.parent.id, found.child.id, { ...(asked.reason ? { reason: asked.reason } : {}) }, hooks));
  return true;
}
