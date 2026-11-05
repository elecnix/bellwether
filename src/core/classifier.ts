// The classifier: turns herdr states into child events, with a settle time for
// each. It is a pure function of (state, clock, observation) so tier 1 can run
// it against a fake clock without a socket.
import type { AgentStatus, ChildEventKind } from './types.ts';

/** Starting values. The lab tunes these; they are not measurements. */
export const DEFAULT_LIMITS: SettleLimits = {
  idleMs: 5_000,
  blockedMs: 3_000,
  stuckMs: 10 * 60_000,
};

export interface SettleLimits {
  /** How long an idle child waits, so a quick next turn sends no message. */
  idleMs: number;
  /** How long a blocked child waits before its dialog is worth reading. */
  blockedMs: number;
  /** How long a working child may be quiet before it is stuck. */
  stuckMs: number;
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
}

export interface Observation {
  status: AgentStatus;
  completionSeq?: number;
  /** True when the child produced output or its transcript grew since the last look. */
  busy?: boolean;
}

export function initialState(status: AgentStatus, now: number): ClassifierState {
  return { status, statusSince: now, lastBusyAt: now };
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
  if (observation.status !== state.status) {
    next.status = observation.status;
    next.statusSince = now;
    next.firedStuckSince = undefined;
  }
  if (observation.completionSeq !== undefined && observation.completionSeq !== state.completionSeq) {
    next.completionSeq = observation.completionSeq;
    next.statusSince = now;
  }
  if (observation.busy) {
    next.lastBusyAt = now;
    next.firedStuckSince = undefined;
  }

  if (next.status === 'blocked' && now - next.statusSince >= limits.blockedMs) {
    return { state: { ...next, statusSince: now }, event: 'blocked' };
  }
  if (isReady(next.status) && next.completionSeq !== undefined && next.completionSeq !== next.reportedFor && now - next.statusSince >= limits.idleMs) {
    return { state: { ...next, reportedFor: next.completionSeq }, event: 'idle' };
  }
  if ((next.status === 'working' || next.status === 'unknown') && next.firedStuckSince !== next.lastBusyAt && now - next.lastBusyAt >= limits.stuckMs) {
    return { state: { ...next, firedStuckSince: next.lastBusyAt }, event: 'stuck' };
  }
  return { state: next };
}

/** Mark the newest turn as covered by a report, so no idle event follows it. */
export function markReported(state: ClassifierState, now: number): ClassifierState {
  return { ...state, reportedFor: state.completionSeq, lastBusyAt: now, statusSince: now };
}
