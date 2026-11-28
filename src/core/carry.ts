// Carrying a child's session to another machine under the same child id. Both
// agent_move and agent_teleport (issue #226) run these steps, in an order
// where each one is safe to fail, and each supplies its own policy: what it
// refuses, whether it tells the child, and which log takes the outcome.
//
//   1. Resolve both ends: the child's machine and harness, the destination,
//      and the session on the source. Refuse on anything the policy names,
//      and on work the child would leave behind (issue #224), before touching
//      anything.
//   2. Copy the session to the destination, where its harness looks for it
//      from the directory the child resumes in there, and verify every byte.
//   3. For a live child, stop its tab on the source, so the session is never
//      live twice, and copy again if its last moments added to it. A stopped
//      child has no tab to stop.
//   4. Start the child at the destination, resuming the copy, under the same
//      id and name, with the policy's notice as its first input.
//   5. When the start fails, put a live child back on its source from the
//      session still there, and leave a stopped one stopped as it was.
//   6. Commit the copy, point the record, and so the relay, at the new host,
//      and append the outcome to the policy's log.
import { noticeTaken, withMessagesOf } from './delivery.ts';
import { authorityFor } from './authority.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withChildLock } from './child-lock.ts';
import { recordDeparture } from './departures.ts';
import { harnessFor } from './harnesses/index.ts';
import { missingIntegration } from './herdr-integration.ts';
import { LOCAL_HOST, hostOf, type ClientFor } from './machine.ts';
import { removeChildFiles } from './mcp-config.ts';
import type { EndpointFor } from './move-endpoint.ts';
import { leftBehindLines } from './move-leftovers.ts';
import { isMoving, pickTarget, rewriteForTarget, rollbackPlan, sha256, type MovableHarness, type MoveStage } from './move-plan.ts';
import { childById, listParents, readParent, updateChild, upsertChild } from './registry.ts';
import { holdsSession, resumeChild, sessionOf, type HarnessSession, type NoticeOutcome } from './resume.ts';
import type { Inbox } from './send.ts';
import type { ImportResult, ProbeResult, SessionBundle } from './session-state.ts';
import { harnessOf, herdrLink, type RegisterRemote } from './spawn.ts';
import { processInfoOf } from './start-check.ts';
import { teleportState, type TeleportRefusalInput, type TeleportState } from './teleport-plan.ts';
import type { ChildRecord, Crossing } from './types.ts';
import { crossingFailed, relocated, runEnds, viewOf } from './incarnation.ts';
import { crossingBegun, crossingEnded, crossingStep } from './requests.ts';
import { keepRetirement } from './retire.ts';

/** How long the watcher ignores the old pane's close. Longer than any carry: two copies, a stop and a start. */
export const MOVE_WINDOW_MS = 15 * 60_000;

/**
 * This daemon process, as a crossing's mark names it. A daemon that finds a
 * mark naming another process knows that process stopped mid-crossing, since
 * one daemon runs per machine and a new one starts only once the old one is
 * gone.
 */
export const DAEMON_INSTANCE = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export interface CarryRequest {
  /** The child's name, id or pane. */
  child: string;
  /** The destination: `local`, or a saved herdr machine. Inferred when exactly one other is known. */
  machine?: string;
  /** The directory the child resumes in at the destination. Defaults to the one it runs in now. */
  cwd?: string;
  /** The harness asked for at the destination, as a kind. Anything but the child's own is refused. */
  kind?: string;
  /** Why the child crosses, for the log. */
  reason?: string;
  /**
   * Cross even though the child would leave work behind on the source: a
   * background job that ends with its session there, or a worktree it worked
   * in that holds uncommitted changes or unpushed commits. The reply names each.
   */
  acceptLoss?: boolean;
}

export interface CarryDeps {
  clientFor: ClientFor;
  endpointFor: EndpointFor;
  /** The hosts a child can run on, for a request that names no machine. */
  knownHosts: () => Promise<string[]>;
  /** Register a child on its machine again, so its reports come back from there. */
  registerRemote?: RegisterRemote;
  /** Remove what a registration wrote on a machine the child left. */
  cleanupRemote?: (child: ChildRecord) => Promise<void>;
  log?: (line: string) => void;
  /** How long the startup dialogs may take. Tests shorten it. */
  startupTimeoutMs?: number;
  redrawMs?: number;
  /** The daemon's way into the child's session, for a policy that tells the child. */
  inbox?: Inbox;
  /** Who asked, as the record and the logs keep it: a parent's id, or `self`. */
  by?: string;
  /** Who sends the notice, as the child's session shows the sender. */
  from?: string;
}

/** What a policy needs to word its notice. */
export interface CarryPlaces {
  source: string;
  target: string;
  sourceCwd: string;
  targetCwd: string;
  at: string;
  by: string;
  reason?: string;
  state: TeleportState;
}

/** What agent_move and agent_teleport each decide on their own. */
export interface CarryPolicy {
  /** `move` or `teleport`, for the lock, the log lines and the messages. */
  verb: 'move' | 'teleport';
  /** Every reason the carry must not start, from the facts found so far. */
  refuse: (facts: TeleportRefusalInput) => string[];
  /** Facts the policy finds before any machine is read, such as the destination's inbound path. */
  early?: (child: ChildRecord, target: string) => Promise<Partial<TeleportRefusalInput>>;
  /** The notice the child reads as its first input at the destination. Without it, the child is told nothing. */
  notice?: (places: CarryPlaces) => string;
  refused: (childName: string, target: string, reasons: string[]) => Error;
  failed: (message: string, stage: MoveStage, restoredPane?: string) => Error;
  /** The file each outcome goes to, one JSON line each. */
  logPath: () => string;
  /** The outcome a carry that started the child records. */
  outcome: (notice: NoticeOutcome | undefined) => string;
}

export interface CarryResult {
  child: ChildRecord;
  state: TeleportState;
  from: { host: string; cwd: string; paneId?: string };
  to: { host: string; cwd: string; paneId: string };
  /** When the carry was asked for. */
  at: string;
  by: string;
  /** The session file the child resumed at the destination. */
  sessionFile: string;
  /** The bytes that crossed, every file of the session together. */
  bytes: number;
  /** What stayed on the source because the caller accepted the loss, one line each. */
  leftBehind: string[];
  notice?: NoticeOutcome;
  link: string;
}

export function where(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

/** `local` and an empty name mean this machine. */
function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === 'local' ? LOCAL_HOST : trimmed;
}

/** A session file, rewritten for its destination and summed, as the destination must read it back. */
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

/** Every file the destination wrote must match what was sent, byte count and checksum, and none may be missing. */
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

async function probeOrRefuse(endpoint: ReturnType<EndpointFor>, request: Parameters<ReturnType<EndpointFor>['probe']>[0]): Promise<ProbeResult | string> {
  try {
    return await endpoint.probe(request);
  } catch (error) {
    return `Bellwether could not read ${where(endpoint.host)}: ${(error as Error).message}`;
  }
}

export async function carryChild(deps: CarryDeps, parentId: string, request: CarryRequest, policy: CarryPolicy): Promise<CarryResult> {
  const log = deps.log ?? (() => {});
  const verb = policy.verb;
  const appendLog = (line: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(policy.logPath()), { recursive: true });
    fs.appendFileSync(policy.logPath(), `${JSON.stringify(line)}\n`);
  };
  const first = readParent(parentId);
  if (!first) throw new Error(`No Bellwether registry for ${parentId}.`);
  const found = childById(first, request.child);
  if (!found) throw new Error(`No child of this session matches "${request.child}". Call agent_list to see them.`);
  const source = hostOf(found);
  const target = normalizeHost(request.machine) ?? pickTarget(await deps.knownHosts(), source);
  const by = deps.by ?? parentId;

  return withChildLock(found.id, `${found.name} (child ${found.id})`, `${verb} to ${target}`, async () => {
    // Read the record again under the lock: a resume or a move that held it may have changed it.
    const child = readParent(parentId)?.children.find((entry) => entry.id === found.id) ?? found;
    const original: ChildRecord = structuredClone(child);
    const askedAt = new Date();
    const state = teleportState(child);
    const session = sessionOf(child);
    const cwd = request.cwd?.trim() || child.cwd;
    const requestedHarness = request.kind ? harnessOf(request.kind) : undefined;
    const moveInFlight = child.moving && isMoving(child, askedAt.getTime()) ? { to: child.moving.to, since: child.moving.since } : undefined;

    // 1. What can be refused from the record alone is refused before any machine is read.
    // With no session, herdr on the child's machine says whether its integration for the harness is why.
    const missing = session ? undefined : await missingIntegration(await deps.clientFor(source).catch(() => undefined), harnessFor(child.kind));
    const base: TeleportRefusalInput = {
      childName: child.name,
      harness: child.harness,
      requestedHarness,
      status: child.lastStatus,
      state,
      ...authorityFor(child, policy.verb, target),
      source,
      target,
      moveInFlight,
      hasSession: Boolean(session),
      ...(child.route ? { route: child.route.name } : {}),
      ...(missing ? { missingIntegration: missing } : {}),
      ...(policy.early ? await policy.early(child, target) : {}),
    };
    const early = policy.refuse(base);
    if (!cwd && early.length === 0) early.push(`${child.name} has no recorded working directory, so Bellwether cannot tell where it resumes on ${where(target)}. Pass cwd.`);
    if (early.length) throw policy.refused(child.name, target, early);
    const harness = child.harness as MovableHarness;
    const entry = harnessFor(child.kind);
    // The copy resumes as the harness names its session: by the file, or by the id.
    const byPath = entry?.session.from === 'herdr' && entry.session.kind === 'path';
    const resumable = session as HarnessSession;
    const targetCwd = cwd as string;

    const sourceEnd = deps.endpointFor(source);
    const targetEnd = deps.endpointFor(target);
    // The source tells the harness from a background job by the pane's shell and foreground process, which herdr there knows.
    const pane = state === 'live'
      ? await deps
          .clientFor(source)
          .then((client) => client.request('pane.process_info', { pane_id: child.paneId }))
          .then(processInfoOf)
          .catch(() => undefined)
      : undefined;
    // A worktree another live child stands in is that child's work, not this one's.
    const others = listParents().flatMap((parent) => parent.children.filter((other) => other.id !== child.id && !other.exitedAt && hostOf(other) === source && other.cwd).map((other) => other.cwd as string));
    const leftBehindRequest = { childId: child.id, harness, session: resumable.value, ...(child.cwd ? { cwd: child.cwd } : {}), ...(pane ? { pane } : {}), others };
    const [sourceProbe, targetProbe] = await Promise.all([probeOrRefuse(sourceEnd, { harnesses: [harness], leftBehind: leftBehindRequest }), probeOrRefuse(targetEnd, { harnesses: [harness], cwd: targetCwd, piModels: entry?.chosenBy === 'pair' })]);
    const unreachable = [sourceProbe, targetProbe].filter((probe): probe is string => typeof probe === 'string');
    if (unreachable.length) throw policy.refused(child.name, target, unreachable);
    const sourceInfo = sourceProbe as ProbeResult;
    const targetInfo = targetProbe as ProbeResult;

    let bundle: SessionBundle;
    try {
      bundle = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
    } catch (error) {
      throw policy.refused(child.name, target, [`Bellwether could not read ${child.name}'s session on ${where(source)}: ${(error as Error).message}`]);
    }
    const refusals = policy.refuse({
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
    // A session crosses, and its processes and worktrees do not (issue #224).
    const leftBehind = leftBehindLines(child.name, where(source), sourceInfo.leftBehind, sourceInfo.bellwether);
    if (!request.acceptLoss) refusals.push(...leftBehind);
    if (refusals.length) throw policy.refused(child.name, target, refusals);

    const sourceClient = await deps.clientFor(source);
    const targetClient = await deps.clientFor(target);
    let stage: MoveStage = 'checked';
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
      // A file the first copy created stays created, whatever the second finds.
      for (const file of result.files) written.set(file.path, { path: file.path, created: written.get(file.path)?.created ?? file.created });
      mark({ files: settle.files() });
      verifyCopy(prepared, result, target);
      sessionFile = result.sessionFile;
      bytes = prepared.reduce((sum, file) => sum + file.bytes, 0);
    };
    const settle = { childId: child.id, files: () => [...written.values()] };
    const noticeText = policy.notice?.({ source, target, sourceCwd: child.cwd ?? targetCwd, targetCwd, at: askedAt.toISOString(), by, ...(request.reason ? { reason: request.reason } : {}), state });

    // The mark keeps a resume, a restart and the watcher off the child while it
    // crosses, and tells a daemon that starts after this one stopped how far the
    // crossing got, so it can finish or undo it (recover.ts).
    const mark = (change: Partial<Crossing>): void => {
      updateChild(parentId, child.id, (record) => {
        crossingStep(record, DAEMON_INSTANCE, change);
      });
    };
    updateChild(parentId, child.id, (record) => {
      crossingBegun(record, {
        from: source,
        to: target,
        since: askedAt.toISOString(),
        until: new Date(askedAt.getTime() + MOVE_WINDOW_MS).toISOString(),
        verb,
        daemon: DAEMON_INSTANCE,
        stage: 'checked',
        state,
        source: { ...(child.cwd ? { cwd: child.cwd } : {}), paneId: child.paneId, ...(child.tabId ? { tabId: child.tabId } : {}), ...(child.workspaceId ? { workspaceId: child.workspaceId } : {}), ...(child.session ? { session: child.session } : {}), ...(child.transcript ? { transcript: child.transcript } : {}), ...(child.exitedAt ? { exitedAt: child.exitedAt } : {}) },
        target: { cwd: targetCwd },
        sourceFile: bundle.sourceFile,
        by,
        ...(request.reason ? { reason: request.reason } : {}),
      });
    });

    try {
      // 2. Copy and verify, while a live child still runs on the source.
      stage = 'copied';
      await copy(bundle);
      stage = 'verified';
      const targetSession = byPath ? { kind: 'path', value: sessionFile } : { kind: 'id', value: resumable.value };
      mark({ stage, files: settle.files(), target: { cwd: targetCwd, session: targetSession } });
      log(`${verb}: ${child.name} copied to ${where(target)} and verified, ${bytes} bytes`);

      // 3. Stop a live child, so the session is never live twice. The watcher ignores this close.
      if (state === 'live') {
        let closeError: Error | undefined;
        try {
          if (child.tabId) await sourceClient.tabClose(child.tabId);
          else await sourceClient.paneClose(child.paneId);
        } catch (error) {
          closeError = error as Error;
        }
        const stillLive = (await sourceClient.agentList()).find((other) => other.paneId === child.paneId || holdsSession(other, resumable));
        if (stillLive) throw new Error(closeError ? `its tab on ${where(source)} could not be closed: ${closeError.message}` : `its session still runs in pane ${stillLive.paneId} on ${where(source)} after its tab closed`);
        stage = 'stopped';
        mark({ stage });

        // The harness may write its last lines as it exits, so read the session once more.
        const after = await sourceEnd.exportSession({ harness, session: resumable.value, cwd: child.cwd });
        if (!sameBundle(bundle, after)) {
          stage = 'recopied';
          await copy(after);
          mark({ stage, files: settle.files() });
          log(`${verb}: ${child.name}'s session grew as it stopped, so it was copied again and verified, ${bytes} bytes`);
        }
      }

      // 4. Start the child at the destination, resuming the copy, under the same id and name.
      const at = new Date().toISOString();
      const moved: ChildRecord = { ...(readParent(parentId)?.children.find((record) => record.id === child.id) ?? child) };
      relocated(moved, { host: target, cwd: targetCwd, session: byPath ? { kind: 'path', value: sessionFile } : { kind: 'id', value: resumable.value } });
      // The run on the source ended when its tab closed, or before, for a stopped child.
      runEnds(moved, { at: child.exitedAt ?? at });
      delete moved.transcript;
      delete moved.transcriptMissing;
      // A workspace id belongs to the source machine's herdr. A child with a
      // workspace of its own gets a new one at the destination, under the same label.
      delete moved.workspaceId;
      upsertChild(parentId, moved);
      const parent = readParent(parentId);
      if (!parent) throw new Error(`the registry for ${parentId} disappeared`);
      // The mark names the destination's tab before the launch line goes into
      // it. herdr reports the harness only once it loads, so a daemon that
      // stops in between leaves a session the next one cannot see there, and
      // would resume a second copy on the source unless it closes this tab.
      const onTab = (tab: { paneId: string; tabId?: string }): void => {
        stage = 'launching';
        mark({ stage, target: { cwd: targetCwd, session: targetSession, paneId: tab.paneId, ...(tab.tabId ? { tabId: tab.tabId } : {}) } });
      };
      const resumed = await resumeChild(targetClient, parent, { child: moved, session: { kind: byPath ? 'path' : 'id', value: moved.session?.value ?? '' } }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs, onTab, ...(noticeText === undefined ? {} : { inbox: deps.inbox, from: deps.from ?? by, notice: noticeText }) });
      started = resumed.child;
      notice = resumed.notice;
      stage = 'started';
    } catch (error) {
      const failure = (error as Error).message;
      const plan = rollbackPlan(stage);
      const notes: string[] = [];
      if (plan.closeTarget && started) {
        await targetClient.tabClose(started.tabId ?? started.paneId).catch((fault: unknown) => notes.push(`its new tab on ${where(target)} could not be closed: ${(fault as Error).message}`));
        if (target !== LOCAL_HOST) await deps.cleanupRemote?.(viewOf(started, { host: target })).catch(() => {});
        else removeChildFiles(child.id);
      }
      if (plan.discardTarget && written.size) {
        await targetEnd.discard({ childId: settle.childId, files: settle.files() }).catch((fault: unknown) => notes.push(`the copy on ${where(target)} could not be removed: ${(fault as Error).message}`));
      }
      // The record goes back to what it was before the carry: the source's host,
      // directory and session. Messages sent since keep their place on it.
      const current = readParent(parentId)?.children.find((record) => record.id === child.id);
      upsertChild(parentId, withMessagesOf(original, current));
      // A live child that was stopped resumes on the source, whose session the carry never touched.
      const restart = plan.restartSource && state === 'live';
      let restoredPane: string | undefined;
      let rollbackError: string | undefined;
      const reopen = `agent_spawn with resume ${child.name}, which resumes it on ${where(source)} from ${bundle.sourceFile}`;
      if (restart) {
        // Until the resume names a pane on the source, the record says the
        // child runs on neither machine, so a daemon that stops in between
        // leaves a record doctor names rather than one nothing repairs.
        updateChild(parentId, child.id, (record) => {
          const at = new Date().toISOString();
          runEnds(record, { at });
          crossingFailed(record, { at, verb, from: source, to: target, stage, error: `${failure.replace(/\.$/, '')}; the daemon stopped before it started it again on ${where(source)}`, sourceFile: bundle.sourceFile, reopen, interrupted: true });
        });
        const restored = readParent(parentId)?.children.find((record) => record.id === child.id);
        const parent = readParent(parentId);
        try {
          if (!restored || !parent) throw new Error('the child record disappeared');
          const back = await resumeChild(sourceClient, parent, { child: restored, session: resumable }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs });
          restoredPane = back.child.paneId;
          // A resume clears a retirement request, and a child that never left keeps its own.
          updateChild(parentId, child.id, (record) => keepRetirement(record, original));
        } catch (fault) {
          rollbackError = (fault as Error).message;
        }
      }
      updateChild(parentId, child.id, (record) => {
        crossingEnded(record, { ran: false, reason: `the ${verb} failed after the step "${stage}": ${failure.replace(/\.$/, '')}` });
        // A child that runs on neither machine says so until it runs again.
        if (rollbackError) crossingFailed(record, { at: new Date().toISOString(), verb, from: source, to: target, stage, error: `${failure.replace(/\.$/, '')}; starting it again on ${where(source)} failed too: ${rollbackError}`, sourceFile: bundle.sourceFile, reopen });
      });
      const outcome = rollbackError ? 'stranded' : restart ? 'rolled-back' : 'abandoned';
      appendLog({ at: new Date().toISOString(), parent: parentId, child: child.id, name: child.name, harness, state, outcome, from: source, to: target, stage, by, reason: request.reason, error: failure, ...(rollbackError ? { rollbackError } : {}), ...(notes.length ? { notes } : {}) });
      log(`${verb}: ${child.name} to ${where(target)} failed at ${stage}: ${failure}`);
      const lead = `${verb === 'move' ? 'Moving' : 'Teleporting'} ${child.name} to ${where(target)} failed after the step "${stage}": ${failure.replace(/\.$/, '')}.`;
      const tail = notes.length ? ` Also: ${notes.join('; ')}.` : '';
      const copyGone = written.size ? `, and the copy on ${where(target)} was removed` : '';
      if (state === 'stopped') throw policy.failed(`${lead} ${child.name} stays stopped on ${where(source)}, with its record as it was${copyGone}.${tail}`, stage);
      if (!restart) throw policy.failed(`${lead} Nothing was stopped: ${child.name} still runs on ${where(source)} in pane ${child.paneId}${copyGone}.${tail}`, stage);
      if (rollbackError) throw policy.failed(`${lead} Bellwether then tried to start it again on ${where(source)}, and that failed too: ${rollbackError}. ${child.name} is stopped, and its session is intact on ${where(source)} at ${bundle.sourceFile}. Call agent_spawn with resume ${child.name} to bring it back there.${tail}`, stage);
      throw policy.failed(`${lead} Bellwether rolled it back: ${child.name} runs again on ${where(source)} in pane ${restoredPane}, from its session there, as the same child ${child.id}.${tail}`, stage, restoredPane);
    }

    // 6. Keep the copy, tidy the machine the child left, and point the record at its new host.
    await targetEnd.commit({ childId: settle.childId, files: settle.files() }).catch((error: unknown) => log(`${verb}: the backups on ${where(target)} stay: ${(error as Error).message}`));
    if (source === LOCAL_HOST) removeChildFiles(child.id);
    else await deps.cleanupRemote?.(viewOf(child, { host: source })).catch((error: unknown) => log(`${verb}: could not remove ${child.name}'s files on ${where(source)}: ${(error as Error).message}`));
    const doneAt = new Date().toISOString();
    updateChild(parentId, child.id, (record) => {
      crossingEnded(record, { ran: true });
      recordDeparture(record, { host: source, at: doneAt, ...(child.cwd ? { cwd: child.cwd } : {}), verb, ...(request.reason ? { reason: request.reason } : {}) });
    });
    const outcome = policy.outcome(notice);
    const untold = notice && !noticeTaken(notice) ? (notice.notTaken ?? notice.delivery.unanswered ?? 'Bellwether did not see its model read it and begin a turn on it') : undefined;
    appendLog({ at: doneAt, parent: parentId, child: child.id, name: child.name, harness, state, outcome, from: source, to: target, by, reason: request.reason, sourceFile: bundle.sourceFile, targetFile: sessionFile, cwd: targetCwd, bytes, pane: started?.paneId, ...(leftBehind.length && request.acceptLoss ? { leftBehind } : {}), ...(untold ? { undelivered: untold } : {}) });
    log(`${verb}: ${child.name} ${outcome} from ${where(source)} to ${where(target)}, pane ${started?.paneId}${request.reason ? `, because ${request.reason}` : ''}${untold ? `, not told: ${untold}` : ''}`);
    const saved = readParent(parentId)?.children.find((record) => record.id === child.id) ?? (started as ChildRecord);
    return {
      child: saved,
      state,
      from: { host: source, cwd: child.cwd ?? '', ...(child.paneId ? { paneId: child.paneId } : {}) },
      to: { host: target, cwd: targetCwd, paneId: saved.paneId },
      at: askedAt.toISOString(),
      by,
      sessionFile,
      bytes,
      leftBehind: request.acceptLoss ? leftBehind : [],
      ...(notice ? { notice } : {}),
      link: herdrLink('pane', saved.paneId),
    };
  }, undefined, undefined, { action: verb === 'move' ? 'moved' : 'teleported' });
}
