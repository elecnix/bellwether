// A child's brief lives in a private file, and the harness gets a one-line
// pointer to it. herdr types an agent's arguments into a shell and refuses a
// line break, and a prompt on a command line shows in `ps` and matches
// `pkill -f`. A file keeps the line breaks, any length, and the text private.
import fs from 'node:fs';
import path from 'node:path';
import { bellwetherHome, promptPath, promptsDir, slug } from './paths.ts';

/** A brief is read when the child starts. One a week old has been read. */
const BRIEF_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Write the brief with mode 0600 in a 0700 directory, and return its path. */
export function writeBrief(childId: string, text: string, now = Date.now()): string {
  const dir = promptsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  pruneBriefs(now);
  const file = promptPath(childId);
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove a child's brief. A brief that is already gone is not an error. */
export function removeBrief(childId: string): void {
  fs.rmSync(promptPath(childId), { force: true });
}

/**
 * Remove the briefs older than a week. A child that exits removes its own, so
 * this only catches a daemon that stopped before its child did.
 */
export function pruneBriefs(now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(promptsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(promptsDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > BRIEF_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // Another process removed it first.
    }
  }
}

/** The directory a child's working directory holds its brief in. It ignores itself in git. */
export const WORKDIR_BRIEF_DIR = '.bellwether';

/**
 * Write the brief inside the child's own working directory, and return its
 * path. A child on another machine reads its brief there: a harness asks
 * before it reads a file outside its working directories, and a question at
 * startup is the interruption the brief exists to avoid. The directory holds a
 * `.gitignore` of `*`, so git ignores the directory and everything in it, and
 * a worktree stays clean. A working directory that is the user's home, whose
 * `.bellwether` is the Bellwether home itself, takes the brief in the prompts
 * directory there, which is inside it too.
 */
export function writeBriefIn(cwd: string, childId: string, text: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error(`the working directory ${cwd} does not exist on this machine, so the brief has nowhere to go and the child would start somewhere else`);
  }
  if (!stat.isDirectory()) throw new Error(`the working directory ${cwd} is not a directory on this machine`);
  const dir = path.join(cwd, WORKDIR_BRIEF_DIR);
  if (path.resolve(dir) === path.resolve(bellwetherHome())) return writeBrief(childId, text);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
  const file = workdirBriefPath(cwd, childId);
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Where `writeBriefIn` puts a child's brief in a working directory. */
export function workdirBriefPath(cwd: string, childId: string): string {
  return path.join(cwd, WORKDIR_BRIEF_DIR, `brief-${slug(childId)}.md`);
}

/**
 * Remove a brief `writeBriefIn` wrote, and its directory once nothing but the
 * `.gitignore` is left in it. A path that is not such a brief is left alone,
 * so a damaged record cannot point the cleanup at another file.
 */
export function removeBriefAt(file: string): void {
  const dir = path.dirname(file);
  if (path.basename(dir) !== WORKDIR_BRIEF_DIR || !/^brief-[A-Za-z0-9._-]+\.md$/.test(path.basename(file))) return;
  fs.rmSync(file, { force: true });
  try {
    const left = fs.readdirSync(dir);
    if (left.every((name) => name === '.gitignore')) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}
