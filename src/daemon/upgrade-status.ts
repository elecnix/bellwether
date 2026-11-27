// What `bellwether doctor` says about an upgrade on this machine: one line for
// the installed build and the running daemon's build, the sockets
// under the home, anything a crash left behind, and the sessions still on
// older code with what each would lose by ending. `describeUpgrade` is a pure
// function of what `gatherUpgrade` read, so a test can hand it any machine.
import fs from 'node:fs';
import path from 'node:path';
import { BELLWETHER_BUILD, BELLWETHER_BUILD_ID, BELLWETHER_VERSION, describeBuild } from '../core/version.ts';
import { daemonSessions, startingMarker } from './client.ts';
import { compareVersions, decideHandOver, type HandOverDecision } from './handover.ts';
import { FEATURES, missingFrom, unknownTo, type DaemonOffer, type Feature } from './features.ts';
import { DAEMON_ENTRY, isAlive, readLock, type LockRecord } from './lock.ts';
import { DAEMON_PROTOCOL, MIN_CLIENT_PROTOCOL, type RelayHostState, type SessionInfo, type SessionsReply } from './protocol.ts';
import { canConnect } from './server.ts';

export interface UpgradeInput {
  /** This install: its version, protocol, build id, the line that describes its build, and the daemon entry point it would start, canonical. */
  installed: { version: string; protocol: number; minClientProtocol: number; build?: string; buildLine?: string; entry?: string };
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

/**
 * finished: see describeUpgrade, which defines it; in-progress: a hand-over, a
 * leftover or a session on another build remains; unknown: the builds cannot
 * be compared; behind: this install is older than the daemon; idle: no daemon.
 */
export type UpgradeState = 'finished' | 'in-progress' | 'unknown' | 'behind' | 'idle';

export interface UpgradeReport {
  lines: string[];
  state: UpgradeState;
  /** Leftovers a crash or a killed process left: none after a clean convergence. */
  leftovers: string[];
  /** Sessions whose adapter runs an older release than the daemon, which the daemon still serves. */
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
    installed: { version: BELLWETHER_VERSION, protocol: DAEMON_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL, build: BELLWETHER_BUILD_ID, buildLine: describeBuild(BELLWETHER_VERSION, BELLWETHER_BUILD), entry: DAEMON_ENTRY },
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

/** Whether a build id names a commit: `unknown` and an absent one do not. */
function namesCommit(build: string | undefined): build is string {
  return build !== undefined && build !== '' && build !== 'unknown';
}

/** How one session's adapter stands against the running daemon. */
export type SessionStanding = 'same-build' | 'older-served' | 'other-build' | 'unknown-build' | 'newer';

/**
 * Where a session's adapter stands against the daemon. An older release on a
 * protocol the daemon serves is `older-served`. The daemon's version and
 * protocol on another commit is `other-build`, and `unknown-build` when either
 * side names no commit, so a difference is never rounded away.
 */
export function sessionStanding(session: Pick<SessionInfo, 'client' | 'build' | 'protocol'>, daemon: Pick<SessionsReply['daemon'], 'version' | 'build' | 'protocol' | 'minClientProtocol'>): SessionStanding {
  const order = compareVersions(session.client, daemon.version);
  if (order === undefined) return 'unknown-build';
  if (order < 0 || (order === 0 && session.protocol < daemon.protocol)) return session.protocol >= daemon.minClientProtocol ? 'older-served' : 'other-build';
  if (order > 0 || session.protocol > daemon.protocol) return 'newer';
  if (!namesCommit(session.build) || !namesCommit(daemon.build)) return 'unknown-build';
  return session.build === daemon.build ? 'same-build' : 'other-build';
}

/** One session, with every connection the daemon holds for it. */
export interface DistinctSession {
  key: string;
  connections: SessionInfo[];
}

/**
 * The daemon's connections, one entry per session. A session is its harness
 * session id, so a Claude Code session whose plugin and per-child server both
 * connect counts once. A connection that names no harness session counts by
 * its parent id.
 */
export function distinctSessions(connections: readonly SessionInfo[]): DistinctSession[] {
  const groups = new Map<string, SessionInfo[]>();
  for (const connection of connections) {
    const key = connection.session ? `${connection.harness}:${connection.session}` : `parent:${connection.parentId}`;
    groups.set(key, [...(groups.get(key) ?? []), connection]);
  }
  return [...groups].map(([key, list]) => ({ key, connections: list }));
}

const STANDING_ORDER: SessionStanding[] = ['same-build', 'older-served', 'unknown-build', 'newer', 'other-build'];

function worst(standings: SessionStanding[]): SessionStanding {
  return standings.reduce((a, b) => (STANDING_ORDER.indexOf(b) > STANDING_ORDER.indexOf(a) ? b : a), 'same-build');
}

function adapterOf(session: SessionInfo): string {
  return `${session.client}${namesCommit(session.build) ? ` build ${session.build}` : ', with no commit named,'} on protocol ${session.protocol}`;
}

/**
 * The versions line: this install's build, the running daemon's build and
 * entry point, whether they are one build, and what a session started from
 * this install would do about it. The hand-over clause comes from
 * decideHandOver, the rule the client itself follows, so the two cannot disagree.
 */
export function describeVersions(input: UpgradeInput, running: boolean, daemon?: SessionsReply['daemon']): { line: string; decision?: HandOverDecision; newer: boolean } {
  const { installed } = input;
  const mine = `this install is ${installed.buildLine ?? installed.version} on protocol ${installed.protocol}, and a daemon from it serves sessions on protocols ${installed.minClientProtocol} to ${installed.protocol}`;
  if (!running) return { line: info(`versions: ${mine}; no daemon runs, so the next session starts one from its own install`), newer: false };
  const version = daemon?.version ?? input.lock?.version;
  const protocol = daemon?.protocol ?? input.lock?.protocol ?? 0;
  // The daemon's own answer wins; without one, the lock names the build since 0.1.5.
  const build = daemon?.build ?? input.lock?.build;
  const buildText = namesCommit(build) ? `build ${build}` : daemon ? 'naming no commit, because it predates build ids' : input.lock?.build ? 'naming no commit in its lock' : 'with a build it cannot report';
  const entry = input.lock?.entry;
  const origin = input.lock?.origin === 'checkout' ? 'a git checkout' : 'an installed package';
  // Before this release, `bellwether daemon` wrote a lock with a version and no entry point. That stays true of a lock an older build wrote.
  const unnamed = input.lock?.version ? `started by hand with bellwether daemon on ${input.lock.socket || 'a socket its lock does not name'}, so its lock names no entry point` : 'from an entry point its lock does not name, because the daemon that wrote it predates that field';
  const install = !entry ? '' : installed.entry && entry === installed.entry ? `this install's entry point, ${entry}` : `${entry} (${origin})`;
  const entryText = !entry ? unnamed : input.lock?.foreground ? `started by hand with bellwether daemon on ${input.lock.socket || 'a socket its lock does not name'}, from ${install}` : `from ${install}`;
  const theirs = `the running daemon, pid ${input.lock?.pid}, is ${version ?? 'a release older than 0.1.5'} on protocol ${protocol}, ${buildText}, ${entryText}`;
  const order = version ? compareVersions(version, installed.version) : -1;
  const newer = order !== undefined && (order > 0 || (order === 0 && protocol > installed.protocol));
  const sameRelease = order === 0 && protocol === installed.protocol;
  const comparable = namesCommit(installed.build) && namesCommit(build);
  const same = sameRelease && comparable && build === installed.build;
  const sameText = same ? 'They are the same build' : sameRelease && !comparable ? `It cannot be told whether they are the same build, because ${namesCommit(installed.build) ? 'the daemon' : 'this install'} names no commit` : 'They are not the same build';
  const decision = decideHandOver(version ? { version, protocol } : { protocol }, { version: installed.version, protocol: installed.protocol });
  let then: string;
  if (decision.kind === 'replace') then = `A session started from this install hands it over, because ${decision.reason}; the sessions on it reconnect and keep working, and none needs a restart`;
  else if (newer) then = 'A session started from this install keeps it, because it is newer; update this install to match';
  else if (same) then = 'A session started from this install keeps it';
  else then = 'A session started from this install keeps it, because only a newer version or protocol hands over; run bellwether drain from this install to have the next session start its daemon';
  return { line: (same ? ok : info)(`versions: ${mine}; ${theirs}. ${sameText}. ${then}.`), decision, newer };
}

/**
 * The doctor lines for an upgrade, and its state.
 *
 * "upgrade: finished" is defined here and nowhere else: a daemon runs and is
 * not draining, no hand-over is due from this install or under way, nothing a
 * crashed process left remains, the daemon listed its sessions, and every
 * session's adapter runs the daemon's build, or an older release on a
 * protocol the daemon still serves. A session on the daemon's version but
 * another commit keeps the upgrade from finishing, and so does one whose
 * commit cannot be compared: doctor names it instead of rounding it away.
 */
export function describeUpgrade(input: UpgradeInput): UpgradeReport {
  const lines: string[] = [];
  const leftovers: string[] = [];
  const olderSessions: string[] = [];
  const pending: string[] = [];
  const unknown: string[] = [];

  const sessions = input.sessions && 'sessions' in input.sessions ? input.sessions : undefined;
  const daemonVersion = sessions?.daemon.version ?? input.lock?.version;
  const daemonProtocol = sessions?.daemon.protocol ?? input.lock?.protocol;
  const daemonSocket = input.sockets.find((socket) => socket.name === input.daemonSocket);
  const running = input.lockAlive && Boolean(daemonSocket?.answers);
  const versions = describeVersions(input, running, sessions?.daemon);
  lines.push(versions.line);

  if (running) {
    if (versions.decision?.kind === 'replace') pending.push('the daemon runs an older release');
    if (daemonProtocol !== undefined) {
      const features = sessions?.daemon.features;
      lines.push(...describePairing(input.installed, { protocol: daemonProtocol, ...(daemonVersion ? { version: daemonVersion } : {}), ...(features ? { features } : {}) }));
    }
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

  const otherBuild: string[] = [];
  const unknownBuild: string[] = [];
  const newerSessions: string[] = [];
  if (input.sessions && 'error' in input.sessions) {
    lines.push(info(`sessions: the daemon did not list them (${input.sessions.error}); a daemon older than 0.1.5 cannot`));
    unknown.push('the daemon did not list its sessions, so which build each runs is unknown');
  } else if (sessions) {
    const daemon = sessions.daemon;
    const distinct = distinctSessions(sessions.sessions);
    const doubled = sessions.sessions.length - distinct.length;
    const relays = sessions.relaySubscribers ? `, and ${plural(sessions.relaySubscribers, 'parent daemon')} from other machines` : '';
    if (!distinct.length) lines.push(info(`sessions: none connected${relays}`));
    else lines.push(info(`sessions: ${plural(distinct.length, 'session')} connected${relays}, each counted once by its harness session id, or by its parent id when a connection names no session${doubled ? `; the daemon holds ${plural(sessions.sessions.length, 'connection')}, because some sessions connect more than once` : ''}`));
    for (const group of distinct) {
      const first = group.connections[0] as SessionInfo;
      const who = `session ${first.parentId}${first.childId ? ` (child ${first.childId})` : ''}`;
      const standing = worst(group.connections.map((connection) => sessionStanding(connection, daemon)));
      const adapters = [...new Set(group.connections.map(adapterOf))];
      const adapter = `${adapters.length === 1 ? 'adapter' : 'adapters'} ${adapters.join(' and ')}${group.connections.length > 1 ? `, over ${plural(group.connections.length, 'connection')}` : ''}`;
      const liveChildren = Math.max(...group.connections.map((connection) => connection.liveChildren));
      const unreadCount = Math.max(...group.connections.map((connection) => connection.unread));
      const children = liveChildren ? `Ending it leaves ${plural(liveChildren, 'live child', 'live children')} without their parent until the session resumes` : 'Ending it leaves no live child behind';
      const unread = unreadCount ? `, and ${plural(unreadCount, 'unread event')} ${unreadCount === 1 ? 'waits' : 'wait'} for it` : '';
      const minProtocol = Math.min(...group.connections.map((connection) => connection.protocol));
      if (standing === 'same-build') {
        lines.push(ok(`${who}: ${adapter}, the daemon's build`));
      } else if (standing === 'older-served') {
        const oldest = minProtocol <= daemon.minClientProtocol ? ' It speaks the oldest protocol the daemon serves, so only a protocol change that breaks it would refuse it.' : '';
        const lacking = FEATURES.filter((feature) => feature.kind === 'tool' && feature.protocol > minProtocol);
        const gains = lacking.length ? ` Its adapter does not offer ${namedFeatures(lacking)}; the session gains ${lacking.length === 1 ? 'it' : 'them'} when it next starts from a newer install.` : '';
        lines.push(info(`${who}: ${adapter}, older than the daemon, which still serves it. Its tools run in the daemon's code; only its adapter stays on the older code until the session ends on its own. ${children}${unread}.${oldest}${gains}`));
        olderSessions.push(first.parentId);
      } else if (standing === 'other-build') {
        lines.push(info(`${who}: ${adapter}, where the daemon runs ${daemonVersion} ${namesCommit(daemon.build) ? `build ${daemon.build}` : 'with no commit named'}: another build of the same release, which it keeps until the session ends on its own. ${children}${unread}.`));
        otherBuild.push(first.parentId);
      } else if (standing === 'newer') {
        lines.push(info(`${who}: ${adapter}, newer than the daemon; a session started from that adapter's install hands the daemon over. ${children}${unread}.`));
        newerSessions.push(first.parentId);
      } else {
        lines.push(info(`${who}: ${adapter}, the daemon's version, but whether it runs the daemon's commit cannot be told, because ${namesCommit(daemon.build) ? 'the adapter' : 'the daemon'} names none. ${children}${unread}.`));
        unknownBuild.push(first.parentId);
      }
    }
    if (otherBuild.length) pending.push(`${plural(otherBuild.length, 'session')} ${otherBuild.length === 1 ? 'runs' : 'run'} another build than the daemon's (${otherBuild.join(', ')})`);
    if (newerSessions.length) pending.push(`${plural(newerSessions.length, 'session')} ${newerSessions.length === 1 ? 'runs' : 'run'} a newer adapter than the daemon (${newerSessions.join(', ')})`);
    if (unknownBuild.length) unknown.push(`${plural(unknownBuild.length, 'session')} on the daemon's version cannot be compared by commit (${unknownBuild.join(', ')})`);
  } else if (running) {
    unknown.push('the daemon did not answer a request for its sessions');
  }

  if (leftovers.length) pending.push(`${plural(leftovers.length, 'leftover')} from a stopped process`);
  const state: UpgradeState = pending.length ? 'in-progress' : unknown.length ? 'unknown' : versions.newer ? 'behind' : running ? 'finished' : 'idle';
  const daemonBuild = namesCommit(sessions?.daemon.build) ? ` build ${sessions?.daemon.build}` : '';
  if (state === 'finished') lines.push(ok(`upgrade: finished; every connected session runs the daemon's build, ${daemonVersion}${daemonBuild}${olderSessions.length ? `, or an older release it serves (${olderSessions.length})` : ''}`));
  else if (state === 'behind') lines.push(info(`upgrade: this install, ${input.installed.version}, is older than the daemon, ${daemonVersion ?? 'unknown'}. Its sessions keep working on the daemon's code, without what the pairing line names. Update this install when convenient.`));
  else if (state === 'idle') lines.push(ok(`upgrade: nothing to finish; no daemon runs, and the next session starts ${input.installed.version} or whichever install it runs`));
  else if (state === 'unknown') lines.push(info(`upgrade: not known to be finished, because ${unknown.join('; ')}.`));
  else lines.push(info(`upgrade: in progress, because ${pending.join('; ')}. Nothing needs a restart: it finishes as sessions end on their own.`));
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
