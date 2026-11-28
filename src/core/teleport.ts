// Teleporting a child to another machine, live or stopped, under the same
// child id (issue #226). Bellwether is responsible for three things and no
// more: it starts the agent at the destination, in a directory that exists
// there, resuming its session; it proves the agent is alive; and it tells the
// agent it was teleported, as the first input its session reads. Whoever asks
// for the teleport prepares the destination: the folder, the worktree and any
// program the agent needs. Bellwether never copies a worktree.
//
// The order is agent_move's, so each step is safe to fail:
//
//   1. Resolve both ends, and refuse on anything teleport-plan.ts names,
//      before touching anything.
//   2. Copy the session to the destination and verify every byte.
//   3. For a live agent, stop its tab on the source, so the session is never
//      live twice, and copy again if its last moments added to it. A stopped
//      agent has no tab to stop.
//   4. Start it at the destination, resuming the copy, with the notice as the
//      session's first input. A notice the model does not take leaves the
//      agent running there, says so, and keeps the notice for its next hello.
//   5. When the start fails, put a live agent back on its source from the
//      session still there, and leave a stopped one stopped as it was.
//   6. Commit the copy, point the record at the destination, and record the
//      teleport on the child and in teleport.log.
import fs from 'node:fs';
import path from 'node:path';
import { withChildLock } from './child-lock.ts';
import { harnessFor } from './harnesses/index.ts';
import { missingIntegration } from './herdr-integration.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { removeChildFiles } from './mcp-config.ts';
import { MOVE_WINDOW_MS, verifyCopy, type MoveDeps } from './move.ts';
import { pickTarget, rewriteForTarget, sha256, type MovableHarness } from './move-plan.ts';
import { bellwetherHome } from './paths.ts';
import { childById, readParent, updateChild, upsertChild } from './registry.ts';
import { holdsSession, resumeChild, sessionOf, type HarnessSession, type NoticeOutcome } from './resume.ts';
import type { Inbox } from './send.ts';
import type { ImportResult, ProbeResult, SessionBundle } from './session-state.ts';
import { herdrLink } from './spawn.ts';
import { machineLabel, teleportNotice } from './teleport-notice.ts';
import { teleportRefusals, teleportState, type TeleportEntry, type TeleportNoticeRecord, type TeleportRefusalInput, type TeleportState } from './teleport-plan.ts';
import type { ChildRecord } from './types.ts';

export function teleportLogPath(): string {
  return path.join(bellwetherHome(), 'teleport.log');
}

export interface TeleportRequest {
  /** The child's name, id or pane. */
  child: string;
  /** The destination: `local`, or a saved herdr machine. Inferred when exactly one other is known. */
  machine?: string;
  /** The directory the agent resumes in at the destination. It must exist there. Defaults to the one it runs in now. */
  cwd?: string;
  /** Why the agent crosses, for the notice, the record and teleport.log. */
  reason?: string;
  /** The harness asked for at the destination, as a kind. Anything but the child's own is refused. */
  kind?: string;
}

export interface TeleportDeps extends MoveDeps {
  /** The daemon's way into the child's session, which carries the notice. Without it, the teleport is refused. */
  inbox?: Inbox;
  /** Why a destination machine cannot put a message into the child's session, when it cannot: its Bellwether predates relay-message, or no relay connection reaches it. */
  inbound?: (host: string, kind: string) => Promise<string | undefined>;
  /** Who asked for the teleport, as the agent reads it in the notice. */
  by?: string;
}

export interface TeleportResult {
  child: ChildRecord;
  state: TeleportState;
  from: { host: string; cwd: string };
  to: { host: string; cwd: string };
  sessionFile: string;
  bytes: number;
  notice: TeleportNoticeRecord;
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
  readonly stage: Stage;
  readonly restoredPane?: string;

  constructor(message: string, stage: Stage, restoredPane?: string) {
    super(message);
    this.name = 'TeleportFailedError';
    this.stage = stage;
    this.restoredPane = restoredPane;
  }
}

type Stage = 'checked' | 'copied' | 'verified' | 'stopped' | 'recopied' | 'started';

function where(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === 'local' ? LOCAL_HOST : trimmed;
}

interface PreparedFile {
  rel: string;
  data: Buffer;
  bytes: number;
  sha256: string;
}

function prepare(bundle: SessionBundle, cwd: string): PreparedFile[] {
  return bundle.files.map((file) => {
    const raw = Buffer.from(file.data, 'base64');
    const data = file.rel === bundle.fileName ? rewriteForTarget(bundle.harness, raw, cwd) : raw;
    return { rel: file.rel, data, bytes: data.length, sha256: sha256(data) };
  });
}

function sameBundle(a: SessionBundle, b: SessionBundle): boolean {
  if (a.files.length !== b.files.length) return false;
  return a.files.every((file, index) => file.rel === b.files[index]?.rel && file.data === b.files[index]?.data);
}

function appendLog(line: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(teleportLogPath()), { recursive: true });
  fs.appendFileSync(teleportLogPath(), `${JSON.stringify(line)}\n`);
}

/** Why the destination cannot take the notice into the session, or undefined when it can. */
async function inboundGap(deps: TeleportDeps, target: string, kind: string): Promise<string | undefined> {
  if (!deps.inbox) return 'this call holds no connection to any agent session, so the notice has nowhere to go';
  const entry = harnessFor(kind);
  if (!entry) return `Bellwether has no harness entry for kind ${kind}`;
  if (entry.inbox.via === 'none') return entry.inbox.reason;
  return deps.inbound?.(target, kind);
}

async function probeOrRefuse(endpoint: ReturnType<MoveDeps['endpointFor']>, request: Parameters<ReturnType<MoveDeps['endpointFor']>['probe']>[0]): Promise<ProbeResult | string> {
  try {
    return await endpoint.probe(request);
  } catch (error) {
    return `Bellwether could not read ${where(endpoint.host)}: ${(error as Error).message}`;
  }
}

function noticeRecord(outcome: NoticeOutcome | undefined): TeleportNoticeRecord {
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
  const log = deps.log ?? (() => {});
  const first = readParent(parentId);
  if (!first) throw new Error(`No Bellwether registry for ${parentId}.`);
  const found = childById(first, request.child);
  if (!found) throw new Error(`No child of this session matches "${request.child}". Call agent_list to see them.`);
  const source = hostOf(found);
  const target = normalizeHost(request.machine) ?? pickTarget(await deps.knownHosts(), source);
  const by = deps.by ?? parentId;

  return withChildLock(found.id, `${found.name} (child ${found.id})`, `teleport to ${target}`, async () => {
    // Read the record again under the lock: a resume or a move that held it may have changed it.
    const child = readParent(parentId)?.children.find((entry) => entry.id === found.id) ?? found;
    const original: ChildRecord = structuredClone(child);
    const askedAt = new Date();
    const state = teleportState(child);
    const session = sessionOf(child);
    const cwd = request.cwd?.trim() || child.cwd;
    const requestedHarness = request.kind ? harnessFor(request.kind)?.harness ?? request.kind : undefined;
    const moveInFlight = child.moving && Date.parse(child.moving.until) > askedAt.getTime() ? { to: child.moving.to, since: child.moving.since } : undefined;

    // 1. What can be refused from the record and the destination's inbound path is refused before any copy.
    const missing = session ? undefined : await missingIntegration(await deps.clientFor(source).catch(() => undefined), harnessFor(child.kind));
    const base: TeleportRefusalInput = {
      childName: child.name,
      harness: child.harness,
      requestedHarness,
      status: child.lastStatus,
      state,
      origin: child.origin,
      source,
      target,
      moveInFlight,
      hasSession: Boolean(session),
      ...(child.route ? { route: child.route.name } : {}),
      ...(missing ? { missingIntegration: missing } : {}),
    };
    const gap = await inboundGap(deps, target, child.kind);
    const early = teleportRefusals({ ...base, ...(gap ? { inbound: gap } : {}) });
    if (!cwd && early.length === 0) early.push(`${child.name} has no recorded working directory, so Bellwether cannot tell where it resumes on ${where(target)}. Pass cwd with a directory that exists there.`);
    if (early.length) throw new TeleportRefusedError(child.name, target, early);
    const harness = child.harness as MovableHarness;
    const entry = harnessFor(child.kind);
    // The copy resumes as the harness names its session: pi by the file, Claude Code by the id.
    const byPath = entry?.session.from === 'herdr' && entry.session.kind === 'path';
    const resumable = session as HarnessSession;
    const targetCwd = cwd as string;

    const sourceEnd = deps.endpointFor(source);
    const targetEnd = deps.endpointFor(target);
    const [sourceProbe, targetProbe] = await Promise.all([probeOrRefuse(sourceEnd, { harnesses: [harness] }), probeOrRefuse(targetEnd, { harnesses: [harness], cwd: targetCwd, piModels: entry?.chosenBy === 'pair' })]);
    const unreachable = [sourceProbe, targetProbe].filter((probe): probe is string => typeof probe === 'string');
    if (unreachable.length) throw new TeleportRefusedError(child.name, target, unreachable);
    const sourceInfo = sourceProbe as ProbeResult;
    const targetInfo = targetProbe as ProbeResult;

    let bundle: SessionBundle;
    try {
      bundle = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
    } catch (error) {
      throw new TeleportRefusedError(child.name, target, [`Bellwether could not read ${child.name}'s session on ${where(source)}: ${(error as Error).message}`]);
    }
    const refusals = teleportRefusals({
      ...base,
      sourceHarness: sourceInfo.harnesses[harness],
      targetHarness: targetInfo.harnesses[harness],
      recordedVersions: bundle.recordedVersions,
      targetCwd,
      targetCwdExists: targetInfo.cwd?.exists,
      piModel: bundle.piModel,
      targetModels: targetInfo.piModels,
      targetModelsError: targetInfo.piModelsError,
      targetModelsFile: targetInfo.piModelsFile,
    });
    if (refusals.length) throw new TeleportRefusedError(child.name, target, refusals);

    const sourceClient = await deps.clientFor(source);
    const targetClient = await deps.clientFor(target);
    let stage: Stage = 'checked';
    const written = new Map<string, { path: string; created: boolean }>();
    let sessionFile = '';
    let bytes = 0;
    let started: ChildRecord | undefined;
    let notice: NoticeOutcome | undefined;

    const copy = async (from: SessionBundle): Promise<void> => {
      const prepared = prepare(from, targetCwd);
      let result: ImportResult;
      try {
        result = await targetEnd.importSession({ harness, childId: child.id, cwd: targetCwd, fileName: from.fileName, files: prepared.map((file) => ({ rel: file.rel, data: file.data.toString('base64') })) });
      } catch (error) {
        throw new Error(`the copy to ${where(target)} failed: ${(error as Error).message}`);
      }
      for (const file of result.files) written.set(file.path, { path: file.path, created: written.get(file.path)?.created ?? file.created });
      verifyCopy(prepared, result, target);
      sessionFile = result.sessionFile;
      bytes = prepared.reduce((sum, file) => sum + file.bytes, 0);
    };
    const settle = { childId: child.id, files: () => [...written.values()] };
    const text = teleportNotice({
      from: { machine: machineLabel(source), cwd: child.cwd ?? targetCwd },
      to: { machine: machineLabel(target), cwd: targetCwd },
      at: askedAt.toISOString(),
      by,
      ...(request.reason ? { reason: request.reason } : {}),
      state,
    });

    try {
      // 2. Copy and verify, while a live agent still runs on the source.
      stage = 'copied';
      await copy(bundle);
      stage = 'verified';
      log(`teleport: ${child.name} copied to ${where(target)} and verified, ${bytes} bytes`);

      // The mark keeps a resume, a restart and the watcher off the child while it crosses.
      updateChild(parentId, child.id, (entry) => {
        entry.moving = { from: source, to: target, since: askedAt.toISOString(), until: new Date(askedAt.getTime() + MOVE_WINDOW_MS).toISOString() };
      });

      // 3. Stop a live agent, so the session is never live twice.
      if (state === 'live') {
        let closeError: Error | undefined;
        try {
          if (child.tabId) await sourceClient.tabClose(child.tabId);
          else await sourceClient.paneClose(child.paneId);
        } catch (error) {
          closeError = error as Error;
        }
        const stillLive = (await sourceClient.agentList()).find((pane) => pane.paneId === child.paneId || holdsSession(pane, resumable));
        if (stillLive) throw new Error(closeError ? `its tab on ${where(source)} could not be closed: ${closeError.message}` : `its session still runs in pane ${stillLive.paneId} on ${where(source)} after its tab closed`);
        stage = 'stopped';
        const after = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
        if (!sameBundle(bundle, after)) {
          stage = 'recopied';
          await copy(after);
          log(`teleport: ${child.name}'s session grew as it stopped, so it was copied again and verified, ${bytes} bytes`);
        }
      }

      // 4. Start at the destination, resuming the copy, with the notice first.
      const at = new Date().toISOString();
      const moved: ChildRecord = { ...(readParent(parentId)?.children.find((entry) => entry.id === child.id) ?? child), host: target, cwd: targetCwd, session: byPath ? { kind: 'path', value: sessionFile } : { kind: 'id', value: resumable.value }, exitedAt: child.exitedAt ?? at };
      delete moved.transcript;
      delete moved.transcriptMissing;
      // A workspace id belongs to the source machine's herdr.
      delete moved.workspaceId;
      upsertChild(parentId, moved);
      const parent = readParent(parentId);
      if (!parent) throw new Error(`the registry for ${parentId} disappeared`);
      const resumed = await resumeChild(targetClient, parent, { child: moved, session: { kind: byPath ? 'path' : 'id', value: moved.session?.value ?? '' } }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs, inbox: deps.inbox, from: by, notice: text });
      started = resumed.child;
      notice = resumed.notice;
      stage = 'started';
    } catch (error) {
      const failure = (error as Error).message;
      const notes: string[] = [];
      if (written.size) await targetEnd.discard({ childId: settle.childId, files: settle.files() }).catch((fault: unknown) => notes.push(`the copy on ${where(target)} could not be removed: ${(fault as Error).message}`));
      const stopped = stage === 'stopped' || stage === 'recopied';
      let restoredPane: string | undefined;
      let rollbackError: string | undefined;
      // The record goes back to what it was before the teleport: the source's host, directory and session.
      // Messages sent since keep their place on it.
      const current = readParent(parentId)?.children.find((entry) => entry.id === child.id);
      upsertChild(parentId, { ...original, ...(current?.messages ? { messages: current.messages } : {}) });
      if (stopped) {
        // 5. The live agent was stopped on the source, whose session is untouched, so it resumes there.
        updateChild(parentId, child.id, (entry) => {
          entry.exitedAt = new Date().toISOString();
        });
        const restored = readParent(parentId)?.children.find((entry) => entry.id === child.id);
        const parent = readParent(parentId);
        try {
          if (!restored || !parent) throw new Error('the child record disappeared');
          const back = await resumeChild(sourceClient, parent, { child: restored, session: resumable }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs });
          restoredPane = back.child.paneId;
        } catch (fault) {
          rollbackError = (fault as Error).message;
        }
      }
      updateChild(parentId, child.id, (entry) => {
        delete entry.moving;
      });
      const outcome = rollbackError ? 'stranded' : stopped ? 'rolled-back' : 'abandoned';
      appendLog({ at: new Date().toISOString(), parent: parentId, child: child.id, name: child.name, harness, state, outcome, from: source, to: target, stage, by, reason: request.reason, error: failure, ...(rollbackError ? { rollbackError } : {}), ...(notes.length ? { notes } : {}) });
      log(`teleport: ${child.name} to ${where(target)} failed at ${stage}: ${failure}`);
      const lead = `Teleporting ${child.name} to ${where(target)} failed after the step "${stage}": ${failure.replace(/\.$/, '')}.`;
      const tail = notes.length ? ` Also: ${notes.join('; ')}.` : '';
      const copyGone = written.size ? `, and the copy on ${where(target)} was removed` : '';
      if (state === 'stopped') throw new TeleportFailedError(`${lead} ${child.name} stays stopped on ${where(source)}, with its record as it was${copyGone}.${tail}`, stage);
      if (!stopped) throw new TeleportFailedError(`${lead} Nothing was stopped: ${child.name} still runs on ${where(source)} in pane ${child.paneId}${copyGone}.${tail}`, stage);
      if (rollbackError) throw new TeleportFailedError(`${lead} Bellwether then tried to start it again on ${where(source)}, and that failed too: ${rollbackError}. ${child.name} is stopped, and its session is intact on ${where(source)} at ${bundle.sourceFile}. Call agent_spawn with resume ${child.name} to bring it back there.${tail}`, stage);
      throw new TeleportFailedError(`${lead} Bellwether rolled it back: ${child.name} runs again on ${where(source)} in pane ${restoredPane}, from its session there, as the same child ${child.id}.${tail}`, stage, restoredPane);
    }

    // 6. Keep the copy, tidy the machine it left, and record the teleport.
    await targetEnd.commit({ childId: settle.childId, files: settle.files() }).catch((error: unknown) => log(`teleport: the backups on ${where(target)} stay: ${(error as Error).message}`));
    if (source === LOCAL_HOST) removeChildFiles(child.id);
    else await deps.cleanupRemote?.({ ...child, host: source }).catch((error: unknown) => log(`teleport: could not remove ${child.name}'s files on ${where(source)}: ${(error as Error).message}`));
    const doneAt = new Date().toISOString();
    const told = noticeRecord(notice);
    const teleport: TeleportEntry = {
      at: askedAt.toISOString(),
      by,
      ...(request.reason ? { reason: request.reason } : {}),
      state,
      from: { host: source, cwd: child.cwd ?? '', ...(child.paneId ? { paneId: child.paneId } : {}) },
      to: { host: target, cwd: targetCwd, paneId: started?.paneId ?? '' },
      sessionFile,
      bytes,
      notice: told,
      alive: { at: told.takenAt ?? doneAt, proof: told.takenAt ? 'took-notice' : 'detected' },
    };
    updateChild(parentId, child.id, (record) => {
      delete record.moving;
      record.movedFrom = { host: source, at: doneAt };
      record.teleports = [...(record.teleports ?? []), teleport];
    });
    appendLog({ at: doneAt, parent: parentId, child: child.id, name: child.name, harness, state, outcome: told.takenAt ? 'teleported' : 'teleported-untold', from: source, to: target, by, reason: request.reason, sourceFile: bundle.sourceFile, targetFile: sessionFile, cwd: targetCwd, bytes, pane: started?.paneId, ...(told.undelivered ? { undelivered: told.undelivered } : {}) });
    log(`teleport: ${child.name} teleported from ${where(source)} to ${where(target)}, pane ${started?.paneId}${told.takenAt ? '' : `, not told: ${told.undelivered}`}`);
    const saved = readParent(parentId)?.children.find((record) => record.id === child.id) ?? (started as ChildRecord);
    return { child: saved, state, from: { host: source, cwd: child.cwd ?? '' }, to: { host: target, cwd: targetCwd }, sessionFile, bytes, notice: told, link: herdrLink('pane', saved.paneId) };
  }, undefined, undefined, { action: 'teleported' });
}
