// Finishing or undoing a move or a teleport that a daemon left half done
// (issue #226). carry.ts marks the child record before it copies anything,
// and updates the mark at each step with the files it wrote at the
// destination and where the child ran before. When a daemon starts and finds
// a mark that another daemon process wrote, that process stopped in the
// middle of the crossing, because a machine runs one daemon at a time.
//
// The decision comes from what the machines show, not from the step alone,
// because the old daemon may have stopped between an act and the mark that
// records it:
//
//   - The destination runs the session: the crossing got that far, so it is
//     finished. The record points at the destination, and the copy stays.
//   - The destination does not run it: the crossing is undone. The copy goes,
//     and the record points at the source again. A child that ran when the
//     crossing began and no longer runs on the source resumes there, from its
//     session, which a crossing never changes. A child that was stopped stays
//     stopped.
//   - The crossing had opened a tab at the destination and typed the launch
//     line there (the step `launching`): herdr reports a harness only once it
//     loads, so a session can be on its way up there although no pane holds
//     it yet. The undo closes that tab first, and changes nothing when it
//     cannot, so the session never runs on both machines.
//   - Either machine cannot be read: nothing changes, because rolling back a
//     session that might run at the destination could run it twice. The mark
//     stays for the next start, and doctor shows it.
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_INSTANCE, where, type CarryDeps } from './carry.ts';
import { withChildLock } from './child-lock.ts';
import { recordDeparture } from './departures.ts';
import type { HerdrPane } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';
import { removeChildFiles } from './mcp-config.ts';
import { bellwetherHome } from './paths.ts';
import { readParent, updateChild } from './registry.ts';
import { holdsSession, resumeChild, type HarnessSession } from './resume.ts';
import type { ChildRecord, Crossing, ParentRecord } from './types.ts';
import { crossingFailed, relocated, releaseEvents, runContinues, runEnds, runStarts, viewOf } from './incarnation.ts';

/** What a recovery did with one crossing, for the daemon log and the tests. */
export interface Recovery {
  childId: string;
  name: string;
  outcome: 'finished' | 'undone' | 'resumed' | 'stranded' | 'unknown';
  detail: string;
}

function logPath(crossing: Crossing): string {
  return path.join(bellwetherHome(), crossing.verb === 'teleport' ? 'teleport.log' : 'move.log');
}

function appendLog(crossing: Crossing, line: Record<string, unknown>): void {
  const file = logPath(crossing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** A mark another daemon process wrote, which that process can no longer finish. */
export function interrupted(child: Pick<ChildRecord, 'moving'>, instance = DAEMON_INSTANCE): boolean {
  return Boolean(child.moving?.daemon && child.moving.daemon !== instance);
}

/** Finish or undo every crossing of this parent's children that another daemon process left behind. */
export async function recoverCrossings(deps: CarryDeps, parentId: string, instance = DAEMON_INSTANCE): Promise<Recovery[]> {
  const parent = readParent(parentId);
  if (!parent) return [];
  const done: Recovery[] = [];
  for (const child of parent.children.filter((entry) => interrupted(entry, instance))) {
    try {
      const recovery = await withChildLock(child.id, `${child.name} (child ${child.id})`, 'recover an interrupted crossing', () => recoverOne(deps, parentId, child.id, instance), undefined, undefined, { action: 'recovered' });
      if (recovery) done.push(recovery);
    } catch (error) {
      done.push({ childId: child.id, name: child.name, outcome: 'unknown', detail: (error as Error).message });
    }
  }
  for (const recovery of done) deps.log?.(`crossing of ${recovery.name} (child ${recovery.childId}): ${recovery.outcome}: ${recovery.detail}`);
  return done;
}

async function holding(deps: CarryDeps, host: string, session: { kind: string; value: string } | undefined): Promise<HerdrPane | undefined | 'unreadable'> {
  if (!session) return undefined;
  try {
    const client = await deps.clientFor(host);
    const wanted: HarnessSession = { kind: session.kind === 'path' ? 'path' : 'id', value: session.value };
    return (await client.agentList()).find((pane) => holdsSession(pane, wanted));
  } catch {
    return 'unreadable';
  }
}

/**
 * Close the tab a crossing opened at the destination, which may hold a harness
 * herdr has yet to report. A pane that is gone, or that now runs another
 * session, is not the crossing's to close. Returns why it could not close the
 * tab, or undefined once no pane of the crossing's is left there.
 */
async function closeOpened(deps: CarryDeps, host: string, target: NonNullable<Crossing['target']>): Promise<string | undefined> {
  const paneId = target.paneId as string;
  const session: HarnessSession | undefined = target.session ? { kind: target.session.kind === 'path' ? 'path' : 'id', value: target.session.value } : undefined;
  const ours = (pane: HerdrPane): boolean => pane.paneId === paneId && (!target.tabId || pane.tabId === target.tabId) && (!pane.agentSessionId || (session !== undefined && holdsSession(pane, session)));
  try {
    const client = await deps.clientFor(host);
    if (!(await client.paneList()).some(ours)) return undefined;
    const fault = await (target.tabId ? client.tabClose(target.tabId) : client.paneClose(paneId)).then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    if ((await client.paneList()).some(ours)) return `its tab there, pane ${paneId}, did not close${fault ? `: ${fault}` : ''}`;
    return undefined;
  } catch (error) {
    return `it could not be read: ${(error as Error).message}`;
  }
}

async function recoverOne(deps: CarryDeps, parentId: string, childId: string, instance: string): Promise<Recovery | undefined> {
  // Read again under the lock: another start of this daemon may have finished it.
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const crossing = child?.moving;
  if (!child || !crossing || !interrupted(child, instance)) return undefined;
  const verb = crossing.verb ?? 'move';
  const at = new Date().toISOString();
  const base = { at, parent: parentId, child: child.id, name: child.name, harness: child.harness, state: crossing.state, from: crossing.from, to: crossing.to, stage: crossing.stage, recovered: true };

  // 1. The destination runs the session: the crossing is finished.
  const there = await holding(deps, crossing.to, crossing.target?.session);
  if (there === 'unreadable') return { childId, name: child.name, outcome: 'unknown', detail: `${where(crossing.to)} could not be read, so Bellwether cannot tell whether the session runs there, and changed nothing. It tries again when the daemon next starts.` };
  if (there) {
    await deps.endpointFor(crossing.to).commit({ childId, files: crossing.files ?? [] }).catch(() => {});
    if (crossing.from === LOCAL_HOST) removeChildFiles(childId);
    else await deps.cleanupRemote?.(viewOf(child, { host: crossing.from })).catch(() => {});
    updateChild(parentId, childId, (entry) => {
      relocated(entry, { host: crossing.to, ...(crossing.target ? { cwd: crossing.target.cwd } : {}), ...(crossing.target?.session ? { session: crossing.target.session } : {}) });
      // The session runs at the destination: a new run, and nothing of the source's stays.
      runStarts(entry, { paneId: there.paneId, tabId: there.tabId || undefined, status: there.agentStatus });
      if (there.workspaceId) entry.workspaceId = there.workspaceId;
      else delete entry.workspaceId;
      delete entry.transcript;
      recordDeparture(entry, { host: crossing.from, at, ...(crossing.source?.cwd ? { cwd: crossing.source.cwd } : {}), verb, ...(crossing.reason ? { reason: crossing.reason } : {}) });
      delete entry.moving;
    });
    appendLog(crossing, { ...base, outcome: verb === 'teleport' ? 'teleported-untold' : 'moved', pane: there.paneId, ...(verb === 'teleport' ? { undelivered: 'the daemon that ran the teleport stopped before it saw the notice taken' } : {}) });
    return { childId, name: child.name, outcome: 'finished', detail: `the session runs in pane ${there.paneId} on ${where(crossing.to)}, so the ${verb} stands` };
  }

  // 2. It does not run there: undo. A tab the crossing opened there goes
  // first, since its harness may still come up.
  if (crossing.target?.paneId) {
    const left = await closeOpened(deps, crossing.to, crossing.target);
    if (left) return { childId, name: child.name, outcome: 'unknown', detail: `the ${verb} had typed the launch line into a tab on ${where(crossing.to)}, and ${left}, so Bellwether changed nothing rather than run the session on both machines. It tries again when the daemon next starts.` };
  }
  // Is the child still running on the source?
  const source = crossing.source;
  const here = await holding(deps, crossing.from, source?.session);
  if (here === 'unreadable') return { childId, name: child.name, outcome: 'unknown', detail: `${where(crossing.from)} could not be read, so Bellwether cannot tell whether the session still runs there, and changed nothing. It tries again when the daemon next starts.` };
  await deps.endpointFor(crossing.to).discard({ childId, files: crossing.files ?? [] }).catch(() => {});
  if (crossing.to !== LOCAL_HOST) await deps.cleanupRemote?.(viewOf(child, { host: crossing.to })).catch(() => {});
  updateChild(parentId, childId, (entry) => {
    const tab = here ? here.tabId : source?.tabId;
    relocated(entry, { host: crossing.from, ...(source?.cwd ? { cwd: source.cwd } : {}), ...(source?.session ? { session: source.session } : {}), paneId: here ? here.paneId : (source?.paneId ?? entry.paneId), tabId: tab || undefined });
    if (source?.transcript) entry.transcript = source.transcript;
    const workspace = here ? here.workspaceId : source?.workspaceId;
    if (workspace) entry.workspaceId = workspace;
    else delete entry.workspaceId;
    releaseEvents(entry);
    // The source still runs the session: the run never ended. Otherwise it
    // stays stopped where it was, or comes back below through a resume.
    if (here) runContinues(entry);
    else runEnds(entry, { at: source?.exitedAt ?? at });
  });

  if (here || crossing.state === 'stopped') {
    updateChild(parentId, childId, (entry) => {
      delete entry.moving;
    });
    appendLog(crossing, { ...base, outcome: 'abandoned' });
    return { childId, name: child.name, outcome: 'undone', detail: here ? `the session still runs in pane ${here.paneId} on ${where(crossing.from)}, so the copy on ${where(crossing.to)} was removed and nothing else changed` : `the child was stopped before the ${verb} and stays stopped on ${where(crossing.from)}, and the copy on ${where(crossing.to)} was removed` };
  }

  // 3. It ran when the crossing began and runs nowhere now: resume it on the source.
  const reopen = `agent_spawn with resume ${child.name}, which resumes it on ${where(crossing.from)}${crossing.sourceFile ? ` from ${crossing.sourceFile}` : ''}`;
  const restored = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const parent = readParent(parentId) as ParentRecord;
  try {
    if (!restored || !source?.session) throw new Error('the record names no session to resume on the source');
    const client = await deps.clientFor(crossing.from);
    // The mark goes first, or the resume refuses a child that is being moved.
    updateChild(parentId, childId, (entry) => {
      delete entry.moving;
    });
    const back = await resumeChild(client, readParent(parentId) ?? parent, { child: { ...restored, moving: undefined }, session: { kind: source.session.kind === 'path' ? 'path' : 'id', value: source.session.value } }, { registerRemote: deps.registerRemote, cleanupRemote: deps.cleanupRemote, startupTimeoutMs: deps.startupTimeoutMs, redrawMs: deps.redrawMs });
    appendLog(crossing, { ...base, outcome: 'rolled-back', pane: back.child.paneId });
    return { childId, name: child.name, outcome: 'resumed', detail: `the daemon stopped after the child's tab closed and before it ran on ${where(crossing.to)}, so it resumed on ${where(crossing.from)} in pane ${back.child.paneId}, as the same child` };
  } catch (error) {
    const message = (error as Error).message;
    updateChild(parentId, childId, (entry) => {
      delete entry.moving;
      crossingFailed(entry, { at, verb, from: crossing.from, to: crossing.to, stage: crossing.stage ?? 'unknown', error: `the daemon running the ${verb} stopped after the child's tab closed, and resuming it on ${where(crossing.from)} failed: ${message}`, ...(crossing.sourceFile ? { sourceFile: crossing.sourceFile } : {}), reopen, interrupted: true });
    });
    appendLog(crossing, { ...base, outcome: 'stranded', rollbackError: message });
    return { childId, name: child.name, outcome: 'stranded', detail: `it runs on neither machine: ${message}. Bring it back with ${reopen}.` };
  }
}

/** The state a crossing child shows in agent_list and doctor, instead of `exited`: it is unreachable, not gone (issue #219). */
export function crossingState(child: Pick<ChildRecord, 'moving'>): string | undefined {
  const crossing = child.moving;
  if (!crossing) return undefined;
  return `${crossing.verb === 'teleport' ? 'teleporting' : 'moving'} to ${crossing.to === LOCAL_HOST ? 'local' : crossing.to} since ${crossing.since}`;
}

/** doctor's lines for crossings: one under way, one a stopped daemon left behind, and a child that runs on neither machine. */
export function crossingLines(parents: Pick<ParentRecord, 'children'>[], now = Date.now()): string[] {
  const lines: string[] = [];
  for (const child of parents.flatMap((parent) => parent.children)) {
    const crossing = child.moving;
    if (crossing) {
      const stale = Date.parse(crossing.until) <= now;
      const head = `${child.name} (child ${child.id}) is ${crossingState(child)}, from ${where(crossing.from)}${crossing.stage ? `, past the step "${crossing.stage}"` : ''}`;
      lines.push(stale ? `warn  crossing: ${head}, and its window ended at ${crossing.until} with nothing finished. The next daemon start finishes or undoes it from the record.` : `info  crossing: ${head}. It is unreachable until it starts on ${where(crossing.to)}, not exited.`);
    }
    const failed = child.crossingFailed;
    if (failed) lines.push(`fail  crossing: ${child.name} (child ${child.id}) runs on neither machine since ${failed.at}: the ${failed.verb} from ${where(failed.from)} to ${where(failed.to)}, past the step "${failed.stage}", failed: ${failed.error.replace(/\.$/, '')}. Bring it back with ${failed.reopen}.`);
  }
  return lines;
}
