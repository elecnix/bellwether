// Tier 1: the real retirement operations against a real git repository in a
// scratch directory. gh is stubbed, because a pull request lives on GitHub; git
// and the process table are real.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { realRetireOps, runCommand, type Runner } from '../../src/core/retire.ts';

const GIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with one commit on main, and a linked worktree on branch feat with one more. */
function repository(t: test.TestContext): { root: string; repo: string; feat: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-retire-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const feat = path.join(root, 'feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
  fs.writeFileSync(path.join(feat, 'b.txt'), 'b\n');
  git(feat, 'add', 'b.txt');
  git(feat, 'commit', '-q', '-m', 'b');
  return { root, repo, feat };
}

/** gh answers with these pull requests; git runs for real. */
function withPrs(prs: { number: number; state: string; headRefOid: string }[]): Runner {
  return (command, args, cwd) => (command === 'gh' ? Promise.resolve({ code: 0, stdout: JSON.stringify(prs), stderr: '' }) : runCommand(command, args, cwd));
}

test('inspect tells a main worktree from a linked one, in a plain and a bare repository', async (t) => {
  const { root, repo, feat } = repository(t);
  const ops = realRetireOps({ run: withPrs([]) });
  const main = await ops.inspect(repo);
  assert.ok(!('error' in main));
  assert.equal(main.main, 'its git directory is the repository itself');
  const linked = await ops.inspect(path.join(feat));
  assert.ok(!('error' in linked));
  assert.equal(linked.main, undefined);
  assert.equal(linked.branch, 'feat');
  assert.equal(linked.repo, path.join(repo, '.git'));
  assert.equal(linked.defaultBranch, 'main');
  // A subdirectory resolves to its worktree root.
  fs.mkdirSync(path.join(feat, 'sub'));
  const nested = await ops.inspect(path.join(feat, 'sub'));
  assert.ok(!('error' in nested));
  assert.equal(nested.worktree, feat);

  // The bare layout this machine uses: ~/Source/git-root/x.git with worktrees beside it.
  const bare = path.join(root, 'x.git');
  git(root, 'clone', '-q', '--bare', repo, bare);
  const bareMain = path.join(root, 'x', 'main');
  const bareFeat = path.join(root, 'x', 'feat2');
  git(root, `--git-dir=${bare}`, 'worktree', 'add', '-q', bareMain, 'main');
  git(root, `--git-dir=${bare}`, 'worktree', 'add', '-q', '-b', 'feat2', bareFeat);
  const checkedOutMain = await ops.inspect(bareMain);
  assert.ok(!('error' in checkedOutMain));
  assert.equal(checkedOutMain.main, 'it has the default branch main checked out');
  const other = await ops.inspect(bareFeat);
  assert.ok(!('error' in other));
  assert.equal(other.main, undefined);
  assert.equal(other.repo, bare);

  const outside = await ops.inspect(root);
  assert.ok('error' in outside);
});

test('dirty and stash are read from git', async (t) => {
  const { repo, feat } = repository(t);
  const ops = realRetireOps({ run: withPrs([]) });
  const gitDir = path.join(repo, '.git');
  assert.deepEqual(await ops.dirty(feat), []);
  fs.writeFileSync(path.join(feat, 'c.txt'), 'c\n');
  assert.deepEqual(await ops.dirty(feat), ['?? c.txt']);
  git(feat, 'stash', 'push', '-q', '-u', '-m', 'half done');
  assert.deepEqual(await ops.dirty(feat), []);
  assert.deepEqual(await ops.stashes(gitDir, 'feat'), ['On feat: half done']);
  assert.deepEqual(await ops.stashes(gitDir, 'main'), []);
});

test('safety: unmerged and unpushed is unsafe, an open pull request is unsafe, merged either way is safe', async (t) => {
  const { repo, feat } = repository(t);
  const gitDir = path.join(repo, '.git');
  const tip = git(feat, 'rev-parse', 'HEAD');
  const ask = (prs: { number: number; state: string; headRefOid: string }[]) => realRetireOps({ run: withPrs(prs) }).safety({ repo: gitDir, worktree: feat, branch: 'feat' });

  const none = await ask([]);
  assert.equal(none.safe, false);
  assert.match(none.how, /^branch feat has 2 commit\(s\) on no remote, is not merged into main, and no merged pull request has its tip/);
  const stale = await ask([{ number: 3, state: 'MERGED', headRefOid: 'deadbeef' }]);
  assert.equal(stale.safe, false, 'a merged pull request for an older tip does not cover new commits');
  const open = await ask([{ number: 4, state: 'OPEN', headRefOid: tip }]);
  assert.deepEqual(open, { safe: false, how: 'branch feat has 2 commit(s) on no remote, and pull request #4 is still open' });
  const squashed = await ask([{ number: 5, state: 'MERGED', headRefOid: tip }]);
  assert.deepEqual(squashed, { safe: true, how: 'branch feat is pushed and pull request #5 is merged' });

  git(repo, 'merge', '-q', '--ff-only', 'feat');
  assert.deepEqual(await ask([]), { safe: true, how: 'branch feat is merged into main' });
});

test('busy names a process whose working directory is inside the worktree', async (t) => {
  const { feat } = repository(t);
  const ops = realRetireOps({ run: withPrs([]) });
  assert.deepEqual(await ops.busy(feat), []);
  fs.mkdirSync(path.join(feat, 'deep'));
  const sleeper = spawn('sleep', ['30'], { cwd: path.join(feat, 'deep'), stdio: 'ignore' });
  t.after(() => sleeper.kill());
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  const pids = await ops.busy(feat);
  assert.ok(pids?.includes(sleeper.pid as number), `expected ${sleeper.pid} in ${JSON.stringify(pids)}`);
});

test('remove and delete leave neither the worktree nor the branch, and git agrees', async (t) => {
  const { repo, feat } = repository(t);
  const gitDir = path.join(repo, '.git');
  const ops = realRetireOps({ run: withPrs([]) });
  assert.equal(await ops.worktreeExists(gitDir, feat), true);
  assert.equal(await ops.branchExists(gitDir, 'feat'), true);
  await ops.removeWorktree(gitDir, feat);
  assert.equal(fs.existsSync(feat), false);
  assert.equal(await ops.worktreeExists(gitDir, feat), false);
  await ops.deleteBranch(gitDir, 'feat');
  assert.equal(await ops.branchExists(gitDir, 'feat'), false);
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /feat/);
});

test('git refuses to remove a dirty worktree, and the error comes back', async (t) => {
  const { repo, feat } = repository(t);
  const ops = realRetireOps({ run: withPrs([]) });
  fs.writeFileSync(path.join(feat, 'b.txt'), 'changed\n');
  await assert.rejects(ops.removeWorktree(path.join(repo, '.git'), feat), /--force/);
  assert.equal(fs.existsSync(feat), true);
});
