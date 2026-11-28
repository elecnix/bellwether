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
import { refusal } from './authority.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChildBusyError, withChildLock } from './child-lock.ts';
import { departuresOf, dropDeparture } from './departures.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { bellwetherHome } from './paths.ts';
import { RelayAnswerLost } from './relay-answer.ts';
import { listRelayRecords } from './relay-records.ts';
import { childOfCaller } from './report.ts';
import { listParents, readParent, updateChild } from './registry.ts';
import type { InFlight } from './requests.ts';
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
  // Whether this parent may retire the child at all is authority's to answer (issue #279).
  const refused = refusal(child, 'retire');
  if (refused) return refused;
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
  return Boolean(intent?.movedAway && !refusal(child, 'retire') && intent.worktree);
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
 * The worktrees a child has on machines other than this one: the one it runs
 * in there, then each one it left on another machine by a move. The daemon on
 * each machine retires them on this daemon's request (issue #242). A child held
 * by adoption has none that Bellwether answers for.
 */
export function farWorktrees(child: ChildRecord): FarWorktree[] {
  if (refusal(child, 'retire')) return [];
  const found: FarWorktree[] = [];
  const add = (host: string, worktree: string | undefined, runs: boolean): void => {
    if (!worktree || host === LOCAL_HOST || found.some((entry) => entry.host === host && path.resolve(entry.worktree) === path.resolve(worktree))) return;
    found.push({ host, worktree, ...(runs ? { runs: true as const } : {}) });
  };
  add(hostOf(child), child.cwd, true);
  for (const entry of departuresOf(child)) add(entry.host, entry.cwd, false);
  return found;
}

/** A list of far worktrees in words, each with its machine. */
function farList(far: readonly FarWorktree[]): string {
  const items = far.map((entry) => `${entry.worktree} on ${entry.host}`);
  return items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Whom this daemon asks to retire the far worktrees, and which: one machine by name, or each. */
function farAsk(far: readonly FarWorktree[]): string {
  const hosts = new Set(far.map((entry) => entry.host));
  return hosts.size === 1 ? `the daemon on ${far[0]?.host} to retire ${far.map((entry) => entry.worktree).join(' and ')} there` : `the daemon on each machine to retire ${farList(far)} there`;
}

/**
 * One sentence for the child on the worktrees it has on other machines, or ''
 * when it has none. This daemon cannot take a proof there, so it asks the
 * daemon on each machine to take them once the child's pane is gone.
 */
function farTail(far: readonly FarWorktree[], parentId: string): string {
  if (!far.length) return '';
  return ` Once your pane is gone, the daemon of parent ${parentId} also asks ${farAsk(far)}, after the same checks on that machine. A machine that cannot answer keeps its worktree, and the record says so.`;
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
  const far = farWorktrees(child);
  return recordRequest(parent.id, child, child.cwd as string, ops, reason, { left: leftHere(child), tail: farTail(far, parent.id), far });
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
  const refused = refusal(child, 'retire');
  if (refused) throw new RetireRefused(`${refused} Nothing was written.`);
  // Every place the child left counts, not only the last (issue #241).
  const here = departuresOf(child).filter((entry) => entry.host === LOCAL_HOST);
  const far = farWorktrees(child);
  const tail = farTail(far, parentId);
  if (!here.length) {
    // Every worktree it has sits on another machine, whose daemon takes the proofs there (issue #242).
    if (!far.length) throw new RetireRefused(`${child.name} runs on machine ${host}, and its record names no working directory, so there is no worktree to retire. Nothing was written. Close your tab.`);
    return recordFarRequest(parentId, child, reason, far);
  }
  const [first, ...others] = leftHere(child);
  if (!first) throw new RetireRefused(`${child.name} moved to ${host} before Bellwether recorded where a moved child worked, so the daemon of parent ${parentId} cannot tell which worktree it left behind and removes nothing. Nothing was written. Remove the worktree you left on the parent's machine by hand once its work is safe.`);
  return recordRequest(parentId, child, first, ops, reason, { movedAway: host, lead: `The daemon of parent ${parentId} took your request, and retires the worktree you left on its machine when you moved away from it.`, tail, left: others, far });
}

/**
 * Write the intent of a child whose every worktree sits on another machine
 * (issue #242). This daemon takes no proof there, so the answer says which
 * daemon will, and when. Nothing is removed now.
 */
function recordFarRequest(parentId: string, child: ChildRecord, reason: string | undefined, far: FarWorktree[]): string {
  writeIntent(parentId, child.id, { ...(reason ? { reason } : {}), far });
  return [
    `The daemon of parent ${parentId} took your request. Retirement requested for ${child.name}: ${farList(far)}. Nothing has been removed.`,
    `Once your pane is gone, that daemon asks ${farAsk(far)}. The daemon there removes a worktree only when it is not a main worktree, is clean and has no stash, its work is safe, and no process or live child works inside it. A machine that cannot answer keeps its worktree, and the record says so.`,
    'Close your tab to finish.',
  ].join('\n');
}

/**
 * The intent as it goes on the record: every worktree the child has on
 * another machine is part of it, whichever path asked (issue #273). A path
 * that leaves `far` out cannot produce a retirement that claims a removal
 * while a far worktree stays, because this module is the intent's only writer
 * and `conclude` reads `far` before it says `removed`.
 */
export function intentFor(child: ChildRecord, intent: RetireIntent): RetireIntent {
  if (intent.far) return intent;
  const far = farWorktrees(child);
  return far.length ? { ...intent, far } : intent;
}

/** Write a fresh intent on the child record, clearing an earlier retirement's outcome. */
function writeIntent(parentId: string, childId: string, intent: RetireIntent, gone: string[] = []): void {
  const now = new Date().toISOString();
  updateChild(parentId, childId, (entry) => {
    // A child resumed after an earlier retirement asks afresh.
    if (entry.retireOutcome) clearRetirement(entry);
    writableRetirement(entry).retireRequestedAt ??= now;
    writableRetirement(entry).retireIntent = intentFor(entry, intent);
    // A place whose directory is gone holds nothing to retire, so the list forgets it.
    for (const dir of gone) dropDeparture(entry, LOCAL_HOST, dir);
  });
}

/**
 * Run the checks a request can run while the child is alive, against `dir`,
 * write `retireRequestedAt` and the intent on the child record, and return
 * one line per check. It removes nothing.
 */
async function recordRequest(parentId: string, child: ChildRecord, dir: string, ops: RetireOps, reason: string | undefined, extra: { movedAway?: string; lead?: string; tail?: string; left?: string[]; far?: FarWorktree[] }): Promise<string> {
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
  const intent: RetireIntent = { worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}), ...(reason ? { reason } : {}), ...(afar ? { movedAway: afar.movedAway } : {}), ...(earlier.left.length ? { left: earlier.left } : {}), ...(extra.far?.length ? { far: extra.far } : {}) };
  writeIntent(parentId, child.id, intent, earlier.gone);

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

/** The fields this module owns, which the ownership gate reads (step 5 of docs/design-matrix.md). */
export const RETIREMENT_FIELDS = ['retireRequestedAt', 'retireIntent', 'retireStage', 'retiredAt', 'retireOutcome', 'retireReason', 'retireProof'] as const;
type RetirementField = (typeof RETIREMENT_FIELDS)[number];

/** The record as this module alone may write it. */
function writableRetirement(child: ChildRecord): { -readonly [K in RetirementField]: ChildRecord[K] } {
  return child as { -readonly [K in RetirementField]: ChildRecord[K] };
}

/**
 * Keep on a record the request a child made before a crossing that failed: the
 * resume that rolled it back cleared it, and a child that never left keeps
 * its own (issue #226).
 */
export function keepRetirement(child: ChildRecord, original: Pick<ChildRecord, 'retireRequestedAt' | 'retireIntent'>): void {
  const entry = writableRetirement(child);
  if (original.retireRequestedAt) entry.retireRequestedAt = original.retireRequestedAt;
  if (original.retireIntent) entry.retireIntent = original.retireIntent;
}

/** Drop every retirement field, for a child that is brought back. */
export function clearRetirement(record: ChildRecord): void {
  const child = writableRetirement(record);
  delete child.retireRequestedAt;
  delete child.retireIntent;
  delete child.retireStage;
  delete child.retiredAt;
  delete child.retireOutcome;
  delete child.retireReason;
  delete child.retireProof;
}

/** Whether retirement removed the worktree the intent names, whatever else stayed in place. */
export function retiredItsWorktree(child: ChildRecord): boolean {
  return child.retireOutcome === 'removed' || child.retireOutcome === 'partial';
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
  const far = intent.far ?? [];
  // Each worktree on another machine has its own outcome, from the daemon there (issue #242).
  const farDone = far.map((item) =>
    item.outcome === 'removed'
      ? ` On ${item.host}, the daemon there removed worktree ${item.root ?? item.worktree}${item.branch ? ` and branch ${item.branch}` : ''}${item.proof ? `, because ${item.proof}` : ''}.`
      : item.outcome === 'refused'
        ? ` ${item.refusal ?? `${item.worktree} on ${item.host} stays in place.`}`
        : item.outcome === 'gone'
          ? ` ${item.worktree} on ${item.host} no longer existed, so nothing was left to retire there.`
          : ` Retirement of ${item.worktree} on ${item.host} waits for the answer of the daemon there.`,
  );
  if (!intent.worktree) {
    if (!child.retireOutcome && !child.retireRequestedAt) return undefined;
    if (!child.retireOutcome && far.every((item) => !item.outcome && !item.requestId)) return `Retirement pending: once herdr no longer lists the pane, Bellwether asks ${farAsk(far)}, if it can prove the work merged. agent_list and retire.log show the outcome.`;
    return `${child.retireOutcome === 'removed' ? 'Retired:' : child.retireOutcome === 'partial' ? 'Retired in part:' : 'Retirement left each worktree in place:'}${farDone.join('')}`;
  }
  if (child.retireOutcome) {
    // Each worktree the child left here by an earlier move has its own outcome (issue #241).
    const earlier = left.map((item) =>
      item.outcome === 'removed' ? ` Also removed worktree ${item.worktree} and branch ${item.branch}, which it left on this machine by an earlier move.` : item.outcome === 'refused' ? ` Left worktree ${item.worktree}, which it left on this machine by an earlier move, in place, because ${plain(item.refusal ?? '')}` : '',
    );
    const removed = `removed worktree ${intent.worktree} and branch ${intent.branch}${child.retireProof ? `, because ${child.retireProof}` : ''}.${earlier.join('')}${farDone.join('')}`;
    if (child.retireOutcome === 'removed') return `Retired: ${removed}`;
    if (child.retireOutcome === 'partial') return `Retired in part: ${removed}`;
    const unproved = child.retireReason?.startsWith('condition 3');
    return `Retirement left worktree ${intent.worktree} and branch ${intent.branch} in place, because ${unproved ? 'Bellwether could not prove the work merged: ' : ''}${plain(child.retireReason ?? '')}${earlier.join('')}${farDone.join('')}`;
  }
  const also = left.length ? `, and the worktree${left.length === 1 ? '' : 's'} it left on this machine by an earlier move, ${left.map((item) => item.worktree).join(', ')},` : '';
  const there = far.length ? ` It then asks ${farAsk(far)}, after the same checks.` : '';
  if (child.retireRequestedAt) return `Retirement pending: Bellwether removes worktree ${intent.worktree} and branch ${intent.branch}${also} once herdr no longer lists the pane, if it can still prove the work merged.${there} agent_list and retire.log show the outcome.`;
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
  if (retirementPending(child) || refusal(child, 'retire')) return undefined;
  const runsHere = hostOf(child) === LOCAL_HOST;
  const here = leftHere(child);
  if (runsHere && !child.cwd) return undefined;
  const [dir, ...others] = runsHere ? [child.cwd as string, ...here] : here;
  const far = farWorktrees(child);
  if (!dir) {
    // Every worktree sits on another machine, whose daemon retires it on this one's request (issue #242).
    if (far.length) writeIntent(parentId, child.id, { reason: STOP_REASON, far });
    return undefined;
  }
  const subject = runsHere ? `Its working directory ${dir}` : `The worktree ${child.name} left on this machine when it moved away, ${dir},`;
  if (!ops.dirExists(dir)) return runsHere ? `${child.name}'s working directory ${dir} no longer exists, so retirement had no worktree left to remove.` : `${subject} no longer exists, so retirement had nothing left to remove here.`;
  const facts = await ops.inspect(dir);
  if ('error' in facts) return `${subject} is not a git worktree, so retirement leaves it in place.`;
  if (facts.main) return `Retirement leaves ${facts.worktree} in place: it is the repository's main worktree (${facts.main}), and Bellwether never removes a main worktree.`;
  if (!facts.branch) return `Retirement leaves ${facts.worktree} in place: it has a detached HEAD at ${facts.head.slice(0, 12)}, so Bellwether cannot tell whether its work merged.`;
  const earlier = await leftWorktrees(child, facts.worktree, others, ops);
  const intent: RetireIntent = { worktree: facts.worktree, repo: facts.repo, branch: facts.branch, head: facts.head, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}), reason: STOP_REASON, ...(runsHere ? {} : { movedAway: hostOf(child) }), ...(earlier.left.length ? { left: earlier.left } : {}), ...(far.length ? { far } : {}) };
  writeIntent(parentId, child.id, intent, earlier.gone);
  return undefined;
}

/**
 * Whether a child has asked to be retired and the cleanup has not finished:
 * no outcome yet, or a worktree on another machine whose answer has not come
 * back (issue #242).
 */
export function retirementPending(child: ChildRecord): boolean {
  if (!child.retireRequestedAt) return false;
  return !child.retireOutcome || Boolean(child.retireIntent?.far?.some((entry) => !entry.outcome));
}

/** How long a retirement may stay unfinished once the pane is gone, before doctor fails it. The watcher runs it at the close, and a far answer comes back over the relay. */
export const RETIRE_ACT_BOUND_MS = 60 * 60_000;

/**
 * A retirement in flight, for doctor: requested, and the pane it waited for is
 * gone, with no outcome yet or a far machine's answer still out. Before the
 * pane closes the request is the child's standing instruction, which
 * `agent_list` shows; it begins to run when herdr reports the pane gone.
 */
export function retirementInFlight(child: ChildRecord, who: string): InFlight | undefined {
  if (!retirementPending(child) || !child.exitedAt) return undefined;
  const waiting = child.retireIntent?.far?.filter((entry) => !entry.outcome).map((entry) => `${entry.worktree} on ${entry.host}`) ?? [];
  const owner = waiting.length && child.retireOutcome ? `the daemon on each far machine, whose answer for ${waiting.join(' and ')} waits in its relay outbox` : `the watcher's retirement, which runs once herdr no longer lists pane ${child.paneId || '(none)'}`;
  return { kind: 'retire', who, phase: 'acted', since: child.exitedAt, until: new Date(Date.parse(child.exitedAt) + RETIRE_ACT_BOUND_MS).toISOString(), owner };
}

export interface ReapDeps {
  ops: RetireOps;
  /** Whether herdr still shows the pane or the tab. Throws when herdr cannot be asked. */
  paneOrTabLive: (child: ChildRecord) => Promise<boolean>;
  log?: (message: string) => void;
  /** How long to wait for a process still leaving the path. */
  busyRetries?: number;
  busyDelayMs?: number;
  /**
   * Ask the daemon on another machine to retire a worktree there, over the
   * relay connection this daemon keeps (issue #242). Absent when this daemon
   * holds no relay, and each far worktree is then refused by name.
   */
  retireFar?: (host: string, ask: RelayRetireAsk) => Promise<RelayRetireAnswer>;
}

/** What a parent's daemon asks the daemon on a child's far machine to retire, by the directory its record holds (issue #242). */
export interface RelayRetireAsk {
  parentId: string;
  childId: string;
  dir: string;
  /** Names the request, so a repeat gets the same answer and a lost answer waits in that machine's relay outbox. */
  requestId: string;
}

/** What the daemon on a far machine found and did. */
export type RelayRetireAnswer = { outcome: 'removed'; worktree: string; branch: string; proof?: string } | { outcome: 'refused'; reason: string; worktree?: string; branch?: string } | { outcome: 'gone' };

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

  const intent = child.retireIntent;
  if (refusal(child, 'retire')) return refuse(`out of bounds: ${outOfBounds(child)}`);
  if (!intent || (!intent.worktree && !intent.far?.length)) return refuse(`no intent: the record of ${child.name} asks for retirement but names no worktree, so nothing was touched. Ask again from a live child.`);
  // A worktree on this machine for a child on another one is in bounds only when the child left it here by a move.
  if (intent.worktree && !leftBehindHere(child)) {
    const bounds = outOfBounds(child);
    if (bounds) return refuse(`out of bounds: ${bounds}`);
  }

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

  // 2 to 6 for the worktree on this machine, when the intent names one and an
  // earlier pass has not settled it.
  let proof: string | undefined;
  if (intent.worktree && !child.retireOutcome) {
    const local = await reapHere(parentId, child, { ...(intent as Required<Pick<RetireIntent, 'worktree' | 'repo' | 'branch'>> & RetireIntent) }, deps, log);
    if (local.outcome === 'skipped') return { outcome: 'skipped' };
    if (local.outcome === 'removed') proof = local.proof;
  }

  // Then each worktree on another machine, by the daemon there (issue #242).
  const far = await reapFar(parentId, child, deps, log);
  if (far.skipped) return { outcome: 'skipped' };
  const result = conclude(parentId, child.id, log, proof);
  if (far.doubt.length) return { outcome: 'pending', reason: `the answer from ${far.doubt.join(' and ')} has not come back; it waits in that machine's relay outbox` };
  return result;
}

/**
 * Write the retirement's outcome from what the record shows now, once the
 * worktree on this machine is settled or there is none. `removed` only when
 * nothing the record knows of stays in place; `partial` when something was
 * removed and something stays, such as a worktree left here that failed its
 * proofs, or one on another machine that its daemon refused or has not
 * answered for (issues #273, #242); `refused` when nothing was removed. A
 * refusal of the worktree on this machine stays as it is. A far answer that
 * arrives later writes the outcome again.
 */
function conclude(parentId: string, childId: string, log: (message: string) => void, proof?: string): ReapResult {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const intent = child?.retireIntent;
  if (!child || !intent) return { outcome: 'skipped' };
  if (intent.worktree && child.retireOutcome === 'refused') return { outcome: 'refused', reason: child.retireReason ?? '' };
  const far = intent.far ?? [];
  const stays = [
    ...(intent.left ?? []).filter((item) => item.outcome === 'refused').map((item) => `${item.worktree}: ${item.refusal ?? 'refused'}`),
    ...far.filter((item) => item.outcome === 'refused').map((item) => item.refusal ?? `${item.worktree} on ${item.host}`),
    ...far.filter((item) => !item.outcome).map((item) => `${item.worktree} on ${item.host}, whose daemon has not answered yet`),
  ];
  const removedAny = Boolean(intent.worktree) || far.some((item) => item.outcome === 'removed') || (intent.left ?? []).some((item) => item.outcome === 'removed');
  // With no worktree here and an answer still out, the outcome waits for it, rather than read as a refusal meanwhile.
  if (!intent.worktree && far.some((item) => !item.outcome)) return { outcome: 'pending', reason: `the answer for ${far.filter((item) => !item.outcome).map((item) => `${item.worktree} on ${item.host}`).join(' and ')} has not come back` };
  const outcome = !stays.length ? 'removed' : removedAny ? 'partial' : 'refused';
  const reason = stays.length ? `${intent.worktree ? `removed ${intent.worktree}, and ` : ''}left in place ${stays.join('; ')}` : undefined;
  if (child.retireOutcome === outcome && child.retireReason === reason) return reason ? { outcome: outcome as 'partial' | 'refused', reason } : { outcome: 'removed' };
  const staying = far.filter((item) => item.outcome !== 'removed' && item.outcome !== 'gone').map((item) => ({ host: item.host, worktree: item.worktree }));
  finish(parentId, child, outcome, reason, proof ?? child.retireProof, staying.length ? { stays: staying } : {});
  if (outcome !== 'removed') log(`retire ${child.name}: ${outcome}: ${reason}`);
  return reason ? { outcome: outcome as 'partial' | 'refused', reason } : { outcome: 'removed' };
}

/** The child, as saved now, while its retirement is still asked for. */
function stillRequested(parentId: string, childId: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((entry) => entry.id === childId && entry.retireRequestedAt);
}

/** Conditions 2 to 6 for the worktree on this machine, then each one the child left here by an earlier move (issue #241). */
async function reapHere(parentId: string, child: ChildRecord, intent: RetireIntent & { worktree: string; repo: string; branch: string }, deps: ReapDeps, log: (message: string) => void): Promise<{ outcome: 'removed'; proof?: string } | { outcome: 'refused' | 'skipped' }> {
  const refuse = (reason: string): { outcome: 'refused' } => {
    finish(parentId, child, 'refused', reason);
    log(`retire ${child.name}: refused: ${reason}`);
    return { outcome: 'refused' };
  };
  // The outcome on the record comes last, so a daemon that stops part of the
  // way through finds the retirement still pending and finishes it.
  const first = await retireWorktree({ ...intent, ...(child.retireStage ? { stage: child.retireStage } : {}) }, recordOf(parentId, child.id, (entry, stage) => {
    writableRetirement(entry).retireStage = stage;
  }), deps);
  if (first.outcome === 'skipped') {
    log(`retire ${child.name}: the child came back while the retirement checked ${intent.worktree}, so it stays`);
    return { outcome: 'skipped' };
  }
  for (const left of intent.left ?? []) {
    if (left.outcome) continue;
    const at = (entry: ChildRecord): LeftWorktree | undefined => entry.retireIntent?.left?.find((item) => item.worktree === left.worktree);
    const result = await retireWorktree(left, recordOf(parentId, child.id, (entry, stage) => {
      const item = at(entry);
      if (item) item.stage = stage;
    }), deps);
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
      log(`retire ${child.name}: left ${left.worktree} in place: ${result.reason}`);
    } else {
      log(`retire ${child.name}: removed ${left.worktree} and branch ${left.branch}, which it left here by an earlier move${result.proof ? `, because ${result.proof}` : ''}`);
    }
  }
  if (first.outcome === 'refused') return refuse(first.reason);
  if (intent.movedAway) {
    updateChild(parentId, child.id, (entry) => {
      dropDeparture(entry, LOCAL_HOST, intent.worktree);
    });
  }
  // The outcome waits for the worktrees on other machines, in conclude.
  log(`retire ${child.name}: removed ${intent.worktree} and branch ${intent.branch}${first.proof ? `, because ${first.proof}` : ''}`);
  return { outcome: 'removed', ...(first.proof ? { proof: first.proof } : {}) };
}

/** The hooks retireWorktree needs from a child record on this machine. */
function recordOf(parentId: string, childId: string, setStage: (entry: ChildRecord, stage: 'worktree-removed' | 'branch-deleted') => void): WorktreeHooks {
  return {
    childId,
    stillGone: () => Boolean(stillExited(parentId, childId)),
    setStage: (stage) => updateChild(parentId, childId, (entry) => setStage(entry, stage)),
  };
}

/**
 * Ask the daemon on each other machine to retire the child's worktree there,
 * and write each answer on the record (issue #242). This daemon decides, by
 * the directory its record names; the daemon there takes every proof. A
 * machine that cannot be asked keeps its worktree, refused by host and
 * directory. An answer lost on the way back leaves the request on the record,
 * and the far machine keeps the answer in its relay outbox until this daemon
 * takes it.
 */
async function reapFar(parentId: string, child: ChildRecord, deps: ReapDeps, log: (message: string) => void): Promise<{ refusals: string[]; doubt: string[]; skipped?: true }> {
  const refusals: string[] = [];
  const doubt: string[] = [];
  for (const entry of child.retireIntent?.far ?? []) {
    const now = stillRequested(parentId, child.id)?.retireIntent?.far?.find((item) => item.host === entry.host && item.worktree === entry.worktree);
    if (!now) return { refusals, doubt, skipped: true };
    if (now.outcome) {
      if (now.outcome === 'refused') refusals.push(now.refusal ?? `${now.worktree} on ${now.host}: refused`);
      continue;
    }
    if (!deps.retireFar) {
      const reason = `${now.worktree} on ${now.host} stays in place: this daemon holds no relay connection to machine ${now.host}, so it cannot ask the daemon there to take retirement's proofs. Remove it by hand on ${now.host} once its work is safe.`;
      settleFar(parentId, child.id, now.host, now.worktree, { outcome: 'refused', reason }, log);
      refusals.push(reason);
      continue;
    }
    const requestId = now.requestId ?? `retire-${randomUUID()}`;
    if (!now.requestId) {
      updateChild(parentId, child.id, (record) => {
        const item = record.retireIntent?.far?.find((candidate) => candidate.host === now.host && candidate.worktree === now.worktree);
        if (item) item.requestId = requestId;
      });
    }
    let answer: RelayRetireAnswer;
    try {
      answer = await deps.retireFar(now.host, { parentId, childId: child.id, dir: now.worktree, requestId });
    } catch (error) {
      if (error instanceof RelayAnswerLost) {
        doubt.push(`machine ${now.host}`);
        log(`retire ${child.name}: the answer for ${now.worktree} on ${now.host} was lost (${error.message}); it waits in that machine's relay outbox`);
        continue;
      }
      answer = { outcome: 'refused', reason: `${now.worktree} on ${now.host} stays in place: machine ${now.host} could not be asked to retire it (${(error as Error).message.trim()}). Remove it by hand on ${now.host} once its work is safe.` };
    }
    // The same answer also crosses in that machine's relay outbox, and may be written first, so read the entry as saved.
    const outcome = settleFar(parentId, child.id, now.host, now.worktree, answer, log, requestId) ?? readParent(parentId)?.children.find((item) => item.id === child.id)?.retireIntent?.far?.find((item) => item.host === now.host && item.worktree === now.worktree);
    if (outcome?.outcome === 'refused') refusals.push(outcome.refusal ?? '');
  }
  return { refusals, doubt };
}

/**
 * Write what the daemon on a far machine answered on the far worktree's entry,
 * and one line in retire.log. With `requestId`, only the entry that still
 * waits for that request takes it, so an answer is written once.
 */
function settleFar(parentId: string, childId: string, host: string, dir: string, answer: RelayRetireAnswer, log: (message: string) => void, requestId?: string): FarWorktree | undefined {
  let written: FarWorktree | undefined;
  let name = childId;
  updateChild(parentId, childId, (record) => {
    name = record.name;
    const item = record.retireIntent?.far?.find((candidate) => candidate.host === host && candidate.worktree === dir);
    if (!item || item.outcome || (requestId && item.requestId && item.requestId !== requestId)) return;
    item.outcome = answer.outcome;
    delete item.requestId;
    if (answer.outcome !== 'gone') {
      if (answer.worktree) item.root = answer.worktree;
      if (answer.branch) item.branch = answer.branch;
    }
    if (answer.outcome === 'refused') item.refusal = answer.reason.includes(host) && answer.reason.includes(dir) ? answer.reason : `${dir} on ${host} stays in place: ${answer.reason}`;
    if (answer.outcome === 'removed' && answer.proof) item.proof = answer.proof;
    // A place retired, or found gone, leaves the list of places the child left.
    if (answer.outcome !== 'refused') dropDeparture(record, host, dir);
    written = { ...item };
  });
  if (!written) return undefined;
  const settled = written as FarWorktree;
  appendRetireLog({ parent: parentId, child: childId, name, outcome: settled.outcome, host, worktree: settled.root ?? dir, ...(settled.branch ? { branch: settled.branch } : {}), far: true, ...(settled.refusal ? { reason: settled.refusal } : {}), ...(settled.proof ? { proof: settled.proof } : {}) });
  log(`retire ${name}: ${settled.outcome === 'removed' ? `the daemon on ${host} removed ${settled.root ?? dir}${settled.proof ? `, because ${settled.proof}` : ''}` : settled.outcome === 'gone' ? `${dir} on ${host} no longer existed` : `left ${dir} on ${host} in place: ${settled.refusal}`}`);
  return settled;
}

/**
 * The answer of a far retirement that crossed back in that machine's relay
 * outbox, after the answer to the request itself was lost (issue #242). It is
 * written once, and the child's retirement finishes when nothing else waits.
 */
export function learnRelayRetire(parentId: string, childId: string, host: string, requestId: string, answer: RelayRetireAnswer, log: (message: string) => void = () => {}): string {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const entry = child?.retireIntent?.far?.find((item) => item.host === host && item.requestId === requestId);
  if (!child || !entry) return `the answer of retirement ${requestId} of child ${childId} from machine ${host} was already settled`;
  settleFar(parentId, childId, host, entry.worktree, answer, log, requestId);
  // A retirement whose first pass ended can only gain from a far answer: partial becomes removed once nothing stays.
  const after = readParent(parentId)?.children.find((item) => item.id === childId);
  if (after?.retireOutcome || (after?.retireIntent && !after.retireIntent.worktree)) conclude(parentId, childId, log);
  return `took the kept answer of retirement ${requestId} of child ${childId} from machine ${host}: ${answer.outcome}`;
}

/**
 * The far daemon's side of `relay-retire` (issue #242): retirement's
 * conditions for the worktree at `dir`, against this machine's git, process
 * table, registry and relay records. The parent's daemon decided, and named
 * the directory; this daemon removes nothing else, and nothing that fails a
 * condition.
 */
export async function retireForRelay(ask: RelayRetireAsk, deps: Pick<ReapDeps, 'ops' | 'busyRetries' | 'busyDelayMs'>): Promise<RelayRetireAnswer> {
  const { ops } = deps;
  if (!ops.dirExists(ask.dir)) return { outcome: 'gone' };
  const facts = await ops.inspect(ask.dir);
  if ('error' in facts) return { outcome: 'refused', reason: `condition 2 (worktree): ${ask.dir} is not a git worktree Bellwether can retire: ${facts.error}. Look at it by hand.` };
  if (facts.main) return { outcome: 'refused', worktree: facts.worktree, reason: `condition 2 (main worktree): ${facts.worktree} is the repository's main worktree (${facts.main}), and Bellwether never removes a main worktree.` };
  if (!facts.branch) return { outcome: 'refused', worktree: facts.worktree, reason: `condition 2 (branch): ${facts.worktree} has a detached HEAD at ${facts.head.slice(0, 12)}, so Bellwether cannot tell whether its work is safe. Look at it by hand.` };
  const branch = facts.branch;
  const result = await retireWorktree({ worktree: facts.worktree, repo: facts.repo, branch, ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}) }, { childId: ask.childId, stillGone: () => true, setStage: () => {} }, deps);
  if (result.outcome === 'removed') return { outcome: 'removed', worktree: facts.worktree, branch, ...(result.proof ? { proof: result.proof } : {}) };
  if (result.outcome === 'refused') return { outcome: 'refused', worktree: facts.worktree, branch, reason: result.reason };
  return { outcome: 'refused', worktree: facts.worktree, branch, reason: `${facts.worktree} changed while the daemon there checked it, so it stays. Look at it by hand.` };
}

type WorktreeTarget = Pick<LeftWorktree, 'worktree' | 'repo' | 'branch' | 'defaultBranch' | 'stage'>;
type WorktreeResult = { outcome: 'removed'; proof?: string } | { outcome: 'refused'; reason: string } | { outcome: 'skipped' };

/** What retireWorktree needs from whoever holds the record: the child it is for, whether it is still gone, and where to write each stage. */
interface WorktreeHooks {
  childId: string;
  stillGone: () => boolean;
  setStage: (stage: 'worktree-removed' | 'branch-deleted') => void;
}

/**
 * Conditions 2 to 6 for one worktree on this machine: not a main worktree,
 * clean, no stash, its work safe, nobody inside, then the removal and its
 * check. `setStage` writes each stage as it completes, so a restart skips
 * what is done.
 */
async function retireWorktree(intent: WorktreeTarget, hooks: WorktreeHooks, deps: Pick<ReapDeps, 'ops' | 'busyRetries' | 'busyDelayMs'>): Promise<WorktreeResult> {
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
    const standing = standingIn(intent.worktree, hooks.childId);
    if (standing.length) return refuse(`condition 4 (no live child inside): ${standing} in ${intent.worktree}, and removing it would leave that child with no directory for its commands. Remove the worktree by hand once that child exits.`);
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
  if (!hooks.stillGone()) return { outcome: 'skipped' };

  // 6. Remove, delete, verify. Each stage is written as it completes, so a
  // restart skips what is done.
  try {
    if (!worktreeDone) {
      await ops.removeWorktree(intent.repo, intent.worktree);
      hooks.setStage('worktree-removed');
    }
    if (branchLeft) await ops.deleteBranch(intent.repo, intent.branch);
    hooks.setStage('branch-deleted');
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

/**
 * The live children standing in a directory, in words, or '' when none does:
 * each child of a parent on this machine, and each child this machine runs
 * for a parent on another one, by its relay record (issue #242). Either
 * one's harness starts each command there.
 */
function standingIn(dir: string, except: string): string {
  const root = realpath(dir);
  const here = liveChildrenIn(dir, except);
  const relayed = listRelayRecords().filter((record) => record.childId !== except && !record.retiredAt && record.cwd && inside(realpath(record.cwd), root));
  if (!here.length && !relayed.length) return '';
  const names = [
    ...here.map(({ parent, child }) => `${child.name} (child ${child.id} in pane ${child.paneId}, of the ${parent.harness} session ${parent.session})${child.cwd ? ` at ${child.cwd}` : ''}`),
    ...relayed.map((record) => `${record.name} (child ${record.childId}, of parent ${record.parentId} on another machine) at ${record.cwd}`),
  ];
  const count = names.length;
  return `live child${count === 1 ? '' : 'ren'} ${names.join(', ')} still ${count === 1 ? 'stands' : 'stand'}`;
}

/** Record the outcome on the child record first, then append the log line. */
function finish(parentId: string, child: ChildRecord, outcome: 'removed' | 'partial' | 'refused', reason?: string, proof?: string, extra: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  updateChild(parentId, child.id, (record) => {
    const entry = writableRetirement(record);
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
