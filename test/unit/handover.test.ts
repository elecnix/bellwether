// Tier 1: the rules behind a hand-over. Which install's daemon runs, which
// client protocols a daemon serves, when a draining daemon closes, and the
// lock that keeps a second daemon from owning the same children.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareVersions, decideHandOver, drainDecision } from '../../src/daemon/handover.ts';
import { DAEMON_PROTOCOL, MIN_CLIENT_PROTOCOL, PROTOCOL_HISTORY, ProtocolError, acceptsClientProtocol, parseRequest } from '../../src/daemon/protocol.ts';
import { acquire, readLock, release } from '../../src/daemon/lock.ts';
import { describePairing, describeUpgrade, farPairing } from '../../src/daemon/upgrade-status.ts';
import { RelayOutbox } from '../../src/daemon/relay.ts';
import { relayOutboxPath } from '../../src/core/paths.ts';
import type { SessionInfo, SessionsReply } from '../../src/daemon/protocol.ts';

test('versions compare by number, and a prerelease sorts before its release', () => {
  assert.equal(compareVersions('0.1.5', '0.1.4'), 1);
  assert.equal(compareVersions('0.1.4', '0.1.5'), -1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.5', '0.1.5'), 0);
  assert.equal(compareVersions('0.1.5-rc.1', '0.1.5'), -1);
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.10'), -1);
  assert.equal(compareVersions('unknown', '0.1.5'), undefined);
});

test('a client replaces a daemon from an older release, and only an older one', () => {
  const own = { version: '0.1.5', protocol: 4 };
  assert.equal(decideHandOver({ version: '0.1.4', protocol: 3 }, own).kind, 'replace');
  assert.equal(decideHandOver({ version: '0.1.4', protocol: 4 }, own).kind, 'replace');
  // A daemon that predates the version in its lock is older than any install that records one.
  assert.equal(decideHandOver({ protocol: 3 }, own).kind, 'replace');
  assert.equal(decideHandOver({ version: '0.1.5', protocol: 4 }, own).kind, 'keep');
  // The same release on an older protocol is a checkout mid-change: the higher protocol wins.
  assert.equal(decideHandOver({ version: '0.1.5', protocol: 3 }, own).kind, 'replace');
  // A newer daemon stays, whichever protocol it speaks, so two installs never take turns.
  assert.equal(decideHandOver({ version: '0.1.6', protocol: 4 }, own).kind, 'keep');
  assert.equal(decideHandOver({ version: '0.1.6', protocol: 3 }, own).kind, 'keep');
  // A newer protocol is a newer release even when its lock records no version.
  assert.equal(decideHandOver({ protocol: 5 }, own).kind, 'keep');
  // An install that cannot read its own version never replaces anything.
  assert.equal(decideHandOver({ version: '0.1.4', protocol: 3 }, { version: 'unknown', protocol: 4 }).kind, 'keep');
});

test('the reason for a replacement names both versions', () => {
  const decision = decideHandOver({ version: '0.1.4', protocol: 3 }, { version: '0.1.5', protocol: 4 });
  assert.equal(decision.kind, 'replace');
  assert.match(decision.reason, /0\.1\.4 on protocol 3/);
  assert.match(decision.reason, /0\.1\.5 on protocol 4/);
});

test('a daemon serves every protocol back to the last bump that breaks, and nothing newer than its own', () => {
  const breaking = PROTOCOL_HISTORY.filter((entry) => entry.breaks).map((entry) => entry.protocol);
  assert.equal(MIN_CLIENT_PROTOCOL, Math.max(...breaking));
  assert.equal(PROTOCOL_HISTORY.at(-1)?.protocol, DAEMON_PROTOCOL, 'every bump has an entry that says whether it breaks');
  for (let protocol = MIN_CLIENT_PROTOCOL; protocol <= DAEMON_PROTOCOL; protocol += 1) assert.equal(acceptsClientProtocol(protocol), true, `protocol ${protocol}`);
  assert.equal(acceptsClientProtocol(MIN_CLIENT_PROTOCOL - 1), false);
  assert.equal(acceptsClientProtocol(DAEMON_PROTOCOL + 1), false);
});

test('a report from any served protocol parses, and one from below the floor is refused', () => {
  const report = (protocol: number): string => JSON.stringify({ type: 'report', id: 'r1', protocol, report: { childId: 'c1', status: 'done', text: 'finished' } });
  assert.equal(parseRequest(report(DAEMON_PROTOCOL - 1)).type, 'report');
  assert.equal(parseRequest(report(MIN_CLIENT_PROTOCOL)).type, 'report');
  assert.throws(() => parseRequest(report(MIN_CLIENT_PROTOCOL - 1)), (error: unknown) => error instanceof ProtocolError && error.code === 'protocol_mismatch');
});

test('a draining daemon waits for its calls in flight, up to a grace period', () => {
  const graceMs = 60_000;
  assert.equal(drainDecision({ inFlight: 0, drainingSince: 0, now: 0, graceMs }), 'close');
  assert.equal(drainDecision({ inFlight: 2, drainingSince: 0, now: 1_000, graceMs }), 'wait');
  assert.equal(drainDecision({ inFlight: 1, drainingSince: 0, now: graceMs, graceMs }), 'close');
});

test('one daemon owns a home: a live lock refuses a second daemon, even after the first stopped listening', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-own-'));
  try {
    const socket = path.join(home, 'daemon.sock');
    assert.equal(acquire(home, socket, 1001, () => true).kind, 'acquired');
    // The draining daemon has closed its socket, but its pid still lives: the newcomer waits.
    const second = acquire(home, socket, 1002, () => true);
    assert.equal(second.kind, 'held');
    assert.equal(second.kind === 'held' ? second.record.pid : 0, 1001);
    // A release by anyone but the holder leaves the lock in place.
    release(home, 1002);
    assert.equal(readLock(home)?.pid, 1001);
    // Once the holder is gone, its lock is stale and the next daemon takes it.
    assert.equal(acquire(home, socket, 1002, (pid) => pid !== 1001).kind, 'acquired');
    assert.equal(readLock(home)?.pid, 1002);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const installed = { version: '0.1.5', protocol: 4, minClientProtocol: 3 };
const liveLock = { pid: 4242, startedAt: 0, protocol: 4, version: '0.1.5', socket: '/h/daemon.sock' };
function sessionsReply(sessions: Partial<SessionInfo>[], daemon: Partial<SessionsReply['daemon']> = {}): SessionsReply {
  return {
    type: 'sessions',
    id: 's1',
    daemon: { pid: 4242, version: '0.1.5', build: 'aaaaaaaaaaaa', protocol: 4, minClientProtocol: 3, startedAt: '2026-11-27T00:00:00.000Z', draining: false, ...daemon },
    sessions: sessions.map((session, index) => ({ parentId: `pi-${index}`, harness: 'pi', session: `s${index}`, client: '0.1.5', build: 'aaaaaaaaaaaa', protocol: 4, connectedAt: '2026-11-27T00:00:00.000Z', liveChildren: 0, unread: 0, ...session })),
    relaySubscribers: 0,
  };
}

test('doctor calls an upgrade finished once every session runs the daemon build', () => {
  const report = describeUpgrade({ installed, lock: liveLock, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: sessionsReply([{}, {}]) });
  assert.equal(report.state, 'finished');
  assert.deepEqual(report.leftovers, []);
  assert.match(report.lines.join('\n'), /upgrade: finished; every connected session runs the daemon's build, 0\.1\.5 build aaaaaaaaaaaa$/m);
});

test('doctor names a session on an older adapter the daemon serves, and what it would lose by ending, and still calls the upgrade finished', () => {
  const report = describeUpgrade({ installed, lock: liveLock, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: sessionsReply([{ client: '0.1.4', build: 'bbbbbbbbbbbb', protocol: 3, liveChildren: 2, unread: 1 }]) });
  assert.equal(report.state, 'finished');
  assert.deepEqual(report.olderSessions, ['pi-0']);
  const text = report.lines.join('\n');
  assert.match(text, /adapter 0\.1\.4 build bbbbbbbbbbbb on protocol 3, older than the daemon, which still serves it/);
  assert.match(text, /upgrade: finished; every connected session runs the daemon's build, 0\.1\.5 build aaaaaaaaaaaa, or an older release it serves \(1\)/);
  assert.match(text, /Ending it leaves 2 live children without their parent until the session resumes, and 1 unread event waits for it/);
  assert.match(text, /oldest protocol the daemon serves/);
});

test('doctor says an older daemon is handed over by the next session, with no restart', () => {
  const report = describeUpgrade({ installed, lock: { pid: 4242, startedAt: 0, protocol: 3, socket: '/h/daemon.sock' }, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: { error: 'unknown_type: unknown request type "sessions"' } });
  assert.equal(report.state, 'in-progress');
  const text = report.lines.join('\n');
  assert.match(text, /the running daemon, pid 4242, is a release older than 0\.1\.5 on protocol 3, with a build it cannot report/);
  assert.match(text, /A session started from this install hands it over, because the running daemon is a release older than 0\.1\.5 on protocol 3/);
  assert.match(text, /upgrade: in progress, because the daemon runs an older release/);
  assert.match(text, /a daemon older than 0\.1\.5 cannot/);
});

test('doctor lists what a crash left: a dead lock, a stale marker and a silent socket', () => {
  const report = describeUpgrade({ installed, lock: { ...liveLock, pid: 99 }, lockAlive: false, sockets: [{ name: 'daemon.sock', answers: false }, { name: 'daemon-v3.sock', answers: false }], daemonSocket: 'daemon.sock', marker: { pid: 98, alive: false, ageMs: 1_000 } });
  assert.equal(report.state, 'in-progress');
  assert.equal(report.leftovers.length, 4);
  // With nothing left behind and no daemon, there is nothing to finish.
  assert.equal(describeUpgrade({ installed, lockAlive: false, sockets: [], daemonSocket: 'daemon.sock' }).state, 'idle');
});

test('a report a 0.1.4 daemon kept for its own retries is still offered to the parent that collects it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-legacy-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    // The shape 0.1.4 wrote: it dialled the parent itself, so it kept the host and its retry state.
    const legacy = { receipt: 'rp-0123456789abcdef', childId: 'c1', parentId: 'pi-parent', parentHost: 'parent-machine', status: 'needs-input', text: 'the brief did not arrive', at: '2026-11-27T06:32:20.916Z', attempts: 17, nextAttemptAt: '2026-11-27T07:21:01.528Z', lastError: 'ssh exited with 255' };
    fs.mkdirSync(path.dirname(relayOutboxPath(legacy.receipt)), { recursive: true });
    fs.writeFileSync(relayOutboxPath(legacy.receipt), JSON.stringify(legacy));
    const waiting = new RelayOutbox().waiting(new Set(['pi-parent']));
    assert.deepEqual(waiting.map((entry) => [entry.receipt, entry.status, entry.text]), [[legacy.receipt, 'needs-input', legacy.text]]);
  } finally {
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor states the pairing: an older daemon refuses the newer tools by name, and upgrading it gains them', () => {
  const report = describeUpgrade({ installed, lock: { pid: 4242, startedAt: 0, protocol: 3, version: '0.1.4', socket: '/h/daemon.sock' }, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: { error: 'unknown_type: unknown request type "sessions"' } });
  const text = report.lines.join('\n');
  assert.match(text, /pairing on this machine: this install speaks protocol 4, the daemon 3 \(Bellwether 0\.1\.4\); they speak protocol 3/);
  assert.match(text, /degraded on this machine: the daemon refuses agent_restart, agent_move, agent_request_depth, agent_grant_depth \(protocol 4, Bellwether 0\.1\.5\) by name; every other tool works\. Upgrading the daemon there gains them, when convenient\./);
});

test('doctor says a daemon newer than this install leaves it behind, not finished, and names what updating gains', () => {
  const report = describeUpgrade({
    installed,
    lock: { ...liveLock, version: '0.2.0', protocol: 5 },
    lockAlive: true,
    sockets: [{ name: 'daemon.sock', answers: true }],
    daemonSocket: 'daemon.sock',
    sessions: sessionsReply([{}], { version: '0.2.0', protocol: 5, minClientProtocol: 2, features: ['agent_list', 'agent_move', 'agent_clone'] }),
  });
  assert.equal(report.state, 'behind');
  const text = report.lines.join('\n');
  assert.doesNotMatch(text, /upgrade: finished/);
  assert.match(text, /behind on this machine: the daemon serves agent_clone, which this install does not offer\. Updating this install gains it, when convenient\./);
  assert.match(text, /upgrade: this install, 0\.1\.5, is older than the daemon, 0\.2\.0/);
});

test('doctor says a matching pair loses nothing', () => {
  assert.match(describePairing(installed, { protocol: 4, version: '0.1.5' }).join('\n'), /nothing is degraded, and neither side gains anything by updating/);
});

test('doctor names, per relay machine, its daemon and what updating that machine gains', () => {
  const base = { host: 'far', status: 'connected' as const, since: 't', attempts: 0, children: [] };
  assert.equal(farPairing(base), '');
  assert.equal(farPairing({ ...base, farProtocol: 4, farVersion: '0.1.5' }), ', on protocol 4; nothing to gain by updating it');
  assert.equal(farPairing({ ...base, farProtocol: 3, farVersion: '0.1.4' }), ', on protocol 3; updating that machine gains agent_restart, agent_move, agent_request_depth, agent_grant_depth (protocol 4, Bellwether 0.1.5), when convenient');
});
