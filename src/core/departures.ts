// Every place a child left by a move or a teleport (issue #241). The record
// keeps them as `departures`, oldest first, and keeps the newest as
// `movedFrom` too, the one field a daemon from before this list reads. The
// parent's daemon drains each machine in the list once after the child left
// it, and retires each worktree in it that sits on its own machine.
import path from 'node:path';
import { hostOf } from './machine.ts';
import type { ChildRecord, Departure } from './types.ts';

/** Two departures name one place when host and directory agree. */
function samePlace(a: { host: string; cwd?: string }, b: { host: string; cwd?: string }): boolean {
  return a.host === b.host && path.resolve(a.cwd ?? '/') === path.resolve(b.cwd ?? '/');
}

/**
 * The places a child left, oldest first. A record an older daemon wrote has
 * only `movedFrom`, and an older daemon that moved a child after this one
 * wrote the list updated only `movedFrom`, so a `movedFrom` the list lacks
 * counts as the newest departure.
 */
export function departuresOf(child: Pick<ChildRecord, 'departures' | 'movedFrom'>): Departure[] {
  const list = [...(child.departures ?? [])];
  const last = child.movedFrom;
  if (last && !list.some((entry) => samePlace(entry, last) && entry.at === last.at)) {
    return [...list.filter((entry) => !samePlace(entry, last)), last];
  }
  return list;
}

/**
 * Note that the child left `departure`, once the record already names where
 * it went. The list keeps one entry per place, the newest, and drops the
 * place the child now runs in, since it is no longer left. So it never holds
 * more entries than the places the child really left and nothing retired.
 */
export function recordDeparture(record: ChildRecord, departure: Departure): void {
  const now = { host: hostOf(record), ...(record.cwd ? { cwd: record.cwd } : {}) };
  const list = departuresOf(record).filter((entry) => !samePlace(entry, departure) && !samePlace(entry, now));
  record.departures = [...list, departure];
  record.movedFrom = departure;
}

/**
 * Forget the places on `host` that sit inside `dir`, once retirement removed
 * that worktree or found it gone. `movedFrom` goes too when it names one of
 * them, so an older daemon neither drains nor retires a place already handled.
 */
export function dropDeparture(record: ChildRecord, host: string, dir: string): void {
  const root = path.resolve(dir);
  const gone = (entry: Departure): boolean => entry.host === host && entry.cwd !== undefined && inside(path.resolve(entry.cwd), root);
  const list = departuresOf(record).filter((entry) => !gone(entry));
  if (list.length) record.departures = list;
  else delete record.departures;
  const last = list.at(-1);
  if (last) record.movedFrom = last;
  else delete record.movedFrom;
}

function inside(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
}
