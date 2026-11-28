// The incarnation of a child: everything that describes one run of it in one
// pane (issue #277). This module is the only writer of those fields. Every
// other module reads them, and changes them only through the transitions
// below, so a field's meaning no longer depends on which code path last
// touched it. `test/unit/incarnation-owner.test.ts` fails on a write anywhere
// else, and `ChildRecord` declares each of these fields `readonly`, so the
// typecheck fails on a write through any alias too.
//
// The fields stay flat on the child record, where they have always been,
// rather than moving into a nested object. The registry files, the relay
// answers a far daemon sends (`RelayRestartAnswer.record`), and every daemon
// from an older release read them there. A nested object would need a
// registry migration and a protocol bump, and would leave an older daemon
// that takes over the same registry reading none of them.
//
// Each field has a lifetime, in `LIFETIMES`:
//
//   start  Set by each start of a run, kept after the run ends, so a resume
//          knows where the child last ran and on which session.
//   run    True only while one run lasts. A start clears it, whatever the path.
//   end    How the last run ended. A start clears it, and so does a finding
//          that the run never ended.
//   child  Not an incarnation field. It describes the child across its runs,
//          and another family owns it, or none does yet.
//
// Which field exists at which stage of a run, and who sets and clears it:
//
//   field            lifetime  set by                                   cleared by
//   paneId           start     firstRun, runStarts, paneOpened,         never: a resume starts at '' until its tab opens
//                              runAwaitsPane, runOpens,
//                              runFailedToRestart, restoreRun
//   tabId            start     firstRun, runStarts, paneOpened          runStarts or relocated without a tab, runFailedToRestart
//   host             start     firstRun, relocated, defaultHost         never
//   cwd              start     firstRun, runStarts, relocated           never
//   session          start     firstRun, sessionSeen, relocated         never: a retired child keeps it to be resumed
//   resumedAt        start     runStarts when the start is a return     never
//   launchedAt       start     runStarts or runAwaitsPane when          runStarts that starts no harness, as
//                              harness, as a resume or restart does     an adoption's return (issue #256)
//   lastStatus       run       firstRun, runStarts, statusSeen          set to unknown by runEnds and by runStarts without a status
//   startingUntil    run       holdEvents                               releaseEvents, every start, runFailedToRestart
//   harnessSeenAt    run       harnessSeen, runStarts given seenAt      every start
//   reportPending    run       reportPending                            every start
//   closing          run       closingPane                              paneClosed, every start, runFailedToRestart
//   restartInDoubt   run       answerLost                               doubtSettled, every start
//   exitedAt         end       runEnds, runAwaitsPane                   every start but runAwaitsPane, runContinues, runOpens
//   exitCode         end       runEnds                                  every start, runContinues
//   paneEnd          end       runEnds, tabClosed                       every start, runContinues
//   harnessEnded     end       runEnds                                  every start, runContinues
//   tabClosedAt      end       tabClosed                                every start, runContinues
//   awaitsResume     end       runEnds                                  stopAwaiting, every start, runContinues
//   restartFailed    end       runFailedToRestart                       every start, runContinues
//   crossingFailed   end       crossingFailed                           every start, runContinues
//
// The five ways a child comes back, and the transition each calls:
//
//   resume.ts           runAwaitsPane, which keeps the run before ended until runOpens names
//                       the new tab's pane
//   restart.ts          runStarts, once the session runs in the new pane (local or far)
//   adopt.ts            runStarts, in backInPane, with seenAt: herdr sees the harness at that moment
//   recover-crossing.ts runStarts when the destination runs the session, runContinues when the
//                       source still runs it, runEnds when neither does
//   spawn-resume.ts     runContinues, when herdr shows the session in its own pane after the
//                       registry marked it exited: the run never ended, so only the end goes
//
// A resume that fails puts back every field it cleared, with snapshotRun and
// restoreRun.
//
// A start clears every `run` and `end` field by reading this table, so a new
// field with either lifetime is cleared by all five paths without any of them
// naming it.
import { LOCAL_HOST } from './machine.ts';
import type { AgentStatus, ChildRecord, ChildSession, CrossingFailure, PaneEnd, RestartFailure, RestartInDoubt } from './types.ts';

export type Lifetime = 'start' | 'run' | 'end' | 'child';

/** Every field of the child record, with its lifetime. A field without one fails the typecheck. */
export const LIFETIMES = {
  id: 'child',
  name: 'child',
  agentName: 'child',
  model: 'child',
  route: 'child',
  kind: 'child',
  harness: 'child',
  store: 'child',
  paneId: 'start',
  tabId: 'start',
  workspaceId: 'child',
  workspaceLabel: 'child',
  ownsWorkspace: 'child',
  host: 'start',
  origin: 'child',
  resumedAt: 'start',
  launchedAt: 'start',
  cwd: 'start',
  startedAt: 'child',
  lastStatus: 'run',
  statusChangedAt: 'child',
  completionSeq: 'child',
  completionPane: 'child',
  transcript: 'child',
  transcriptMissing: 'child',
  toolSource: 'child',
  session: 'start',
  stateChangeSeq: 'child',
  depth: 'child',
  maxDepth: 'child',
  depthRequests: 'child',
  depthGrants: 'child',
  briefs: 'child',
  messages: 'child',
  lastReport: 'child',
  reportPending: 'run',
  turnNotified: 'child',
  turnBaseline: 'child',
  lastBusyAt: 'child',
  prompt: 'child',
  decisions: 'child',
  reads: 'child',
  stuckMs: 'child',
  startingUntil: 'run',
  closing: 'run',
  restartInDoubt: 'run',
  inactiveMs: 'child',
  inactiveNotifiedFor: 'child',
  restartRequestedAt: 'child',
  restartRoute: 'child',
  restartedAt: 'child',
  restartFailed: 'end',
  restartWait: 'child',
  restartStalled: 'child',
  moving: 'child',
  crossingFailed: 'end',
  teleportRequest: 'child',
  teleportStalled: 'child',
  movedFrom: 'child',
  departures: 'child',
  teleports: 'child',
  exitedAt: 'end',
  exitCode: 'end',
  paneEnd: 'end',
  harnessSeenAt: 'run',
  harnessEnded: 'end',
  tabClosedAt: 'end',
  awaitsResume: 'end',
  farRecordLost: 'child',
  adoptInDoubt: 'child',
  claimUnconfirmed: 'child',
  cleanupPending: 'child',
  replacedBy: 'child',
  retireRequestedAt: 'child',
  retireIntent: 'child',
  retireStage: 'child',
  retiredAt: 'child',
  retireOutcome: 'child',
  retireReason: 'child',
  retireProof: 'child',
} as const satisfies Record<keyof ChildRecord, Lifetime>;

type FieldsWith<L extends Lifetime> = { [K in keyof typeof LIFETIMES]: (typeof LIFETIMES)[K] extends L ? K : never }[keyof typeof LIFETIMES];

/** The fields this module owns: every field whose lifetime is not `child`. */
export type IncarnationField = FieldsWith<'start' | 'run' | 'end'>;

function fieldsWith(...lifetimes: Lifetime[]): IncarnationField[] {
  return (Object.keys(LIFETIMES) as (keyof typeof LIFETIMES)[]).filter((field) => lifetimes.includes(LIFETIMES[field])) as IncarnationField[];
}

/** The fields this module owns, which the ownership gate reads. */
export const INCARNATION_FIELDS: readonly IncarnationField[] = fieldsWith('start', 'run', 'end');
/** The fields a start clears. */
export const RUN_FIELDS: readonly IncarnationField[] = fieldsWith('run', 'end');
/** The fields that say how a run ended, which a run that never ended loses. */
export const END_FIELDS: readonly IncarnationField[] = fieldsWith('end');

/** The record as this module alone may write it. */
type Writable = { -readonly [K in keyof ChildRecord]: ChildRecord[K] };
function writable(record: ChildRecord): Writable {
  return record as Writable;
}

function clear(record: ChildRecord, fields: readonly IncarnationField[]): void {
  const entry = writable(record);
  for (const field of fields) {
    if (field === 'lastStatus') entry.lastStatus = 'unknown';
    else delete entry[field];
  }
}

/** Where a run is: a field given as undefined goes, and a field left out stays. */
export interface Place {
  paneId?: string;
  tabId?: string | undefined;
  cwd?: string | undefined;
  session?: ChildSession | undefined;
}

function place(record: ChildRecord, where: Place): void {
  const entry = writable(record);
  if (where.paneId !== undefined) entry.paneId = where.paneId;
  for (const field of ['tabId', 'cwd', 'session'] as const) {
    if (!(field in where)) continue;
    const value = where[field];
    if (value === undefined) delete entry[field];
    else (entry as Record<string, unknown>)[field] = value;
  }
}

/** The incarnation of a record that has never run: a spawn, an adoption, a resume of a session no child ran. */
export function firstRun(start: { paneId: string; tabId?: string | undefined; host: string; cwd?: string | undefined; session?: ChildSession | undefined; status?: AgentStatus }): Pick<ChildRecord, 'paneId' | 'tabId' | 'host' | 'cwd' | 'session' | 'lastStatus'> {
  return {
    paneId: start.paneId,
    ...(start.tabId === undefined ? {} : { tabId: start.tabId }),
    host: start.host,
    ...(start.cwd === undefined ? {} : { cwd: start.cwd }),
    ...(start.session === undefined ? {} : { session: start.session }),
    lastStatus: start.status ?? 'unknown',
  };
}

export interface RunStart extends Place {
  /** The status herdr reports for the new run, or unknown until it does. */
  status?: AgentStatus;
  /** When the child came back, for a start that returns a child rather than its first. */
  resumedAt?: string;
  /** When herdr saw the harness run, for a start that finds it already running. */
  seenAt?: string;
  /**
   * When Bellwether started the harness, for a start that launches it in a tab
   * Bellwether opened. A start that finds a harness someone else started, as
   * an adoption's return does, leaves it out, and the field goes (issue #256).
   */
  launchedAt?: string;
}

/**
 * A run starts in a pane. Every `run` and `end` field of the run before goes,
 * whichever path brings the child back, and the start fields take the new
 * place. `paneId` may be '' for a start whose tab has not opened yet.
 */
export function runStarts(record: ChildRecord, start: RunStart): void {
  clear(record, RUN_FIELDS);
  place(record, start);
  const entry = writable(record);
  entry.lastStatus = start.status ?? 'unknown';
  if (start.resumedAt) entry.resumedAt = start.resumedAt;
  if (start.seenAt) entry.harnessSeenAt = start.seenAt;
  if (start.launchedAt) entry.launchedAt = start.launchedAt;
  else delete entry.launchedAt;
}

/**
 * The run the record marked ended still runs, as herdr shows: the end goes,
 * and what the run learned while it ran stays.
 */
export function runContinues(record: ChildRecord, where: Place = {}): void {
  clear(record, END_FIELDS);
  place(record, where);
}

export interface RunEnd {
  at: string;
  /** The exit code, which an end that names one writes even when it is undefined. */
  code?: number | undefined;
  /** What became of the pane, for agent_list and doctor (issue #187). */
  paneEnd?: PaneEnd;
  harnessEnded?: ChildRecord['harnessEnded'];
  /** For an adopted harness that ended in its open pane: the pane may see it again (issue #191). */
  awaitsResume?: boolean;
  /** Whether the status goes to unknown, as it does once herdr reports the pane gone. */
  statusUnknown?: boolean;
}

/** The run ends. */
export function runEnds(record: ChildRecord, end: RunEnd): void {
  const entry = writable(record);
  entry.exitedAt = end.at;
  if ('code' in end) entry.exitCode = end.code;
  if (end.statusUnknown) entry.lastStatus = 'unknown';
  if (end.paneEnd) entry.paneEnd = end.paneEnd;
  if (end.harnessEnded) entry.harnessEnded = end.harnessEnded;
  if (end.awaitsResume) entry.awaitsResume = end.at;
}

/** A restart closed the child's pane and could not start it again (issue #185). The record names the pane it last ran in. */
export function runFailedToRestart(record: ChildRecord, failure: RestartFailure): void {
  const entry = writable(record);
  entry.paneId = failure.oldPane;
  delete entry.tabId;
  delete entry.closing;
  delete entry.startingUntil;
  entry.restartFailed = failure;
  runEnds(record, { at: failure.at, statusUnknown: true, paneEnd: { pane: failure.oldPane, ...(failure.workspaceId ? { workspaceId: failure.workspaceId } : {}), how: 'restart', at: failure.at } });
}

/** herdr closed the tab of a child whose harness had already ended in it. */
export function tabClosed(record: ChildRecord, at: string): void {
  const entry = writable(record);
  entry.tabClosedAt = at;
  entry.paneEnd = { pane: record.paneId, ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}), how: 'closed', at };
}

/** The pane an adopted child ended in no longer waits for it. */
export function stopAwaiting(record: ChildRecord): void {
  delete writable(record).awaitsResume;
}

/** A move or a teleport stopped the child and could not start it on either machine. */
export function crossingFailed(record: ChildRecord, failure: CrossingFailure): void {
  writable(record).crossingFailed = failure;
}

/** The fields that last only while one run lasts, which a start whose tab has not opened yet clears. */
const RUN_ONLY_FIELDS: readonly IncarnationField[] = fieldsWith('run');

/**
 * A start whose tab has not opened yet, with no pane. The run before stays
 * ended, with how it ended, until runOpens names the new pane, so a daemon
 * that stops in between leaves a record that says the child is not running,
 * with any restartFailed or crossingFailed it carried. Without that, the
 * record would name no pane and no exit, and the watcher skips a record with
 * no pane.
 */
export function runAwaitsPane(record: ChildRecord, start: Omit<RunStart, 'paneId' | 'seenAt'> & { at: string }): void {
  clear(record, RUN_ONLY_FIELDS);
  place(record, { ...start, paneId: '' });
  const entry = writable(record);
  entry.lastStatus = start.status ?? 'unknown';
  if (start.resumedAt) entry.resumedAt = start.resumedAt;
  if (start.launchedAt) entry.launchedAt = start.launchedAt;
  else delete entry.launchedAt;
  if (!entry.exitedAt) entry.exitedAt = start.at;
}

/** The tab of a start that runAwaitsPane began opened: the run before stops being the record's last word. */
export function runOpens(record: ChildRecord, tab: { paneId: string; tabId?: string | undefined }): void {
  clear(record, END_FIELDS);
  paneOpened(record, tab);
}

/** The tab a start opened, before its harness starts. A tab left out of `tab` keeps the one on the record unless `replaceTab` says it goes. */
export function paneOpened(record: ChildRecord, tab: { paneId: string; tabId?: string | undefined }, replaceTab = true): void {
  const entry = writable(record);
  entry.paneId = tab.paneId;
  if (tab.tabId !== undefined) entry.tabId = tab.tabId;
  else if (replaceTab) delete entry.tabId;
}

/** Every incarnation field of a record as it stands, so a start that fails can put the run before it back. */
export type RunSnapshot = Partial<Pick<ChildRecord, IncarnationField>>;

export function snapshotRun(record: ChildRecord, change: RunSnapshot = {}): RunSnapshot {
  const snapshot: Record<string, unknown> = {};
  for (const field of INCARNATION_FIELDS) if (record[field] !== undefined) snapshot[field] = record[field];
  return { ...(snapshot as RunSnapshot), ...change };
}

/** A start failed: the record takes back the run it had before, field for field. */
export function restoreRun(record: ChildRecord, snapshot: RunSnapshot): void {
  const entry = writable(record);
  for (const field of INCARNATION_FIELDS) {
    if (field === 'lastStatus' || field === 'paneId' || field === 'host') continue;
    delete entry[field];
  }
  Object.assign(entry, snapshot);
}

/** The record points at another machine, after a move, a teleport, or a crossing a stopped daemon left half done. */
export function relocated(record: ChildRecord, to: { host: string } & Place): void {
  writable(record).host = to.host;
  place(record, to);
}

/** A record from before registry version 2 ran on the parent's own herdr. */
export function defaultHost(record: ChildRecord): void {
  if (typeof record.host !== 'string' || !record.host) writable(record).host = LOCAL_HOST;
}

/** The watcher holds the child's events until `until`, while a start answers dialogs or hands over a brief. */
export function holdEvents(record: ChildRecord, until: string): void {
  writable(record).startingUntil = until;
}

export function releaseEvents(record: ChildRecord): void {
  delete writable(record).startingUntil;
}

/** A restart closes the pane and tab the record still names (issue #211). */
export function closingPane(record: ChildRecord, closing: NonNullable<ChildRecord['closing']>): void {
  writable(record).closing = closing;
}

export function paneClosed(record: ChildRecord): void {
  delete writable(record).closing;
}

/** A restart on another machine whose answer was lost with its connection (issue #211). */
export function answerLost(record: ChildRecord, doubt: RestartInDoubt): void {
  writable(record).restartInDoubt = doubt;
}

export function doubtSettled(record: ChildRecord): void {
  delete writable(record).restartInDoubt;
}

/** The status herdr reports for the run. Returns whether it changed. */
export function statusSeen(record: ChildRecord, status: AgentStatus): boolean {
  if (record.lastStatus === status) return false;
  writable(record).lastStatus = status;
  return true;
}

/** The harness session herdr or the harness's store reports for the run. */
export function sessionSeen(record: ChildRecord, session: ChildSession): void {
  writable(record).session = session;
}

/** herdr saw the harness run in the child's pane, the first time this run. */
export function harnessSeen(record: ChildRecord, at: string): void {
  if (!record.harnessSeenAt) writable(record).harnessSeenAt = at;
}

/** A final report arrived while its turn still runs, or that turn ended. */
export function reportPending(record: ChildRecord, pending: boolean): void {
  if (pending) writable(record).reportPending = true;
  else delete writable(record).reportPending;
}

/** A copy of the record with another incarnation, for a reader that acts on it elsewhere, such as the files on the machine a child left. Never stored. */
export function viewOf(record: ChildRecord, change: Partial<Pick<ChildRecord, IncarnationField>>): ChildRecord {
  return { ...record, ...change };
}
