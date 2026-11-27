// Tier 1: a version number is not a build. Two installs of one version, built
// from different commits, must not look the same: not in the line a person
// reads, not in the handshake field, and not in doctor's daemon line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BELLWETHER_BUILD_ID, BUILD_FILE, buildId, describeBuild, readBuild } from '../../src/core/version.ts';
import { describeUpgrade } from '../../src/daemon/upgrade-status.ts';
import { runsOn } from '../../src/daemon/relay-links.ts';
import type { SessionsReply } from '../../src/daemon/protocol.ts';

const COMMIT_A = '1111111111111111111111111111111111111111';
const COMMIT_B = '2222222222222222222222222222222222222222';

function install(t: test.TestContext, build: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, BUILD_FILE), JSON.stringify(build));
  return root;
}

const noGit = (): string => {
  throw new Error('git must not run for a built install');
};

test('two builds of one version from different commits do not look identical', (t) => {
  const first = readBuild(install(t, { commit: COMMIT_A, builtAt: '2026-11-27T01:06:00Z' }), noGit);
  const second = readBuild(install(t, { commit: COMMIT_B, builtAt: '2026-11-27T01:49:00Z' }), noGit);
  assert.equal(first.source, 'build');
  assert.notEqual(buildId(first), buildId(second));
  const lines = [describeBuild('0.1.4', first), describeBuild('0.1.4', second)];
  assert.notEqual(lines[0], lines[1]);
  assert.equal(lines[0], '0.1.4 (commit 111111111111, built 2026-11-27T01:06:00Z)');
  assert.ok(!lines[0]?.includes('\n'), 'one line a person can read');
});

test('a run from a checkout names the commit git reports, and says when the tree has changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clean = readBuild(root, (args) => (args[0] === 'rev-parse' ? `${COMMIT_A}\n` : ''));
  assert.deepEqual(clean, { source: 'checkout', commit: COMMIT_A });
  const changed = readBuild(root, (args) => (args[0] === 'rev-parse' ? `${COMMIT_A}\n` : ' M src/cli.ts\n'));
  assert.equal(buildId(changed), '111111111111+changes');
  assert.match(describeBuild('0.1.4', changed), /commit 111111111111, with changes no commit holds, run from a checkout/);
  const none = readBuild(root, () => {
    throw new Error('not a git repository');
  });
  assert.equal(buildId(none), 'unknown');
  assert.match(describeBuild('0.1.4', none), /build unknown/);
});

test('this checkout names its own build', () => {
  assert.match(BELLWETHER_BUILD_ID, /^[0-9a-f]{12}(\+changes)?$/);
});

function sessions(build: string | undefined): SessionsReply {
  return { type: 'sessions', id: 's', daemon: { pid: 4242, version: '0.1.4', ...(build ? { build } : {}), protocol: 4, minClientProtocol: 3, startedAt: '', draining: false }, sessions: [], relaySubscribers: 0 };
}

test("doctor tells a daemon of the same version but another build from this install's", () => {
  const installed = { version: '0.1.4', protocol: 4, minClientProtocol: 3, build: '111111111111', buildLine: '0.1.4 (commit 111111111111, built 2026-11-27T01:49:00Z)' };
  const lock = { pid: 4242, startedAt: 0, protocol: 4, version: '0.1.4', socket: '/h/daemon.sock' };
  const base = { installed, lock, lockAlive: true, sockets: [{ name: 'daemon.sock', answers: true }], daemonSocket: 'daemon.sock' };
  const same = describeUpgrade({ ...base, sessions: sessions('111111111111') }).lines.join('\n');
  assert.match(same, /ok {4}versions: this install is 0\.1\.4 \(commit 111111111111, built 2026-11-27T01:49:00Z\) on protocol 4.*; the running daemon, pid 4242, is 0\.1\.4 on protocol 4, build 111111111111, .*They are the same build\. A session started from this install keeps it\.$/m);
  const other = describeUpgrade({ ...base, sessions: sessions('222222222222') }).lines.join('\n');
  assert.match(other, /info {2}versions: this install is 0\.1\.4 \(commit 111111111111.*the running daemon, pid 4242, is 0\.1\.4 on protocol 4, build 222222222222, .*They are not the same build\. A session started from this install keeps it, because only a newer version or protocol hands over; run bellwether drain/);
});

test('the relay names the build a child machine runs, or says it predates naming one', () => {
  assert.equal(runsOn({ version: '0.1.4', build: '222222222222' }), 'bellwether 0.1.4 build 222222222222');
  assert.equal(runsOn({ version: '0.1.4' }), 'bellwether 0.1.4, a build that names no commit');
  assert.match(runsOn({}), /predates naming its version and build/);
});
