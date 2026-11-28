// Release notes, one file per change (issue #182).
//
// A change in what Bellwether does has its note in a file of its own,
// release-notes/<version>/<name>.md, which holds the paragraph the release
// pull request lists under that version. Two pull requests add two files, so
// their merges never touch the same bytes. One array in features.ts made
// every pair of concurrent changes conflict on adjacent lines.
//
// A note needn't know its pull request's number, which doesn't exist until
// the pull request opens. Main takes squash merges, so the commit that added
// the file ends with `(#N)`, and the release reads N from there. A note added
// by a later pull request, for a change that merged without one, names the
// change it describes in front matter instead:
//
//   ---
//   prs: [181]
//   ---
//   A spawn counts a brief taken once the child's model begins a turn on it.
import fs from 'node:fs';
import path from 'node:path';

export const NOTES_DIR = 'release-notes';

/** A change in what a release does that adds nothing to the wire, as the release pull request lists it. */
export interface Behavior {
  /** The first release that behaves this way: the directory the note sits in. */
  version: string;
  /** The pull requests that brought it, which the release script matches against what merged. */
  prs: readonly number[];
  /** What someone can now do, or what now happens, in one paragraph that passes the same Vale rules as the docs. */
  summary: string;
}

/** A note as its file states it, before the release reads the pull request that added it. */
export interface Note extends Behavior {
  /** The path from the repository root, with forward slashes. */
  file: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const NAME = /^[a-z0-9][a-z0-9.-]*\.md$/;

/** Read one note from its path and text, or throw an error that names the file and what is wrong with it. */
export function parseNote(file: string, text: string): Note {
  const parts = file.split('/');
  if (parts.length !== 3 || parts[0] !== NOTES_DIR || !VERSION.test(parts[1]!) || !NAME.test(parts[2]!)) {
    throw new Error(`${file}: a release note sits at ${NOTES_DIR}/<version>/<name>.md, with a lowercase name of letters, digits, dots and hyphens`);
  }
  let body = text.replace(/\r\n/g, '\n');
  let prs: number[] = [];
  const front = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (front) {
    body = body.slice(front[0].length);
    for (const line of front[1]!.split('\n').filter((each) => each.trim())) {
      const list = /^prs:\s*\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]\s*$/.exec(line);
      if (!list) throw new Error(`${file}: front matter takes one line, \`prs: [N, ...]\`, and "${line}" is not that line`);
      prs = list[1]!.split(',').map((each) => Number(each.trim()));
    }
  }
  const summary = body.trim();
  if (!summary) throw new Error(`${file}: the note is empty. Write the paragraph a person reads in the release pull request.`);
  if (/\n\s*\n/.test(summary)) throw new Error(`${file}: a note is one paragraph, because the release pull request lists it as one line`);
  return { file, version: parts[1]!, prs, summary: summary.replace(/\s+/g, ' ') };
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * Notes by version, then by the first pull request each names, so the
 * release lists changes in the order they merged. A note that names no pull
 * request comes after the rest of its version, and the file name breaks a tie.
 */
export function sortNotes<T extends Note>(notes: readonly T[]): T[] {
  const first = (note: Note) => note.prs[0] ?? Number.POSITIVE_INFINITY;
  return [...notes].sort((a, b) => compareVersions(a.version, b.version) || first(a) - first(b) || a.file.localeCompare(b.file));
}

/** Every note under `root`, or an empty list when it has no notes directory. */
export function readNotes(root: string): Note[] {
  const dir = path.join(root, NOTES_DIR);
  if (!fs.existsSync(dir)) return [];
  const notes: Note[] = [];
  for (const version of fs.readdirSync(dir)) {
    const sub = path.join(dir, version);
    if (!fs.statSync(sub).isDirectory()) throw new Error(`${NOTES_DIR}/${version}: ${NOTES_DIR} holds one directory per version, and nothing else`);
    for (const name of fs.readdirSync(sub)) notes.push(parseNote(`${NOTES_DIR}/${version}/${name}`, fs.readFileSync(path.join(sub, name), 'utf8')));
  }
  return sortNotes(notes);
}

/** The `git log` arguments that list each first-parent commit that added a note, newest first, with its subject. */
export const ADDED_NOTES_LOG = ['log', '--first-parent', '--diff-filter=A', '--format=%x00%s', '--name-only', 'HEAD', '--', NOTES_DIR];

/**
 * Each note's path, mapped to the pull request whose squash commit added it,
 * from the output of ADDED_NOTES_LOG. A file added, removed and added again
 * maps to its newest addition. A commit whose subject ends without `(#N)`
 * maps its files to undefined, because no pull request brought them.
 */
export function addedBy(log: string): Map<string, number | undefined> {
  const added = new Map<string, number | undefined>();
  for (const commit of log.split('\0').slice(1)) {
    const [subject = '', ...files] = commit.split('\n');
    const number = /\(#(\d+)\)$/.exec(subject.trim())?.[1];
    for (const file of files.map((each) => each.trim()).filter(Boolean)) {
      if (!added.has(file)) added.set(file, number ? Number(number) : undefined);
    }
  }
  return added;
}

/** The notes with each one's pull request: the front matter's when it names them, else the one that added its file. */
export function resolvePrs(notes: readonly Note[], added: ReadonlyMap<string, number | undefined>): Note[] {
  return sortNotes(notes.map((note) => {
    if (note.prs.length > 0) return note;
    const number = added.get(note.file);
    return { ...note, prs: number === undefined ? [] : [number] };
  }));
}
