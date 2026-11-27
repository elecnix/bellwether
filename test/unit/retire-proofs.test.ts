// Tier 1: the proofs retirement accepts before it removes a worktree, run on
// the real operations against a scripted git and gh. No repository is read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { realRetireOps, type Runner } from '../../src/core/retire.ts';

const REPO = '/repos/x.git';
const TIP = 'abc123def4567890';

interface Script {
  /** Whether the tip is an ancestor of the default branch. */
  ancestor?: boolean;
  /** How many of the branch's commits sit on no remote branch. */
  unpushed?: number;
  prs?: { number: number; state: string; headRefOid: string }[];
}

/** A runner that answers git and gh from the script and records every argument list. */
function scripted(script: Script): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (command === 'gh') return ok(JSON.stringify(script.prs ?? []));
    const verb = args.slice(1);
    if (verb[0] === 'rev-parse') return ok(`${TIP}\n`);
    if (verb[0] === 'merge-base') return script.ancestor ? ok() : { code: 1, stdout: '', stderr: '' };
    if (verb[0] === 'rev-list') return ok(`${script.unpushed ?? 0}\n`);
    return ok();
  };
  return { run, calls };
}

const ask = (script: Script) => {
  const { run, calls } = scripted(script);
  return realRetireOps({ run, proc: undefined })
    .safety({ repo: REPO, branch: 'feat', defaultBranch: 'origin/main' })
    .then((safety) => ({ safety, calls }));
};

test('proof 1: a branch whose tip the default branch contains is merged', async () => {
  const { safety } = await ask({ ancestor: true, unpushed: 3 });
  assert.deepEqual(safety, { safe: true, how: 'branch feat is merged into origin/main' });
});

test('proof 2: a branch whose every commit is on a remote branch is safe, and gh is not asked', async () => {
  const { safety, calls } = await ask({ unpushed: 0 });
  assert.deepEqual(safety, { safe: true, how: 'every commit on branch feat is on a remote branch' });
  assert.ok(calls.some((call) => call.join(' ') === `git --git-dir=${REPO} rev-list --count ${TIP} --not --remotes`));
  assert.ok(!calls.some((call) => call[0] === 'gh'));
});

test('proof 3: a merged pull request whose head is the tip is safe; a closed one is not', async () => {
  const merged = await ask({ unpushed: 2, prs: [{ number: 5, state: 'MERGED', headRefOid: TIP }] });
  assert.deepEqual(merged.safety, { safe: true, how: 'branch feat is pushed and pull request #5 is merged' });

  const closed = await ask({ unpushed: 2, prs: [{ number: 6, state: 'CLOSED', headRefOid: TIP }] });
  assert.deepEqual(closed.safety, { safe: false, how: 'branch feat has 2 commit(s) on no remote, and pull request #6 was closed without merging' });

  const stale = await ask({ unpushed: 2, prs: [{ number: 3, state: 'MERGED', headRefOid: 'deadbeef' }] });
  assert.equal(stale.safety.safe, false, 'a merged pull request for an older tip does not cover new commits');
});

test('no proof: unpushed commits are named by count', async () => {
  const { safety } = await ask({ unpushed: 2 });
  assert.deepEqual(safety, { safe: false, how: `branch feat has 2 commit(s) on no remote, is not merged into origin/main, and no merged pull request has its tip ${TIP.slice(0, 12)}, so its work may exist nowhere else` });
});

test('removal never passes --force to git', async () => {
  const { run, calls } = scripted({});
  await realRetireOps({ run, proc: undefined }).removeWorktree(REPO, '/work/x/feat');
  assert.deepEqual(calls[0], ['git', `--git-dir=${REPO}`, 'worktree', 'remove', '/work/x/feat']);
  assert.ok(calls.every((call) => !call.includes('--force') && !call.includes('-f')), JSON.stringify(calls));
});
