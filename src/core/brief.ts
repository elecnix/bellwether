// A child's brief lives in a private file, and the harness gets a one-line
// pointer to it. herdr types an agent's arguments into a shell and refuses a
// line break, and a prompt on a command line shows in `ps` and matches
// `pkill -f`. A file keeps the line breaks, any length, and the text private.
import fs from 'node:fs';
import path from 'node:path';
import { promptPath, promptsDir } from './paths.ts';

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

/**
 * The one argument that hands the brief to the harness. Claude Code and Pi
 * attach a file named with @ to the first message, so the child spends no tool
 * call reading it. Any other harness gets a sentence that names the file.
 */
export function briefArgument(kind: string, file: string): string {
  // Claude Code reads a mention out of the prompt text, so a path with a space
  // needs quotes there. Pi takes the argument whole and strips only the @.
  if (kind === 'claude') return /\s/.test(file) ? `@"${file}"` : `@${file}`;
  if (kind === 'pi') return `@${file}`;
  return `Your task is in ${file}. Read it, then do what it says.`;
}
