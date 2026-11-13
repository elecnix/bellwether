// The daemon's lock: one file per home, written before a client spawns a
// daemon, so a second client waits for the daemon already starting instead of
// starting another. A lock whose pid is gone is stale and is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_PROTOCOL } from './protocol.ts';

export interface LockRecord {
  pid: number;
  startedAt: number;
  protocol: number;
  socket: string;
}

export function lockPath(home: string): string {
  return path.join(home, 'daemon.lock');
}

export function readLock(home: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath(home), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Partial<LockRecord>;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return undefined;
    return { pid: record.pid, startedAt: record.startedAt ?? 0, protocol: record.protocol ?? 0, socket: record.socket ?? '' };
  } catch {
    return undefined;
  }
}

/** Whether a process with that pid still runs. EPERM counts as alive. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type AcquireResult = { kind: 'acquired' } | { kind: 'held'; record: LockRecord };

/** Take the lock, or report the live daemon that holds it. */
export function acquire(home: string, socketPath: string, pid = process.pid, alive = isAlive): AcquireResult {
  fs.mkdirSync(home, { recursive: true });
  const target = lockPath(home);
  const record: LockRecord = { pid, startedAt: Date.now(), protocol: DAEMON_PROTOCOL, socket: socketPath };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(target, 'wx', 0o600);
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.closeSync(fd);
      return { kind: 'acquired' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = readLock(home);
      if (held && alive(held.pid)) return { kind: 'held', record: held };
      fs.rmSync(target, { force: true });
    }
  }
  const held = readLock(home);
  if (held && alive(held.pid)) return { kind: 'held', record: held };
  throw new Error('the daemon lock could not be taken');
}

/** Remove the lock when this process owns it. */
export function release(home: string, pid = process.pid): void {
  const held = readLock(home);
  if (held && held.pid !== pid) return;
  fs.rmSync(lockPath(home), { force: true });
}
