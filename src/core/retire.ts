// Retirement: a child asks to be retired, and the daemon cleans up after it.
//
// The request runs while the child is alive, so it can tell the child which
// checks pass now. It writes the intent on the child record and removes
// nothing. The daemon does the cleaning once herdr reports the pane gone,
// because the daemon already holds the registry, watches every pane and
// outlives every child. No other process takes part.
//
// The cleanup removes nothing until every condition holds, records its outcome
// on the child record, and appends one line to retire.log. Each step checks the
// state it leaves behind, so a daemon restarted part of the way through
// finishes the job without doing any step twice.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { bellwetherHome } from './paths.ts';
import { childOfCaller } from './report.ts';
import { readParent, updateChild } from './registry.ts';
import type { CallerIdentity, ChildRecord, RetireIntent } from './types.ts';

/** What git says about the worktree a path sits in. */
export interface WorktreeFacts {
  /** The worktree root, which the path may sit under. */
  worktree: string;
  /** The repository's common git directory, shared by all its worktrees. */
  repo: string;
  /** The branch checked out, or undefined for a detached HEAD. */
  branch?: string;
  head: string;
  /** The repository's default branch, as `origin/main` or `main`. */
  defaultBranch?: string;
  /** Set when this is the repository's main worktree, with the reason. */
  main?: string;
}

/** Whether a branch's work is safe to delete, and how that was decided. */
export interface Safety {
  safe: boolean;
  /** How the work is safe, or why it is not. */
  how: string;
}

/**
 * Everything retirement asks of git, gh and the process table. The daemon uses
 * the real one; tests pass a fake that can be made dirty, merged, unmerged or busy.
 */
export interface RetireOps {
  /** The worktree a path sits in, or a sentence saying why it is not one. */
  inspect(dir: string): Promise<WorktreeFacts | { error: string }>;
  /** `git status --porcelain` lines: empty for a clean worktree. */
  dirty(worktree: string): Promise<string[]>;
  /** Stash entries made on this branch. The stash is shared by every worktree of a repository. */
  stashes(repo: string, branch: string): Promise<string[]>;
  /** Whether the branch is merged into the default branch, or pushed with its pull request merged or closed. */
  safety(facts: { repo: string; worktree?: string; branch: string; defaultBranch?: string }): Promise<Safety>;
  /** The processes whose working directory is inside the path, or undefined when that cannot be told. */
  busy(dir: string): Promise<number[] | undefined>;
  /** Whether git still lists the worktree, or a directory still sits at the path. */
  worktreeExists(repo: string, worktree: string): Promise<boolean>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  removeWorktree(repo: string, worktree: string): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
}

export const RETIRE_TOOL = 'request_retirement';

/** A request refused outright: nothing is written, and the error says why. */
export class RetireRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetireRefused';
  }
}

/** The one log line per outcome, beside the daemon's own state. */
export function retireLogPath(): string {
  return path.join(bellwetherHome(), 'retire.log');
}

/**
 * The bounds no request and no cleanup may cross: a child this daemon did not
 * spawn, a child on another host, a child with no working directory. Returns
 * the refusal, or undefined when the child is in bounds.
 */
function outOfBounds(child: ChildRecord): string | undefined {
  if (child.origin === 'adopt') return `${child.name} was adopted, not spawned by Bellwether, so Bellwether never removes its worktree. Remove it by hand with \`git worktree remove\` once its work is safe.`;
  if (hostOf(child) !== LOCAL_HOST) return `${child.name} runs on machine ${hostOf(child)}, and this daemon only cleans up after children on its own machine. Remove the worktree on ${hostOf(child)} by hand.`;
  if (!child.cwd) return `${child.name} has no working directory on its record, so there is no worktree to retire.`;
  return undefined;
}

function mainRefusal(worktree: string, why: string): string {
  return `${worktree} is the repository's main worktree (${why}), and Bellwether never removes a main worktree, whoever asks. Nothing was written. Work in a worktree of your own to be retired with it.`;
}

/**
 * The child-facing request. It runs the checks it can run while the child is
 * alive, writes `retireRequestedAt` and the intent on the child record, and
 * returns one line per check. It removes nothing.
 */
export async function requestRetirement(caller: CallerIdentity, ops: RetireOps, reason?: string): Promise<string> {
  if (!caller.childId) {
    throw new RetireRefused(`${RETIRE_TOOL} needs a child id, and this session sent none: its environment carries no BELLWETHER_CHILD, so it is not a child Bellwether spawned. Nothing was written.`);
  }
  const found = childOfCaller(caller);
  if (!found) throw new RetireRefused(`${RETIRE_TOOL} was called for child id ${caller.childId}, which no registry on this machine holds, so there is nothing to retire. Nothing was written.`);
  const { parent, child } = found;
  const bounds = outOfBounds(child);
  if (bounds) throw new RetireRefused(`${bounds} Nothing was written.`);

  const facts = await ops.inspect(child.cwd as string);
  if ('error' in facts) throw new RetireRefused(`${child.cwd} is not a git worktree Bellwether can retire: ${facts.error}. Nothing was written.`);
  if (facts.main) throw new RetireRefused(mainRefusal(facts.worktree, facts.main));
  if (!facts.branch) throw new RetireRefused(`${facts.worktree} has no branch checked out (detached HEAD at ${facts.head.slice(0, 12)}), so Bellwether cannot tell whether its work is safe. Check out a branch, then ask again. Nothing was written.`);

  const passed: string[] = [];
  const failing: string[] = [];
  const dirty = await ops.dirty(facts.worktree);
  (dirty.length ? failing : passed).push(dirty.length ? `the worktree has ${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}` : 'the worktree is clean');
  const stashes = await ops.stashes(facts.repo, facts.branch);
  (stashes.length ? failing : passed).push(stashes.length ? `${stashes.length} stash entr${stashes.length === 1 ? 'y' : 'ies'} on ${facts.branch}` : 'no stash on the branch');
  const safety = await ops.safety({ repo: facts.repo, worktree: facts.worktree, branch: facts.branch, defaultBranch: facts.defaultBranch });
  (safety.safe ? passed : failing).push(safety.how);

  const intent: RetireIntent = { worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}), ...(reason ? { reason } : {}) };
  const now = new Date().toISOString();
  updateChild(parent.id, child.id, (entry) => {
    // A child resumed after an earlier retirement asks afresh.
    if (entry.retireOutcome) clearRetirement(entry);
    entry.retireRequestedAt ??= now;
    entry.retireIntent = intent;
  });

  const lines = [`Retirement requested for ${child.name}: ${facts.worktree} on branch ${facts.branch}. Nothing has been removed.`];
  lines.push(`Passed now: ${passed.length ? passed.join('; ') : 'none'}.`);
  if (failing.length) lines.push(`Failing now: ${failing.join('; ')}. Fix these before you exit, or the daemon will refuse and leave everything in place.`);
  lines.push('After your pane is gone, the daemon checks again that the pane and tab are gone, that the worktree is not a main worktree, is clean and has no stash, that the work is safe, and that no process works inside it. Only then does it remove the worktree and delete the branch.');
  lines.push('Close your tab to finish.');
  return lines.join('\n');
}

/** Drop every retirement field, for a child that is brought back. */
export function clearRetirement(child: ChildRecord): void {
  delete child.retireRequestedAt;
  delete child.retireIntent;
  delete child.retireStage;
  delete child.retiredAt;
  delete child.retireOutcome;
  delete child.retireReason;
}

/** Whether a child has asked to be retired and the cleanup has not finished. */
export function retirementPending(child: ChildRecord): boolean {
  return Boolean(child.retireRequestedAt && !child.retireOutcome);
}

export interface ReapDeps {
  ops: RetireOps;
  /** Whether herdr still shows the pane or the tab. Throws when herdr cannot be asked. */
  paneOrTabLive: (child: ChildRecord) => Promise<boolean>;
  log?: (message: string) => void;
  /** How long to wait for a process still leaving the path. */
  busyRetries?: number;
  busyDelayMs?: number;
}

export type ReapResult = { outcome: 'removed' | 'refused'; reason?: string } | { outcome: 'pending'; reason: string } | { outcome: 'skipped' };

/**
 * The daemon's cleanup for one child that asked to be retired. It runs after
 * the watcher marks the child exited, and again when a daemon starts, so an
 * unfinished retirement finishes. A child still alive is left alone.
 */
export async function reapChild(parentId: string, childId: string, deps: ReapDeps): Promise<ReapResult> {
  const log = deps.log ?? (() => {});
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  if (!child || !retirementPending(child)) return { outcome: 'skipped' };
  if (!child.exitedAt) return { outcome: 'skipped' };

  const refuse = (reason: string): ReapResult => {
    finish(parentId, child, 'refused', reason);
    log(`retire ${child.name}: refused: ${reason}`);
    return { outcome: 'refused', reason };
  };

  const bounds = outOfBounds(child);
  if (bounds) return refuse(`out of bounds: ${bounds}`);
  const intent = child.retireIntent;
  if (!intent) return refuse(`no intent: the record of ${child.name} asks for retirement but names no worktree, so nothing was touched. Ask again from a live child.`);

  // 1. The pane and the tab are gone from herdr.
  let live: boolean;
  try {
    live = await deps.paneOrTabLive(child);
  } catch (error) {
    const reason = `herdr could not be asked whether pane ${child.paneId} is gone (${String(error)}); the retirement waits for the next exit event or daemon start`;
    log(`retire ${child.name}: ${reason}`);
    return { outcome: 'pending', reason };
  }
  if (live) {
    const reason = `pane ${child.paneId} or tab ${child.tabId ?? '?'} is still in herdr; the retirement waits until both are gone`;
    log(`retire ${child.name}: ${reason}`);
    return { outcome: 'pending', reason };
  }

  const { ops } = deps;
  const worktreeDone = child.retireStage === 'worktree-removed' || child.retireStage === 'branch-deleted' || !(await ops.worktreeExists(intent.repo, intent.worktree));
  if (!worktreeDone) {
    // 2. Not a main worktree, the same one the child asked about, clean, no stash.
    const facts = await ops.inspect(intent.worktree);
    if ('error' in facts) return refuse(`condition 2 (worktree): ${intent.worktree} is no longer a git worktree Bellwether can read: ${facts.error}. Look at it by hand.`);
    if (facts.main) return refuse(`condition 2 (main worktree): ${mainRefusal(facts.worktree, facts.main)}`);
    if (path.resolve(facts.worktree) !== path.resolve(intent.worktree) || path.resolve(facts.repo) !== path.resolve(intent.repo)) {
      return refuse(`condition 2 (worktree): ${intent.worktree} now belongs to ${facts.repo} at ${facts.worktree}, not the worktree the child asked about. Nothing was touched; look at it by hand.`);
    }
    if (facts.branch !== intent.branch) return refuse(`condition 2 (branch): ${intent.worktree} has ${facts.branch ?? 'a detached HEAD'} checked out, not ${intent.branch}, which the child asked to retire. Nothing was touched; look at it by hand.`);
    const dirty = await ops.dirty(intent.worktree);
    if (dirty.length) return refuse(`condition 2 (clean): ${intent.worktree} has ${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}. Commit or discard them, then remove it with \`git worktree remove ${intent.worktree}\`.`);
    const stashes = await ops.stashes(intent.repo, intent.branch);
    if (stashes.length) return refuse(`condition 2 (stash): ${stashes.length} stash entr${stashes.length === 1 ? 'y' : 'ies'} on ${intent.branch} (${stashes[0]}). Apply or drop them, then remove the worktree by hand.`);
  }

  // 3. The work is safe. Checked again after the worktree is gone, because the
  // branch is deleted only when it holds nothing that exists nowhere else.
  const branchLeft = child.retireStage !== 'branch-deleted' && (await ops.branchExists(intent.repo, intent.branch));
  if (branchLeft) {
    const safety = await ops.safety({ repo: intent.repo, worktree: worktreeDone ? undefined : intent.worktree, branch: intent.branch, defaultBranch: intent.defaultBranch });
    if (!safety.safe) return refuse(`condition 3 (work is safe): ${safety.how}. Merge the branch, or push it and merge or close its pull request, then remove the worktree and the branch by hand.`);
  }

  // 4. No process works inside the path. A shell can take a moment to leave
  // after its pane exits, so look a few times before refusing.
  if (!worktreeDone) {
    const tries = (deps.busyRetries ?? 3) + 1;
    let pids: number[] | undefined = [];
    for (let attempt = 0; attempt < tries; attempt += 1) {
      pids = await ops.busy(intent.worktree);
      if (pids === undefined || pids.length === 0) break;
      if (attempt < tries - 1) await new Promise((resolve) => setTimeout(resolve, deps.busyDelayMs ?? 500));
    }
    if (pids === undefined) return refuse(`condition 4 (no process inside): this machine offers neither /proc nor lsof, so Bellwether cannot tell whether a process works in ${intent.worktree}. Check by hand, then remove it.`);
    if (pids.length) return refuse(`condition 4 (no process inside): process(es) ${pids.join(', ')} have their working directory in ${intent.worktree}. Stop them, then remove the worktree by hand.`);
  }

  // 5. Remove, delete, verify. Each stage is written as it completes, so a
  // restart skips what is done.
  try {
    if (!worktreeDone) {
      await ops.removeWorktree(intent.repo, intent.worktree);
      updateChild(parentId, child.id, (entry) => {
        entry.retireStage = 'worktree-removed';
      });
    }
    if (branchLeft) await ops.deleteBranch(intent.repo, intent.branch);
    updateChild(parentId, child.id, (entry) => {
      entry.retireStage = 'branch-deleted';
    });
  } catch (error) {
    return refuse(`condition 5 (removal): git refused: ${(error as Error).message.trim()}. Look at ${intent.worktree} and branch ${intent.branch} by hand.`);
  }
  const pathLeft = (await ops.worktreeExists(intent.repo, intent.worktree)) || fs.existsSync(intent.worktree);
  const branchStill = await ops.branchExists(intent.repo, intent.branch);
  if (pathLeft || branchStill) {
    return refuse(`condition 5 (verify): after removal ${[pathLeft ? `${intent.worktree} still exists` : '', branchStill ? `branch ${intent.branch} still exists` : ''].filter(Boolean).join(' and ')}. Remove what is left by hand.`);
  }
  finish(parentId, child, 'removed');
  log(`retire ${child.name}: removed ${intent.worktree} and branch ${intent.branch}`);
  return { outcome: 'removed' };
}

/** Record the outcome on the child record first, then append the log line. */
function finish(parentId: string, child: ChildRecord, outcome: 'removed' | 'refused', reason?: string): void {
  const at = new Date().toISOString();
  updateChild(parentId, child.id, (entry) => {
    entry.retiredAt = at;
    entry.retireOutcome = outcome;
    if (reason) entry.retireReason = reason;
    else delete entry.retireReason;
  });
  const line = { at, parent: parentId, child: child.id, name: child.name, outcome, worktree: child.retireIntent?.worktree, branch: child.retireIntent?.branch, ...(reason ? { reason } : {}) };
  fs.mkdirSync(path.dirname(retireLogPath()), { recursive: true });
  fs.appendFileSync(retireLogPath(), `${JSON.stringify(line)}\n`);
}

// The real operations, on git, gh and the process table.

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], cwd?: string) => Promise<Run>;

/** Run a command without a shell, without a prompt, and never throw on a non-zero exit. */
export const runCommand: Runner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : 127) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === 127 ? error.message : '') });
      },
    );
  });

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function inside(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
}

export interface RealOpsOptions {
  run?: Runner;
  /** The /proc directory, or undefined to use lsof. Defaults to /proc when it exists. */
  proc?: string | undefined;
}

/** The retirement operations on the real git, gh and process table. */
export function realRetireOps(options: RealOpsOptions = {}): RetireOps {
  const run = options.run ?? runCommand;
  const proc = 'proc' in options ? options.proc : fs.existsSync('/proc/self/cwd') ? '/proc' : undefined;
  const git = (repo: string, args: string[]): Promise<Run> => run('git', [`--git-dir=${repo}`, ...args]);
  const gitIn = (dir: string, args: string[]): Promise<Run> => run('git', ['-C', dir, ...args]);

  const defaultBranchOf = async (repo: string): Promise<string | undefined> => {
    const head = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
      const remote = ref.startsWith('origin/');
      const found = await git(repo, ['show-ref', '--verify', '--quiet', remote ? `refs/remotes/${ref}` : `refs/heads/${ref}`]);
      if (found.code === 0) return ref;
    }
    return undefined;
  };

  const listWorktrees = async (repo: string): Promise<{ path: string; branch?: string; bare: boolean }[]> => {
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return [];
    const entries: { path: string; branch?: string; bare: boolean }[] = [];
    for (const block of listed.stdout.split('\n\n')) {
      const lines = block.split('\n');
      const where = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      if (!where) continue;
      const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch refs/heads/'.length);
      entries.push({ path: realpath(where), ...(branch ? { branch } : {}), bare: lines.includes('bare') });
    }
    return entries;
  };

  return {
    async inspect(dir) {
      if (!fs.existsSync(dir)) return { error: `${dir} does not exist` };
      const top = await gitIn(dir, ['rev-parse', '--show-toplevel']);
      if (top.code !== 0) return { error: top.stderr.trim() || 'git rev-parse failed' };
      const worktree = realpath(top.stdout.trim());
      const dirs = await gitIn(worktree, ['rev-parse', '--absolute-git-dir', '--git-common-dir', 'HEAD']);
      if (dirs.code !== 0) return { error: dirs.stderr.trim() || 'git rev-parse failed' };
      const [gitDir = '', common = '', head = ''] = dirs.stdout.trim().split('\n');
      const repo = realpath(path.resolve(worktree, common));
      const branchRun = await gitIn(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const branch = branchRun.code === 0 ? branchRun.stdout.trim() : undefined;
      const defaultBranch = await defaultBranchOf(repo);
      const defaultName = defaultBranch?.replace(/^origin\//, '');
      const worktrees = await listWorktrees(repo);
      let main: string | undefined;
      if (realpath(gitDir) === repo) main = 'its git directory is the repository itself';
      else if (worktrees[0] && !worktrees[0].bare && worktrees[0].path === worktree) main = 'git lists it first';
      else if (branch && defaultName && branch === defaultName) main = `it has the default branch ${defaultName} checked out`;
      else if (['main', 'master'].includes(path.basename(worktree))) main = `it is named ${path.basename(worktree)}`;
      return { worktree, repo, head, ...(branch ? { branch } : {}), ...(defaultBranch ? { defaultBranch } : {}), ...(main ? { main } : {}) };
    },
    async dirty(worktree) {
      const status = await gitIn(worktree, ['status', '--porcelain', '--untracked-files=all']);
      if (status.code !== 0) return [`git status failed: ${status.stderr.trim()}`];
      return status.stdout.split('\n').filter((line) => line.trim());
    },
    async stashes(repo, branch) {
      const list = await git(repo, ['stash', 'list', '--format=%gs']);
      if (list.code !== 0) return [];
      return list.stdout.split('\n').filter((line) => line.startsWith(`WIP on ${branch}:`) || line.startsWith(`On ${branch}:`));
    },
    async safety({ repo, worktree, branch, defaultBranch }) {
      const tip = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (tip.code !== 0) return { safe: false, how: `branch ${branch} does not exist in ${repo}` };
      const sha = tip.stdout.trim();
      const base = defaultBranch ?? (await defaultBranchOf(repo));
      if (base) {
        const ancestor = await git(repo, ['merge-base', '--is-ancestor', sha, base]);
        if (ancestor.code === 0) return { safe: true, how: `branch ${branch} is merged into ${base}` };
      }
      const pr = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid', '--limit', '20'], worktree && fs.existsSync(worktree) ? worktree : repo);
      if (pr.code !== 0) return { safe: false, how: `branch ${branch} is not merged into ${base ?? 'a default branch'}, and gh could not list its pull requests (${(pr.stderr || pr.stdout).trim().split('\n')[0]})` };
      let prs: { number: number; state: string; headRefOid: string }[] = [];
      try {
        prs = JSON.parse(pr.stdout) as typeof prs;
      } catch {
        prs = [];
      }
      const pushed = prs.filter((entry) => entry.headRefOid === sha);
      const settled = pushed.find((entry) => entry.state === 'MERGED' || entry.state === 'CLOSED');
      if (settled) return { safe: true, how: `branch ${branch} is pushed and pull request #${settled.number} is ${settled.state.toLowerCase()}` };
      const open = pushed.find((entry) => entry.state === 'OPEN');
      if (open) return { safe: false, how: `branch ${branch} is pushed but pull request #${open.number} is still open` };
      return { safe: false, how: `branch ${branch} is not merged into ${base ?? 'a default branch'}, and no merged or closed pull request has its tip ${sha.slice(0, 12)}, so its work may exist nowhere else` };
    },
    async busy(dir) {
      const target = realpath(dir);
      if (proc) {
        const pids: number[] = [];
        let entries: string[];
        try {
          entries = fs.readdirSync(proc);
        } catch {
          return undefined;
        }
        for (const entry of entries) {
          if (!/^\d+$/.test(entry)) continue;
          try {
            if (inside(fs.readlinkSync(path.join(proc, entry, 'cwd')), target)) pids.push(Number(entry));
          } catch {
            // A process that left, or one this user cannot read.
          }
        }
        return pids;
      }
      const lsof = await run('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-Fpn']);
      if (lsof.code === 127) return undefined;
      const pids: number[] = [];
      let pid = 0;
      for (const line of lsof.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && inside(line.slice(1), target)) pids.push(pid);
      }
      return pids;
    },
    async worktreeExists(repo, worktree) {
      const target = realpath(worktree);
      if (fs.existsSync(worktree)) return true;
      return (await listWorktrees(repo)).some((entry) => entry.path === target || entry.path === path.resolve(worktree));
    },
    async branchExists(repo, branch) {
      return (await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    },
    async removeWorktree(repo, worktree) {
      const removed = await git(repo, ['worktree', 'remove', worktree]);
      if (removed.code !== 0) throw new Error(removed.stderr.trim() || `git worktree remove exited ${removed.code}`);
      await git(repo, ['worktree', 'prune']);
    },
    async deleteBranch(repo, branch) {
      const deleted = await git(repo, ['branch', '-D', branch]);
      if (deleted.code !== 0) throw new Error(deleted.stderr.trim() || `git branch -D exited ${deleted.code}`);
    },
  };
}
