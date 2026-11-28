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
import path from 'node:path';
import { carryChild, where, type CarryDeps, type CarryPolicy, type CarryRequest } from './carry.ts';
import { harnessFor } from './harnesses/index.ts';
import type { MoveStage } from './move-plan.ts';
import { bellwetherHome } from './paths.ts';
import { updateChild } from './registry.ts';
import type { NoticeOutcome } from './resume.ts';
import { machineLabel, teleportNotice } from './teleport-notice.ts';
import { teleportRefusals, type TeleportEntry, type TeleportNoticeRecord, type TeleportState } from './teleport-plan.ts';
import type { ChildRecord, ParentRecord } from './types.ts';

export function teleportLogPath(): string {
  return path.join(bellwetherHome(), 'teleport.log');
}

export type TeleportRequest = CarryRequest;

export interface TeleportDeps extends CarryDeps {
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

/** The notice as the record keeps it: how it arrived, or why Bellwether did not see the model take it. */
export function noticeRecord(outcome: NoticeOutcome | undefined): TeleportNoticeRecord {
  const delivery = outcome?.delivery;
  if (!delivery) return { undelivered: 'the resume carried no notice' };
  return {
    ...(delivery.message ? { message: delivery.message } : {}),
    ...(delivery.via ? { via: delivery.via } : {}),
    ...(delivery.receivedAt ? { receivedAt: delivery.receivedAt } : {}),
    ...(delivery.readAt ? { readAt: delivery.readAt } : {}),
    ...(delivery.takenAt ? { takenAt: delivery.takenAt } : {}),
    ...(delivery.takenAt ? {} : { undelivered: outcome?.notTaken ?? delivery.unanswered ?? 'Bellwether did not see its model read it and begin a turn on it' }),
  };
}

export async function teleportChild(deps: TeleportDeps, parentId: string, request: TeleportRequest): Promise<TeleportResult> {
  const policy: CarryPolicy = {
    verb: 'teleport',
    refuse: teleportRefusals,
    early: async (child, target) => {
      const gap = await inboundGap(deps, target, child.kind);
      return gap ? { inbound: gap } : {};
    },
    notice: (places) => teleportNotice({ from: { machine: machineLabel(places.source), cwd: places.sourceCwd }, to: { machine: machineLabel(places.target), cwd: places.targetCwd }, at: places.at, by: places.by, ...(places.reason ? { reason: places.reason } : {}), state: places.state }),
    refused: (name, target, reasons) => new TeleportRefusedError(name, target, reasons),
    failed: (message, stage, restoredPane) => new TeleportFailedError(message, stage, restoredPane),
    logPath: teleportLogPath,
    outcome: (notice) => (notice?.delivery.takenAt ? 'teleported' : 'teleported-untold'),
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
    const last = child.teleports?.at(-1);
    if (!last) continue;
    const read = last.notice.message ? child.messages?.find((message) => message.id === last.notice.message)?.readAt : undefined;
    const trip = `${child.name} went from ${where(last.from.host)} (${last.from.cwd}) to ${where(last.to.host)} (${last.to.cwd}) at ${last.at}`;
    if (!last.notice.takenAt && !read) lines.push(`warn  teleport: ${trip}, and has not read the notice that it was teleported: ${(last.notice.undelivered ?? 'no reason was recorded').replace(/\.$/, '')}. Its session is offered the notice when it next connects.`);
    else if (Date.parse(last.at) > now - RECENT_MS) lines.push(`info  teleport: ${trip}, and read the notice at ${last.notice.takenAt ?? read}.`);
  }
  return lines;
}
