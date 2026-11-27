// What doctor says about versions and an upgrade, from inputs a test picks.
// Each case is a machine a person met: several installs of one release, one
// daemon, and sessions that connected from different commits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeUpgrade, distinctSessions, sessionStanding, type UpgradeInput } from '../../src/daemon/upgrade-status.ts';
import type { SessionInfo, SessionsReply } from '../../src/daemon/protocol.ts';

const CHECKOUT = '/work/bellwether/main/src/daemon/main.ts';
const PLUGIN = '/plugins/cache/bellwether/0.1.5/src/daemon/main.ts';
const COMMIT_A = 'aaaaaaaaaaaa';
const COMMIT_B = 'bbbbbbbbbbbb';
const COMMIT_C = 'cccccccccccc';

function session(index: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { parentId: `pi-${index}`, harness: 'pi', session: `s${index}`, client: '0.1.5', protocol: 4, connectedAt: '2026-11-27T00:00:00.000Z', liveChildren: 0, unread: 0, ...extra };
}

function reply(sessions: SessionInfo[], daemon: Partial<SessionsReply['daemon']> = {}): SessionsReply {
  return { type: 'sessions', id: 's1', daemon: { pid: 4242, version: '0.1.5', build: COMMIT_B, protocol: 4, minClientProtocol: 3, startedAt: '', draining: false, ...daemon }, sessions, relaySubscribers: 0 };
}

/** This install is the checkout at commit A; the daemon came from the plugin, at commit B. */
function threeInstalls(sessions: SessionsReply | { error: string }, lock: Partial<UpgradeInput['lock']> = {}): UpgradeInput {
  return {
    installed: { version: '0.1.5', protocol: 4, minClientProtocol: 3, build: COMMIT_A, buildLine: `0.1.5 (commit ${COMMIT_A}, run from a checkout)`, entry: CHECKOUT },
    lock: { pid: 4242, startedAt: 0, protocol: 4, version: '0.1.5', socket: '/h/daemon.sock', entry: PLUGIN, origin: 'package', ...lock },
    lockAlive: true,
    sockets: [{ name: 'daemon.sock', answers: true }],
    daemonSocket: 'daemon.sock',
    sessions,
  };
}

test('three installs, one daemon and two sessions on other commits: one versions line, and the upgrade is not finished', () => {
  // One session from this checkout (commit A), one from a third install (commit C), one from the daemon's own install (commit B).
  const report = describeUpgrade(threeInstalls(reply([session(0, { build: COMMIT_A }), session(1, { build: COMMIT_C }), session(2, { build: COMMIT_B })])));
  const versions = report.lines.filter((line) => /^\w+ +versions: /.test(line));
  assert.equal(versions.length, 1, report.lines.join('\n'));
  // The lines that used to say the same thing twice, in two ways, are gone.
  assert.equal(report.lines.filter((line) => /^\w+ +(installed|daemon|daemon entry): /.test(line)).length, 0, report.lines.join('\n'));
  const line = versions[0] as string;
  assert.match(line, new RegExp(`this install is 0\\.1\\.5 \\(commit ${COMMIT_A}, run from a checkout\\) on protocol 4`));
  assert.match(line, new RegExp(`the running daemon, pid 4242, is 0\\.1\\.5 on protocol 4, build ${COMMIT_B}, from ${PLUGIN} \\(an installed package\\)`));
  assert.match(line, /They are not the same build\. A session started from this install keeps it, because only a newer version or protocol hands over/);
  // Nothing anywhere says a hand-over will happen, because none will.
  assert.doesNotMatch(report.lines.join('\n'), /hands it over|hands over\.|predates 0\.1\.5/);
  assert.equal(report.state, 'in-progress');
  const upgrade = report.lines.find((entry) => entry.includes('upgrade:')) ?? '';
  assert.doesNotMatch(upgrade, /finished/);
  assert.match(upgrade, /upgrade: in progress, because 2 sessions run another build than the daemon's \(pi-0, pi-1\)/);
  assert.match(report.lines.join('\n'), /ok {4}session pi-2: adapter 0\.1\.5 build bbbbbbbbbbbb on protocol 4, the daemon's build/);
});

test('a daemon whose lock names no entry point is described once, without a hand-over it will not do', () => {
  // The machine from the report: same version, no sessions request, no entry in the lock.
  const report = describeUpgrade(threeInstalls({ error: 'unknown_type: unknown request type "sessions"' }, { entry: undefined, origin: undefined }));
  const text = report.lines.join('\n');
  assert.match(text, /from an entry point its lock does not name, because the daemon that wrote it predates that field/);
  assert.doesNotMatch(text, /hands it over/);
  // Without the sessions list, nobody can say which build each session runs, so the upgrade is not called finished.
  assert.equal(report.state, 'unknown');
  assert.match(text, /upgrade: not known to be finished, because the daemon did not list its sessions/);
});

test('a session that connects twice is listed once, counted by its harness session id', () => {
  const doubled = session(0, { harness: 'claude-code', session: '0b6c9f1e-1111-4222-8333-944455556666', parentId: 'claude-code-0b6c9f1e', build: COMMIT_B });
  const sessions = [doubled, { ...doubled, connectedAt: '2026-11-27T00:00:05.000Z' }, session(1, { build: COMMIT_B })];
  assert.deepEqual(distinctSessions(sessions).map((group) => [group.key, group.connections.length]), [['claude-code:0b6c9f1e-1111-4222-8333-944455556666', 2], ['pi:s1', 1]]);
  const report = describeUpgrade(threeInstalls(reply(sessions)));
  const text = report.lines.join('\n');
  assert.equal(report.lines.filter((line) => line.includes('session claude-code-0b6c9f1e:')).length, 1, text);
  assert.match(text, /sessions: 2 sessions connected, each counted once by its harness session id, or by its parent id when a connection names no session; the daemon holds 3 connections/);
  assert.match(text, /session claude-code-0b6c9f1e: adapter 0\.1\.5 build bbbbbbbbbbbb on protocol 4, over 2 connections, the daemon's build/);
  assert.equal(report.state, 'finished');
  // A connection with no harness session falls back to its parent id.
  assert.deepEqual(distinctSessions([session(3, { session: '' }), session(3, { session: '' })]).map((group) => group.key), ['parent:pi-3']);
});

test("a session's standing against the daemon: its build, an older release served, another commit, or one that cannot be compared", () => {
  const daemon = { version: '0.1.5', build: COMMIT_B, protocol: 4, minClientProtocol: 3 };
  assert.equal(sessionStanding({ client: '0.1.5', build: COMMIT_B, protocol: 4 }, daemon), 'same-build');
  assert.equal(sessionStanding({ client: '0.1.4', build: COMMIT_A, protocol: 3 }, daemon), 'older-served');
  assert.equal(sessionStanding({ client: '0.1.5', build: COMMIT_A, protocol: 4 }, daemon), 'other-build');
  assert.equal(sessionStanding({ client: '0.1.5', protocol: 4 }, daemon), 'unknown-build');
  assert.equal(sessionStanding({ client: '0.1.5', build: 'unknown', protocol: 4 }, daemon), 'unknown-build');
  assert.equal(sessionStanding({ client: '0.1.6', build: COMMIT_C, protocol: 4 }, daemon), 'newer');
});
