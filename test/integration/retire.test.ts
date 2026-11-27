// Tier 2: a child asks to be retired, and the daemon's watcher cleans up after
// it once herdr reports the pane gone. herdr is the fake socket, git is the
// fake in test/fixtures/fake-git.ts, and the home is a scratch directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { RETIRE_TOOL, retireLogPath } from '../../src/core/retire.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { runBellwetherTool, toolsFor, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeGit, type FakeGit } from '../fixtures/fake-git.ts';

const WORKTREE = '/work/x/feat-x';
const MAIN = '/work/x/main';
const REPO = '/repos/x.git';
const PANE = 'w1:p5';
const TAB = 'w1:t5';

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface World {
  herdr: FakeHerdr;
  git: FakeGit;
  parentId: string;
  /** The panes herdr lists, by pane id, with their tab. */
  panes: Map<string, string>;
  watcher(): Watcher;
  ctx(watcher: Watcher): ToolContext;
  child(): ChildRecord;
  /** Take the pane out of herdr and send pane_exited, as herdr does when the child quits. */
  exit(): void;
  log(): Record<string, unknown>[];
  /** Run once, right after herdr answers the next pane.list, so a test can change herdr while an answer is in flight. */
  afterList: (() => void) | undefined;
}

async function world(t: test.TestContext, overrides: Partial<ChildRecord> = {}): Promise<World> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-retire-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const panes = new Map<string, string>([[PANE, TAB]]);
  const list = (): Record<string, unknown>[] => [...panes].map(([pane_id, tab_id]) => ({ pane_id, tab_id, workspace_id: 'w1', agent: 'claude', agent_status: 'idle' }));
  const herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'pane.list') {
        const answer = { result: { type: 'pane_list', panes: list() } };
        const after = result.afterList;
        result.afterList = undefined;
        after?.();
        return answer;
      }
      if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: list(), agents: list() } } };
      return undefined;
    },
  });
  const git = fakeGit();
  git.add(WORKTREE, { repo: REPO, branch: 'feat/x' });
  git.add(MAIN, { repo: REPO, branch: 'main', main: 'it has the default branch main checked out' });
  const long = new Date(Date.now() - 60_000).toISOString();
  const parent = emptyParent('claude-code', `retire-${path.basename(home)}`, '/work', { paneId: 'w1:p1' });
  parent.children.push({ id: 'c-retire', name: 'feat-x', kind: 'claude', harness: 'claude-code', paneId: PANE, tabId: TAB, host: 'local', origin: 'spawn', cwd: WORKTREE, startedAt: long, lastStatus: 'idle', statusChangedAt: long, lastBusyAt: long, depth: 1, ...overrides });
  saveParent(parent);
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  const watchers: Watcher[] = [];
  t.after(async () => {
    for (const watcher of watchers) watcher.stop();
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const result: World = {
    afterList: undefined,
    herdr,
    git,
    parentId: parent.id,
    panes,
    watcher() {
      const watcher = new Watcher({ client, parentId: parent.id, onEntries: () => {}, tickMs: 60_000, screenPollMs: 0, retireOps: git, retireBusyRetries: 0 });
      watchers.push(watcher);
      return watcher;
    },
    ctx: (watcher) => ({ client, clientFor: async () => client, parentId: parent.id, watcher, retireOps: git }),
    child: () => readParent(parent.id)?.children.find((entry) => entry.id === 'c-retire') as ChildRecord,
    exit() {
      panes.delete(PANE);
      herdr.send({ event: 'pane_exited', data: { pane_id: PANE, exit_code: 0 } });
    },
    log: () => (fs.existsSync(retireLogPath()) ? fs.readFileSync(retireLogPath(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []),
  };
  return result;
}

const caller = { childId: 'c-retire', paneId: PANE };

/** Start a watcher, wait for its subscription, and have the child ask to be retired. */
async function requested(w: World): Promise<{ watcher: Watcher; text: string }> {
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  const text = await runBellwetherTool(w.ctx(watcher), RETIRE_TOOL, { reason: 'merged' }, caller);
  return { watcher, text };
}

test('a clean, merged child that asks to be retired is removed once its pane is gone, and its record says so', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher, text } = await requested(w);
  assert.match(text, /Retirement requested for feat-x: \/work\/x\/feat-x on branch feat\/x\. Nothing has been removed\./);
  assert.match(text, /Passed now: the worktree is clean; no stash on the branch; branch feat\/x is merged into origin\/main\./);
  assert.doesNotMatch(text, /Failing now/);
  assert.ok(w.child().retireRequestedAt);
  assert.deepEqual(w.child().retireIntent, { worktree: WORKTREE, repo: REPO, branch: 'feat/x', head: 'abc123def456', defaultBranch: 'origin/main', reason: 'merged' });
  assert.deepEqual(w.git.calls, [], 'the request removes nothing');

  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  const child = w.child();
  assert.equal(child.retireOutcome, 'removed');
  assert.ok(child.retiredAt);
  assert.equal(child.retireReason, undefined);
  assert.equal(child.retireStage, 'branch-deleted');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.equal(w.git.worktrees.has(WORKTREE), false);
  assert.equal(w.git.worktrees.has(MAIN), true, 'the main worktree stays');
  const log = w.log();
  assert.equal(log.length, 1);
  assert.equal(log[0]?.['outcome'], 'removed');
  assert.equal(log[0]?.['worktree'], WORKTREE);
});

test('a pull request merged by squash counts as safe', async (t) => {
  const w = await world(t);
  w.git.mergedPrs.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
});

test('a dirty worktree is refused, recorded, and left untouched', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  w.git.worktrees.get(WORKTREE)?.dirty.push(' M src/a.ts', '?? notes.md');
  const { watcher, text } = await requested(w);
  assert.match(text, /Failing now: the worktree has 2 uncommitted path\(s\): {2}M src\/a\.ts, \?\? notes\.md\. Fix these before you exit/);
  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  const child = w.child();
  assert.equal(child.retireOutcome, 'refused');
  assert.match(child.retireReason ?? '', /^condition 2 \(clean\): \/work\/x\/feat-x has 2 uncommitted path\(s\).*Commit or discard them/);
  assert.deepEqual(w.git.calls, []);
  assert.equal(w.git.worktrees.has(WORKTREE), true);
  assert.equal(w.git.branches.has(`${REPO}:feat/x`), true);
  assert.equal(w.log()[0]?.['outcome'], 'refused');
});

test('a stash left on the branch is refused', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  w.git.stashList.set(`${REPO}:feat/x`, ['On feat/x: half done']);
  const { watcher } = await requested(w);
  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.match(w.child().retireReason ?? '', /^condition 2 \(stash\): 1 stash entry on feat\/x/);
  assert.deepEqual(w.git.calls, []);
});

test('an unmerged and unpushed branch is refused, naming the reason', async (t) => {
  const w = await world(t);
  const { watcher, text } = await requested(w);
  assert.match(text, /Failing now: branch feat\/x has 1 commit\(s\) on no remote, is not merged into origin\/main/);
  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  const child = w.child();
  assert.equal(child.retireOutcome, 'refused');
  assert.match(child.retireReason ?? '', /^condition 3 \(work is safe\): branch feat\/x has 1 commit\(s\) on no remote, is not merged into origin\/main, and no merged pull request has its tip.*Push the branch or merge it/);
  assert.deepEqual(w.git.calls, []);
  assert.equal(w.git.worktrees.has(WORKTREE), true);
});

test('a process still working inside the worktree is refused, naming it', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  w.git.worktrees.get(WORKTREE)?.busy.push(4242);
  const { watcher } = await requested(w);
  w.exit();
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.match(w.child().retireReason ?? '', /^condition 4 \(no process inside\): process\(es\) 4242 have their working directory in \/work\/x\/feat-x/);
  assert.deepEqual(w.git.calls, []);
});

test('a child whose pane is still alive gets no cleanup', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  // No exit event: the child asked, but it still runs.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, undefined);
  watcher.stop();

  // A record marked exited while herdr still lists the tab is not gone either.
  updateChild(w.parentId, 'c-retire', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  w.panes.delete(PANE);
  w.panes.set('w1:p6', TAB);
  const restarted = w.watcher();
  restarted.start();
  await restarted.retirements();
  assert.equal(w.child().retireOutcome, undefined, 'still pending, not refused');
  assert.ok(w.child().retireRequestedAt);
  assert.deepEqual(w.git.calls, []);
  assert.deepEqual(w.log(), []);
});

test('the main worktree of a repository is never removed, whoever asks', async (t) => {
  const w = await world(t, { cwd: MAIN });
  w.git.merged.add(`${REPO}:main`);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  await assert.rejects(runBellwetherTool(w.ctx(watcher), RETIRE_TOOL, {}, caller), /\/work\/x\/main is the repository's main worktree \(it has the default branch main checked out\), and Bellwether never removes a main worktree, whoever asks\. Nothing was written\./);
  assert.equal(w.child().retireRequestedAt, undefined);
  watcher.stop();

  // A record written by hand to point the cleanup at the main worktree.
  updateChild(w.parentId, 'c-retire', (entry) => {
    entry.retireRequestedAt = new Date().toISOString();
    entry.retireIntent = { worktree: MAIN, repo: REPO, branch: 'main', head: 'abc123def456' };
    entry.exitedAt = new Date().toISOString();
  });
  w.panes.clear();
  const restarted = w.watcher();
  restarted.start();
  await until('the outcome', () => w.child().retireOutcome);
  await restarted.retirements();
  assert.equal(w.child().retireOutcome, 'refused');
  assert.match(w.child().retireReason ?? '', /^condition 2 \(main worktree\)/);
  assert.deepEqual(w.git.calls, []);
  assert.equal(w.git.worktrees.has(MAIN), true);
});

test('a daemon restarted after the worktree is removed finishes the job, and does not repeat a completed removal', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  // The first daemon dies while it deletes the branch: the call never returns.
  let release: () => void = () => {};
  w.git.override.deleteBranch = () => new Promise<void>((resolve) => (release = resolve));
  const { watcher } = await requested(w);
  w.exit();
  await until('the worktree removal', () => (w.child().retireStage === 'worktree-removed' ? true : undefined));
  watcher.stop();
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`]);
  assert.equal(w.child().retireOutcome, undefined);

  delete w.git.override.deleteBranch;
  const second = w.watcher();
  second.start();
  await until('the outcome', () => w.child().retireOutcome);
  await second.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x'], 'the worktree is removed once');
  second.stop();

  // A third start finds nothing left to do.
  const third = w.watcher();
  third.start();
  await third.retirements();
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.equal(w.log().length, 1, 'one log line per outcome');
  release();
});

test('the request tool refuses when the child environment names no child record', async (t) => {
  const w = await world(t);
  const watcher = w.watcher();
  await assert.rejects(runBellwetherTool(w.ctx(watcher), RETIRE_TOOL, {}, { paneId: 'w9:p9' }), /its environment carries no BELLWETHER_CHILD, so it is not a child Bellwether spawned\. Nothing was written\./);
  await assert.rejects(runBellwetherTool(w.ctx(watcher), RETIRE_TOOL, {}, { childId: 'c-unknown' }), /child id c-unknown, which no registry on this machine holds/);
  assert.equal(w.child().retireRequestedAt, undefined);
  // The adapters offer the tool only to a session whose environment carries BELLWETHER_CHILD.
  const names = (env: { parent?: string; child?: string }): string[] => toolsFor(env).map((tool) => tool.name);
  assert.ok(!names({}).includes(RETIRE_TOOL));
  assert.ok(!names({ parent: 'pi-p' }).includes(RETIRE_TOOL));
  assert.ok(names({ parent: 'pi-p', child: 'c-1' }).includes(RETIRE_TOOL));
  assert.ok(names({ parent: 'pi-p', child: 'c-1' }).includes('parent_report'));
});

test('an adopted child and a child on another host are out of bounds', async (t) => {
  const adopted = await world(t, { origin: 'adopt' });
  await assert.rejects(runBellwetherTool(adopted.ctx(adopted.watcher()), RETIRE_TOOL, {}, caller), /feat-x was adopted, not spawned by Bellwether/);
  assert.equal(adopted.child().retireRequestedAt, undefined);

  // A record that asks anyway is refused by the cleanup, with nothing touched.
  updateChild(adopted.parentId, 'c-retire', (entry) => {
    entry.retireRequestedAt = new Date().toISOString();
    entry.retireIntent = { worktree: WORKTREE, repo: REPO, branch: 'feat/x', head: 'abc123def456' };
    entry.exitedAt = new Date().toISOString();
  });
  adopted.git.merged.add(`${REPO}:feat/x`);
  adopted.panes.clear();
  const watcher = adopted.watcher();
  watcher.start();
  await until('the outcome', () => adopted.child().retireOutcome);
  await watcher.retirements();
  assert.match(adopted.child().retireReason ?? '', /^out of bounds: feat-x was adopted/);
  assert.deepEqual(adopted.git.calls, []);
});

test('a child on another host cannot ask', async (t) => {
  const remote = await world(t, { host: 'hawthorne' });
  await assert.rejects(runBellwetherTool(remote.ctx(remote.watcher()), RETIRE_TOOL, {}, { childId: 'c-retire' }), /runs on machine hawthorne, and this daemon only cleans up after children on its own machine/);
  assert.equal(remote.child().retireRequestedAt, undefined);
});

// agent_stop and herdr's pane_closed are two notices of one fact: the parent
// closed the child's tab. Whichever lands first, the cleanup runs once, with
// no daemon restart. Issue #120.

/** Run agent_stop through a herdr client whose tab.close runs `after` once herdr answers. */
async function stop(w: World, watcher: Watcher, after: () => Promise<void> | void = () => {}): Promise<string> {
  const closing = new HerdrClient({ socketPath: w.herdr.socketPath });
  const close = closing.tabClose.bind(closing);
  closing.tabClose = async (tabId) => {
    await close(tabId);
    await after();
  };
  return runBellwetherTool({ ...w.ctx(watcher), client: closing, clientFor: async () => closing }, 'agent_stop', { child: 'feat-x' });
}

test('agent_stop first, pane_closed second: a child that asked to be retired is retired without a daemon restart', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  // herdr answers tab.close before it drops the pane from its list, so the stop's own attempt waits.
  const text = await stop(w, watcher);
  assert.equal(text, 'Closed feat-x. Retirement pending: Bellwether removes worktree /work/x/feat-x and branch feat/x once herdr no longer lists the pane, if it can still prove the work merged. agent_list and retire.log show the outcome.');
  await watcher.retirements();
  assert.ok(w.child().exitedAt, 'the stop marks the child exited');
  assert.equal(w.child().retireOutcome, undefined, 'the pane is still listed, so nothing is removed yet');
  assert.deepEqual(w.git.calls, []);

  w.panes.delete(PANE);
  w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE, tab_id: TAB } });
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.deepEqual(w.log().map((line) => line['outcome']), ['removed'], 'retire.log gets one line');
});

test('agent_stop alone retires the child when herdr drops the pane at once and no pane_closed reaches the watcher', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  await stop(w, watcher, () => {
    w.panes.delete(PANE);
  });
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
  assert.deepEqual(w.log().map((line) => line['outcome']), ['removed']);

  // A late pane_closed finds the work done: no second removal, no second line.
  w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE, tab_id: TAB } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await watcher.retirements();
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.equal(w.log().length, 1);
});

test('pane_closed first, agent_stop second: the child is retired once, and the stop does not wait for anything', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  // herdr's event for the close reaches the watcher before tab.close answers the stop.
  await stop(w, watcher, async () => {
    w.panes.delete(PANE);
    w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE, tab_id: TAB } });
    await until('the watcher to see the close', () => w.child().exitedAt);
  });
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.deepEqual(w.log().map((line) => line['outcome']), ['removed'], 'retire.log gets one line');
});

// A parent's agent_stop is a retirement too: the child never has to remove
// the directory its harness runs every command from. Issue #143.

test('agent_stop retires a child that never asked, once its branch is merged, and the stop line says so', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  const text = await stop(w, watcher, () => {
    w.panes.delete(PANE);
  });
  assert.equal(text, 'Closed feat-x. Retired: removed worktree /work/x/feat-x and branch feat/x, because branch feat/x is merged into origin/main.');
  const child = w.child();
  assert.equal(child.retireOutcome, 'removed');
  assert.equal(child.retireProof, 'branch feat/x is merged into origin/main');
  assert.equal(child.retireIntent?.reason, 'agent_stop by the parent');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
  assert.ok(w.git.calls.every((call) => !call.includes('--force')), 'no case runs git worktree remove --force');
  assert.deepEqual(w.log().map((line) => [line['outcome'], line['proof']]), [['removed', 'branch feat/x is merged into origin/main']]);
  const listed = await runBellwetherTool(w.ctx(watcher), 'agent_list', {});
  assert.equal(listed.split('\n')[1]?.split('\t')[3], 'exited, retired');
  // The worktree is gone because Bellwether removed it, so agent_read gives the retire line, not a warning.
  w.git.override.inspect = async () => ({ error: 'unreachable' });
  const read = await runBellwetherTool(w.ctx(watcher), 'agent_read', { child: 'feat-x' }).catch((error: unknown) => String(error));
  assert.match(read, /^Retired: removed worktree \/work\/x\/feat-x and branch feat\/x, because branch feat\/x is merged into origin\/main\./);
  // A resume would start the child where nothing is left, so it is refused by name.
  updateChild(w.parentId, 'c-retire', (entry) => {
    entry.session = { kind: 'id', value: 'session-feat-x' };
  });
  await assert.rejects(runBellwetherTool(w.ctx(watcher), 'agent_spawn', { resume: 'feat-x' }), /feat-x's working directory \/work\/x\/feat-x no longer exists: retirement removed it at .*, so Bellwether refused to resume the child there\./);
});

test('a branch whose commits are all on the remote counts as merged', async (t) => {
  const w = await world(t);
  w.git.onRemote.add(`${REPO}:feat/x`);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  const text = await stop(w, watcher, () => {
    w.panes.delete(PANE);
  });
  assert.equal(text, 'Closed feat-x. Retired: removed worktree /work/x/feat-x and branch feat/x, because every commit on branch feat/x is on a remote branch.');
  assert.deepEqual(w.git.calls, [`worktree remove ${WORKTREE}`, 'branch -D feat/x']);
});

test('agent_stop leaves a worktree whose branch has unpushed commits, and the stop line says why', async (t) => {
  const w = await world(t);
  w.git.unpushed.set(`${REPO}:feat/x`, 2);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  const text = await stop(w, watcher, () => {
    w.panes.delete(PANE);
  });
  assert.equal(text, 'Closed feat-x. Retirement left worktree /work/x/feat-x and branch feat/x in place, because Bellwether could not prove the work merged: branch feat/x has 2 commit(s) on no remote, is not merged into origin/main, and no merged pull request has its tip abc123def456, so its work may exist nowhere else. Push the branch or merge it, then remove the worktree and the branch by hand.');
  assert.equal(w.child().retireOutcome, 'refused');
  assert.deepEqual(w.git.calls, []);
  assert.equal(w.git.worktrees.has(WORKTREE), true);
  assert.equal(w.git.branches.has(`${REPO}:feat/x`), true);
  assert.deepEqual(w.log().map((line) => line['outcome']), ['refused']);
});

test('agent_stop leaves a working directory that is not a git worktree, and a main worktree, and says so', async (t) => {
  const plain = await world(t, { cwd: '/work/notes' });
  plain.git.dirs.add('/work/notes');
  const watcher = plain.watcher();
  watcher.start();
  await plain.herdr.waitFor('events.subscribe');
  const text = await stop(plain, watcher, () => {
    plain.panes.delete(PANE);
  });
  assert.equal(text, 'Closed feat-x. Its working directory /work/notes is not a git worktree, so retirement leaves it in place.');
  assert.equal(plain.child().retireRequestedAt, undefined);
  assert.deepEqual(plain.log(), []);

  const main = await world(t, { cwd: MAIN });
  const mainWatcher = main.watcher();
  mainWatcher.start();
  await main.herdr.waitFor('events.subscribe');
  const mainText = await stop(main, mainWatcher, () => {
    main.panes.delete(PANE);
  });
  assert.equal(mainText, "Closed feat-x. Retirement leaves /work/x/main in place: it is the repository's main worktree (it has the default branch main checked out), and Bellwether never removes a main worktree.");
  assert.deepEqual(main.git.calls, []);
});

test('a child whose working directory is gone is named by agent_read and request_retirement, and agent_stop still closes it', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  // The child removed its own worktree: the directory and the worktree entry are gone, the record still names it.
  w.git.worktrees.delete(WORKTREE);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  const gone = "feat-x's working directory /work/x/feat-x no longer exists. A harness that starts each command there, as pi does, now fails every shell command; the child's Bellwether tools still work, so it can still call parent_report, and agent_stop still closes it.";

  const read = await runBellwetherTool(w.ctx(watcher), 'agent_read', { child: 'feat-x' });
  assert.equal(read.split('\n')[0], gone);

  await assert.rejects(runBellwetherTool(w.ctx(watcher), RETIRE_TOOL, {}, caller), (error: Error) => {
    assert.equal(error.message, 'Your working directory /work/x/feat-x no longer exists, so a harness that starts each command there fails every shell command, and there is no worktree left to retire. Call parent_report, which needs no shell, to tell your parent, and ask it to close you with agent_stop. Nothing was written.');
    return true;
  });
  assert.equal(w.child().retireRequestedAt, undefined);

  const text = await stop(w, watcher, () => {
    w.panes.delete(PANE);
  });
  assert.equal(text, "Closed feat-x. feat-x's working directory /work/x/feat-x no longer exists, so retirement had no worktree left to remove.");
  assert.ok(w.child().exitedAt);
  assert.deepEqual(w.git.calls, []);
});

test('a pane_closed that lands while the stop is still checking the pane gets the cleanup a second look', async (t) => {
  const w = await world(t);
  w.git.merged.add(`${REPO}:feat/x`);
  const { watcher } = await requested(w);
  // The stop's pass reads the pane as listed; herdr drops it and sends the event before that pass ends.
  w.afterList = () => {
    w.panes.delete(PANE);
    w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE, tab_id: TAB } });
  };
  await stop(w, watcher);
  await until('the outcome', () => w.child().retireOutcome);
  await watcher.retirements();
  assert.equal(w.child().retireOutcome, 'removed');
  assert.deepEqual(w.log().map((line) => line['outcome']), ['removed']);
});
