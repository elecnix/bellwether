// Every request that someone made and that has not finished: a restart a
// session asked for of itself, a teleport a child asked for, a crossing under
// way, and the requests a far machine keeps for its parent's daemon (step 4 of
// docs/design-matrix.md). This module is the only writer of those fields.
// Every other module reads them through the phases below and changes them
// only through the transitions, so no module decides on its own when a
// request is over. `test/unit/requests-owner.test.ts` fails on a write
// anywhere else, and the types declare each owned field `readonly`, so the
// typecheck fails on a write through any alias too.
//
// Four defects on the night of 27 to 28 November 2026 came from that kind of
// decision taken in four places: a restart that waited forever (#220), a
// request whose act refused and left nothing to end it (#228), a retirement
// that claimed a removal it did not perform (#273, now `retire.ts`'s alone),
// and a wait whose stored bound outlived the wait that a new daemon armed.
//
// The fields stay flat on the records, where older daemons that take over the
// same registry read them. The phase is a pure function of the stored fields,
// in `restartPhase`, `teleportPhase` and `crossingPhase`, and each transition
// moves only along `TRANSITIONS`.
//
// A request is in one phase:
//
//   phase      means                                                             bound
//   requested  Recorded, and no daemon waits on it. The next service that        requestedAt + RESTART_DEFER_MS
//              starts for the session arms it or gives it up.
//   waiting    A daemon waits for the session's turn to end.                     wait.until
//   acted      The turn ended and the act took the request. It has not           wait.until (restart, reset to
//              answered yet.                                                     ACT_BOUND_MS when taken), or
//                                                                                moving.until (crossing)
//   answered   The act ran. Nothing is in flight.                                none
//   stalled    It gave up: the bound passed, or the act refused. The reason      none
//              stays until the next request.
//   failed     The act closed the pane and could not start the session again    none
//              (`restartFailed`, `crossingFailed`, owned by incarnation.ts).
//   in-doubt   The far machine's answer was lost with the connection             at + IN_DOUBT_BOUND_MS
//              (`restartInDoubt`, owned by incarnation.ts).
//
// Every phase that is in flight (requested, waiting, acted, in-doubt) has a
// time by which it ends: a transition into it takes the bound as an argument
// the typecheck requires, and a record an older daemon wrote without one gets
// the bound its kind defaults to. `bellwether doctor` prints each with its
// bound and its owner, and a `fail` line once one outlives its bound.
//
// Which field holds each phase, and which transition writes it:
//
//   field                 phase         written by                         cleared by
//   restartRequestedAt    requested,    restartRequested                   restartTaken, restartAnswered,
//                         waiting                                          restartStalled, restartFailedEnds
//   restartWait           waiting,      restartRequested, restartArmed,    restartAnswered, restartStalled,
//                         acted         restartTaken, waitStatusSeen        restartFailedEnds, restartDisarmed
//   restartRoute          waiting       restartRequested                   restartTaken, restartAnswered, restartStalled
//   restartStalled        stalled       restartStalled                     restartRequested
//   restartedAt           answered      restartAnswered                    never
//   teleportRequest       waiting,      teleportRequested, teleportArmed,  teleportAnswered, teleportStalled,
//                         acted         waitStatusSeen                     crossingEnded
//   teleportStalled       stalled       teleportStalled, crossingEnded     teleportRequested
//   moving                acted         crossingBegun, crossingStep,       crossingEnded
//                                       keepCrossing
//   retireRequest,        requested     relayRequestSaved                  relayRequestAnswered
//   teleportRequest
//   (relay record)
import type { RelayRecord } from './relay-records.ts';
import type { ChildRecord, Crossing, ParentRecord, RestartStall, RestartWait, TeleportRequestRecord } from './types.ts';

/** How long a self-restart or a self-teleport waits for its session's turn to end (issue #188). */
export const RESTART_DEFER_MS = 5 * 60_000;

/** How long a restart's act may run once it took the request: the close hold, the startup hold and the harness's start, with room. */
export const ACT_BOUND_MS = 5 * 60_000;
/** How long a lost far answer may stay in doubt before doctor fails it. The relay retries with backoff well inside this. */
export const IN_DOUBT_BOUND_MS = 60 * 60_000;

export type RequestPhase = 'requested' | 'waiting' | 'acted' | 'answered' | 'stalled' | 'failed' | 'in-doubt';
export type RequestKind = 'restart' | 'teleport' | 'crossing' | 'retire';

/** What can happen to a request. */
export type RequestEvent = 'request' | 'arm' | 'disarm' | 'status' | 'take' | 'answer' | 'stall' | 'fail';

/** The phases a request is in flight in, each of which carries a bound. */
export const IN_FLIGHT: readonly RequestPhase[] = ['requested', 'waiting', 'acted', 'in-doubt'];

/**
 * Every move the machine allows, from each phase on each event. A pair left
 * out is refused, and the record stays as it was. `none` is a record that
 * never asked.
 */
export const TRANSITIONS: Record<RequestPhase | 'none', Partial<Record<RequestEvent, RequestPhase | 'none'>>> = {
  none: {
    request: 'waiting',
    // A direct agent_restart by a parent asks nothing first, and its act still answers.
    answer: 'answered',
  },
  requested: {
    // A request with nothing waiting on it is replaced by a new one (issue #220).
    request: 'waiting',
    // The next service for the session arms it again, with a full bound.
    arm: 'waiting',
    // A direct restart took it, or the record shows the restart ran after it.
    take: 'acted',
    answer: 'answered',
    stall: 'stalled',
    fail: 'failed',
  },
  waiting: {
    // A second call while one waits is answered with the wait, and never writes. A new daemon arms the wait again.
    arm: 'waiting',
    status: 'waiting',
    // The daemon stopped mid-wait: the request stays for the next daemon.
    disarm: 'requested',
    take: 'acted',
    answer: 'answered',
    // The bound passed, or the act refused before it closed anything (issues #220, #228).
    stall: 'stalled',
    fail: 'failed',
  },
  acted: {
    status: 'acted',
    answer: 'answered',
    // The act refused or threw without a failure mark: the reason stays rather than nothing.
    stall: 'stalled',
    fail: 'failed',
  },
  answered: { request: 'waiting', answer: 'answered' },
  stalled: { request: 'waiting', answer: 'answered' },
  failed: { request: 'waiting', answer: 'answered' },
  // The far daemon hands its kept answer over; incarnation.ts settles the doubt.
  'in-doubt': { answer: 'answered', fail: 'failed', stall: 'stalled' },
};

/** The phase a request moves to on an event, or undefined when the machine refuses the move. */
export function next(phase: RequestPhase | 'none', event: RequestEvent): RequestPhase | 'none' | undefined {
  return TRANSITIONS[phase][event];
}

/** The restart fields a parent record and a child record both carry. */
export interface RestartHolder {
  readonly restartRequestedAt?: string;
  readonly restartWait?: RestartWait;
  readonly restartStalled?: RestartStall;
  readonly restartedAt?: string;
  readonly restartRoute?: ChildRecord['restartRoute'];
  readonly restartFailed?: ChildRecord['restartFailed'];
  readonly restartInDoubt?: ChildRecord['restartInDoubt'];
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
function writable<T>(record: T): Writable<T> {
  return record as Writable<T>;
}

/** The phase of a restart, from the stored fields. */
export function restartPhase(holder: RestartHolder): RequestPhase | 'none' {
  if (holder.restartInDoubt) return 'in-doubt';
  if (holder.restartRequestedAt) return holder.restartWait ? 'waiting' : 'requested';
  if (holder.restartWait) return 'acted';
  if (holder.restartFailed) return 'failed';
  if (holder.restartStalled && !(holder.restartedAt && holder.restartedAt >= holder.restartStalled.at)) return 'stalled';
  if (holder.restartedAt) return 'answered';
  return 'none';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Apply a move when the table allows it, and say whether it did. */
function move(phase: RequestPhase | 'none', event: RequestEvent, apply: () => void): boolean {
  if (!next(phase, event)) return false;
  apply();
  return true;
}

export interface Bound {
  /** The pane whose turn the request waits on. */
  paneId: string;
  /** When the wait gives up. Required: no request waits without one. */
  until: string;
}

/** A session asked to be restarted once its turn ends. */
export function restartRequested(holder: RestartHolder, at: string, bound: Bound, route?: ChildRecord['restartRoute']): boolean {
  return move(restartPhase(holder), 'request', () => {
    const entry = writable(holder);
    entry.restartRequestedAt = at;
    entry.restartWait = { until: bound.until, paneId: bound.paneId };
    delete entry.restartStalled;
    if (route) entry.restartRoute = route;
    else delete entry.restartRoute;
  });
}

/** A daemon waits on a request again, with a fresh bound. */
export function restartArmed(holder: RestartHolder, bound: Bound): boolean {
  return move(restartPhase(holder), 'arm', () => {
    writable(holder).restartWait = { until: bound.until, paneId: bound.paneId };
  });
}

/** The daemon that waited stopped: the request stays for the next one, and nothing waits on it now. */
export function restartDisarmed(holder: RestartHolder): boolean {
  return move(restartPhase(holder), 'disarm', () => {
    delete writable(holder).restartWait;
  });
}

/** Keep the status herdr reports for the waiting pane, for a second call and doctor. */
export function waitStatusSeen(wait: RestartWait | undefined, status: string, at = new Date().toISOString()): void {
  if (!wait) return;
  const entry = writable(wait);
  entry.status = status;
  entry.statusSince = at;
}

/** The turn ended and the act took the request: it now has the act's bound. */
export function restartTaken(holder: RestartHolder, paneId: string, now = Date.now()): boolean {
  return move(restartPhase(holder), 'take', () => {
    const entry = writable(holder);
    entry.restartWait = { ...(holder.restartWait ?? {}), paneId: holder.restartWait?.paneId ?? paneId, until: iso(now + ACT_BOUND_MS), acting: iso(now) };
    delete entry.restartRequestedAt;
    delete entry.restartRoute;
  });
}

/** The act ran: the session runs again on its session. */
export function restartAnswered(holder: RestartHolder, at: string): boolean {
  return move(restartPhase(holder), 'answer', () => {
    const entry = writable(holder);
    entry.restartedAt = at;
    delete entry.restartRequestedAt;
    delete entry.restartWait;
    delete entry.restartRoute;
  });
}

/** The request gave up: its bound passed, or its act refused. The reason stays until the next request. */
export function restartStalled(holder: RestartHolder, reason: string, at = new Date().toISOString()): boolean {
  const requestedAt = holder.restartRequestedAt;
  const paneId = holder.restartWait?.paneId;
  return move(restartPhase(holder), 'stall', () => {
    const entry = writable(holder);
    entry.restartStalled = { at, ...(requestedAt ? { requestedAt } : {}), ...(paneId ? { paneId } : {}), reason };
    delete entry.restartRequestedAt;
    delete entry.restartWait;
    delete entry.restartRoute;
  });
}

/** The act closed the pane and failed to start the session: incarnation.ts records the failure, and the request ends. */
export function restartFailedEnds(holder: RestartHolder): boolean {
  return move(restartPhase(holder), 'fail', () => {
    const entry = writable(holder);
    delete entry.restartRequestedAt;
    delete entry.restartWait;
    delete entry.restartRoute;
  });
}

/** Whether the record shows the restart ran after it was asked for. */
export function restartRanSince(holder: RestartHolder): boolean {
  return Boolean(holder.restartRequestedAt && holder.restartedAt && holder.restartedAt >= holder.restartRequestedAt);
}

// Teleport a child asked for itself (issue #226).

type TeleportHolder = Pick<ChildRecord, 'teleportRequest' | 'teleportStalled' | 'moving' | 'crossingFailed'>;

/** The phase of a teleport a child asked for, from the stored fields. */
export function teleportPhase(child: TeleportHolder): RequestPhase | 'none' {
  const asked = child.teleportRequest;
  if (asked) {
    if (child.moving?.verb === 'teleport') return 'acted';
    return asked.wait ? 'waiting' : 'requested';
  }
  if (child.crossingFailed?.verb === 'teleport') return 'failed';
  if (child.teleportStalled) return 'stalled';
  return 'none';
}

export interface TeleportAsk {
  at: string;
  machine: string;
  cwd?: string;
  reason?: string;
}

/** A child asked to be teleported once its turn ends. */
export function teleportRequested(child: TeleportHolder, ask: TeleportAsk, bound: Bound): boolean {
  return move(teleportPhase(child), 'request', () => {
    const entry = writable(child);
    entry.teleportRequest = { at: ask.at, machine: ask.machine, ...(ask.cwd ? { cwd: ask.cwd } : {}), ...(ask.reason ? { reason: ask.reason } : {}), wait: { until: bound.until, paneId: bound.paneId } };
    delete entry.teleportStalled;
  });
}

/** A daemon waits on a teleport request again, with a fresh bound, so doctor never reads the bound of a wait that ended with its daemon. */
export function teleportArmed(child: TeleportHolder, bound: Bound): boolean {
  const asked = child.teleportRequest;
  if (!asked) return false;
  return move(teleportPhase(child), 'arm', () => {
    writable(child).teleportRequest = { ...asked, wait: { until: bound.until, paneId: bound.paneId } };
  });
}

/** The teleport ran. */
export function teleportAnswered(child: TeleportHolder): boolean {
  return move(teleportPhase(child), 'answer', () => {
    delete writable(child).teleportRequest;
  });
}

/** The teleport gave up: its bound passed, or the crossing refused. */
export function teleportStalled(child: TeleportHolder, reason: string, paneId: string | undefined, at = new Date().toISOString()): boolean {
  const asked = child.teleportRequest;
  if (!asked) return false;
  return move(teleportPhase(child), 'stall', () => {
    const entry = writable(child);
    entry.teleportStalled = { at, requestedAt: asked.at, ...(paneId ? { paneId } : {}), machine: asked.machine, reason };
    delete entry.teleportRequest;
  });
}

// A crossing under way: a move or a teleport that runs (issue #226).

/** The phase of a crossing mark. A mark is always an act under way, with its own bound. */
export function crossingPhase(child: Pick<ChildRecord, 'moving' | 'crossingFailed'>): RequestPhase | 'none' {
  if (child.moving) return 'acted';
  if (child.crossingFailed) return 'failed';
  return 'none';
}

/** A crossing begins. `until` is part of the mark, so a crossing never runs without a bound. */
export function crossingBegun(child: Pick<ChildRecord, 'moving'>, mark: Crossing): void {
  writable(child).moving = mark;
}

/** A crossing finished a step. Only the daemon that runs it writes its steps. */
export function crossingStep(child: Pick<ChildRecord, 'moving'>, daemon: string, change: Partial<Crossing>): boolean {
  if (child.moving?.daemon !== daemon) return false;
  writable(child).moving = { ...child.moving, ...change };
  return true;
}

/** Keep on a copy of the record the mark a hook wrote to the stored one, so a later write of the copy does not drop it. */
export function keepCrossing(child: Pick<ChildRecord, 'moving'>, mark: Crossing | undefined): void {
  if (mark) writable(child).moving = mark;
}

/** A copy of the record with no crossing mark, for a resume that must not refuse a child as being moved. */
export function withoutCrossing<T extends Pick<ChildRecord, 'moving'>>(child: T): T {
  const copy = { ...child };
  delete writable(copy).moving;
  return copy;
}

/**
 * A crossing ended. A teleport the child asked for itself ends with it: the
 * crossing it asked for ran, or was undone. Without this a daemon that
 * recovered the crossing left the request standing, and the next service
 * armed a second teleport of a child already at its destination.
 */
export function crossingEnded(child: TeleportHolder, outcome: { ran: true } | { ran: false; reason: string }): void {
  const verb = child.moving?.verb;
  const entry = writable(child);
  delete entry.moving;
  if (verb !== 'teleport' || !child.teleportRequest) return;
  if (outcome.ran) teleportAnswered(child);
  else teleportStalled(child, outcome.reason, child.teleportRequest.wait?.paneId);
}

// The requests a far machine keeps in its relay record for the parent's daemon.

type RelayRequestKind = 'retireRequest' | 'teleportRequest';

/** A request saved in the relay outbox, for doctor on the machine that runs the child. */
export function relayRequestSaved(record: RelayRecord, kind: RelayRequestKind, request: { at: string; receipt: string; machine?: string }): void {
  const entry = writable(record);
  if (kind === 'retireRequest') entry.retireRequest = { at: request.at, receipt: request.receipt };
  else entry.teleportRequest = { at: request.at, receipt: request.receipt, ...(request.machine ? { machine: request.machine } : {}) };
}

/** The parent's daemon took the request, or refused it. */
export function relayRequestAnswered(record: RelayRecord, kind: RelayRequestKind, receipt: string, refused?: string): void {
  const kept = record[kind];
  if (kept?.receipt !== receipt) return;
  const entry = writable(record);
  if (refused) entry[kind] = { ...kept, refused } as never;
  else delete entry[kind];
}

// What doctor prints.

/** One request in flight, or one that ended without running, as doctor reads it. */
export interface InFlight {
  kind: RequestKind;
  /** Who asked, in words: `session <id>`, or `<name> (child <id> of <parent>)`. */
  who: string;
  phase: RequestPhase;
  since: string;
  /** When it ends at the latest. An in-flight phase always has one. */
  until: string;
  /** What ends it: the code that acts on it, or the event it waits for. */
  owner: string;
}

function statusWords(wait: RestartWait | undefined): string {
  return wait?.status ? `herdr reports it ${wait.status}${wait.statusSince ? ` since ${wait.statusSince}` : ''}` : 'herdr has reported no status for it yet';
}

function addMs(at: string, ms: number): string {
  return iso(Date.parse(at) + ms);
}

/** The restart in flight on a record, with its bound and owner. */
export function restartInFlight(holder: RestartHolder, who: string, session: string): InFlight | undefined {
  const phase = restartPhase(holder);
  if (phase === 'requested') {
    const since = holder.restartRequestedAt as string;
    return { kind: 'restart', who, phase, since, until: addMs(since, RESTART_DEFER_MS), owner: `no daemon waits on it; the next service for ${session} arms it or gives it up` };
  }
  if (phase === 'waiting') return { kind: 'restart', who, phase, since: holder.restartRequestedAt as string, until: holder.restartWait?.until as string, owner: `the daemon's deferred restart, waiting for pane ${holder.restartWait?.paneId} to end its turn (${statusWords(holder.restartWait)})` };
  if (phase === 'acted') {
    const wait = holder.restartWait as RestartWait;
    return { kind: 'restart', who, phase, since: wait.acting ?? wait.until, until: wait.until, owner: `the restart act, closing pane ${wait.paneId} and starting the session in a new tab` };
  }
  if (phase === 'in-doubt') {
    const doubt = holder.restartInDoubt as NonNullable<RestartHolder['restartInDoubt']>;
    return { kind: 'restart', who, phase, since: doubt.at, until: addMs(doubt.at, IN_DOUBT_BOUND_MS), owner: `the relay link to ${doubt.host}, which asks the daemon there for the answer it kept; the connection ended with: ${doubt.error ?? 'no cause given'}, and the pane before the restart was ${doubt.oldPane || '(none)'}` };
  }
  return undefined;
}

/** The teleport a child asked for itself, in flight, with its bound and owner. */
export function teleportInFlight(child: ChildRecord, who: string): InFlight | undefined {
  const phase = teleportPhase(child);
  const asked = child.teleportRequest;
  if (!asked) return undefined;
  if (phase === 'requested') return { kind: 'teleport', who, phase, since: asked.at, until: addMs(asked.at, RESTART_DEFER_MS), owner: 'no daemon waits on it; the service of the parent that holds the record arms it when it starts' };
  if (phase === 'waiting') return { kind: 'teleport', who, phase, since: asked.at, until: asked.wait?.until as string, owner: `the parent's deferred teleport, waiting for pane ${asked.wait?.paneId} to end its turn (${statusWords(asked.wait)})` };
  if (phase === 'acted' && child.moving) return { kind: 'teleport', who, phase, since: asked.at, until: child.moving.until, owner: `the crossing run by daemon ${child.moving.daemon ?? '(unknown)'}` };
  return undefined;
}

/** A crossing mark, with its bound and owner. A self-teleport's crossing is listed once, under the teleport. */
export function crossingInFlight(child: ChildRecord, who: string): InFlight | undefined {
  const mark = child.moving;
  if (!mark || teleportPhase(child) === 'acted') return undefined;
  return { kind: 'crossing', who, phase: 'acted', since: mark.since, until: mark.until, owner: `the ${mark.verb ?? 'move'} run by daemon ${mark.daemon ?? '(unknown)'}, at step ${mark.stage ?? 'unknown'}; a daemon that starts after it stopped finishes or undoes it` };
}

/** Every request in flight on the parents' records. */
export function requestsInFlight(parents: readonly ParentRecord[], extra: (child: ChildRecord, who: string) => InFlight | undefined = () => undefined): InFlight[] {
  const found: InFlight[] = [];
  for (const parent of parents) {
    const own = restartInFlight(parent, `session ${parent.id}`, `session ${parent.id}`);
    if (own) found.push(own);
    for (const child of parent.children) {
      const who = `${child.name} (child ${child.id} of ${parent.id})`;
      for (const item of [restartInFlight(child, who, `session ${parent.id}`), teleportInFlight(child, who), crossingInFlight(child, who), extra(child, who)]) if (item) found.push(item);
    }
  }
  return found;
}

/** One doctor line per request in flight: `info` within its bound, `fail` once it outlived it. */
export function requestLines(items: readonly InFlight[], now = Date.now()): string[] {
  return items.map((item) => {
    const over = Date.parse(item.until) <= now;
    const head = `request: ${item.kind} of ${item.who}, ${item.phase} since ${item.since}`;
    return over
      ? `fail  ${head}, outlived its bound ${item.until}. Its owner, ${item.owner}, never ended it. Run agent_list for the child, then ask again or restart the daemon, which arms or gives up each request it finds.`
      : `info  ${head}, ends by ${item.until}. Owner: ${item.owner}.`;
  });
}

/** The fields this module owns, which the ownership gate reads: on a child record, a parent record and a relay record. */
export const REQUEST_FIELDS = ['restartRequestedAt', 'restartRoute', 'restartWait', 'restartStalled', 'restartedAt', 'teleportRequest', 'teleportStalled', 'moving', 'retireRequest'] as const;
