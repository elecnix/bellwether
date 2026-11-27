// A fake git, gh and process table for retirement. A test builds worktrees and
// branches, makes one dirty, merged, unmerged or busy, and reads back which
// removals ran. It touches no disk and no real repository.
import type { RetireOps, Safety, WorktreeFacts } from '../../src/core/retire.ts';

export interface FakeWorktree {
  repo: string;
  branch?: string;
  head: string;
  /** Set for a main worktree, with the reason git would give. */
  main?: string;
  dirty: string[];
  busy: number[];
}

export interface FakeGit extends RetireOps {
  worktrees: Map<string, FakeWorktree>;
  /** Branch names, per repository, as `repo:branch`. */
  branches: Set<string>;
  /** Branches merged into the default branch, as `repo:branch`. */
  merged: Set<string>;
  /** Branches whose pull request is merged or closed, as `repo:branch`. */
  settledPrs: Set<string>;
  stashList: Map<string, string[]>;
  /** Every removal and deletion, in order. */
  calls: string[];
  /** Replace an operation, for a step that must hang or fail. */
  override: Partial<RetireOps>;
  add(path: string, worktree: Partial<FakeWorktree> & { repo: string }): FakeWorktree;
}

export function fakeGit(): FakeGit {
  const worktrees = new Map<string, FakeWorktree>();
  const branches = new Set<string>();
  const merged = new Set<string>();
  const settledPrs = new Set<string>();
  const stashList = new Map<string, string[]>();
  const calls: string[] = [];
  const override: Partial<RetireOps> = {};
  const git: FakeGit = {
    worktrees,
    branches,
    merged,
    settledPrs,
    stashList,
    calls,
    override,
    add(path, worktree) {
      const full: FakeWorktree = { head: 'abc123def456', dirty: [], busy: [], ...worktree };
      worktrees.set(path, full);
      if (full.branch) branches.add(`${full.repo}:${full.branch}`);
      return full;
    },
    async inspect(dir): Promise<WorktreeFacts | { error: string }> {
      if (override.inspect) return override.inspect(dir);
      const tree = worktrees.get(dir);
      if (!tree) return { error: `${dir} does not exist` };
      return { worktree: dir, repo: tree.repo, head: tree.head, defaultBranch: 'origin/main', ...(tree.branch ? { branch: tree.branch } : {}), ...(tree.main ? { main: tree.main } : {}) };
    },
    async dirty(worktree) {
      return worktrees.get(worktree)?.dirty ?? [];
    },
    async stashes(repo, branch) {
      return stashList.get(`${repo}:${branch}`) ?? [];
    },
    async safety({ repo, branch }): Promise<Safety> {
      if (merged.has(`${repo}:${branch}`)) return { safe: true, how: `branch ${branch} is merged into origin/main` };
      if (settledPrs.has(`${repo}:${branch}`)) return { safe: true, how: `branch ${branch} is pushed and pull request #7 is merged` };
      return { safe: false, how: `branch ${branch} is not merged into origin/main, and no merged or closed pull request has its tip abc123def456, so its work may exist nowhere else` };
    },
    async busy(dir) {
      if (override.busy) return override.busy(dir);
      return worktrees.get(dir)?.busy ?? [];
    },
    async worktreeExists(_repo, worktree) {
      return worktrees.has(worktree);
    },
    async branchExists(repo, branch) {
      return branches.has(`${repo}:${branch}`);
    },
    async removeWorktree(repo, worktree) {
      if (override.removeWorktree) return override.removeWorktree(repo, worktree);
      calls.push(`worktree remove ${worktree}`);
      worktrees.delete(worktree);
    },
    async deleteBranch(repo, branch) {
      if (override.deleteBranch) return override.deleteBranch(repo, branch);
      calls.push(`branch -D ${branch}`);
      branches.delete(`${repo}:${branch}`);
    },
  };
  return git;
}
