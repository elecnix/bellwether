// What `bellwether doctor` says about an upgrade on this machine: the
// installed version, the running daemon's version and protocol, the sockets
// under the home, anything a crash left behind, and the sessions still on
// older code with what each would lose by ending. `describeUpgrade` is a pure
// function of what `gatherUpgrade` read, so a test can hand it any machine.
import fs from 'node:fs';
import path from 'node:path';
import { BELLWETHER_BUILD, BELLWETHER_BUILD_ID, BELLWETHER_VERSION, describeBuild } from '../core/version.ts';
import { daemonSessions, startingMarker } from './client.ts';
import { compareVersions } from './handover.ts';
import { FEATURES, missingFrom, unknownTo, type DaemonOffer, type Feature } from './features.ts';
import { isAlive, readLock, type LockRecord } from './lock.ts';
import { DAEMON_PROTOCOL, MIN_CLIENT_PROTOCOL, type RelayHostState, type SessionsReply } from './protocol.ts';
import { canConnect } from './server.ts';

export interface UpgradeInput {
  installed: { version: string; protocol: number; minClientProtocol: number; build?: string; buildLine?: string };
  lock?: LockRecord;
  lockAlive: boolean;
  /** Every `*.sock` under the home, and whether something answers on it. */
  sockets: { name: string; answers: boolean }[];
  /** The socket the daemon uses, by file name under the home. */
  daemonSocket: string;
  /** The starting marker, when one exists: its writer, whether that writer lives, and its age. */
  marker?: { pid: number; alive: boolean; ageMs: number };
  /** The daemon's answer to a sessions request, or why there is none. */
  sessions?: SessionsReply | { error: string };
}

/** finished: one release everywhere; in-progress: a hand-over or older sessions remain; behind: this install is older than the daemon; idle: no daemon. */
export type UpgradeState = 'finished' | 'in-progress' | 'behind' | 'idle';

export interface UpgradeReport {
  lines: string[];
  state: UpgradeState;
  /** Leftovers a crash or a killed process left: none after a clean convergence. */
  leftovers: string[];
  /** Sessions whose adapter runs older code than this install. */
  olderSessions: string[];
}

const ok = (text: string): string => `ok    ${text}`;
const info = (text: string): string => `info  ${text}`;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Features grouped by the release that brought them: "agent_restart and agent_move (protocol 4, Bellwether 0.1.5)". */
export function namedFeatures(features: readonly Feature[]): string {
  const groups = new Map<string, string[]>();
  for (const feature of features) {
    const key = `protocol ${feature.protocol}, Bellwether ${feature.version}`;
    groups.set(key, [...(groups.get(key) ?? []), feature.name]);
  }
  return [...groups].map(([since, names]) => `${names.join(', ')} (${since})`).join('; ');
}

/**
 * How this install and a daemon pair up: the protocol they speak, what the
 * pairing loses, and which side would gain by updating. A pure function, so
 * doctor's line for this machine and for each relay machine read the same.
 */
export function describePairing(installed: { version: string; protocol: number; minClientProtocol: number }, daemon: DaemonOffer, where = 'this machine'): string[] {
  const lines: string[] = [];
  const spoken = Math.min(installed.protocol, daemon.protocol);
  const served = spoken >= installed.minClientProtocol;
  lines.push(info(`pairing on ${where}: this install speaks protocol ${installed.protocol}, the daemon ${daemon.protocol}${daemon.version ? ` (Bellwether ${daemon.version})` : ''}; they speak ${served ? `protocol ${spoken}` : 'no common protocol, so the daemon refuses this install'}`));
  if (!served) return lines;
  const tools = missingFrom(daemon, 'tool');
  const requests = missingFrom(daemon).filter((feature) => feature.kind !== 'tool' && feature.kind !== 'argument');
  const args = missingFrom(daemon, 'argument');
  if (tools.length) lines.push(info(`degraded on ${where}: the daemon refuses ${namedFeatures(tools)} by name; every other tool works. Upgrading the daemon there gains them, when convenient.`));
  if (requests.length) lines.push(info(`degraded on ${where}: the daemon lacks the ${namedFeatures(requests)} request${requests.length === 1 ? '' : 's'}.`));
  if (args.length) lines.push(info(`degraded on ${where}: the daemon does not read ${namedFeatures(args)}, so this install refuses a call that passes ${args.length === 1 ? 'it' : 'one'} rather than let the daemon ignore it.`));
  const extra = unknownTo(daemon);
  if (extra.length) lines.push(info(`behind on ${where}: the daemon serves ${extra.join(', ')}, which this install does not offer. Updating this install gains ${extra.length === 1 ? 'it' : 'them'}, when convenient.`));
  if (!tools.length && !requests.length && !args.length && !extra.length) lines.push(ok(`pairing on ${where}: nothing is degraded, and neither side gains anything by updating`));
  return lines;
}

/** Read what the report needs from a home and its daemon socket. */
export async function gatherUpgrade(home: string, socketPath = path.join(home, 'daemon.sock')): Promise<UpgradeInput> {
  const lock = readLock(home);
  const sockets: { name: string; answers: boolean }[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(home).filter((name) => name.endsWith('.sock')).sort();
  } catch {
    names = [];
  }
  for (const name of names) sockets.push({ name, answers: await canConnect(path.join(home, name)) });
  const input: UpgradeInput = {
    installed: { version: BELLWETHER_VERSION, protocol: DAEMON_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL, build: BELLWETHER_BUILD_ID, buildLine: describeBuild(BELLWETHER_VERSION, BELLWETHER_BUILD) },
    lockAlive: Boolean(lock && isAlive(lock.pid)),
    sockets,
    daemonSocket: path.relative(home, socketPath),
  };
  if (lock) input.lock = lock;
  try {
    const marker = JSON.parse(fs.readFileSync(startingMarker(home), 'utf8')) as { pid?: number; at?: number };
    if (typeof marker.pid === 'number') input.marker = { pid: marker.pid, alive: isAlive(marker.pid), ageMs: Date.now() - (marker.at ?? 0) };
  } catch {
    // No marker: nobody is starting or handing over the daemon.
  }
  if (await canConnect(socketPath)) {
    try {
      input.sessions = await daemonSessions(socketPath);
    } catch (error) {
      input.sessions = { error: (error as Error).message };
    }
  }
  return input;
}

/** The doctor lines for an upgrade, and whether it has finished. */
export function describeUpgrade(input: UpgradeInput): UpgradeReport {
  const { installed } = input;
  const lines: string[] = [];
  const leftovers: string[] = [];
  const olderSessions: string[] = [];
  const pending: string[] = [];
  lines.push(info(`installed: ${installed.buildLine ?? installed.version}, protocol ${installed.protocol}; a daemon from it serves sessions on protocols ${installed.minClientProtocol} to ${installed.protocol}`));

  const sessions = input.sessions && 'sessions' in input.sessions ? input.sessions : undefined;
  const daemonVersion = sessions?.daemon.version ?? input.lock?.version;
  const daemonProtocol = sessions?.daemon.protocol ?? input.lock?.protocol;
  const daemonSocket = input.sockets.find((socket) => socket.name === input.daemonSocket);
  const running = input.lockAlive && Boolean(daemonSocket?.answers);

  if (!running) {
    lines.push(info('daemon: not running; the next session starts it from that session\'s install'));
  } else {
    const daemonBuild = sessions?.daemon.build;
    const built = daemonBuild ? ` build ${daemonBuild}` : '';
    const described = `pid ${input.lock?.pid}, ${daemonVersion ?? 'a release older than 0.1.5'}${built} on protocol ${daemonProtocol ?? 'unknown'}`;
    const order = daemonVersion ? compareVersions(daemonVersion, installed.version) : -1;
    // One version number covers every build made from it, so the same number can hide different code.
    const otherBuild = installed.build !== undefined && installed.build !== 'unknown' && daemonBuild !== installed.build;
    if (order === 0 && daemonProtocol === installed.protocol && otherBuild) {
      lines.push(info(`daemon: ${described}, the same version as this install but ${daemonBuild ? 'another build' : 'a build that names no commit'}, where this install is build ${installed.build}. A newer version hands over on its own, and the same version does not: run bellwether drain to let the next session start this install's daemon.`));
    } else if (order === 0 && daemonProtocol === installed.protocol) {
      lines.push(ok(`daemon: ${described}, this install's`));
    } else if (order === undefined || order < 0 || (order === 0 && (daemonProtocol ?? 0) < installed.protocol)) {
      lines.push(info(`daemon: ${described}, older than this install. The next session started from this install hands it over; the sessions on it reconnect and keep working, and none needs a restart.`));
      pending.push('the daemon runs an older release');
    } else {
      lines.push(info(`daemon: ${described}, newer than this install. Sessions from this install use it while it serves their protocol; update this install to match.`));
    }
    if (daemonProtocol !== undefined) {
      const features = sessions?.daemon.features;
      lines.push(...describePairing(installed, { protocol: daemonProtocol, ...(daemonVersion ? { version: daemonVersion } : {}), ...(features ? { features } : {}) }));
    }
    if (order !== undefined && (order > 0 || (order === 0 && (daemonProtocol ?? 0) > installed.protocol))) pending.push('behind');
    if (sessions?.daemon.draining) {
      lines.push(info('daemon: handing over; it takes no new call and exits once its calls in flight answer'));
      pending.push('the daemon is draining');
    }
  }

  for (const socket of input.sockets) {
    if (socket.name === input.daemonSocket && socket.answers) {
      lines.push(ok(`socket ${socket.name}: answers`));
    } else if (socket.answers) {
      lines.push(info(`socket ${socket.name}: answers, but it is not the daemon socket this install uses`));
      leftovers.push(`${socket.name} answers beside the daemon socket`);
    } else {
      lines.push(info(`socket ${socket.name}: nothing answers; a stopped daemon left it, and the next daemon to start removes it`));
      leftovers.push(`${socket.name} with nothing answering`);
    }
  }
  if (input.lock && !input.lockAlive) {
    lines.push(info(`lock: names pid ${input.lock.pid}, which no longer runs; the next daemon to start takes it over`));
    leftovers.push(`a lock for pid ${input.lock.pid}, which no longer runs`);
  }
  if (input.marker) {
    if (input.marker.alive && input.marker.ageMs < 30_000) {
      lines.push(info(`hand-over: pid ${input.marker.pid} is starting or handing over the daemon now`));
      pending.push(`pid ${input.marker.pid} is starting the daemon`);
    } else {
      lines.push(info(`marker: daemon.starting from pid ${input.marker.pid}, which ${input.marker.alive ? 'stopped refreshing it' : 'no longer runs'}; the next client to start a daemon takes it over`));
      leftovers.push(`a daemon.starting marker from pid ${input.marker.pid}`);
    }
  }

  if (input.sessions && 'error' in input.sessions) {
    lines.push(info(`sessions: the daemon did not list them (${input.sessions.error}); a daemon older than 0.1.5 cannot`));
  } else if (sessions) {
    if (!sessions.sessions.length) lines.push(info(`sessions: none connected${sessions.relaySubscribers ? `, ${plural(sessions.relaySubscribers, 'parent daemon')} from other machines` : ''}`));
    for (const session of sessions.sessions) {
      const who = `session ${session.parentId}${session.childId ? ` (child ${session.childId})` : ''}`;
      const order = compareVersions(session.client, installed.version);
      const children = session.liveChildren ? `Ending it leaves ${plural(session.liveChildren, 'live child', 'live children')} without their parent until the session resumes` : 'Ending it leaves no live child behind';
      const unread = session.unread ? `, and ${plural(session.unread, 'unread event')} ${session.unread === 1 ? 'waits' : 'wait'} for it` : '';
      if (order === undefined || order < 0 || session.protocol < installed.protocol) {
        const oldest = session.protocol <= sessions.daemon.minClientProtocol ? ' It speaks the oldest protocol the daemon serves, so only a protocol change that breaks it would refuse it.' : '';
        const lacking = FEATURES.filter((feature) => feature.kind === 'tool' && feature.protocol > session.protocol);
        const gains = lacking.length ? ` Its adapter does not offer ${namedFeatures(lacking)}; the session gains ${lacking.length === 1 ? 'it' : 'them'} when it next starts from this install.` : '';
        lines.push(info(`${who}: adapter ${session.client} on protocol ${session.protocol}, older than this install. Its tools run in the daemon's code; only its adapter stays on ${session.client} until the session ends on its own. ${children}${unread}.${oldest}${gains}`));
        olderSessions.push(session.parentId);
      } else {
        lines.push(ok(`${who}: adapter ${session.client}${session.build ? ` build ${session.build}` : ''} on protocol ${session.protocol}`));
      }
    }
    if (olderSessions.length) pending.push(`${plural(olderSessions.length, 'session')} still on an older adapter`);
  }

  if (leftovers.length) pending.push(`${plural(leftovers.length, 'leftover')} from a stopped process`);
  const behind = pending.includes('behind');
  const reasons = pending.filter((reason) => reason !== 'behind');
  const state: UpgradeState = reasons.length ? 'in-progress' : behind ? 'behind' : running ? 'finished' : 'idle';
  if (state === 'finished') lines.push(ok(`upgrade: finished; the daemon and every connected session run ${installed.version}`));
  else if (state === 'behind') lines.push(info(`upgrade: this install, ${installed.version}, is older than the daemon, ${daemonVersion ?? 'unknown'}. Its sessions keep working on the daemon's code, without what the pairing line names. Update this install when convenient.`));
  else if (state === 'idle') lines.push(ok(`upgrade: nothing to finish; no daemon runs, and the next session starts ${installed.version} or whichever install it runs`));
  else lines.push(info(`upgrade: in progress, because ${reasons.join('; ')}. Nothing needs a restart: it finishes as sessions end on their own.`));
  return { lines, state, leftovers, olderSessions };
}

/**
 * The protocol the daemon on a relay machine speaks, and what that machine
 * gains by updating: the tools its daemon would refuse to the sessions there.
 * The line before it already names that daemon's version and build.
 */
export function farPairing(state: RelayHostState): string {
  if (state.farProtocol === undefined) return '';
  const far = { protocol: state.farProtocol, ...(state.farVersion ? { version: state.farVersion } : {}) };
  const missing = missingFrom(far, 'tool');
  const gains = missing.length ? `; updating that machine gains ${namedFeatures(missing)}, when convenient` : '; nothing to gain by updating it';
  return `, on protocol ${state.farProtocol}${gains}`;
}
