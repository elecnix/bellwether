// What both adapters put in front of the parent's model: events in the order
// they happened, and a note on any that arrive late, so a reader can tell a
// fresh event from a backlog.
import type { OutboxEntry } from './types.ts';

/** An event delivered this long after it happened counts as late. */
export const LATE_AFTER_MS = 60_000;

/** The entries sorted by event time, oldest first. Entries with the same time keep their order. */
export function byEventTime<T extends Pick<OutboxEntry, 'at'>>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.at) }))
    .sort((a, b) => (Number.isNaN(a.at) || Number.isNaN(b.at) ? 0 : a.at - b.at) || a.index - b.index)
    .map(({ entry }) => entry);
}

function span(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The note for an event delivered late, such as
 * ` (late by 4m34s: it happened at 07:25:46 UTC)`, or an empty string for one
 * delivered on time.
 */
export function lateNote(entry: Pick<OutboxEntry, 'at'>, now = Date.now()): string {
  const at = Date.parse(entry.at);
  if (Number.isNaN(at) || now - at < LATE_AFTER_MS) return '';
  return ` (late by ${span(now - at)}: it happened at ${new Date(at).toISOString().slice(11, 19)} UTC)`;
}
