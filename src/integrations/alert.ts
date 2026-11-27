// The text a parent reads for its children's events, shared by both adapters
// so they say the same thing. The pi extension sends one message for a burst;
// the Claude Code channel sends one notification per event, and puts the
// roster line on the last notification of a flush only.
import { childLabel } from '../core/label.ts';
import { byEventTime, lateNote } from '../core/notice.ts';
import { rosterLine, type RosterChild } from '../core/roster.ts';
import type { OutboxEntry } from '../core/types.ts';

const FOOTER = 'Read more with agent_read. Reply with agent_send.';

/** One event's first line and its text. */
function block(entry: OutboxEntry, now: number): string {
  return `${childLabel({ name: entry.name, paneId: entry.paneId, id: entry.childId })} ${entry.event}, a ${entry.kind} agent — receipt ${entry.receipt}${lateNote(entry, now)}\n${entry.text}`;
}

/** The roster line, after a blank line, or nothing when the line is empty. */
const withRoster = (line: string): string => (line ? `\n\n${line}` : '');

/**
 * One message for a burst of events, so three children changing at once read
 * once. Events come oldest first, and one delivered late says so. The roster
 * line leaves out every child the burst names.
 */
export function composeBurst(entries: OutboxEntry[], now = Date.now(), roster?: readonly RosterChild[]): string {
  if (!entries.length) return '';
  const head = entries.length === 1 ? '[bellwether]' : `[bellwether] ${entries.length} children changed`;
  const body = byEventTime(entries)
    .map((entry) => block(entry, now))
    .join('\n\n');
  const line = rosterLine(roster, entries.map((entry) => entry.childId), now);
  return `${head}\n${body}${withRoster(line)}\n\n${FOOTER}`;
}

/** One channel event's text, with the roster line the caller worked out for its flush, if any. */
export function composeEvent(entry: OutboxEntry, now = Date.now(), line = ''): string {
  return `[bellwether] ${block(entry, now)}${withRoster(line)}\n\n${FOOTER}`;
}
