// The daemon's lock: one file per home, written before a client spawns a
// daemon, so a second client waits for the daemon already starting instead of
// starting another. A lock whose pid is gone is stale and is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { BELLWETHER_VERSION } from '../core/version.ts';
import { DAEMON_PROTOCOL } from './protocol.ts';

export interface LockRecord {
  pid: number;
  startedAt: number;
  protocol: number;
  /** The package version of the daemon that holds the lock. A lock from before 0.1.5 has none. */
  version?: string;
  socket: string;
  /**
   * The absolute path of the entry point the daemon runs, with symbolic links
   * resolved. A lock from before 0.1.5 has none, and neither has a daemon a
   * test starts inside its own process.
   */
  entry?: string;
  /** Whether that entry point sits in a git checkout or in an installed package. */
  origin?: DaemonOrigin;
}

/** Where a daemon's code comes from: a git working tree, or a package a package manager installed. */
export type DaemonOrigin = 'checkout' | 'package';

/**
 * Where an entry point comes from. The package root is the nearest directory
 * above it with a package.json. A checkout has `.git` there, as a directory
 * or, in a worktree, as a file. npm never puts `.git` in a package it installs.
 */
export function originOf(entry: string): DaemonOrigin {
  let dir = path.dirname(entry);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return fs.existsSync(path.join(dir, '.git')) ? 'checkout' : 'package';
    const parent = path.dirname(dir);
    if (parent === dir) return 'package';
    dir = parent;
  }
}

/** An entry point as the lock records it: absolute, with symbolic links resolved. */
export function canonicalEntry(entry: string): string {
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
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
    const read: LockRecord = { pid: record.pid, startedAt: record.startedAt ?? 0, protocol: record.protocol ?? 0, socket: record.socket ?? '' };
    if (typeof record.version === 'string') read.version = record.version;
    if (typeof record.entry === 'string' && record.entry) read.entry = record.entry;
    if (record.origin === 'checkout' || record.origin === 'package') read.origin = record.origin;
    return read;
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

/**
 * Take the lock, or report the live daemon that holds it. `entry` is the file
 * the daemon process runs, recorded with where it comes from, so a person can
 * tell an installed daemon from one a checkout started.
 */
export function acquire(home: string, socketPath: string, pid = process.pid, alive = isAlive, entry?: string): AcquireResult {
  fs.mkdirSync(home, { recursive: true });
  const target = lockPath(home);
  const record: LockRecord = { pid, startedAt: Date.now(), protocol: DAEMON_PROTOCOL, version: BELLWETHER_VERSION, socket: socketPath };
  if (entry) {
    record.entry = canonicalEntry(entry);
    record.origin = originOf(record.entry);
  }
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

/**
 * The doctor line that says which copy of Bellwether the running daemon is,
 * and whether it is the copy this command would start.
 */
export function describeDaemonEntry(lock: LockRecord | undefined, ownEntry: string): string {
  if (!lock?.entry) return 'info  daemon entry: not recorded, because the daemon predates 0.1.5. The next session started from this install hands it over.';
  const own = canonicalEntry(ownEntry);
  const origin = lock.origin === 'checkout' ? 'a git checkout' : 'an installed package';
  if (lock.entry === own) return `ok    daemon entry: ${lock.entry} (${origin}), the one this command runs`;
  const mine = originOf(own) === 'checkout' ? 'a git checkout' : 'an installed package';
  return `info  daemon entry: ${lock.entry} (${origin}), not this command's ${own} (${mine}). A daemon from a newer release replaces an older one when its next session starts; between two copies of one release, run bellwether drain from the copy you want.`;
}
