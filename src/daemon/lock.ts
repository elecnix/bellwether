// The daemon's lock: one file per home, written before a client spawns a
// daemon, so a second client waits for the daemon already starting instead of
// starting another. A lock whose pid is gone is stale and is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasAgent } from '../core/ssh-agent.ts';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from '../core/version.ts';
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
  /** The build id of the daemon's install, as its hello reports it. A lock from before 0.1.5 has none. */
  build?: string;
  /**
   * True for a daemon that `bellwether daemon` runs in the foreground. Its
   * entry is the daemon entry point of the same install, the file a client
   * would have started. A detached daemon leaves the field out.
   */
  foreground?: true;
  /**
   * Whether the daemon started with an SSH agent: SSH_AUTH_SOCK set to a path
   * that exists. Its relays' ssh inherits that environment, so a daemon without
   * one reaches a host only through IdentityAgent or IdentityFile in
   * ~/.ssh/config. A lock from before 0.1.10 has none (issue #245).
   */
  sshAgent?: boolean;
}

/** How the daemon that takes a lock was started, for the lock to record. */
export interface LockOrigin {
  /** The daemon entry point of the install the daemon runs from. */
  entry?: string;
  /** Whether `bellwether daemon` runs it in the foreground. */
  foreground?: boolean;
  /** Whether the daemon's environment names an SSH agent. Defaults to this process's. */
  sshAgent?: boolean;
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

/** This install's daemon entry point, canonical: main.ts from the sources, main.js from the build. */
export const DAEMON_ENTRY = canonicalEntry(fileURLToPath(new URL(`./main${path.extname(import.meta.url)}`, import.meta.url)));

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
    if (typeof record.build === 'string' && record.build) read.build = record.build;
    if (record.foreground === true) read.foreground = true;
    if (typeof record.sshAgent === 'boolean') read.sshAgent = record.sshAgent;
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
 * Take the lock, or report the live daemon that holds it. The lock records
 * the version and build of this install, and the entry point the daemon
 * runs from with where it comes from, so a person can tell an installed
 * daemon from one a checkout started without asking the daemon.
 */
export function acquire(home: string, socketPath: string, pid = process.pid, alive = isAlive, started: LockOrigin = {}): AcquireResult {
  fs.mkdirSync(home, { recursive: true });
  const target = lockPath(home);
  const record: LockRecord = { pid, startedAt: Date.now(), protocol: DAEMON_PROTOCOL, version: BELLWETHER_VERSION, socket: socketPath, build: BELLWETHER_BUILD_ID };
  if (started.entry) {
    record.entry = canonicalEntry(started.entry);
    record.origin = originOf(record.entry);
  }
  if (started.foreground) record.foreground = true;
  record.sshAgent = started.sshAgent ?? hasAgent(process.env);
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
