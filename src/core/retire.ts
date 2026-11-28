// Retirement: a child asks to be retired, or its parent stops it, and the
// daemon cleans up after it. A child never removes its own worktree: a harness
// that starts each command in its working directory, as pi does, fails every
// command once that directory is gone (issue #143).
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
import { ChildBusyError, withChildLock } from './child-lock.ts';
import { departuresOf, dropDeparture } from './departures.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { bellwetherHome } from './paths.ts';
import { childOfCaller } from './report.ts';
import { listParents, readParent, updateChild } from './registry.ts';
import type { CallerIdentity, ChildRecord, FarWorktree, LeftWorktree, ParentRecord, RetireIntent } from './types.ts';

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
  /**
   * Whether the branch's work exists somewhere other than this worktree: its
   * tip is an ancestor of the default branch, every commit on it sits on a
   * remote branch, or a merged pull request has its tip as head.
   */
  safety(facts: { repo: string; worktree?: string; branch: string; defaultBranch?: string }): Promise<Safety>;
  /** Whether a directory exists at the path. */
  dirExists(dir: string): boolean;
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

/**
 * Whether the worktree a child asked to retire is the one it left on this
 * machine when it moved to another (issue #227). The child then runs
 * elsewhere, but the worktree and its proofs are here, where the daemon can
 * take them.
 */
function leftBehindHere(child: ChildRecord): boolean {
  const intent = child.retireIntent;
  // Only requestRetirementFromAfar sets movedAway, once it found the worktree
  // among the places the child left on this machine. A move after the request
  // changes those places, not the worktree the request named.
  return Boolean(intent?.movedAway && child.origin !== 'adopt' && intent.worktree);
}

/**
 * The directories the child left on this machine by a move, newest first
 * (issue #241). A record from before issue #227 names a place without a
 * directory, which no retirement can find.
 */
function leftHere(child: ChildRecord): string[] {
  return departuresOf(child)
    .filter((entry) => entry.host === LOCAL_HOST && entry.cwd)
    .map((entry) => entry.cwd as string)
    .reverse();
}

/**
 * The worktrees a child has on machines other than this one, which this
 * daemon cannot take a proof on: the one it runs in on another machine, then
 * each one it left on a machine other than this one. An adopted child has
 * none that Bellwether answers for.
 */
export function farWorktrees(child: ChildRecord, runsOn: string | undefined = hostOf(child) === LOCAL_HOST ? undefined : hostOf(child)): FarWorktree[] {
  if (child.origin === 'adopt') return [];
  return [
    ...(runsOn && child.cwd ? [{ host: runsOn, worktree: child.cwd, runs: true as const }] : []),
    ...departuresOf(child)
      .filter((entry) => entry.host !== LOCAL_HOST && entry.cwd)
      .map((entry) => ({ host: entry.host, worktree: entry.cwd as string })),
  ];
}

/** `a`, `a and b`, or `a, b and c`. */
function listed(items: string[]): string {
  return items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * One sentence on the worktrees this daemon cannot see, or '' when there are
 * none: the one the child runs in on another machine, and each one it left on
 * a machine other than this one. Each is named with its machine.
 */
function farTail(child: ChildRecord, parentId: string, runsOn?: string): string {
  const far = farWorktrees(child, runsOn).map((item) => (item.runs ? `your worktree on ${item.host}, ${item.worktree}` : `the one you left on ${item.host}, ${item.worktree}`));
  if (!far.length) return '';
  const list = listed(far);
  const them = far.length === 1 ? 'it' : 'each one';
  return ` ${list.charAt(0).toUpperCase()}${list.slice(1)} ${far.length === 1 ? 'stays' : 'stay'} in place: the daemon of parent ${parentId} cannot take a proof on another machine. Remove ${them} by hand on its machine once its work is safe.`;
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
  return recordRequest(parent.id, child, child.cwd as string, ops, reason, { left: leftHere(child), tail: farTail(child, parent.id) });
}

/**
 * The parent's side of a request that crossed from the machine a child runs
 * on, through that machine's relay outbox (issue #227). The daemon there holds
 * no registry for the child, so the request comes to the daemon that holds the
 * record. This daemon takes retirement's proofs only on its own machine, so
 * the worktree it retires is the one a child left here when it moved away.
 * Any other worktree sits where this daemon cannot look, and the request is
 * refused with nothing written.
 */
export async function requestRetirementFromAfar(parentId: string, childId: string, host: string, ops: RetireOps, reason?: string): Promise<string> {
  const parent = readParent(parentId);
  const child = parent?.children.find((entry) => entry.id === childId);
  if (!parent || !child) throw new RetireRefused(`no parent ${parentId} with child ${childId} on the parent's machine, so there is nothing to retire. Nothing was written.`);
  if (child.origin === 'adopt') throw new RetireRefused(`${outOfBounds(child)} Nothing was written.`);
  // Every place the child left counts, not only the last (issue #241).
  const here = departuresOf(child).filter((entry) => entry.host === LOCAL_HOST);
  const tail = farTail(child, parentId, host);
  if (!here.length) {
    const far = child.cwd ? `the worktree it works in, ${child.cwd}, is on ${host}` : `its record names no working directory`;
    throw new RetireRefused(`${child.name} runs on machine ${host}, and ${far}. The daemon of parent ${parentId} holds the record, but it takes retirement's proofs only on its own machine, so it cannot see that worktree and removes nothing. Nothing was written.${tail}${tail ? ' Then close' : ' Close'} your tab.`);
  }
  const [first, ...others] = leftHere(child);
  if (!first) throw new RetireRefused(`${child.name} moved to ${host} before Bellwether recorded where a moved child worked, so the daemon of parent ${parentId} cannot tell which worktree it left behind and removes nothing. Nothing was written. Remove the worktree you left on the parent's machine by hand once its work is safe.`);
  return recordRequest(parentId, child, first, ops, reason, { movedAway: host, lead: `The daemon of parent ${parentId} took your request, and retires the worktree you left on its machine when you moved away from it.`, tail, left: others });
}

/**
 * Run the checks a request can run while the child is alive, against `dir`,
 * write `retireRequestedAt` and the intent on the child record, and return
 * one line per check. It removes nothing.
 */
async function recordRequest(parentId: string, child: ChildRecord, dir: string, ops: RetireOps, reason: string | undefined, extra: { movedAway?: string; lead?: string; tail?: string; left?: string[] }): Promise<string> {
  const afar = extra.movedAway && extra.lead ? { movedAway: extra.movedAway, lead: extra.lead, tail: extra.tail ?? '' } : undefined;
  const yours = afar ? `The worktree you left behind, ${dir},` : `Your working directory ${dir}`;
  if (!ops.dirExists(dir)) {
    if (afar) throw new RetireRefused(`${yours} no longer exists on the parent's machine, so there is no worktree left to retire there. Nothing was written.${afar.tail}`);
    throw new RetireRefused(`Your working directory ${dir} no longer exists, so a harness that starts each command there fails every shell command, and there is no worktree left to retire. Call parent_report, which needs no shell, to tell your parent, and ask it to close you with agent_stop. Nothing was written.`);
  }
  const facts = await ops.inspect(dir);
  if ('error' in facts) throw new RetireRefused(`${dir} is not a git worktree Bellwether can retire: ${facts.error}. Nothing was written.${afar?.tail ?? ''}`);
  if (facts.main) throw new RetireRefused(`${mainRefusal(facts.worktree, facts.main)}${afar?.tail ?? ''}`);
  if (!facts.branch) throw new RetireRefused(`${facts.worktree} has no branch checked out (detached HEAD at ${facts.head.slice(0, 12)}), so Bellwether cannot tell whether its work is safe. Check out a branch, then ask again. Nothing was written.${afar?.tail ?? ''}`);

  const { passed, failing } = await workChecks(ops, { ...facts, branch: facts.branch });
  const others = liveChildrenIn(facts.worktree, child.id);
  (others.length ? failing : passed).push(others.length ? `${describeStanding(others)} in it, and the daemon never removes a directory a live child stands in` : 'no other live child stands in it');

  const earlier = await leftWorktrees(child, facts.worktree, extra.left ?? [], ops);
  const intent: RetireIntent = { worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}), ...(reason ? { reason } : {}), ...(afar ? { movedAway: afar.movedAway } : {}), ...(earlier.left.length ? { left: earlier.left } : {}) };
  const now = new Date().toISOString();
  updateChild(parentId, child.id, (entry) => {
    // A child resumed after an earlier retirement asks afresh.
    if (entry.retireOutcome) clearRetirement(entry);
    entry.retireRequestedAt ??= now;
    entry.retireIntent = intent;
    // A place whose directory is gone holds nothing to retire, so the list forgets it.
    for (const gone of earlier.gone) dropDeparture(entry, LOCAL_HOST, gone);
  });

  const lines = afar ? [afar.lead] : [];
  lines.push(`Retirement requested for ${child.name}: ${facts.worktree} on branch ${facts.branch}. Nothing has been removed.`);
  lines.push(`Passed now: ${passed.length ? passed.join('; ') : 'none'}.`);
  if (failing.length) lines.push(`Failing now: ${failing.join('; ')}. Fix these before you exit, or the daemon will refuse and leave everything in place.`);
  lines.push(...earlier.lines);
  lines.push('After your pane is gone, the daemon checks again that the pane and tab are gone, that the worktree is not a main worktree, is clean and has no stash, that the work is safe, and that no process works inside it. Only then does it remove the worktree and delete the branch.');
  if (extra.tail) lines.push(extra.tail.trim());
  if (afar) {
    lines.push('Close your tab to finish.');
  } else {
    lines.push('Leave the worktree in place: you stand in it, and your harness needs it for every command until your tab closes. Close your tab to finish.');
  }
  return lines.join('\n');
}

/**
 * The checks a request runs on each other worktree the child left on this
 * machine by an earlier move (issue #241), with one line per worktree for the
 * child. A directory that no longer exists goes into `gone`, so its place
 * leaves the list. One that Bellwether cannot retire stays, and its line says
 * why.
 */
async function leftWorktrees(child: ChildRecord, first: string, dirs: string[], ops: RetireOps): Promise<{ left: LeftWorktree[]; lines: string[]; gone: string[] }> {
  const left: LeftWorktree[] = [];
  const lines: string[] = [];
  const gone: string[] = [];
  const taken = new Set([path.resolve(first)]);
  for (const dir of dirs) {
    if ([...taken].some((root) => inside(path.resolve(dir), root))) continue;
    if (!ops.dirExists(dir)) {
      gone.push(dir);
      lines.push(`You also left ${dir} on the parent's machine, and it no longer exists, so nothing is left to retire there.`);
      continue;
    }
    const facts = await ops.inspect(dir);
    const stays = `You also left ${dir} on the parent's machine, and it stays in place`;
    if ('error' in facts) {
      lines.push(`${stays}: it is not a git worktree Bellwether can retire (${facts.error}).`);
      continue;
    }
    if (facts.main) {
      lines.push(`${stays}: it is the repository's main worktree (${facts.main}), and Bellwether never removes one.`);
      continue;
    }
    if (!facts.branch) {
      lines.push(`${stays}: it has no branch checked out, so Bellwether cannot tell whether its work is safe.`);
      continue;
    }
    if (taken.has(path.resolve(facts.worktree))) continue;
    taken.add(path.resolve(facts.worktree));
    const { passed, failing } = await workChecks(ops, { ...facts, branch: facts.branch });
    const others = liveChildrenIn(facts.worktree, child.id);
    (others.length ? failing : passed).push(others.length ? `${describeStanding(others)} in it` : 'no other live child stands in it');
    left.push({ worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}) });
    lines.push(`It also retires ${facts.worktree} on branch ${facts.branch}, which you left on the parent's machine by an earlier move. Passed now: ${passed.length ? passed.join('; ') : 'none'}.${failing.length ? ` Failing now: ${failing.join('; ')}, so the daemon will leave it in place unless that changes.` : ''}`);
  }
  return { left, lines, gone };
}

/**
 * Whether a worktree's work exists anywhere but in it: the worktree is clean,
 * its branch has no stash, and the branch is merged, pushed, or the head of a
 * merged pull request. Retirement asks this before it removes a worktree, and
 * a move asks it before it leaves one behind (issue #224), so both judge a
 * worktree the same way.
 */
export async function workChecks(ops: Pick<RetireOps, 'dirty' | 'stashes' | 'safety'>, facts: WorktreeFacts & { branch: string }): Promise<{ passed: string[]; failing: string[] }> {
  const passed: string[] = [];
  const failing: string[] = [];
  const dirty = await ops.dirty(facts.worktree);
  (dirty.length ? failing : passed).push(dirty.length ? `the worktree has ${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}` : 'the worktree is clean');
  const stashes = await ops.stashes(facts.repo, facts.branch);
  (stashes.length ? failing : passed).push(stashes.length ? `${stashes.length} stash entr${stashes.length === 1 ? 'y' : 'ies'} on ${facts.branch}` : 'no stash on the branch');
  const safety = await ops.safety({ repo: facts.repo, worktree: facts.worktree, branch: facts.branch, defaultBranch: facts.defaultBranch });
  (safety.safe ? passed : failing).push(safety.how);
  return { passed, failing };
}

/** Whether retirement removed the worktree the intent names, whatever else stayed in place. */
export function retiredItsWorktree(child: ChildRecord): boolean {
  return child.retireOutcome === 'removed' || child.retireOutcome === 'partial';
}

/** Drop every retirement field, for a child that is brought back. */
export function clearRetirement(child: ChildRecord): void {
  delete child.retireRequestedAt;
  delete child.retireIntent;
  delete child.retireStage;
  delete child.retiredAt;
  delete child.retireOutcome;
  delete child.retireReason;
  delete child.retireProof;
}

/** The intent records the parent's stop as its reason, where a child gives its own words. */
export const STOP_REASON = 'agent_stop by the parent';

/**
 * The one line that says a local child's working directory is gone, or
 * undefined while it exists or once retirement removed it.
 */
export function goneCwdLine(child: ChildRecord, ops: Pick<RetireOps, 'dirExists'>): string | undefined {
  if (!child.cwd || hostOf(child) !== LOCAL_HOST || retiredItsWorktree(child)) return undefined;
  if (ops.dirExists(child.cwd)) return undefined;
  const effect = child.exitedAt ? 'A resume has nowhere to start it.' : "A harness that starts each command there, as pi does, now fails every shell command; the child's Bellwether tools still work, so it can still call parent_report, and agent_stop still closes it.";
  return `${child.name}'s working directory ${child.cwd} no longer exists. ${effect}`;
}

/** What retirement did, or will do, with a child's worktree, in one line; undefined when it has nothing to say. */
export function retireLine(child: ChildRecord): string | undefined {
  const intent = child.retireIntent;
  if (!intent) return undefined;
  const plain = (reason: string): string => reason.replace(/^condition \d \([^)]*\): /, '').replace(/^out of bounds: /, '');
  const left = intent.left ?? [];
  if (child.retireOutcome) {
    // Each worktree the child left here by an earlier move has its own outcome (issue #241).
    const earlier = left.map((item) =>
      item.outcome === 'removed' ? ` Also removed worktree ${item.worktree} and branch ${item.branch}, which it left on this machine by an earlier move.` : item.outcome === 'refused' ? ` Left worktree ${item.worktree}, which it left on this machine by an earlier move, in place, because ${plain(item.refusal ?? '')}` : '',
    );
    const removed = `removed worktree ${intent.worktree} and branch ${intent.branch}${child.retireProof ? `, because ${child.retireProof}` : ''}.${earlier.join('')}`;
    if (child.retireOutcome === 'removed') return `Retired: ${removed}`;
    if (child.retireOutcome === 'partial') return `Retired in part: ${removed}${intent.far?.length ? ` ${farLine(intent.far)}` : ''}`;
    const unproved = child.retireReason?.startsWith('condition 3');
    return `Retirement left worktree ${intent.worktree} and branch ${intent.branch} in place, because ${unproved ? 'Bellwether could not prove the work merged: ' : ''}${plain(child.retireReason ?? '')}${earlier.join('')}`;
  }
  const also = left.length ? `, and the worktree${left.length === 1 ? '' : 's'} it left on this machine by an earlier move, ${left.map((item) => item.worktree).join(', ')},` : '';
  if (child.retireRequestedAt) return `Retirement pending: Bellwether removes worktree ${intent.worktree} and branch ${intent.branch}${also} once herdr no longer lists the pane, if it can still prove the work merged. agent_list and retire.log show the outcome.`;
  return undefined;
}

/**
 * A parent's agent_stop retires the child it closes. This records the intent
 * before the tab closes, as request_retirement would, and returns the line to
 * give the parent when there is nothing for the cleanup to do: a working
 * directory that is gone, not a git worktree, a main worktree, or out of
 * bounds. A child that already asked keeps its own request.
 *
 * A child on another machine that moved away from this one left worktrees
 * here, and the stop retires them as the child's own request does
 * (issue #243): the record, the worktrees and their proofs are all on this
 * machine. The worktree it runs in there is not this daemon's to judge.
 */
export async function retireOnStop(parentId: string, child: ChildRecord, ops: RetireOps): Promise<string | undefined> {
  if (retirementPending(child) || child.origin === 'adopt') return undefined;
  const runsHere = hostOf(child) === LOCAL_HOST;
  const here = leftHere(child);
  if (runsHere && !child.cwd) return undefined;
  const [dir, ...others] = runsHere ? [child.cwd as string, ...here] : here;
  if (!dir) return undefined;
  const subject = runsHere ? `Its working directory ${dir}` : `The worktree ${child.name} left on this machine when it moved away, ${dir},`;
  if (!ops.dirExists(dir)) return runsHere ? `${child.name}'s working directory ${dir} no longer exists, so retirement had no worktree left to remove.` : `${subject} no longer exists, so retirement had nothing left to remove here.`;
  const facts = await ops.inspect(dir);
  if ('error' in facts) return `${subject} is not a git worktree, so retirement leaves it in place.`;
  if (facts.main) return `Retirement leaves ${facts.worktree} in place: it is the repository's main worktree (${facts.main}), and Bellwether never removes a main worktree.`;
  if (!facts.branch) return `Retirement leaves ${facts.worktree} in place: it has a detached HEAD at ${facts.head.slice(0, 12)}, so Bellwether cannot tell whether its work merged.`;
  const earlier = await leftWorktrees(child, facts.worktree, others, ops);
  const intent: RetireIntent = { worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}), reason: STOP_REASON, ...(runsHere ? {} : { movedAway: hostOf(child) }), ...(earlier.left.length ? { left: earlier.left } : {}) };
  const now = new Date().toISOString();
  updateChild(parentId, child.id, (entry) => {
    if (entry.retireOutcome) clearRetirement(entry);
    entry.retireRequestedAt = now;
    entry.retireIntent = intent;
    for (const gone of earlier.gone) dropDeparture(entry, LOCAL_HOST, gone);
  });
  return undefined;
}

/**
 * One sentence for the parent on the worktrees a stopped child has on other
 * machines, or undefined when it has none: the one it runs in, and each one it
 * left on a machine other than this one. This daemon cannot take a proof there.
 * A partial outcome already names them, from the record, so it gets none.
 */
export function farWorktreesLine(child: ChildRecord): string | undefined {
  if (child.retireOutcome === 'partial') return undefined;
  return farLine(farWorktrees(child));
}

/** The sentence that names worktrees on other machines, which stay in place. */
function farLine(far: FarWorktree[]): string | undefined {
  if (!far.length) return undefined;
  const list = listed(far.map((item) => `${item.worktree} on ${item.host}, ${item.runs ? 'where it ran' : 'which it left by a move'}`));
  return `Its worktree${far.length === 1 ? '' : 's'} ${list} ${far.length === 1 ? 'stays' : 'stay'} in place, because this daemon cannot take retirement's proofs on another machine. Remove ${far.length === 1 ? 'it' : 'each one'} by hand there once its work is safe.`;
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

export type ReapResult = { outcome: 'removed' } | { outcome: 'partial' | 'refused'; reason: string } | { outcome: 'pending'; reason: string } | { outcome: 'skipped' };

/**
 * The daemon's cleanup for one child that asked to be retired. It runs after
 * the watcher marks the child exited, and again when a daemon starts, so an
 * unfinished retirement finishes. A child still alive is left alone.
 */
export async function reapChild(parentId: string, childId: string, deps: ReapDeps): Promise<ReapResult> {
  const log = deps.log ?? (() => {});
  const first = readParent(parentId)?.children.find((entry) => entry.id === childId);
  if (!first || !retirementPending(first) || !first.exitedAt) return { outcome: 'skipped' };
  // A resume, a restart and a move hold the child's lock while they bring the
  // child back, so a reap that holds it never removes a worktree under a
  // child that came back between its checks and its removal (issue #211).
  try {
    return await withChildLock(childId, `${first.name} (child ${childId})`, `retirement of ${first.name}`, () => reapLocked(parentId, childId, deps, log), undefined, undefined, { action: 'retired' });
  } catch (error) {
    if (!(error instanceof ChildBusyError)) throw error;
    const reason = `another call holds ${first.name} (${error.holder.purpose}); the retirement waits for the next exit event or daemon start`;
    log(`retire ${first.name}: ${reason}`);
    return { outcome: 'pending', reason };
  }
}

/** The child, as saved now, when it still asks to be retired and has exited. */
function stillExited(parentId: string, childId: string): ChildRecord | undefined {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  return child && retirementPending(child) && child.exitedAt ? child : undefined;
}

async function reapLocked(parentId: string, childId: string, deps: ReapDeps, log: (message: string) => void): Promise<ReapResult> {
  // Read under the lock: a caller that held it before this one may have brought the child back.
  const child = stillExited(parentId, childId);
  if (!child) return { outcome: 'skipped' };

  const refuse = (reason: string): ReapResult => {
    finish(parentId, child, 'refused', reason);
    log(`retire ${child.name}: refused: ${reason}`);
    return { outcome: 'refused', reason };
  };

  const bounds = leftBehindHere(child) ? undefined : outOfBounds(child);
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

  // 2 to 6 for the worktree the request named, then for each other worktree
  // the child left on this machine by an earlier move (issue #241). The
  // outcome on the record comes last, so a daemon that stops part of the way
  // through finds the retirement still pending and finishes it.
  const first = await retireWorktree(parentId, child, { ...intent, ...(child.retireStage ? { stage: child.retireStage } : {}) }, deps, (entry, stage) => {
    entry.retireStage = stage;
  });
  if (first.outcome === 'skipped') {
    log(`retire ${child.name}: the child came back while the retirement checked ${intent.worktree}, so it stays`);
    return { outcome: 'skipped' };
  }
  const refusals: string[] = [];
  for (const left of intent.left ?? []) {
    if (left.outcome) {
      if (left.outcome === 'refused') refusals.push(`${left.worktree}: ${left.refusal ?? 'refused'}`);
      continue;
    }
    const at = (entry: ChildRecord): LeftWorktree | undefined => entry.retireIntent?.left?.find((item) => item.worktree === left.worktree);
    const result = await retireWorktree(parentId, child, left, deps, (entry, stage) => {
      const item = at(entry);
      if (item) item.stage = stage;
    });
    if (result.outcome === 'skipped') {
      log(`retire ${child.name}: the child came back while the retirement checked ${left.worktree}, so it stays`);
      return { outcome: 'skipped' };
    }
    updateChild(parentId, child.id, (entry) => {
      const item = at(entry);
      if (!item) return;
      item.outcome = result.outcome;
      if (result.outcome === 'refused') item.refusal = result.reason;
      else if (result.proof) item.proof = result.proof;
      if (result.outcome === 'removed') dropDeparture(entry, LOCAL_HOST, left.worktree);
    });
    appendRetireLog({ parent: parentId, child: child.id, name: child.name, outcome: result.outcome, worktree: left.worktree, branch: left.branch, left: true, ...(result.outcome === 'refused' ? { reason: result.reason } : result.proof ? { proof: result.proof } : {}) });
    if (result.outcome === 'refused') {
      refusals.push(`${left.worktree}: ${result.reason}`);
      log(`retire ${child.name}: left ${left.worktree} in place: ${result.reason}`);
    } else {
      log(`retire ${child.name}: removed ${left.worktree} and branch ${left.branch}, which it left here by an earlier move${result.proof ? `, because ${result.proof}` : ''}`);
    }
  }
  if (first.outcome === 'refused') return refuse(first.reason);
  let far: FarWorktree[] = [];
  updateChild(parentId, child.id, (entry) => {
    if (intent.movedAway) dropDeparture(entry, LOCAL_HOST, intent.worktree);
    // Read from the record as it stands now: each worktree it names on another
    // machine stays, because this daemon cannot take a proof there (issue #273).
    far = farWorktrees(entry);
    if (far.length && entry.retireIntent) entry.retireIntent.far = far;
  });
  const stays = [...refusals, ...far.map((item) => `${item.worktree} on ${item.host}, where this daemon cannot take a proof`)];
  // The record says removed only when nothing it knows of stays in place.
  const reason = stays.length ? `removed ${intent.worktree}, and left in place ${stays.join('; ')}` : undefined;
  finish(parentId, child, stays.length ? 'partial' : 'removed', reason, first.proof, far.length ? { stays: far } : {});
  log(`retire ${child.name}: removed ${intent.worktree} and branch ${intent.branch}${first.proof ? `, because ${first.proof}` : ''}${reason ? `; left in place ${stays.join('; ')}` : ''}`);
  return reason ? { outcome: 'partial', reason } : { outcome: 'removed' };
}

type WorktreeTarget = Pick<LeftWorktree, 'worktree' | 'repo' | 'branch' | 'defaultBranch' | 'stage'>;
type WorktreeResult = { outcome: 'removed'; proof?: string } | { outcome: 'refused'; reason: string } | { outcome: 'skipped' };

/**
 * Conditions 2 to 6 for one worktree on this machine: not a main worktree,
 * clean, no stash, its work safe, nobody inside, then the removal and its
 * check. `setStage` writes each stage on the record as it completes, so a
 * restart skips what is done.
 */
async function retireWorktree(parentId: string, child: ChildRecord, intent: WorktreeTarget, deps: ReapDeps, setStage: (entry: ChildRecord, stage: 'worktree-removed' | 'branch-deleted') => void): Promise<WorktreeResult> {
  const refuse = (reason: string): WorktreeResult => ({ outcome: 'refused', reason });
  const { ops } = deps;
  const worktreeDone = intent.stage === 'worktree-removed' || intent.stage === 'branch-deleted' || !(await ops.worktreeExists(intent.repo, intent.worktree));
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
  let proof: string | undefined;
  const branchLeft = intent.stage !== 'branch-deleted' && (await ops.branchExists(intent.repo, intent.branch));
  if (branchLeft) {
    const safety = await ops.safety({ repo: intent.repo, worktree: worktreeDone ? undefined : intent.worktree, branch: intent.branch, defaultBranch: intent.defaultBranch });
    if (!safety.safe) return refuse(`condition 3 (work is safe): ${safety.how}. Push the branch or merge it, then remove the worktree and the branch by hand.`);
    proof = safety.how;
  }

  // 4. No live child stands inside the path, and no process works there. The
  // registry is read first: a live child's working directory is protected the
  // way a lock is, whatever the process table shows at this moment (issue #189).
  if (!worktreeDone) {
    const standing = liveChildrenIn(intent.worktree, child.id);
    if (standing.length) return refuse(`condition 4 (no live child inside): ${describeStanding(standing)} in ${intent.worktree}, and removing it would leave that child with no directory for its commands. Remove the worktree by hand once that child exits.`);
  }
  // A shell can take a moment to leave after its pane exits, so look a few
  // times before refusing.
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

  // 5. Read the record again after the awaits above. A writer that skips the
  // lock may have brought the child back, and its record then keeps no
  // outcome from this pass.
  if (!stillExited(parentId, child.id)) return { outcome: 'skipped' };

  // 6. Remove, delete, verify. Each stage is written as it completes, so a
  // restart skips what is done.
  try {
    if (!worktreeDone) {
      await ops.removeWorktree(intent.repo, intent.worktree);
      updateChild(parentId, child.id, (entry) => setStage(entry, 'worktree-removed'));
    }
    if (branchLeft) await ops.deleteBranch(intent.repo, intent.branch);
    updateChild(parentId, child.id, (entry) => setStage(entry, 'branch-deleted'));
  } catch (error) {
    return refuse(`condition 5 (removal): git refused: ${(error as Error).message.trim()}. Look at ${intent.worktree} and branch ${intent.branch} by hand.`);
  }
  const pathLeft = (await ops.worktreeExists(intent.repo, intent.worktree)) || fs.existsSync(intent.worktree);
  const branchStill = await ops.branchExists(intent.repo, intent.branch);
  if (pathLeft || branchStill) {
    return refuse(`condition 5 (verify): after removal ${[pathLeft ? `${intent.worktree} still exists` : '', branchStill ? `branch ${intent.branch} still exists` : ''].filter(Boolean).join(' and ')}. Remove what is left by hand.`);
  }
  return { outcome: 'removed', ...(proof ? { proof } : {}) };
}

/**
 * Every live child on this machine, under any parent, whose working directory
 * is `dir` or sits inside it, other than `except`. A child that has not exited
 * stands in its directory, and its harness starts each command there.
 */
export function liveChildrenIn(dir: string, except: string): { parent: ParentRecord; child: ChildRecord }[] {
  const root = realpath(dir);
  return listParents().flatMap((parent) =>
    parent.children.filter((entry) => entry.id !== except && !entry.exitedAt && hostOf(entry) === LOCAL_HOST && entry.cwd && inside(realpath(entry.cwd), root)).map((entry) => ({ parent, child: entry })),
  );
}

/** The live children standing in a directory, by name, id, pane and parent session, for a refusal. */
function describeStanding(standing: { parent: ParentRecord; child: ChildRecord }[]): string {
  const names = standing.map(({ parent, child }) => `${child.name} (child ${child.id} in pane ${child.paneId}, of the ${parent.harness} session ${parent.session})${child.cwd ? ` at ${child.cwd}` : ''}`);
  return `live child${standing.length === 1 ? '' : 'ren'} ${names.join(', ')} still ${standing.length === 1 ? 'stands' : 'stand'}`;
}

/** Record the outcome on the child record first, then append the log line. */
function finish(parentId: string, child: ChildRecord, outcome: 'removed' | 'partial' | 'refused', reason?: string, proof?: string, extra: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  updateChild(parentId, child.id, (entry) => {
    entry.retiredAt = at;
    entry.retireOutcome = outcome;
    if (reason) entry.retireReason = reason;
    else delete entry.retireReason;
    if (proof) entry.retireProof = proof;
    else delete entry.retireProof;
  });
  appendRetireLog({ at, parent: parentId, child: child.id, name: child.name, outcome, worktree: child.retireIntent?.worktree, branch: child.retireIntent?.branch, ...(reason ? { reason } : {}), ...(proof ? { proof } : {}), ...extra });
}

/** One line in retire.log. A line with `left` is about a worktree the child left here by an earlier move (issue #241). */
function appendRetireLog(line: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(retireLogPath()), { recursive: true });
  fs.appendFileSync(retireLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
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
      // Proof 1: the default branch contains the tip.
      const base = defaultBranch ?? (await defaultBranchOf(repo));
      if (base) {
        const ancestor = await git(repo, ['merge-base', '--is-ancestor', sha, base]);
        if (ancestor.code === 0) return { safe: true, how: `branch ${branch} is merged into ${base}` };
      }
      // Proof 2: every commit on the branch sits on a remote branch, as the last fetch saw it.
      const counted = await git(repo, ['rev-list', '--count', sha, '--not', '--remotes']);
      const unpushed = counted.code === 0 ? Number(counted.stdout.trim()) : Number.NaN;
      if (unpushed === 0) return { safe: true, how: `every commit on branch ${branch} is on a remote branch` };
      const offRemote = Number.isNaN(unpushed) ? `git could not count the commits of branch ${branch} that sit on no remote` : `branch ${branch} has ${unpushed} commit(s) on no remote`;
      // Proof 3: a merged pull request whose head is the tip, as a squash merge leaves it.
      const pr = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid', '--limit', '20'], worktree && fs.existsSync(worktree) ? worktree : repo);
      if (pr.code !== 0) return { safe: false, how: `${offRemote}, is not merged into ${base ?? 'a default branch'}, and gh could not list its pull requests (${(pr.stderr || pr.stdout).trim().split('\n')[0]})` };
      let prs: { number: number; state: string; headRefOid: string }[] = [];
      try {
        prs = JSON.parse(pr.stdout) as typeof prs;
      } catch {
        prs = [];
      }
      const pushed = prs.filter((entry) => entry.headRefOid === sha);
      const merged = pushed.find((entry) => entry.state === 'MERGED');
      if (merged) return { safe: true, how: `branch ${branch} is pushed and pull request #${merged.number} is merged` };
      const open = pushed.find((entry) => entry.state === 'OPEN');
      if (open) return { safe: false, how: `${offRemote}, and pull request #${open.number} is still open` };
      const closed = pushed.find((entry) => entry.state === 'CLOSED');
      if (closed) return { safe: false, how: `${offRemote}, and pull request #${closed.number} was closed without merging` };
      return { safe: false, how: `${offRemote}, is not merged into ${base ?? 'a default branch'}, and no merged pull request has its tip ${sha.slice(0, 12)}, so its work may exist nowhere else` };
    },
    dirExists(dir) {
      return fs.existsSync(dir);
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
