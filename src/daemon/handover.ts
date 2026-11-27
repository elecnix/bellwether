// The rules of a hand-over. One daemon runs per home, and the newest install
// on the machine decides which code it runs: a client from a newer release
// drains the running daemon and starts its own, and every session already
// connected reconnects to it, because a daemon serves every protocol back to
// MIN_CLIENT_PROTOCOL as well as its own. These functions decide; client.ts and server.ts act.
import { BELLWETHER_VERSION } from '../core/version.ts';
import { DAEMON_PROTOCOL } from './protocol.ts';

/** How long a hand-over may take, from the drain request to the new daemon answering. */
export const HANDOVER_TIMEOUT_MS = 90_000;

/** How long a draining daemon waits for its calls in flight before it closes anyway. */
export const DRAIN_GRACE_MS = 60_000;

/** What a client knows of a daemon: its package version, when it recorded one, and its protocol. */
export interface DaemonIdentity {
  version?: string;
  protocol: number;
}

export type HandOverDecision = { kind: 'keep' } | { kind: 'replace'; reason: string };

/**
 * Compare two package versions: 1 when `a` is newer, -1 when older, 0 when
 * equal, and undefined when either is not a version. A prerelease sorts
 * before its release, as semver orders them.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order !== 0) return order > 0 ? 1 : -1;
  }
  return 0;
}

function parse(version: string): { core: number[]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/**
 * Whether a client should replace the daemon it found. Only a strictly newer
 * install replaces a daemon, ordered by package version and then by protocol,
 * so two installs on one machine never take turns: the older one's sessions
 * use the newer daemon. A daemon whose lock records no version predates 0.1.5
 * and counts as older than any install that records one.
 */
export function decideHandOver(daemon: DaemonIdentity, own: DaemonIdentity = { version: BELLWETHER_VERSION, protocol: DAEMON_PROTOCOL }): HandOverDecision {
  if (!own.version) return { kind: 'keep' };
  // A daemon on a newer protocol comes from a newer release, whatever its lock records.
  if (daemon.protocol > own.protocol) return { kind: 'keep' };
  const theirs = daemon.version ?? '0.0.0';
  const order = compareVersions(own.version, theirs);
  if (order === undefined) return { kind: 'keep' };
  const newer = order > 0 || (order === 0 && own.protocol > daemon.protocol);
  if (!newer) return { kind: 'keep' };
  const described = daemon.version ? `${daemon.version} on protocol ${daemon.protocol}` : `a release older than 0.1.5 on protocol ${daemon.protocol}`;
  return { kind: 'replace', reason: `the running daemon is ${described}, and this install is ${own.version} on protocol ${own.protocol}` };
}

/**
 * When a draining daemon closes: once no call is in flight, or once the grace
 * period runs out, so a call that never returns cannot hold a hand-over open.
 */
export function drainDecision(state: { inFlight: number; drainingSince: number; now: number; graceMs: number }): 'wait' | 'close' {
  if (state.inFlight <= 0) return 'close';
  return state.now - state.drainingSince >= state.graceMs ? 'close' : 'wait';
}
