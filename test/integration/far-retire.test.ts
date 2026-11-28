// Tier 2: a worktree on a child's far machine is retired (issue #242). The
// parent's daemon holds the record and decides; it cannot take a proof on
// another machine. The daemon on that machine can, and holds no record. So
// once the child's pane is gone, the parent's daemon sends `relay-retire` over
// the connection it keeps open, naming the directory its record holds. The far
// daemon runs retirement's conditions against its own git and process table,
// removes the worktree only when they pass, and keeps its answer in its relay
// outbox until the parent's daemon writes the outcome on the record.
//
// Two machines are two Bellwether homes in one temporary root, joined by the
// fake ssh. The parent's daemon runs in this process with a fake git for its
// own machine. The far daemon is a real process with real git, against a real
// repository under the temporary root, so its proofs are real proofs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runEnds } from '../../src/core/incarnation.ts';
import { RelayAnswerLost } from '../../src/core/relay-answer.ts';
import { emptyParent, readParent, saveParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, listForwards, saveRelayRecord } from '../../src/core/relay-records.ts';
import { reapChild } from '../../src/core/retire.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService } from '../../src/daemon/server.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { fakeGit, type FakeGit } from '../fixtures/fake-git.ts';
import { installFakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const PARENT_ID = 'claude-code-the-parent';

interface World {
  root: string;
  parentHome: string;
  childHome: string;
  /** The main worktree of the far repository, and the child's worktree beside it. */
  repo: string;
  far: string;
  logs: string[];
  closers: (() => Promise<void> | void)[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository on the far machine whose branch feat-x, checked out in its own worktree, is merged into main. */
function farRepository(root: string): { repo: string; far: string } {
  const repo = path.join(root, 'far', 'repo', 'main');
  const far = path.join(root, 'far', 'repo', 'feat-x');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README'), 'base\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat-x', far);
  fs.writeFileSync(path.join(far, 'work'), 'done\n');
  git(far, 'add', 'work');
  git(far, 'commit', '-q', '-m', 'work');
  git(repo, 'merge', '-q', '--ff-only', 'feat-x');
  return { repo, far: fs.realpathSync(far) };
}

function world(t: test.TestContext): World {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/bw-farret-'));
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
  return { root, parentHome, childHome, ...farRepository(root), logs: [], closers };
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

/** A child the parent spawned on child-box, which never ran on the parent's machine. */
function farChild(w: World, childId: string, extra: Partial<ChildRecord> = {}): void {
  const at = new Date().toISOString();
  if (!readParent(PARENT_ID)) saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, { id: childId, name: `child-${childId}`, kind: 'claude', harness: 'claude-code', paneId: 'w2:p7', tabId: 'w2:t7', host: 'child-box', cwd: w.far, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra });
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: `child-${childId}`, kind: 'claude', parentId: PARENT_ID, cwd: w.far, registeredAt: at }));
}

function childOf(childId: string): ChildRecord | undefined {
  return readParent(PARENT_ID)?.children.find((entry) => entry.id === childId);
}

function stubService(): ParentService {
  return { tool: async (name) => `the session service ran ${name}`, markRead: () => {}, onEvents: () => {}, pending: () => [], watchPane: () => () => {}, stop: () => {} };
}

async function parentDaemon(w: World, local: FakeGit): Promise<RelayLinks> {
  const links = new RelayLinks({ resolve: async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }), initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 15_000, log: (line) => w.logs.push(line) });
  const daemon = await startDaemon({ socketPath: path.join(w.parentHome, 'daemon.sock'), home: w.parentHome, factory: () => stubService(), links, retireOps: local, log: (line) => w.logs.push(line) });
  w.closers.push(() => daemon.close());
  return links;
}

/** The child's own Bellwether server on child-box, which starts that machine's daemon. */
async function childSession(w: World, childId: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(
    { harness: 'claude-code', session: `session-${childId}`, cwd: w.far, host: 'child-box', depth: 1, herdrSocket: path.join(w.root, 'no-herdr.sock'), childId, paneId: 'w2:p7' },
    { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') },
  );
  w.closers.push(() => client.close());
  return client;
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(25);
  }
}

/** The child asks from child-box, its pane closes there, and the parent's watcher marks the exit. */
async function askedAndGone(w: World, childId: string, links: RelayLinks): Promise<string> {
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');
  const client = await childSession(w, childId);
  const answer = await client.tool('request_retirement', { reason: 'merged' });
  await client.close();
  updateChild(PARENT_ID, childId, (entry) => {
    runEnds(entry, { at: new Date().toISOString() });
  });
  return answer;
}

test("a child that ran only on another machine has its worktree there retired by that machine's daemon, on the parent's request, once its pane is gone", async (t) => {
  const w = world(t);
  const local = fakeGit();
  farChild(w, 'c-far');
  const links = await parentDaemon(w, local);
  const answer = await askedAndGone(w, 'c-far', links);
  assert.doesNotMatch(answer, /Nothing was written/, answer);
  assert.ok(answer.includes(w.far) && answer.includes('child-box'), `the answer names the worktree and its machine: ${answer}`);
  assert.deepEqual(childOf('c-far')?.retireIntent?.far?.map((entry) => [entry.host, entry.worktree]), [['child-box', w.far]]);
  assert.ok(fs.existsSync(w.far), 'nothing is removed at the request');

  const result = await reapChild(PARENT_ID, 'c-far', { ops: local, paneOrTabLive: async () => false, busyRetries: 0, retireFar: (host, ask) => links.retire(host, ask) });
  assert.equal(result.outcome, 'removed', JSON.stringify(result));
  assert.ok(!fs.existsSync(w.far), 'the far daemon removed the worktree');
  assert.doesNotMatch(git(w.repo, 'branch', '--list', 'feat-x'), /feat-x/, 'and deleted its branch');
  const far = childOf('c-far')?.retireIntent?.far?.[0];
  assert.equal(far?.outcome, 'removed');
  assert.match(far?.proof ?? '', /merged into main/);
  assert.equal(childOf('c-far')?.retireOutcome, 'removed');
  assert.deepEqual(local.calls, [], "the parent's own git touched nothing");
  const log = fs.readFileSync(path.join(w.parentHome, 'retire.log'), 'utf8');
  assert.ok(log.includes(w.far) && log.includes('child-box'), log);
});

test("a far worktree that fails a proof there is refused by that machine's daemon, with the reason on the parent's record, and stays", async (t) => {
  const w = world(t);
  const local = fakeGit();
  farChild(w, 'c-dirty');
  fs.writeFileSync(path.join(w.far, 'notes.md'), 'unsaved\n');
  const links = await parentDaemon(w, local);
  await askedAndGone(w, 'c-dirty', links);

  const result = await reapChild(PARENT_ID, 'c-dirty', { ops: local, paneOrTabLive: async () => false, busyRetries: 0, retireFar: (host, ask) => links.retire(host, ask) });
  assert.equal(result.outcome, 'refused', `${JSON.stringify(result)} ${JSON.stringify(childOf('c-dirty')?.retireIntent)} ${w.logs.filter((line) => line.includes('retire')).join(' | ')}`);
  assert.ok(fs.existsSync(w.far), 'the worktree stays');
  const far = childOf('c-dirty')?.retireIntent?.far?.[0];
  assert.equal(far?.outcome, 'refused');
  assert.match(far?.refusal ?? '', /uncommitted path\(s\): \?\? notes\.md/);
  assert.equal(childOf('c-dirty')?.retireOutcome, 'refused');
});

test('a far worktree on a machine that cannot answer is refused with its machine and directory, and nothing is removed on a guess', async (t) => {
  const w = world(t);
  const local = fakeGit();
  farChild(w, 'c-dark');
  const links = await parentDaemon(w, local);
  await askedAndGone(w, 'c-dark', links);

  const result = await reapChild(PARENT_ID, 'c-dark', {
    ops: local,
    paneOrTabLive: async () => false,
    busyRetries: 0,
    retireFar: async (host) => {
      throw new Error(`machine ${host} is unreachable: ssh exited 255`);
    },
  });
  assert.equal(result.outcome, 'refused');
  assert.ok(fs.existsSync(w.far));
  const far = childOf('c-dark')?.retireIntent?.far?.[0];
  assert.equal(far?.outcome, 'refused');
  assert.ok(far?.refusal?.includes('child-box') && far.refusal.includes(w.far), far?.refusal);
  assert.match(far?.refusal ?? '', /unreachable/);

  // A daemon with no relay at all refuses the same way.
  farChild(w, 'c-alone', { cwd: w.far });
  updateChild(PARENT_ID, 'c-alone', (entry) => {
    entry.retireRequestedAt = new Date().toISOString();
    entry.retireIntent = { reason: 'merged', far: [{ host: 'child-box', worktree: w.far, runs: true }] };
    runEnds(entry, { at: new Date().toISOString() });
  });
  const alone = await reapChild(PARENT_ID, 'c-alone', { ops: local, paneOrTabLive: async () => false, busyRetries: 0 });
  assert.equal(alone.outcome, 'refused');
  assert.ok(childOf('c-alone')?.retireIntent?.far?.[0]?.refusal?.includes(w.far));
  assert.ok(fs.existsSync(w.far));
});

test("an answer lost on the way back waits in the far machine's relay outbox, and the parent's daemon writes the outcome when it collects it", async (t) => {
  const w = world(t);
  const local = fakeGit();
  farChild(w, 'c-lost');
  const links = await parentDaemon(w, local);
  await askedAndGone(w, 'c-lost', links);

  const result = await reapChild(PARENT_ID, 'c-lost', {
    ops: local,
    paneOrTabLive: async () => false,
    busyRetries: 0,
    retireFar: async (host, ask) => {
      await links.retire(host, ask);
      throw new RelayAnswerLost(`the connection to machine ${host} ended`);
    },
  });
  assert.equal(result.outcome, 'pending', JSON.stringify(result));
  await until(() => childOf('c-lost')?.retireIntent?.far?.[0]?.outcome === 'removed', 'the parent to write the kept answer', 20_000, () => w.logs.slice(-5));
  assert.equal(childOf('c-lost')?.retireOutcome, 'removed');
  assert.ok(!fs.existsSync(w.far));
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the far machine to drop its kept answer', 20_000, () => inHome(w.childHome, () => listForwards()));
});
