// Tier 2: a child on another machine asks to be retired (issue #227). Its
// request goes to the daemon on the machine it runs on, which holds no
// registry for it, only the relay record a spawn or a move left there. The
// request has to reach the daemon that owns the record, the parent's, and it
// travels the way a report does: through that machine's relay outbox, over the
// connection the parent's daemon already holds.
//
// Two machines are two Bellwether homes in one temporary root, joined by the
// fake ssh. The parent's daemon runs in this process with a fake git. The
// child's daemon is a real process that the child's own session, or the
// parent's relay bridge, starts in the child's home.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyParent, readParent, saveParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import { reapChild } from '../../src/core/retire.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService } from '../../src/daemon/server.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { fakeGit, type FakeGit } from '../fixtures/fake-git.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');
const PARENT_ID = 'claude-code-the-parent';
/** The worktree the child worked in on the parent's machine before it moved. */
const LEFT = '/work/x/feat-x';
const REPO = '/repos/x.git';
/** The directory the child runs in on the machine it moved to. */
const FAR_CWD = '/far/x/feat-x';

interface World {
  root: string;
  parentHome: string;
  childHome: string;
  ssh: FakeSsh;
  logs: string[];
  closers: (() => Promise<void> | void)[];
}

function world(t: test.TestContext): World {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-retire-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await ssh.drop();
    await stopDaemonsUnder(root, childHome);
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, parentHome, childHome, ssh, logs: [], closers };
}

function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

/** The parent's record of a child that now runs on `child-box`. */
function parentHolds(childId: string, extra: Partial<ChildRecord> = {}): void {
  const at = new Date().toISOString();
  if (!readParent(PARENT_ID)) saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, { id: childId, name: `child-${childId}`, kind: 'claude', harness: 'claude-code', paneId: 'w2:p7', tabId: 'w2:t7', host: 'child-box', cwd: FAR_CWD, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra });
}

/** A child that moved from the parent's machine to `child-box`, leaving its worktree behind. */
function movedChild(childId: string): void {
  parentHolds(childId, { movedFrom: { host: 'local', at: new Date().toISOString(), cwd: LEFT } });
}

/** The relay record that `relay-register` writes on the child's machine, at a spawn there or a move there. */
function childHolds(w: World, childId: string): void {
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: `child-${childId}`, kind: 'claude', parentId: PARENT_ID, cwd: FAR_CWD, registeredAt: new Date().toISOString() }));
}

/** A clean, merged worktree on the parent's machine, which retirement can prove safe. */
function mergedWorktree(): FakeGit {
  const git = fakeGit();
  git.add(LEFT, { repo: REPO, branch: 'feat-x' });
  git.merged.add(`${REPO}:feat-x`);
  return git;
}

function stubService(): ParentService {
  return { tool: async (name) => `the session service ran ${name}`, markRead: () => {}, onEvents: () => {}, pending: () => [], watchPane: () => () => {}, stop: () => {} };
}

async function parentDaemon(w: World, git: FakeGit): Promise<RelayLinks> {
  const links = new RelayLinks({ resolve: async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }), initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, log: (line) => w.logs.push(line) });
  const daemon = await startDaemon({ socketPath: path.join(w.parentHome, 'daemon.sock'), home: w.parentHome, factory: () => stubService(), links, retireOps: git, log: (line) => w.logs.push(line) });
  w.closers.push(() => daemon.close());
  return links;
}

/** The child's own Bellwether server on `child-box`, which starts that machine's daemon when none runs. */
async function childSession(w: World, childId: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(
    { harness: 'claude-code', session: `session-${childId}`, cwd: FAR_CWD, host: 'child-box', depth: 1, herdrSocket: path.join(w.root, 'no-herdr.sock'), childId, paneId: 'w2:p7' },
    { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') },
  );
  w.closers.push(() => client.close());
  return client;
}

function doctorOn(w: World, home: string): Promise<string> {
  const env = { ...process.env, BELLWETHER_HOME: home, BELLWETHER_DAEMON_SOCKET: path.join(home, 'daemon.sock'), HERDR_SOCKET_PATH: path.join(w.root, 'no-herdr.sock') };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'doctor'], { env, encoding: 'utf8' }, (_error, stdout) => resolve(stdout));
  });
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(25);
  }
}

function childOf(childId: string): ChildRecord | undefined {
  return readParent(PARENT_ID)?.children.find((entry) => entry.id === childId);
}

test("a moved child's request_retirement reaches its parent's daemon, and the worktree it left there is retired once its pane is gone", async (t) => {
  const w = world(t);
  const git = mergedWorktree();
  movedChild('c-moved');
  childHolds(w, 'c-moved');
  const links = await parentDaemon(w, git);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-moved');
  const answer = await client.tool('request_retirement', { reason: 'merged' });
  assert.doesNotMatch(answer, /no registry on this machine holds/, answer);
  assert.match(answer, new RegExp(PARENT_ID), 'the answer names the parent whose daemon took it');
  assert.match(answer, /Retirement requested for child-c-moved/, answer);
  assert.ok(answer.includes(LEFT), `the answer names the worktree the parent will retire: ${answer}`);
  assert.ok(answer.includes(FAR_CWD), `the answer says the worktree on child-box stays: ${answer}`);

  const child = childOf('c-moved');
  assert.ok(child?.retireRequestedAt, 'the parent record holds the request');
  assert.equal(child?.retireIntent?.worktree, LEFT);
  assert.equal(child?.retireIntent?.branch, 'feat-x');
  assert.equal(child?.retireIntent?.reason, 'merged');
  assert.equal(child?.retireIntent?.movedAway, 'child-box');
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the child machine to drop its copy once acknowledged');
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-moved'))?.retireRequest, undefined, 'nothing waits on the child machine');
  assert.deepEqual(git.calls, [], 'nothing is removed while the child runs');

  // The pane closes on child-box, and the parent's watcher marks the exit; the cleanup runs as it would have before the move.
  updateChild(PARENT_ID, 'c-moved', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  const result = await reapChild(PARENT_ID, 'c-moved', { ops: git, paneOrTabLive: async () => false, busyRetries: 0 });
  assert.deepEqual(result, { outcome: 'removed' });
  assert.deepEqual(git.calls, [`worktree remove ${LEFT}`, `branch -D feat-x`]);
  assert.equal(childOf('c-moved')?.retireOutcome, 'removed');
});

/** The worktree a child left on the middle machine of a chain, where the parent's daemon cannot take a proof. */
const MID = '/mid/x/feat-x';
/** A second worktree on the parent's machine, which the child came back to and left again. */
const LEFT2 = '/work/x/feat-y';

test("a child that moved twice, from the parent's machine to mid-box and on to child-box, still has its first worktree retired, and the answer names the one on mid-box (issue #241)", async (t) => {
  const w = world(t);
  const git = mergedWorktree();
  const first = new Date(Date.now() - 60_000).toISOString();
  const second = new Date().toISOString();
  // As this release writes it: every place the child left, and movedFrom naming the last for an older daemon.
  parentHolds('c-twice', { departures: [{ host: 'local', at: first, cwd: LEFT, verb: 'move' }, { host: 'mid-box', at: second, cwd: MID, verb: 'teleport' }], movedFrom: { host: 'mid-box', at: second, cwd: MID, verb: 'teleport' } });
  childHolds(w, 'c-twice');
  const links = await parentDaemon(w, git);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-twice');
  const answer = await client.tool('request_retirement', { reason: 'merged' });
  assert.match(answer, /Retirement requested for child-c-twice/, answer);
  assert.ok(answer.includes(LEFT), `the answer names the worktree the parent will retire: ${answer}`);
  assert.ok(answer.includes(MID) && answer.includes('mid-box'), `the answer names the worktree left on mid-box, and the machine: ${answer}`);
  assert.ok(answer.includes(FAR_CWD), `the answer says the worktree on child-box stays: ${answer}`);
  assert.equal(childOf('c-twice')?.retireIntent?.worktree, LEFT);

  updateChild(PARENT_ID, 'c-twice', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  const result = await reapChild(PARENT_ID, 'c-twice', { ops: git, paneOrTabLive: async () => false, busyRetries: 0 });
  assert.equal(result.outcome, 'removed');
  assert.deepEqual(git.calls, [`worktree remove ${LEFT}`, `branch -D feat-x`]);
  const after = childOf('c-twice');
  assert.deepEqual(after?.departures?.map((entry) => entry.host), ['mid-box'], 'the retired place leaves the list, and the one on mid-box stays for its own machine');
  assert.equal(after?.movedFrom?.host, 'mid-box');
});

test("a child that left two worktrees on the parent's machine has both retired, and one that fails its proofs is refused by name while the other goes (issue #241)", async (t) => {
  const w = world(t);
  const git = mergedWorktree();
  git.add(LEFT2, { repo: REPO, branch: 'feat-y', dirty: ['notes.md'] });
  git.merged.add(`${REPO}:feat-y`);
  const at = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
  // Parent's machine, then mid-box, then back to the parent's machine in another worktree, then child-box.
  parentHolds('c-three', { departures: [{ host: 'local', at: at(3), cwd: LEFT }, { host: 'mid-box', at: at(2), cwd: MID }, { host: 'local', at: at(1), cwd: LEFT2 }], movedFrom: { host: 'local', at: at(1), cwd: LEFT2 } });
  childHolds(w, 'c-three');
  const links = await parentDaemon(w, git);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-three');
  const answer = await client.tool('request_retirement', {});
  assert.ok(answer.includes(LEFT) && answer.includes(LEFT2), `the answer names both worktrees on the parent's machine: ${answer}`);
  assert.match(answer, /uncommitted/, `the answer warns now about the dirty one: ${answer}`);
  assert.ok(answer.includes(MID), answer);

  updateChild(PARENT_ID, 'c-three', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  const result = await reapChild(PARENT_ID, 'c-three', { ops: git, paneOrTabLive: async () => false, busyRetries: 0 });
  assert.equal(result.outcome, 'refused', 'a worktree left in place makes the retirement a refusal');
  assert.ok(result.reason?.includes(LEFT2), `the refusal names the worktree it left: ${result.reason}`);
  assert.deepEqual(git.calls, [`worktree remove ${LEFT}`, `branch -D feat-x`], 'the clean worktree goes, the dirty one stays');
  const after = childOf('c-three');
  assert.deepEqual(after?.departures?.map((entry) => [entry.host, entry.cwd]), [['mid-box', MID], ['local', LEFT2]]);
  const log = fs.readFileSync(path.join(w.parentHome, 'retire.log'), 'utf8');
  assert.ok(log.includes(LEFT) && log.includes(LEFT2), log);
});

test("the parent's daemon refuses cleanly when the child's worktree is only on the far machine, and writes nothing", async (t) => {
  const w = world(t);
  const git = mergedWorktree();
  // Spawned on child-box: its only worktree is there, where the parent's daemon cannot take a proof.
  parentHolds('c-far');
  childHolds(w, 'c-far');
  const links = await parentDaemon(w, git);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-far');
  const answer = await client.tool('request_retirement', {});
  assert.match(answer, new RegExp(PARENT_ID));
  assert.ok(answer.includes(FAR_CWD), answer);
  assert.match(answer, /child-box/);
  assert.match(answer, /Nothing was written/);
  assert.equal(childOf('c-far')?.retireRequestedAt, undefined);
  assert.equal(childOf('c-far')?.retireIntent, undefined);
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the refusal to clear the child machine, since no resend changes it');
  assert.deepEqual(git.calls, []);
});

test("the destination daemon answers that the child is not its own, names the parent, and doctor says the request waits until the parent's daemon takes it", async (t) => {
  const w = world(t);
  const git = mergedWorktree();
  movedChild('c-alone');
  childHolds(w, 'c-alone');

  // No parent daemon is connected: the child's machine holds the only copy of the request.
  const client = await childSession(w, 'c-alone');
  const answer = await client.tool('request_retirement', { reason: 'done' });
  assert.doesNotMatch(answer, /no registry on this machine holds/, answer);
  assert.match(answer, /not this machine's child/i, answer);
  assert.match(answer, new RegExp(PARENT_ID), 'the answer names the parent that owns the record');
  assert.match(answer, /close your tab/i, 'the child is not left with a pane it cannot close');
  const waiting = inHome(w.childHome, () => listForwards());
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0]?.retire, { reason: 'done' });
  const record = inHome(w.childHome, () => readRelayRecord('c-alone'));
  assert.ok(record?.retireRequest?.at, 'the relay record says a request waits');
  assert.equal(record?.retireRequest?.receipt, waiting[0]?.receipt);

  const before = await doctorOn(w, w.childHome);
  assert.match(before, /warn\s+retirement: child-c-alone \(child c-alone\)/, before);
  assert.ok(before.includes(PARENT_ID), before);

  // The child closes its tab; later the parent's daemon connects, takes the request, and the exited child is retired as before the move.
  updateChild(PARENT_ID, 'c-alone', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  await client.close();
  // The link opens for the exited child's one drain, and may close again before a poll would see it connected.
  await parentDaemon(w, git);
  await until(() => Boolean(childOf('c-alone')?.retireIntent), 'the parent record to take the request', 20_000, () => w.logs);
  assert.equal(childOf('c-alone')?.retireIntent?.worktree, LEFT);
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the child machine to drop its copy', 20_000, () => w.logs);
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-alone'))?.retireRequest, undefined);
  const after = await doctorOn(w, w.childHome);
  assert.doesNotMatch(after, /retirement: child-c-alone/, after);
});
