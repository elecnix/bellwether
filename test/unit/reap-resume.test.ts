// Lifecycle.tla, LiveWorktreeKept (issue #211). Trace: ReapCheck, ReapBusy,
// ResumeClear, ReapRemove. A reap read the child once, then removed its
// worktree, while a resume of that child took a lock the reap never took.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChildBusyError, withChildLock } from '../../src/core/child-lock.ts';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { clearRetirement, reapChild } from '../../src/core/retire.ts';
import { fakeGit } from '../fixtures/fake-git.ts';
import { isolate } from '../fixtures/isolated.ts';
import { runStarts } from '../../src/core/incarnation.ts';

const WORKTREE = '/work/x/feat-x';
const REPO = '/repos/x.git';
const CHILD = 'c-retire';

function exitedChild(t: test.TestContext) {
  isolate(t, 'bellwether-reap-resume-');
  const git = fakeGit();
  git.add(WORKTREE, { repo: REPO, branch: 'feat/x' });
  git.merged.add(`${REPO}:feat/x`);
  const long = new Date(Date.now() - 60_000).toISOString();
  const parent = emptyParent('claude-code', `reap-resume-${process.hrtime.bigint()}`, '/work', { paneId: 'w1:p1' });
  parent.children.push({
    id: CHILD, name: 'feat-x', kind: 'claude', harness: 'claude-code', paneId: 'w1:p5', tabId: 'w1:t5', host: 'local', origin: 'spawn', cwd: WORKTREE,
    startedAt: long, lastStatus: 'idle', statusChangedAt: long, lastBusyAt: long, depth: 1,
    exitedAt: long, retireRequestedAt: long,
    retireIntent: { worktree: WORKTREE, repo: REPO, branch: 'feat/x', head: 'abc123def456', defaultBranch: 'origin/main', reason: 'merged' },
  });
  saveParent(parent);
  return { git, parentId: parent.id };
}

/** What resumeChild writes before it opens the new tab: the child is live again. */
function resumeWrites(parentId: string): void {
  updateChild(parentId, CHILD, (child) => {
    runStarts(child, { paneId: '', tabId: undefined, resumedAt: new Date().toISOString() });
    clearRetirement(child);
  });
}

test('a child resumed while reap waits on its process check keeps its worktree, and its record takes no outcome', async (t) => {
  const { git, parentId } = exitedChild(t);
  git.override.busy = async () => {
    // ResumeClear, from a writer that skips the lock.
    resumeWrites(parentId);
    return []; // the resumed harness has not started yet
  };
  const result = await reapChild(parentId, CHILD, { ops: git, paneOrTabLive: async () => false, busyRetries: 0 });
  const after = readParent(parentId)?.children[0];
  assert.ok(git.worktrees.has(WORKTREE), `reap removed the worktree of a live child (outcome ${result.outcome}; git calls: ${git.calls.join(', ')})`);
  assert.equal(result.outcome, 'skipped');
  assert.equal(after?.retireOutcome, undefined, 'the resumed record carries no retirement outcome');
  assert.equal(after?.exitedAt, undefined);
});

test('reap holds the child lock that a resume takes, from its checks to its removal', async (t) => {
  const { git, parentId } = exitedChild(t);
  let resume: unknown;
  git.override.busy = async () => {
    resume = await withChildLock(CHILD, `feat-x (child ${CHILD})`, 'resume of feat-x', async () => 'resumed').catch((error: unknown) => error);
    return [];
  };
  const result = await reapChild(parentId, CHILD, { ops: git, paneOrTabLive: async () => false, busyRetries: 0 });
  assert.ok(resume instanceof ChildBusyError, `a resume took the lock while reap checked the worktree: ${String(resume)}`);
  assert.match((resume as ChildBusyError).message, /retirement of feat-x/);
  assert.equal(result.outcome, 'removed');
});

test('a reap that finds a resume holding the child lock waits, and touches nothing', async (t) => {
  const { git, parentId } = exitedChild(t);
  const result = await withChildLock(CHILD, `feat-x (child ${CHILD})`, 'resume of feat-x', () =>
    reapChild(parentId, CHILD, { ops: git, paneOrTabLive: async () => false, busyRetries: 0 }));
  assert.equal(result.outcome, 'pending', JSON.stringify(result));
  assert.match((result as { reason: string }).reason, /resume of feat-x/);
  assert.ok(git.worktrees.has(WORKTREE));
  assert.deepEqual(git.calls.filter((call) => /remove|branch -D/.test(call)), []);
  assert.equal(readParent(parentId)?.children[0]?.retireOutcome, undefined);
});
