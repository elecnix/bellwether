// Moving a live child to another machine, in either direction, under the same
// child id. A move cannot happen in place, so it runs in an order where each
// step is safe to fail:
//
//   1. Resolve both ends: the child's machine and harness, the target machine,
//      and the session file on the source.
//   2. Refuse on any condition move-plan.ts names, before touching anything.
//   3. Copy the session to the target, where its harness looks for it from the
//      working directory the child resumes in there.
//   4. Verify the copy: every file read back on the target must match the
//      bytes and checksum that were sent.
//   5. Stop the child's tab on the source, so the session is never live twice,
//      then read the session again and copy it once more if its last moments
//      added to it.
//   6. Start the child on the target, resuming the copied session, under the
//      same child id and name.
//   7. When step 6 fails, roll back: start the child again on the source from
//      the session file still there, and report the move as failed.
//   8. Commit the copy, point the record, and so the relay, at the new host,
//      and append the outcome to move.log.
import fs from 'node:fs';
import path from 'node:path';
import { withChildLock } from './child-lock.ts';
import { LOCAL_HOST, hostOf, type ClientFor } from './machine.ts';
import { removeChildFiles } from './mcp-config.ts';
import { bellwetherHome } from './paths.ts';
import { childById, readParent, updateChild, upsertChild } from './registry.ts';
import { holdsSession, resumeChild, sessionOf, type HarnessSession } from './resume.ts';
import { harnessOf, herdrLink, type RegisterRemote } from './spawn.ts';
import { isMoving, moveRefusals, pickTarget, rewriteForTarget, rollbackPlan, sha256, type MovableHarness, type MoveStage, type RefusalInput } from './move-plan.ts';
import type { EndpointFor } from './move-endpoint.ts';
import type { ImportResult, ProbeResult, SessionBundle } from './session-state.ts';
import type { ChildRecord } from './types.ts';

/** How long the watcher ignores the old pane's close. Longer than any move: two copies, a stop and a start. */
export const MOVE_WINDOW_MS = 15 * 60_000;

export function moveLogPath(): string {
  return path.join(bellwetherHome(), 'move.log');
}

export interface MoveRequest {
  /** The child's name, id or pane. */
  child: string;
  /** The machine to move to: `local`, or a saved herdr machine. Inferred when exactly one other is known. */
  machine?: string;
  /** The directory the child resumes in on the target. Defaults to the one it runs in now. */
  cwd?: string;
  /** The harness asked for on the target, as a kind. Anything but the child's own is refused. */
  kind?: string;
  /** Why the child moves, for move.log. */
  reason?: string;
}

export interface MoveDeps {
  clientFor: ClientFor;
  endpointFor: EndpointFor;
  /** The hosts a child can run on, for a move that names no machine. */
  knownHosts: () => Promise<string[]>;
  /** Register a child on its machine again, so its reports come back from there. */
  registerRemote?: RegisterRemote;
  /** Remove what a registration wrote on a machine the child left. */
  cleanupRemote?: (child: ChildRecord) => Promise<void>;
  log?: (line: string) => void;
  /** How long the startup dialogs may take. Tests shorten it. */
  startupTimeoutMs?: number;
  redrawMs?: number;
}

export interface MoveResult {
  child: ChildRecord;
  from: string;
  to: string;
  /** The session file the child resumed on the target. */
  sessionFile: string;
  /** The bytes that crossed, every file of the session together. */
  bytes: number;
  link: string;
}

/** A move that never started, with every reason. Nothing was touched. */
export class MoveRefusedError extends Error {
  readonly reasons: string[];

  constructor(childName: string, target: string, reasons: string[]) {
    super(`Bellwether refused to move ${childName} to ${where(target)}:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`);
    this.name = 'MoveRefusedError';
    this.reasons = reasons;
  }
}

/** A move that started and was undone. The message says where the child runs now. */
export class MoveFailedError extends Error {
  readonly stage: MoveStage;
  readonly restoredPane?: string;

  constructor(message: string, stage: MoveStage, restoredPane?: string) {
    super(message);
    this.name = 'MoveFailedError';
    this.stage = stage;
    this.restoredPane = restoredPane;
  }
}

function where(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

/** `local` and an empty name mean this machine. */
function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === 'local' ? LOCAL_HOST : trimmed;
}

/** A session file, rewritten for its target and summed, as the target must read it back. */
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

/** Every file the target wrote must match what was sent, byte count and checksum, and none may be missing. */
export function verifyCopy(sent: PreparedFile[], written: ImportResult, target: string): void {
  const back = new Map(written.files.map((file) => [file.rel, file]));
  for (const file of sent) {
    const copy = back.get(file.rel);
    if (!copy) throw new Error(`the copy on ${where(target)} is missing ${file.rel}`);
    if (copy.bytes !== file.bytes || copy.sha256 !== file.sha256) {
      throw new Error(`the copy of ${file.rel} on ${where(target)} reads back as ${copy.bytes} bytes with sha256 ${copy.sha256}, where ${file.bytes} bytes with sha256 ${file.sha256} were sent`);
    }
  }
  if (back.size !== sent.length) throw new Error(`the target wrote ${back.size} files for the ${sent.length} that were sent`);
}

/** Whether two reads of one session hold the same files with the same bytes. */
function sameBundle(a: SessionBundle, b: SessionBundle): boolean {
  if (a.files.length !== b.files.length) return false;
  return a.files.every((file, index) => file.rel === b.files[index]?.rel && file.data === b.files[index]?.data);
}

function appendMoveLog(line: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(moveLogPath()), { recursive: true });
  fs.appendFileSync(moveLogPath(), `${JSON.stringify(line)}\n`);
}

/** The session the child resumes on the target: the same id for Claude Code, the new file for Pi. */
function targetSession(harness: MovableHarness, session: HarnessSession, sessionFile: string): { kind: string; value: string } {
  return harness === 'pi' ? { kind: 'path', value: sessionFile } : { kind: 'id', value: session.value };
}

async function probeOrRefuse(endpoint: ReturnType<EndpointFor>, request: Parameters<ReturnType<EndpointFor>['probe']>[0]): Promise<ProbeResult | string> {
  try {
    return await endpoint.probe(request);
  } catch (error) {
    return `Bellwether could not read ${where(endpoint.host)}: ${(error as Error).message}`;
  }
}

export async function moveChild(deps: MoveDeps, parentId: string, request: MoveRequest): Promise<MoveResult> {
  const log = deps.log ?? (() => {});
  const first = readParent(parentId);
  if (!first) throw new Error(`No Bellwether registry for ${parentId}.`);
  const found = childById(first, request.child);
  if (!found) throw new Error(`No child of this session matches "${request.child}". Call agent_list to see them.`);
  const source = hostOf(found);
  const target = normalizeHost(request.machine) ?? pickTarget(await deps.knownHosts(), source);

  return withChildLock(found.id, `${found.name} (child ${found.id})`, `move to ${target}`, async () => {
    // Read the record again under the lock: a resume or a move that held it may have changed it.
    const child = readParent(parentId)?.children.find((entry) => entry.id === found.id) ?? found;
    const now = new Date();
    const session = sessionOf(child);
    const cwd = request.cwd?.trim() || child.cwd;
    const requestedHarness = request.kind ? harnessOf(request.kind) : undefined;
    const moveInFlight = child.moving && isMoving(child, now.getTime()) ? { to: child.moving.to, since: child.moving.since } : undefined;

    // 1-2. What can be refused from the record alone is refused before any machine is reached.
    const base: RefusalInput = { childName: child.name, harness: child.harness, requestedHarness, status: child.lastStatus, exited: Boolean(child.exitedAt) || !child.paneId, source: hostOf(child), target, moveInFlight, hasSession: Boolean(session) };
    const early = moveRefusals(base);
    // A route is this machine's launcher, which the other machine's routes file does not hold.
    if (child.route && target !== LOCAL_HOST) early.push(`${child.name} runs on route ${child.route.name}, a launcher this machine's routes file defines, so it cannot resume behind it on ${where(target)}. Restart it with agent_restart and via none first, then move it.`);
    if (!cwd && early.length === 0) early.push(`${child.name} has no recorded working directory, so Bellwether cannot tell where it resumes on ${where(target)}. Pass cwd.`);
    if (early.length) throw new MoveRefusedError(child.name, target, early);
    const harness = child.harness as MovableHarness;
    const resumable = session as HarnessSession;
    const targetCwd = cwd as string;

    const sourceEnd = deps.endpointFor(base.source);
    const targetEnd = deps.endpointFor(target);
    const [sourceProbe, targetProbe] = await Promise.all([probeOrRefuse(sourceEnd, { harnesses: [harness] }), probeOrRefuse(targetEnd, { harnesses: [harness], cwd: targetCwd, piModels: harness === 'pi' })]);
    const unreachable = [sourceProbe, targetProbe].filter((probe): probe is string => typeof probe === 'string');
    if (unreachable.length) throw new MoveRefusedError(child.name, target, unreachable);
    const sourceInfo = sourceProbe as ProbeResult;
    const targetInfo = targetProbe as ProbeResult;

    let bundle: SessionBundle;
    try {
      bundle = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
    } catch (error) {
      throw new MoveRefusedError(child.name, target, [`Bellwether could not read ${child.name}'s session on ${where(base.source)}: ${(error as Error).message}`]);
    }
    const refusals = moveRefusals({
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
    if (refusals.length) throw new MoveRefusedError(child.name, target, refusals);

    const sourceClient = await deps.clientFor(base.source);
    const targetClient = await deps.clientFor(target);
    let stage: MoveStage = 'checked';
    const written = new Map<string, { path: string; created: boolean }>();
    let sessionFile = '';
    let bytes = 0;
    let started: ChildRecord | undefined;

    const copy = async (from: SessionBundle): Promise<void> => {
      const prepared = prepare(from, targetCwd);
      let result: ImportResult;
      try {
        result = await targetEnd.importSession({ harness, childId: child.id, cwd: targetCwd, fileName: from.fileName, files: prepared.map((file) => ({ rel: file.rel, data: file.data.toString('base64') })) });
      } catch (error) {
        throw new Error(`the copy to ${where(target)} failed: ${(error as Error).message}`);
      }
      // A file the first copy created stays created, whatever the second finds.
      for (const file of result.files) written.set(file.path, { path: file.path, created: written.get(file.path)?.created ?? file.created });
      verifyCopy(prepared, result, target);
      sessionFile = result.sessionFile;
      bytes = prepared.reduce((sum, file) => sum + file.bytes, 0);
    };

    const sourceSession = resumable;
    const settle = { childId: child.id, files: () => [...written.values()] };
    try {
      // 3-4. Copy and verify while the child still runs on the source.
      stage = 'copied';
      await copy(bundle);
      stage = 'verified';
      log(`move: ${child.name} copied to ${where(target)} and verified, ${bytes} bytes`);

      // 5. Stop the source, so the session is never live twice. The watcher ignores this close.
      updateChild(parentId, child.id, (entry) => {
        entry.moving = { from: base.source, to: target, since: now.toISOString(), until: new Date(now.getTime() + MOVE_WINDOW_MS).toISOString() };
      });
      let closeError: Error | undefined;
      try {
        if (child.tabId) await sourceClient.tabClose(child.tabId);
        else await sourceClient.paneClose(child.paneId);
      } catch (error) {
        closeError = error as Error;
      }
      const stillLive = (await sourceClient.agentList()).find((pane) => pane.paneId === child.paneId || holdsSession(pane, sourceSession));
      if (stillLive) throw new Error(closeError ? `its tab on ${where(base.source)} could not be closed: ${closeError.message}` : `its session still runs in pane ${stillLive.paneId} on ${where(base.source)} after its tab closed`);
      stage = 'stopped';

      // The harness may write its last lines as it exits, so read the session once more.
      const after = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
      if (!sameBundle(bundle, after)) {
        stage = 'recopied';
        await copy(after);
        log(`move: ${child.name}'s session grew as it stopped, so it was copied again and verified, ${bytes} bytes`);
      }

      // 6. Start the child on the target, resuming the copy, under the same id and name.
      const at = new Date().toISOString();
      const moved: ChildRecord = { ...(readParent(parentId)?.children.find((entry) => entry.id === child.id) ?? child), host: target, cwd: targetCwd, session: targetSession(harness, resumable, sessionFile), exitedAt: at };
      delete moved.transcript;
      delete moved.transcriptMissing;
      // A workspace id belongs to the source machine's herdr. A child with a
      // workspace of its own gets a new one on the target, under the same label.
      delete moved.workspaceId;
      upsertChild(parentId, moved);
      const parent = readParent(parentId);
      if (!parent) throw new Error(`the registry for ${parentId} disappeared`);
      const resumed = await resumeChild(targetClient, parent, { child: moved, session: { kind: harness === 'pi' ? 'path' : 'id', value: moved.session?.value ?? '' } }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs });
      started = resumed.child;
      stage = 'started';
      // A child that cannot report from its new machine has not fully arrived.
      if (resumed.reportWarning) throw new Error(resumed.reportWarning);
    } catch (error) {
      const failure = (error as Error).message;
      const plan = rollbackPlan(stage);
      const notes: string[] = [];
      if (plan.closeTarget && started) {
        await targetClient.tabClose(started.tabId ?? started.paneId).catch((fault: unknown) => notes.push(`its new tab on ${where(target)} could not be closed: ${(fault as Error).message}`));
        if (target !== LOCAL_HOST) await deps.cleanupRemote?.({ ...started, host: target }).catch(() => {});
        else removeChildFiles(child.id);
      }
      if (plan.discardTarget && written.size) {
        await targetEnd.discard({ childId: settle.childId, files: settle.files() }).catch((fault: unknown) => notes.push(`the copy on ${where(target)} could not be removed: ${(fault as Error).message}`));
      }
      let restoredPane: string | undefined;
      let rollbackError: string | undefined;
      if (plan.restartSource) {
        // 7. The session on the source was never touched, so the child resumes there.
        const at = new Date().toISOString();
        updateChild(parentId, child.id, (entry) => {
          entry.host = base.source;
          if (child.cwd) entry.cwd = child.cwd;
          else delete entry.cwd;
          if (child.session) entry.session = child.session;
          if (child.transcript) entry.transcript = child.transcript;
          else delete entry.transcript;
          if (child.transcriptMissing) entry.transcriptMissing = child.transcriptMissing;
          entry.paneId = child.paneId;
          if (child.tabId) entry.tabId = child.tabId;
          entry.exitedAt = entry.exitedAt ?? at;
        });
        const restored = readParent(parentId)?.children.find((entry) => entry.id === child.id);
        const parent = readParent(parentId);
        try {
          if (!restored || !parent) throw new Error('the child record disappeared');
          const back = await resumeChild(sourceClient, parent, { child: restored, session: sourceSession }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs });
          restoredPane = back.child.paneId;
          // A resume clears a retirement request, and a child that never left keeps its own.
          updateChild(parentId, child.id, (entry) => {
            if (child.retireRequestedAt) entry.retireRequestedAt = child.retireRequestedAt;
            if (child.retireIntent) entry.retireIntent = child.retireIntent;
          });
        } catch (fault) {
          rollbackError = (fault as Error).message;
        }
      }
      updateChild(parentId, child.id, (entry) => {
        delete entry.moving;
      });
      const outcome = rollbackError ? 'stranded' : plan.restartSource ? 'rolled-back' : 'abandoned';
      appendMoveLog({ at: new Date().toISOString(), parent: parentId, child: child.id, name: child.name, harness, outcome, from: base.source, to: target, stage, reason: request.reason, error: failure, ...(rollbackError ? { rollbackError } : {}), ...(notes.length ? { notes } : {}) });
      log(`move: ${child.name} to ${where(target)} failed at ${stage}: ${failure}`);
      const lead = `Moving ${child.name} to ${where(target)} failed after the step "${stage}": ${failure}.`;
      const tail = notes.length ? ` Also: ${notes.join('; ')}.` : '';
      if (!plan.restartSource) throw new MoveFailedError(`${lead} Nothing was stopped: ${child.name} still runs on ${where(base.source)} in pane ${child.paneId}${written.size ? `, and the copy on ${where(target)} was removed` : ''}.${tail}`, stage);
      if (rollbackError) {
        throw new MoveFailedError(`${lead} Bellwether then tried to start it again on ${where(base.source)}, and that failed too: ${rollbackError}. ${child.name} is stopped, and its session is intact on ${where(base.source)} at ${bundle.sourceFile}. Call agent_spawn with resume ${child.name} to bring it back there.${tail}`, stage);
      }
      throw new MoveFailedError(`${lead} Bellwether rolled it back: ${child.name} runs again on ${where(base.source)} in pane ${restoredPane}, from its session there, as the same child ${child.id}.${tail}`, stage, restoredPane);
    }

    // 8. Keep the copy, tidy the machine the child left, and point the record at its new host.
    await targetEnd.commit({ childId: settle.childId, files: settle.files() }).catch((error: unknown) => log(`move: the backups on ${where(target)} stay: ${(error as Error).message}`));
    if (base.source === LOCAL_HOST) removeChildFiles(child.id);
    else await deps.cleanupRemote?.({ ...child, host: base.source }).catch((error: unknown) => log(`move: could not remove ${child.name}'s files on ${where(base.source)}: ${(error as Error).message}`));
    const movedAt = new Date().toISOString();
    updateChild(parentId, child.id, (entry) => {
      delete entry.moving;
      entry.movedFrom = { host: base.source, at: movedAt };
    });
    appendMoveLog({ at: movedAt, parent: parentId, child: child.id, name: child.name, harness, outcome: 'moved', from: base.source, to: target, reason: request.reason, sourceFile: bundle.sourceFile, targetFile: sessionFile, cwd: targetCwd, bytes, pane: started?.paneId });
    log(`move: ${child.name} moved from ${where(base.source)} to ${where(target)}, pane ${started?.paneId}${request.reason ? `, because ${request.reason}` : ''}`);
    const saved = readParent(parentId)?.children.find((entry) => entry.id === child.id) ?? (started as ChildRecord);
    return { child: saved, from: base.source, to: target, sessionFile, bytes, link: herdrLink('pane', saved.paneId) };
  }, undefined, undefined, { action: 'moved' });
}
