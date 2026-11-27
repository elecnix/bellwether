// The roster: one line, appended to an alert, about the parent's other
// children (issue #146). An alert names only the children that changed, so a
// parent reading it cannot tell whether it watches two children or fourteen,
// or that one of them went quiet an hour ago.
//
// The line counts and never narrates: `children 5: 2 working, 1 idle 12m, 1
// blocked`. It counts only children that have not exited, leaves out every
// child the alert already names, and says nothing at all when no other live
// child remains, so a one-child parent's alert is the same text as before.
// One age appears, on the state of the child that has been quiet longest,
// because that is the number a parent acts on. agent_list and agent_read stay
// the authority for detail.
//
// The daemon decides when a roster rides an alert (rosterDue), so both
// adapters keep one rule: never a line the parent already received, and at
// most one per ROSTER_INTERVAL_MS. The adapters format it, with the children
// their message names left out.
import type { ChildRecord } from './types.ts';

/** What the roster says a child is doing: its newest state, never an old event. */
export type RosterState = 'working' | 'idle' | 'blocked' | 'unknown';

/** One live child, as the daemon sends it with a push. */
export interface RosterChild {
  childId: string;
  state: RosterState;
  /** When the child entered that state, as an ISO time. */
  since: string;
}

/** The states in the order the line counts them. Four states make four entries at most, which is the cap. */
const STATES: readonly RosterState[] = ['working', 'idle', 'blocked', 'unknown'];

/** The shortest time between two roster lines to one parent. */
export const ROSTER_INTERVAL_MS = 10 * 60_000;

const later = (a: string, b: string | undefined): string => (b && Date.parse(b) > Date.parse(a) ? b : a);

/** A child record's newest state. A child with a dialog open is blocked, whatever herdr reports. */
function stateOf(child: ChildRecord): Pick<RosterChild, 'state' | 'since'> {
  if (child.prompt) return { state: 'blocked', since: child.prompt.since };
  switch (child.lastStatus) {
    case 'working':
      return { state: 'working', since: child.statusChangedAt };
    case 'blocked':
      return { state: 'blocked', since: child.statusChangedAt };
    // A finished turn and an idle prompt are both a child waiting for its parent.
    case 'idle':
    case 'done':
      return { state: 'idle', since: later(child.statusChangedAt, child.lastBusyAt) };
    default:
      return { state: 'unknown', since: child.statusChangedAt };
  }
}

/** The live children of a parent, in record order. An exited or retired child is left out. */
export function rosterOf(children: readonly ChildRecord[]): RosterChild[] {
  return children.filter((child) => !child.exitedAt && !child.retiredAt).map((child) => ({ childId: child.id, ...stateOf(child) }));
}

/**
 * A roster as it came off the wire, keeping only well-formed children. A field
 * that is not a list gives no roster, so the adapter adds no line.
 */
export function rosterFrom(value: unknown): RosterChild[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item: unknown) => {
    const child = item as Partial<Record<keyof RosterChild, unknown>> | null;
    if (!child || typeof child.childId !== 'string' || typeof child.since !== 'string') return [];
    if (typeof child.state !== 'string' || !STATES.includes(child.state as RosterState)) return [];
    return [{ childId: child.childId, state: child.state as RosterState, since: child.since }];
  });
}

/** How long a child has been quiet, in the fewest characters that still read. */
export function quietAge(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (!Number.isFinite(minutes)) return '?';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/**
 * The roster line for one message, or an empty string when it has nothing to
 * say. `named` holds the child ids the message already names. The count after
 * `children` is every live child, so a parent sees how many it watches. With
 * `ages: false`, the line leaves its one age out: that text is what the
 * daemon compares to decide whether anything changed.
 */
export function rosterLine(roster: readonly RosterChild[] | undefined, named: Iterable<string>, now: number, options: { ages?: boolean } = {}): string {
  if (!roster?.length) return '';
  const skip = new Set(named);
  const others = roster.filter((child) => !skip.has(child.childId));
  if (!others.length) return '';
  const quietest = others.filter((child) => child.state !== 'working').sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
  const parts = STATES.flatMap((state) => {
    const count = others.filter((child) => child.state === state).length;
    if (!count) return [];
    const age = options.ages !== false && quietest?.state === state ? ` ${quietAge(quietest.since, now)}` : '';
    return [`${count} ${state}${age}`];
  });
  return `children ${roster.length}: ${parts.join(', ')}`;
}

/** The roster line a parent last received, and when. The daemon keeps it on the parent record. */
export interface RosterSent {
  at: string;
  /** The line without its age, so a child staying quiet longer is not a change. */
  line: string;
}

/**
 * Whether a roster rides the alert the daemon is about to push, and what to
 * record if it does. No line when there is nothing to say, none when the line
 * matches the last one the parent received, and none within
 * ROSTER_INTERVAL_MS of that one, so an alert storm carries one line.
 */
export function rosterDue(roster: readonly RosterChild[], named: Iterable<string>, last: RosterSent | undefined, now: number): RosterSent | undefined {
  const line = rosterLine(roster, named, now, { ages: false });
  if (!line) return undefined;
  if (last && (last.line === line || now - Date.parse(last.at) < ROSTER_INTERVAL_MS)) return undefined;
  return { at: new Date(now).toISOString(), line };
}
