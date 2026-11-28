// The classifier: turns herdr states into child events, with a settle time for
// each. It is a pure function of (state, clock, observation) so tier 1 can run
// it against a fake clock without a socket.
import { DEFAULT_INACTIVE_MS, inactiveMsOf } from './inactivity.ts';
import type { AgentStatus, ChildEventKind, ChildRecord } from './types.ts';

/** Starting values. The lab tunes these; they are not measurements. */
export const DEFAULT_LIMITS: SettleLimits = {
  idleMs: 5_000,
  blockedMs: 3_000,
  stuckMs: 10 * 60_000,
  inactiveMs: DEFAULT_INACTIVE_MS,
};

export interface SettleLimits {
  /** How long an idle child waits, so a quick next turn sends no message. */
  idleMs: number;
  /** How long a blocked child waits before its dialog is worth reading. */
  blockedMs: number;
  /** How long a working child may be quiet before it is stuck. */
  stuckMs: number;
  /**
   * How long a child may show no activity of any kind before it is reported.
   * Optional so limits written before this existed still compile; absent means
   * the default, and limitsFor always sets it on the watcher's path.
   */
  inactiveMs?: number;
}

/** The per-child clock the classifier keeps between observations. */
export interface ClassifierState {
  status: AgentStatus;
  /** When the status last changed, for the settle time. */
  statusSince: number;
  /** herdr's completion_seq for the newest finished turn. */
  completionSeq?: number;
  /**
   * The newest turn the parent has already heard about, by a report or an
   * idle event. It is the last emitted state the idle event compares against,
   * so a status herdr repeats, or a snapshot that reads the same turn again,
   * raises nothing. The watcher keeps it on the child record as turnNotified.
   */
  reportedFor?: number;
  /**
   * Set when a final report arrives while the turn that made it still runs.
   * The report covers that turn, so when it ends it moves reportedFor to the
   * turn's number instead of raising an idle event.
   */
  reportPending?: boolean;
  /** The last time the child moved: output, transcript growth, or a report. */
  lastBusyAt: number;
  /** Set once an event fired for the current quiet period, so it fires once. */
  firedStuckSince?: number;
  /** Set once the blocked event fired, so the dialog is reported once. */
  firedBlocked?: boolean;
  /**
   * The lastActivityAt of the quiet period that already fired its inactive
   * event. A period ends only when new activity moves lastActivityAt past it.
   */
  firedInactiveFor?: number;
  /** The last observable activity: a status change, a new turn, output, or a report. */
  lastActivityAt: number;
  /**
   * The dialog the child waits on, named in one line, while one is open. herdr
   * can report such a child idle or working, so an open prompt is a block of
   * its own, beside herdr's blocked status.
   */
  prompt?: string;
  /** When the open prompt appeared, for the blocked settle time. */
  promptSince?: number;
  /** The pane this state counts turns in. A child in another pane starts from a new seed. */
  paneId?: string;
  /**
   * Set in a pane the child crossed into, until it works there (issue #271).
   * The parent heard every earlier turn, so meanwhile a ready status or a
   * number herdr shows is the starting point, not the end of a turn.
   */
  fresh?: boolean;
  /** The number herdr showed in this pane before the child worked here, which no turn ended. */
  base?: number;
  /**
   * A turn number the classifier made up because herdr ended the turn without
   * one, held while the child stays ready. A number herdr gives during that
   * spell is the same turn's (issue #271).
   */
  counted?: number;
}

export interface Observation {
  status: AgentStatus;
  completionSeq?: number;
  /** True when the child produced output or its transcript grew since the last look. */
  busy?: boolean;
  /** The one-line name of a dialog the child waits on, while it is open. */
  prompt?: string;
}

export interface InitialSeed {
  /** When the child last showed activity, from the registry after a restart. */
  activityAt?: number;
  /** The quiet period whose inactive event already went out, from the registry. */
  firedInactiveFor?: number;
  /** The turn the classifier last saw end, from the registry. */
  completionSeq?: number;
  /** The newest turn the parent heard about, from the registry. */
  reportedFor?: number;
  /** A final report that waits for its turn to end, from the registry. */
  reportPending?: boolean;
  /** The pane the state counts turns in. */
  paneId?: string;
  /** A pane the child crossed into and has not worked in yet, with herdr's number there. */
  fresh?: boolean;
  base?: number;
}

export function initialState(status: AgentStatus, now: number, seed: InitialSeed = {}): ClassifierState {
  const activityAt = seed.activityAt ?? now;
  return {
    status,
    statusSince: now,
    lastBusyAt: now,
    lastActivityAt: activityAt,
    firedInactiveFor: seed.firedInactiveFor,
    ...(seed.completionSeq === undefined ? {} : { completionSeq: seed.completionSeq }),
    ...(seed.reportedFor === undefined ? {} : { reportedFor: seed.reportedFor }),
    ...(seed.reportPending ? { reportPending: true } : {}),
    ...(seed.paneId === undefined ? {} : { paneId: seed.paneId }),
    ...(seed.fresh ? { fresh: true } : {}),
    ...(seed.base === undefined ? {} : { base: seed.base }),
  };
}

/** The limits one child is judged by: the base, with the child's own thresholds. */
export function limitsFor(child: ChildRecord, base: SettleLimits): SettleLimits {
  const limits: SettleLimits = { ...base, inactiveMs: inactiveMsOf(child) };
  return child.stuckMs === undefined ? limits : { ...limits, stuckMs: child.stuckMs };
}

/**
 * herdr's turn number for the pane the child runs in now, or undefined when
 * the record's number came from an earlier pane. herdr numbers each pane on
 * its own (issue #271).
 */
export function seqHere(child: Pick<ChildRecord, 'completionSeq' | 'completionPane' | 'turnNotified' | 'paneId'>): number | undefined {
  if (child.completionSeq === undefined) return undefined;
  const from = child.completionPane ?? child.turnNotified?.paneId ?? child.paneId;
  return from === child.paneId ? child.completionSeq : undefined;
}

/**
 * The state a child starts from, recovered from its registry record. A parent
 * that restarts resumes the same quiet period instead of a fresh one, and does
 * not send the inactive event again for a period it already reported. It also
 * starts from the turn the parent last heard about, so a new service, a daemon
 * that took over, or an adopted pane does not announce a turn twice.
 *
 * That turn belongs to the pane that ran it. A child in another pane, after a
 * restart, resume, move or teleport, has had every earlier turn told, so it
 * starts fresh: nothing in the new pane is a turn until the child works there
 * (issue #271). `crossed` says the watcher saw the child in another pane.
 */
export function seedFor(child: ChildRecord, now: number, options: { crossed?: boolean } = {}): ClassifierState {
  const activityAt = Math.max(Date.parse(child.lastBusyAt), Date.parse(child.statusChangedAt));
  const fired = child.inactiveNotifiedFor === undefined ? NaN : Date.parse(child.inactiveNotifiedFor);
  const common = { activityAt: Number.isFinite(activityAt) ? activityAt : now, firedInactiveFor: Number.isFinite(fired) ? fired : undefined, paneId: child.paneId };
  const notified = child.turnNotified && child.turnNotified.paneId === child.paneId ? child.turnNotified.seq : undefined;
  if (notified !== undefined) {
    return initialState(child.lastStatus, now, { ...common, completionSeq: seqHere(child) ?? notified, reportedFor: notified, reportPending: child.reportPending });
  }
  const baseline = child.turnBaseline?.paneId === child.paneId ? child.turnBaseline : undefined;
  const crossed = baseline !== undefined || options.crossed || (child.turnNotified !== undefined && child.turnNotified.paneId !== child.paneId);
  if (!crossed) return initialState(child.lastStatus, now, { ...common, completionSeq: seqHere(child), reportPending: child.reportPending });
  // A final report waiting for a turn in an earlier pane covers nothing here.
  const seq = baseline ? baseline.seq : seqHere(child);
  return initialState(child.lastStatus, now, { ...common, completionSeq: seq, reportedFor: seq, base: seq, fresh: !baseline?.worked });
}

export function isReady(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done';
}

/**
 * Fold one observation into the state and say whether an event is due.
 * The returned state is a new object; the classifier never mutates its input.
 */
export function advance(state: ClassifierState, observation: Observation, now: number, limits: SettleLimits = DEFAULT_LIMITS): { state: ClassifierState; event?: ChildEventKind } {
  if (state.fresh) {
    // A pane the child crossed into: what herdr shows before the child works
    // here is where counting starts, not a turn (issue #271).
    const settled: ClassifierState = { ...state, status: observation.status, completionSeq: observation.completionSeq, reportedFor: observation.completionSeq, base: observation.completionSeq, prompt: observation.prompt };
    if (observation.status !== state.status) settled.statusSince = now;
    if (observation.status !== state.status || observation.busy) settled.lastActivityAt = now;
    if (observation.busy) settled.lastBusyAt = now;
    // Work in this pane: from here on, the next ready status ends a turn.
    if (observation.status === 'working') return advance({ ...settled, fresh: undefined }, observation, now, limits);
    return { state: settled };
  }
  const next: ClassifierState = { ...state };
  // herdr numbered a turn the classifier had already counted, while the child
  // stayed ready: the same turn, so the number replaces the count (issue #271).
  if (state.counted !== undefined && state.counted === state.completionSeq && observation.completionSeq !== undefined && observation.completionSeq !== state.completionSeq && isReady(state.status) && isReady(observation.status)) {
    next.completionSeq = observation.completionSeq;
    if (state.reportedFor === state.counted) next.reportedFor = observation.completionSeq;
    next.counted = undefined;
    return advance(next, observation, now, limits);
  }
  if (!isReady(observation.status)) next.counted = undefined;
  const seqMoved = observation.completionSeq !== undefined && observation.completionSeq !== state.completionSeq;
  if (observation.status !== state.status || seqMoved || observation.busy) {
    next.lastActivityAt = now;
  }
  if (observation.status !== state.status) {
    next.status = observation.status;
    next.statusSince = now;
    next.firedStuckSince = undefined;
    // A dialog that stays open across the change is the same block. Claude
    // Code's hook can name it before herdr moves the child from working to idle.
    if (state.prompt === undefined || observation.prompt === undefined) next.firedBlocked = undefined;
  }
  const becameReady = isReady(observation.status) && !isReady(state.status);
  const counted = !seqMoved && observation.completionSeq === undefined && becameReady;
  if (seqMoved) {
    next.completionSeq = observation.completionSeq;
    next.statusSince = now;
  } else if (counted) {
    // herdr reports completion_seq on AgentInfo, and the watcher reads that
    // projection, so a reconciled child normally carries one. The field is
    // still absent before the first reconcile finishes, and on a pane herdr
    // has not observed working for: a turn that ends faster than screen
    // detection catches it leaves the value unchanged. A turn that ends is
    // also visible as a status change into idle or done, so count those.
    next.completionSeq = (state.completionSeq ?? 0) + 1;
    next.counted = next.completionSeq;
    next.statusSince = now;
  }
  // The turn a final report covered has ended, so the report was its event.
  if ((seqMoved || counted) && next.reportPending) {
    next.reportedFor = next.completionSeq;
    next.reportPending = undefined;
  }
  if (observation.prompt !== state.prompt) {
    next.lastActivityAt = now;
    if (observation.prompt === undefined) {
      // The prompt closed. A child that answered it and goes on working is in
      // the same turn, so the idle settle starts again from here rather than
      // counting the wait as a finished turn.
      next.prompt = undefined;
      next.promptSince = undefined;
      next.statusSince = now;
      next.firedBlocked = undefined;
    } else if (state.prompt === undefined) {
      next.prompt = observation.prompt;
      next.promptSince = now;
      next.firedBlocked = undefined;
    } else {
      // The same wait with a reworded line is still one block.
      next.prompt = observation.prompt;
    }
  }
  if (observation.busy) {
    next.lastBusyAt = now;
    next.firedStuckSince = undefined;
    // Output under an open prompt is the dialog redrawing, not a new block.
    if (next.prompt === undefined) next.firedBlocked = undefined;
  }

  // A blocked child stays blocked until someone answers it, so report the
  // dialog once and then wait for the status to move rather than repeating it
  // on every tick.
  const blockedSince = next.prompt !== undefined ? (next.promptSince ?? now) : next.status === 'blocked' ? next.statusSince : undefined;
  if (blockedSince !== undefined && now - blockedSince >= limits.blockedMs && !next.firedBlocked) {
    return { state: { ...next, firedBlocked: true }, event: 'blocked' };
  }
  // A child waiting on a prompt has not finished its turn, and it is neither
  // stuck nor inactive: it is blocked, which it already said.
  if (next.prompt !== undefined) return { state: next };
  if (isReady(next.status) && next.completionSeq !== undefined && next.completionSeq !== next.reportedFor && now - next.statusSince >= limits.idleMs) {
    return { state: { ...next, reportedFor: next.completionSeq }, event: 'idle' };
  }
  // A child first seen already settled still owes its parent one message.
  if (isReady(next.status) && next.completionSeq === undefined && state.status !== next.status && now - next.statusSince >= limits.idleMs) {
    return { state: { ...next, completionSeq: 1, reportedFor: 1 }, event: 'idle' };
  }
  if ((next.status === 'working' || next.status === 'unknown') && next.firedStuckSince !== next.lastBusyAt && now - next.lastBusyAt >= limits.stuckMs) {
    return { state: { ...next, firedStuckSince: next.lastBusyAt }, event: 'stuck' };
  }
  // Inactivity is checked last, so it never displaces a more specific event
  // from the same pass. Whatever it defers fires on a later pass, because
  // nothing here consumes the inactivity clock until it fires.
  if (now - next.lastActivityAt >= (limits.inactiveMs ?? DEFAULT_INACTIVE_MS) && (next.firedInactiveFor === undefined || next.lastActivityAt > next.firedInactiveFor)) {
    return { state: { ...next, firedInactiveFor: next.lastActivityAt }, event: 'inactive' };
  }
  return { state: next };
}

/**
 * Fold a report into the state. A report is activity. A final report, `done`
 * or `needs-input`, also covers a turn, so no idle event follows it: the turn
 * that already ended when the child is settled, or else the turn in progress,
 * once it ends. A `progress` report covers nothing, because the turn goes on,
 * and the parent still hears once when it ends.
 */
export function markReported(state: ClassifierState, now: number, final = true): ClassifierState {
  const next: ClassifierState = { ...state, lastBusyAt: now, lastActivityAt: now };
  if (!final) return next;
  if (isReady(state.status) && state.prompt === undefined) {
    // Count from 0 when no turn was numbered yet, so the first-seen rule in
    // advance does not announce the turn this report covered.
    const seq = state.completionSeq ?? 0;
    return { ...next, completionSeq: seq, reportedFor: seq, reportPending: undefined };
  }
  return { ...next, reportPending: true };
}
