// Tier 1: the rules behind a hand-over. Which install's daemon runs, which
// client protocols a daemon serves, when a draining daemon closes, and the
// lock that keeps a second daemon from owning the same children.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareVersions, decideHandOver, drainDecision } from '../../src/daemon/handover.ts';
import { DAEMON_PROTOCOL, MIN_CLIENT_PROTOCOL, ProtocolError, acceptsClientProtocol, parseRequest } from '../../src/daemon/protocol.ts';
import { acquire, readLock, release } from '../../src/daemon/lock.ts';
import { describeUpgrade } from '../../src/daemon/upgrade-status.ts';
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

test('a daemon serves its own protocol and the one before it, and nothing else', () => {
  assert.equal(MIN_CLIENT_PROTOCOL, DAEMON_PROTOCOL - 1);
  assert.equal(acceptsClientProtocol(DAEMON_PROTOCOL), true);
  assert.equal(acceptsClientProtocol(DAEMON_PROTOCOL - 1), true);
  assert.equal(acceptsClientProtocol(DAEMON_PROTOCOL - 2), false);
  assert.equal(acceptsClientProtocol(DAEMON_PROTOCOL + 1), false);
});

test('a report from the previous protocol parses, and one from before it is refused', () => {
  const report = (protocol: number): string => JSON.stringify({ type: 'report', id: 'r1', protocol, report: { childId: 'c1', status: 'done', text: 'finished' } });
  assert.equal(parseRequest(report(DAEMON_PROTOCOL - 1)).type, 'report');
  assert.throws(() => parseRequest(report(DAEMON_PROTOCOL - 2)), (error: unknown) => error instanceof ProtocolError && error.code === 'protocol_mismatch');
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
    daemon: { pid: 4242, version: '0.1.5', protocol: 4, minClientProtocol: 3, startedAt: '2026-11-27T00:00:00.000Z', draining: false, ...daemon },
    sessions: sessions.map((session, index) => ({ parentId: `pi-${index}`, harness: 'pi', session: `s${index}`, client: '0.1.5', protocol: 4, connectedAt: '2026-11-27T00:00:00.000Z', liveChildren: 0, unread: 0, ...session })),
    relaySubscribers: 0,
  };
}

test('doctor calls an upgrade finished once the daemon and every session run this install', () => {
  const report = describeUpgrade({ installed, lock: liveLock, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: sessionsReply([{}, {}]) });
  assert.equal(report.state, 'finished');
  assert.deepEqual(report.leftovers, []);
});

test('doctor names a session on an older adapter and what it would lose by ending', () => {
  const report = describeUpgrade({ installed, lock: liveLock, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: sessionsReply([{ client: '0.1.4', protocol: 3, liveChildren: 2, unread: 1 }]) });
  assert.equal(report.state, 'in-progress');
  assert.deepEqual(report.olderSessions, ['pi-0']);
  const text = report.lines.join('\n');
  assert.match(text, /adapter 0\.1\.4 on protocol 3, older than this install/);
  assert.match(text, /Ending it leaves 2 live children without their parent until the session resumes, and 1 unread event waits for it/);
  assert.match(text, /oldest protocol the daemon serves/);
});

test('doctor says an older daemon is handed over by the next session, with no restart', () => {
  const report = describeUpgrade({ installed, lock: { pid: 4242, startedAt: 0, protocol: 3, socket: '/h/daemon.sock' }, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock', sessions: { error: 'unknown_type: unknown request type "sessions"' } });
  assert.equal(report.state, 'in-progress');
  const text = report.lines.join('\n');
  assert.match(text, /a release older than 0\.1\.5 on protocol 3, older than this install\. The next session started from this install hands it over/);
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
