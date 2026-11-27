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
  /** The newest turn a report has already covered. */
  reportedFor?: number;
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
}

export function initialState(status: AgentStatus, now: number, seed: InitialSeed = {}): ClassifierState {
  const activityAt = seed.activityAt ?? now;
  return { status, statusSince: now, lastBusyAt: now, lastActivityAt: activityAt, firedInactiveFor: seed.firedInactiveFor };
}

/** The limits one child is judged by: the base, with the child's own thresholds. */
export function limitsFor(child: ChildRecord, base: SettleLimits): SettleLimits {
  const limits: SettleLimits = { ...base, inactiveMs: inactiveMsOf(child) };
  return child.stuckMs === undefined ? limits : { ...limits, stuckMs: child.stuckMs };
}

/**
 * The state a child starts from, recovered from its registry record. A parent
 * that restarts resumes the same quiet period instead of a fresh one, and does
 * not send the inactive event again for a period it already reported.
 */
export function seedFor(child: ChildRecord, now: number): ClassifierState {
  const activityAt = Math.max(Date.parse(child.lastBusyAt), Date.parse(child.statusChangedAt));
  const fired = child.inactiveNotifiedFor === undefined ? NaN : Date.parse(child.inactiveNotifiedFor);
  return initialState(child.lastStatus, now, {
    activityAt: Number.isFinite(activityAt) ? activityAt : now,
    firedInactiveFor: Number.isFinite(fired) ? fired : undefined,
  });
}

export function isReady(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done';
}

/**
 * Fold one observation into the state and say whether an event is due.
 * The returned state is a new object; the classifier never mutates its input.
 */
export function advance(state: ClassifierState, observation: Observation, now: number, limits: SettleLimits = DEFAULT_LIMITS): { state: ClassifierState; event?: ChildEventKind } {
  const next: ClassifierState = { ...state };
  const seqMoved = observation.completionSeq !== undefined && observation.completionSeq !== state.completionSeq;
  if (observation.status !== state.status || seqMoved || observation.busy) {
    next.lastActivityAt = now;
  }
  if (observation.status !== state.status) {
    next.status = observation.status;
    next.statusSince = now;
    next.firedStuckSince = undefined;
    next.firedBlocked = undefined;
  }
  const becameReady = isReady(observation.status) && !isReady(state.status);
  if (seqMoved) {
    next.completionSeq = observation.completionSeq;
    next.statusSince = now;
  } else if (observation.completionSeq === undefined && becameReady) {
    // herdr reports completion_seq on AgentInfo, and the watcher reads that
    // projection, so a reconciled child normally carries one. The field is
    // still absent before the first reconcile finishes, and on a pane herdr
    // has not observed working for: a turn that ends faster than screen
    // detection catches it leaves the value unchanged. A turn that ends is
    // also visible as a status change into idle or done, so count those.
    next.completionSeq = (state.completionSeq ?? 0) + 1;
    next.statusSince = now;
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

/** Mark the newest turn as covered by a report, so no idle event follows it. */
export function markReported(state: ClassifierState, now: number): ClassifierState {
  return { ...state, reportedFor: state.completionSeq, lastBusyAt: now, lastActivityAt: now, statusSince: now };
}
