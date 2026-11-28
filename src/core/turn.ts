// What a child's turns leave on its record: when its status last changed and
// when it was last busy, the number herdr gave its last finished turn and the
// pane that turn ran in, the turn the parent last heard about, the
// conversation file a reader opens, and the Bellwether tools its harness
// loads (step 6 of docs/design-matrix.md). This module is the only writer of
// those fields. Every other module reads them and changes them only through
// the transitions below. `test/unit/turn-owner.test.ts` fails on a write
// anywhere else, and `ChildRecord` declares each field `readonly`, so the
// typecheck fails on a write through any alias too.
//
// The rule this module holds: a pane a child crossed into starts fresh, and
// nothing there counts as a turn until the child works there (issue #271).
// herdr numbers turns per pane, so a turn number means nothing without its
// pane: `completionPane` names the pane `completionSeq` came from,
// `turnNotified` names the pane of the turn the parent heard about, and
// `turnBaseline` says where counting starts in a pane the child crossed into
// before it finished a turn there. The classifier reads them with `seqHere`
// and `seedFor`.
//
// The fields stay flat on the child record, where older daemons that take
// over the same registry read them.
//
//   field                means                                  set by                         cleared by
//   statusChangedAt      when lastStatus last changed           firstTurn, statusChanged       never
//   lastBusyAt           when the child last showed activity    firstTurn, busyAt, turnNumbered never
//                                                               given a time
//   completionSeq        herdr's number for the last turn       firstTurn, turnNumbered,       never
//                        that finished                          turnsAlreadyDone
//   completionPane       the pane that numbered it              turnNumbered                   never
//   stateChangeSeq       herdr's number for the last status     stateSeqSeen                   stateSeqSeen without one
//                        change
//   turnNotified         the last turn the parent heard about,  firstTurn, turnsAlreadyDone,   turnTold, when no turn was told
//                        with its pane                          turnTold
//   turnBaseline         where counting starts in a pane the    turnTold                       turnTold, once a turn there is told
//                        child crossed into
//   inactiveNotifiedFor  the quiet period the inactivity        inactiveNoticed                never
//                        notice went out for
//   transcript           the conversation file on this          firstTurn, transcriptFound     transcriptLeft
//                        machine
//   transcriptMissing    why there is none yet                  firstTurn, transcriptFound     transcriptFound with a path,
//                                                                                              transcriptLeft
//   toolSource           which Bellwether tools the child's     toolsChosen                    never
//                        harness loads, from its launch
//
// Which path calls which transition:
//
//   spawn.ts            firstTurn, toolsChosen, transcriptFound, statusChanged, busyAt
//   resume.ts           firstTurn, statusChanged, busyAt, toolsChosen, transcriptFound
//   restart.ts          firstTurn (a far restart's record), statusChanged, busyAt, toolsChosen,
//                       transcriptFound
//   adopt.ts            firstTurn, statusChanged, busyAt, turnsAlreadyDone (backInPane)
//   teleport.ts         statusChanged
//   carry.ts            transcriptLeft: the file belongs to the source machine
//   recover-crossing.ts transcriptLeft, transcriptFound
//   watcher.ts          statusChanged, busyAt, turnNumbered, stateSeqSeen, turnTold, inactiveNoticed,
//                       transcriptFound
//   tools.ts            transcriptFound
//   free.ts             firstTurn
import type { ToolSource } from './tool-source.ts';
import type { ChildRecord } from './types.ts';

/** The fields this module owns, which the ownership gate reads. */
export const TURN_FIELDS = ['statusChangedAt', 'lastBusyAt', 'completionSeq', 'completionPane', 'stateChangeSeq', 'turnNotified', 'turnBaseline', 'inactiveNotifiedFor', 'transcript', 'transcriptMissing', 'toolSource'] as const;
export type TurnField = (typeof TURN_FIELDS)[number];

type Writable = { -readonly [K in TurnField]: ChildRecord[K] };
function writable(record: ChildRecord): Writable {
  return record as unknown as Writable;
}

/** What a look for a session's conversation file found: its path, or why there is none. */
export interface Found {
  path?: string | undefined;
  missing?: string | undefined;
}

/**
 * The turn fields of a new record. An adopted pane's finished turns are not
 * news, so `done` marks the last of them told, and the first event is the
 * end of the next turn, as for a spawned child.
 */
export function firstTurn(start: { at: string; transcript?: Found | undefined; done?: { paneId: string; seq: number | undefined } }): Pick<ChildRecord, TurnField> {
  const seq = start.done?.seq;
  return {
    statusChangedAt: start.at,
    lastBusyAt: start.at,
    ...(seq === undefined ? {} : { completionSeq: seq, turnNotified: { paneId: start.done?.paneId ?? '', seq } }),
    ...(start.transcript?.path ? { transcript: start.transcript.path } : start.transcript?.missing ? { transcriptMissing: start.transcript.missing } : {}),
  };
}

/** The status on the record changed at `at`. */
export function statusChanged(record: ChildRecord, at: string): void {
  writable(record).statusChangedAt = at;
}

/** The child showed activity at `at`: a turn, a report, or a change in its conversation or screen. */
export function busyAt(record: ChildRecord, at: string): void {
  writable(record).lastBusyAt = at;
}

/**
 * herdr numbered a finished turn in the pane the record names. With `at`,
 * the turn counts as activity too.
 */
export function turnNumbered(record: ChildRecord, seq: number, at?: string): void {
  const entry = writable(record);
  entry.completionSeq = seq;
  entry.completionPane = record.paneId;
  if (at) entry.lastBusyAt = at;
}

/**
 * The turns a pane finished before this parent watched it, as at an
 * adoption or an adopted session's return to its pane: the last of them is
 * told, so it is never announced.
 */
export function turnsAlreadyDone(record: ChildRecord, seq: number | undefined): void {
  if (seq === undefined) return;
  const entry = writable(record);
  entry.completionSeq = seq;
  entry.turnNotified = { paneId: record.paneId, seq };
}

/** herdr's number for the status change on the record, or none when the event carried none. */
export function stateSeqSeen(record: ChildRecord, seq: number | undefined): void {
  if (seq === undefined) delete writable(record).stateChangeSeq;
  else writable(record).stateChangeSeq = seq;
}

/**
 * What the parent has heard about the child's turns in `paneId`, from the
 * watcher's classifier state. In a pane the child crossed into, the record
 * keeps where counting starts until a turn there is told (issue #271).
 */
export function turnTold(record: ChildRecord, paneId: string, told: { crossing: boolean; seq: number | undefined; baseline: ChildRecord['turnBaseline'] }): void {
  const entry = writable(record);
  if (told.crossing) {
    if (told.seq !== undefined) entry.turnNotified = { paneId, seq: told.seq };
    if (told.baseline) entry.turnBaseline = told.baseline;
    else delete entry.turnBaseline;
    return;
  }
  if (told.seq === undefined) {
    delete entry.turnNotified;
    return;
  }
  entry.turnNotified = { paneId, seq: told.seq };
  delete entry.turnBaseline;
}

/** A copy of what another record says was told, for a watcher that holds the record in memory. */
export function toldAs(record: ChildRecord, source: Pick<ChildRecord, 'turnNotified' | 'turnBaseline'> | undefined): void {
  const entry = writable(record);
  entry.turnNotified = source?.turnNotified;
  entry.turnBaseline = source?.turnBaseline;
}

/** The inactivity notice went out for the quiet period that started at `since`. */
export function inactiveNoticed(record: ChildRecord, since: string): void {
  writable(record).inactiveNotifiedFor = since;
}

/**
 * A look for the conversation file of the run's session on this machine. A
 * path replaces any reason. Without one, a record that already holds a file
 * of the same session keeps it, and a record without one says why. With
 * `newSession`, the file the record holds belongs to the session before, so
 * the reason goes on beside it until the new file appears.
 */
export function transcriptFound(record: ChildRecord, found: Found, newSession = false): void {
  const entry = writable(record);
  if (found.path) {
    entry.transcript = found.path;
    delete entry.transcriptMissing;
  } else if (record.transcript && !newSession) delete entry.transcriptMissing;
  else if (found.missing) entry.transcriptMissing = found.missing;
}

/** The run left this machine, so its conversation file is on another disk. */
export function transcriptLeft(record: ChildRecord): void {
  const entry = writable(record);
  delete entry.transcript;
  delete entry.transcriptMissing;
}

/** The Bellwether tools a launch gives the child's harness, as `tool-source.ts` chose them. */
export function toolsChosen(record: ChildRecord, source: ToolSource | undefined): void {
  if (source) writable(record).toolSource = source;
}
