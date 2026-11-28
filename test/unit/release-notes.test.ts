// Tier 1: release notes, one file per change (issue #182). The pure parts run
// on strings; the claim that two pull requests never conflict, and that the
// release reads each note's pull request from the commit that added it, runs
// against a real git repository in a scratch directory.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ADDED_NOTES_LOG, addedBy, NOTES_DIR, parseNote, readNotes, resolvePrs } from '../../scripts/release-notes.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

/** A repository whose main holds the commit that set the previous release. */
function repository(t: test.TestContext): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-release-notes-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet');
  write(repo, 'package.json', '{ "version": "0.1.8" }\n');
  write(repo, 'table.ts', 'export const BEHAVIORS = [\n  { prs: [1] },\n];\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'release: 0.1.8 (#100)');
  return repo;
}

/** Branch from main, add `files`, then squash-merge onto main as pull request `number`. Returns whether the merge was clean. */
function squash(repo: string, base: string, branch: string, number: number, files: Record<string, string>): boolean {
  git(repo, 'branch', branch, base);
  git(repo, 'checkout', '--quiet', branch);
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', `work on ${branch}`);
  git(repo, 'checkout', '--quiet', 'main');
  const merge = spawnSync('git', [...GIT, 'merge', '--squash', branch], { cwd: repo, encoding: 'utf8' });
  if (merge.status !== 0) {
    git(repo, 'reset', '--quiet', '--hard', 'HEAD');
    return false;
  }
  git(repo, 'commit', '--quiet', '-m', `${branch} (#${number})`);
  return true;
}

test('a note is the text of release-notes/<version>/<name>.md, with its pull requests from front matter when it has them', () => {
  assert.deepEqual(parseNote('release-notes/0.1.9/doctor-timeout.md', 'Doctor gives each SSH call 6 s.\n'), {
    file: 'release-notes/0.1.9/doctor-timeout.md', version: '0.1.9', prs: [], summary: 'Doctor gives each SSH call 6 s.',
  });
  assert.deepEqual(parseNote('release-notes/0.1.7/roster.md', '---\nprs: [153, 154]\n---\nAn alert can end\nwith one line.\n').prs, [153, 154]);
  assert.equal(parseNote('release-notes/0.1.7/roster.md', 'An alert can end\nwith one line.\n').summary, 'An alert can end with one line.', 'a wrapped line reads as one');
});

test('a note in the wrong place, with two paragraphs, empty, or with other front matter is refused by name', () => {
  assert.throws(() => parseNote('release-notes/next/a.md', 'A change.'), /release-notes\/<version>\/<name>\.md/);
  assert.throws(() => parseNote('release-notes/0.1.9/a.txt', 'A change.'), /release-notes\/<version>\/<name>\.md/);
  assert.throws(() => parseNote('release-notes/0.1.9/sub/a.md', 'A change.'), /release-notes\/<version>\/<name>\.md/);
  assert.throws(() => parseNote('release-notes/0.1.9/a.md', 'One.\n\nTwo.\n'), /one paragraph/);
  assert.throws(() => parseNote('release-notes/0.1.9/a.md', '\n'), /empty/);
  assert.throws(() => parseNote('release-notes/0.1.9/a.md', '---\nversion: 0.1.9\n---\nA change.\n'), /prs: \[/);
});

test('every note in this repository parses, and features.ts no longer keeps a behavior table', async () => {
  const notes = readNotes(ROOT);
  assert.ok(notes.length > 0);
  for (const note of notes) assert.ok(note.summary.length > 0, note.file);
  // A pull request opened before #182 appends to BEHAVIORS. Its merge with
  // main conflicts once, and a resolution that keeps the array would drop
  // the note on the floor, so this names where the line goes now.
  const features = (await import('../../src/daemon/features.ts')) as Record<string, unknown>;
  assert.equal('BEHAVIORS' in features, false, `src/daemon/features.ts exports BEHAVIORS again. Move each entry to a file ${NOTES_DIR}/<version>/<name>.md holding its summary (docs/releasing.md).`);
});

test('two pull requests that each add a note merge cleanly, where two appends to one array conflict', (t) => {
  const repo = repository(t);
  // The array shape from #167: both branches append after the same line.
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  assert.equal(squash(repo, base, 'array-a', 201, { 'table.ts': 'export const BEHAVIORS = [\n  { prs: [1] },\n  { prs: [201] },\n];\n' }), true);
  assert.equal(squash(repo, base, 'array-b', 202, { 'table.ts': 'export const BEHAVIORS = [\n  { prs: [1] },\n  { prs: [202] },\n];\n' }), false, 'two appends to one array conflict');
  // The file shape: both branches from the same base, merged one after the other.
  const fresh = git(repo, 'rev-parse', 'HEAD').trim();
  assert.equal(squash(repo, fresh, 'note-a', 203, { 'release-notes/0.1.9/doctor-timeout.md': 'Doctor gives each SSH call 6 s.\n' }), true);
  assert.equal(squash(repo, fresh, 'note-b', 204, { 'release-notes/0.1.9/doctor-integrations.md': 'Doctor names a missing integration.\n' }), true);
  assert.equal(squash(repo, fresh, 'note-c', 205, { 'release-notes/0.1.9/brief-taken.md': 'A spawn waits for the model.\n' }), true);
  const notes = resolvePrs(readNotes(repo), addedBy(git(repo, ...ADDED_NOTES_LOG)));
  assert.deepEqual(notes.map((note) => [note.file, note.prs]), [
    ['release-notes/0.1.9/doctor-timeout.md', [203]],
    ['release-notes/0.1.9/doctor-integrations.md', [204]],
    ['release-notes/0.1.9/brief-taken.md', [205]],
  ], 'each note takes the pull request whose commit added it, and they list in that order');
});

test('a later edit keeps a note on the pull request that added it, and a note added afterwards names its own', (t) => {
  const repo = repository(t);
  const base = () => git(repo, 'rev-parse', 'HEAD').trim();
  squash(repo, base(), 'note', 210, { 'release-notes/0.1.9/restart.md': 'A restart opens its tab frist.\n' });
  squash(repo, base(), 'typo', 211, { 'release-notes/0.1.9/restart.md': 'A restart opens its tab first.\n' });
  // A forgotten note, added by a pull request of its own after the change merged.
  squash(repo, base(), 'forgotten', 212, { 'release-notes/0.1.9/herdr-path.md': '---\nprs: [209]\n---\nA daemon finds herdr on purpose.\n' });
  // A commit straight to main, without a pull request number.
  write(repo, 'release-notes/0.1.9/direct.md', 'A note without a pull request.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'a direct commit');
  const notes = resolvePrs(readNotes(repo), addedBy(git(repo, ...ADDED_NOTES_LOG)));
  const prs = Object.fromEntries(notes.map((note) => [path.basename(note.file), note.prs]));
  assert.deepEqual(prs, { 'herdr-path.md': [209], 'restart.md': [210], 'direct.md': [] });
  assert.equal(notes.find((note) => note.file.endsWith('restart.md'))!.summary, 'A restart opens its tab first.');
});
