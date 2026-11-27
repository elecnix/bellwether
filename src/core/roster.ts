// The roster: one line, appended to an alert, about the parent's other
// children (issue #146). An alert names only the children that changed, so a
// parent reading it cannot tell whether it watches two children or fourteen,
// or that one of them went quiet an hour ago.
//
// The line counts and never narrates. It lists only children that have not
// exited, leaves out every child the alert already names, and says nothing at
// all when no other live child remains, so a one-child parent's alert is the
// same text as before. Working children are counted together. Every other
// child is named with how long it has been quiet, the quietest first, so the
// cap never hides the one that has waited longest. agent_list and agent_read
// stay the authority for detail.
//
// The daemon computes the roster from the child records it already holds and
// sends it with each push. The adapters format it, because only the adapter
// knows which children one message names.
import type { ChildRecord } from './types.ts';

/** What the roster says a child is doing: its newest state, never an old event. */
export type RosterState = 'working' | 'idle' | 'blocked' | 'unknown';

/** One live child, as the daemon sends it with a push. */
export interface RosterChild {
  childId: string;
  name: string;
  state: RosterState;
  /** When the child entered that state, as an ISO time. */
  since: string;
}

/** How many quiet children the line names before it counts the rest. */
export const ROSTER_CAP = 4;

/** A name longer than this is cut, so the worst case at the cap stays bounded. */
const NAME_MAX = 24;

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
  return children.filter((child) => !child.exitedAt && !child.retiredAt).map((child) => ({ childId: child.id, name: child.name, ...stateOf(child) }));
}

const STATES: readonly string[] = ['working', 'idle', 'blocked', 'unknown'];

/**
 * A roster as it came off the wire, keeping only well-formed children. A field
 * that is not a list gives no roster, so the adapter adds no line.
 */
export function rosterFrom(value: unknown): RosterChild[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item: unknown) => {
    const child = item as Partial<Record<keyof RosterChild, unknown>> | null;
    if (!child || typeof child.childId !== 'string' || typeof child.name !== 'string' || typeof child.since !== 'string') return [];
    if (typeof child.state !== 'string' || !STATES.includes(child.state)) return [];
    return [{ childId: child.childId, name: child.name, state: child.state as RosterState, since: child.since }];
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

const cut = (name: string): string => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);

/**
 * The roster line for one message, or an empty string when it has nothing to
 * say. `named` holds the child ids the message already names. The count in the
 * line is every live child, so a parent sees how many it watches.
 */
export function rosterLine(roster: readonly RosterChild[] | undefined, named: Iterable<string>, now: number): string {
  if (!roster?.length) return '';
  const skip = new Set(named);
  const others = roster.filter((child) => !skip.has(child.childId));
  if (!others.length) return '';
  const working = others.filter((child) => child.state === 'working').length;
  const quiet = others.filter((child) => child.state !== 'working').sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const parts = [
    ...(working ? [`${working} working`] : []),
    ...quiet.slice(0, ROSTER_CAP).map((child) => `${cut(child.name)} ${child.state} ${quietAge(child.since, now)}`),
    ...(quiet.length > ROSTER_CAP ? [`and ${quiet.length - ROSTER_CAP} more`] : []),
  ];
  return `children ${roster.length}: ${parts.join(', ')}`;
}
