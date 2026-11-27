// What a child record proves about the briefs it was given, and what a resume
// hands the child next (issue #132). A harness that exits before it reads its
// brief leaves a session that holds nothing, so a resume that sent only its
// own prompt would leave the task nowhere. Each brief keeps its own file, and
// a resume repeats the newest one ahead of its prompt unless the record shows
// that the child read it: a report sent after the brief was written, or a
// finished turn in the pane that started on it. Neither a status nor the time
// the child ran counts, because a harness can run without reading anything.
import fs from 'node:fs';
import { promptPath } from './paths.ts';
import type { ChildBrief, ChildRecord } from './types.ts';

type BriefFacts = Pick<ChildRecord, 'id' | 'startedAt' | 'briefs' | 'lastReport' | 'turnNotified'>;

/**
 * The briefs a record names. A record written before briefs were numbered
 * names none, and its spawn's brief, when still on disk, counts as number 1,
 * started in an unknown pane.
 */
export function briefsOf(child: BriefFacts): ChildBrief[] {
  if (child.briefs?.length) return child.briefs;
  const legacy = promptPath(child.id);
  return fs.existsSync(legacy) ? [{ n: 1, file: legacy, at: child.startedAt }] : [];
}

/** Whether the record proves the child read this brief. */
export function briefRead(child: BriefFacts, brief: ChildBrief): boolean {
  const report = child.lastReport ? Date.parse(child.lastReport.at) : NaN;
  if (report >= Date.parse(brief.at)) return true;
  const turn = child.turnNotified;
  if (turn && (brief.paneId === undefined || turn.paneId === brief.paneId)) return true;
  return false;
}

/** The newest brief, when nothing on the record proves the child read it. */
export function unreadBrief(child: BriefFacts): ChildBrief | undefined {
  const newest = briefsOf(child).at(-1);
  return newest && !briefRead(child, newest) ? newest : undefined;
}

/**
 * Whether a child that stops running keeps its briefs: it does while its
 * newest brief is unread, so a resume can hand it over and a person can read
 * it. A child that read its brief has it in its session.
 */
export function keepsBriefs(child: BriefFacts): boolean {
  return unreadBrief(child) !== undefined;
}

/** What a start hands the child: the text, and the record entry that names its file. */
export interface NextBrief {
  text: string;
  brief: ChildBrief;
  /** The unread brief this start repeats, when there is one. */
  repeats?: ChildBrief;
  /** True when the start reuses the unread brief's own file and writes nothing new. */
  reused: boolean;
}

/**
 * What a resume gives the child. A new prompt gets the next number. When the
 * newest brief is unread, the new file holds that brief first and the prompt
 * after it, and a resume with no prompt hands the unread brief over again.
 * With neither, the child gets nothing, as before.
 */
export function nextBrief(child: BriefFacts, prompt: string | undefined, now: string): NextBrief | undefined {
  const briefs = briefsOf(child);
  const pending = unreadBrief(child);
  if (prompt === undefined) {
    if (!pending) return undefined;
    return { text: readBrief(pending), brief: { ...pending }, repeats: pending, reused: true };
  }
  const n = Math.max(0, ...briefs.map((brief) => brief.n)) + 1;
  const brief: ChildBrief = { n, file: promptPath(child.id, n), at: now };
  if (!pending) return { text: prompt, brief, reused: false };
  brief.carries = [...(pending.carries ?? []), pending.n];
  return { text: carried(pending, prompt), brief, repeats: pending, reused: false };
}

function readBrief(brief: ChildBrief): string {
  try {
    return fs.readFileSync(brief.file, 'utf8');
  } catch (error) {
    return `(Bellwether could not read the earlier brief at ${brief.file}: ${(error as Error).message}. Ask your parent for the task.)`;
  }
}

/** The unread brief, then the resume's prompt, with a line that says why both are here. */
function carried(pending: ChildBrief, prompt: string): string {
  return [
    `Bellwether gave you the brief below when you started, and nothing shows you read it, so it comes first. It is also in ${pending.file}.`,
    '',
    readBrief(pending),
    '',
    '---',
    '',
    'Then your parent sent this with the resume:',
    '',
    prompt,
  ].join('\n');
}
