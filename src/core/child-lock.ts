// One writer per child. A spawn that resumes a child holds a lock file on the
// child's id while it decides whether the child is alive and while it brings it
// back, so two callers resuming the same session open one tab between them.
// The lock is a file, not a map in memory, because two daemons on one machine
// can share a Bellwether home. A lock whose process is gone, or that is older
// than any resume can take, is stale and is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { isAlive } from '../daemon/lock.ts';
import { bellwetherHome, slug } from './paths.ts';

/** Longer than a resume can last: the start retries for 60 s and the dialogs wait 30 s. */
export const CHILD_LOCK_MAX_AGE_MS = 5 * 60_000;

interface ChildLockRecord {
  pid: number;
  at: number;
  /** What the holder is doing, for the loser's message. */
  purpose: string;
}

export function childLockPath(key: string): string {
  return path.join(bellwetherHome(), 'locks', `${slug(key)}.lock`);
}

/** Thrown to the caller that finds the lock taken. */
export class ChildBusyError extends Error {
  readonly key: string;
  readonly holder: { pid: number; at: number; purpose: string };

  constructor(key: string, holder: { pid: number; at: number; purpose: string }, label: string) {
    super(`${label} is already being brought back by another call (process ${holder.pid}, ${holder.purpose}, started ${new Date(holder.at).toISOString()}). Wait for its event, or call agent_list to see where it landed.`);
    this.name = 'ChildBusyError';
    this.key = key;
    this.holder = holder;
  }
}

function readLock(file: string): ChildLockRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ChildLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'number') return undefined;
    return { pid: parsed.pid, at: parsed.at, purpose: typeof parsed.purpose === 'string' ? parsed.purpose : 'unknown' };
  } catch {
    return undefined;
  }
}

/**
 * Run `work` while holding the lock on `key`. A second caller, in this process
 * or another, gets a ChildBusyError naming `label` instead of waiting.
 */
export async function withChildLock<T>(key: string, label: string, purpose: string, work: () => Promise<T>, now = Date.now, alive = isAlive): Promise<T> {
  const file = childLockPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mine: ChildLockRecord = { pid: process.pid, at: now(), purpose };
  const token = JSON.stringify(mine);
  let taken = false;
  for (let attempt = 0; attempt < 2 && !taken; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${token}\n`);
      fs.closeSync(fd);
      taken = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = readLock(file);
      // A half-written file is a holder that is mid-write, so it counts as held.
      if (!held) throw new ChildBusyError(key, { pid: 0, at: now(), purpose: 'unknown' }, label);
      if (alive(held.pid) && now() - held.at < CHILD_LOCK_MAX_AGE_MS) throw new ChildBusyError(key, held, label);
      fs.rmSync(file, { force: true });
    }
  }
  if (!taken) {
    const held = readLock(file);
    throw new ChildBusyError(key, held ?? { pid: 0, at: now(), purpose: 'unknown' }, label);
  }
  try {
    return await work();
  } finally {
    // Remove the file only while it is still this call's, never a successor's.
    try {
      if (fs.readFileSync(file, 'utf8').trim() === token) fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  }
}
