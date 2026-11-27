// The inactivity notification: a child that has done nothing observable for a
// set time gets one message to its parent. "Nothing observable" covers every
// status, blocked included, so a child waiting on an unanswered dialog is
// reported too. The threshold is per child. Its default and its bounds live
// here, so the spawn tool, the registry and the watcher all agree.
import type { ChildRecord } from './types.ts';

/** The threshold when a spawn does not set one. */
export const DEFAULT_INACTIVE_MS = 5 * 60_000;

/** The longest threshold a spawn may ask for. Anything above it is clamped. */
export const MAX_INACTIVE_MS = 24 * 60 * 60_000;

/**
 * The shortest threshold. A spawn cannot turn the notification off, and a
 * zero or negative value would fire on every tick, so the floor is one minute.
 */
export const MIN_INACTIVE_MS = 60_000;

/**
 * Turn a spawn's minutes into the stored threshold in milliseconds. Leaving
 * the value out gives the default. A value that is not a finite number, such
 * as NaN, also gives the default; a value beyond the range is clamped to it.
 * There is no input that yields no threshold.
 */
export function resolveInactiveMs(minutes: number | undefined): number {
  if (minutes === undefined || Number.isNaN(minutes)) return DEFAULT_INACTIVE_MS;
  const ms = minutes * 60_000;
  return Math.min(MAX_INACTIVE_MS, Math.max(MIN_INACTIVE_MS, Math.round(ms)));
}

/**
 * The threshold a child's record asks for, bounded again on read. A record
 * written by hand, or by an older version, cannot push it past the range.
 */
export function inactiveMsOf(child: Pick<ChildRecord, 'inactiveMs'>): number {
  const stored = child.inactiveMs;
  if (stored === undefined || !Number.isFinite(stored)) return DEFAULT_INACTIVE_MS;
  return Math.min(MAX_INACTIVE_MS, Math.max(MIN_INACTIVE_MS, stored));
}
