// agent_restart: restart an agent in place of its session. The daemon closes
// the old pane, then starts the same harness on the same session in a new tab,
// so one process holds the session at a time and no pane is left over. A child
// keeps its child id, so history, receipts and retire state continue. A parent
// session's pane is closed only when herdr shows it still holding that session.
// A live agent no registry holds is refused: the daemon never closes a pane it
// cannot identify from the registry, and never starts a second copy.
//
// A session that restarts itself gets the reply first. The act is deferred
// until the caller's turn ends, because a tool that killed its own caller
// mid-call would leave no reply and nothing to see. The deferral is a field on
// the record, not a timer in memory: a daemon that stops mid-wait arms it
// again on its next start.
//
// The new tab opens before the old pane closes (issue #185). herdr closes a
// workspace with its last pane, so a session alone in its workspace that closed
// first had nowhere left to open. The harness still starts only once the old
// pane is closed, so one process holds the session at a time. A workspace that
// disappears all the same gives way to a new one under the old label. A
// restart that closed the old pane and then failed leaves `restartFailed` on
// the record: the parent's watcher sends an `exited` event about a child, and
// `bellwether doctor` names the session and its last pane.
//
// The mid-turn rule: never restart a pane that is mid-turn unless the target
// is the caller. For another target the actor waits for herdr to report idle
// or done, with a bounded timeout, and refuses when the wait runs out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMoving } from './move-plan.ts';
import { withChildLock } from './child-lock.ts';
import { HerdrApiError, type HerdrClient, type HerdrEvent, type HerdrPane, type Subscription } from './herdr-client.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { bellwetherHome } from './paths.ts';
import { withSessionCause } from './herdr-integration.ts';
import { readRelayRecord } from './relay-records.ts';
import { childOfCaller } from './report.ts';
import { listParents, mutateParent, readParent, recordDecisions, updateChild } from './registry.ts';
import { resumeArgs, sessionOf, type HarnessSession } from './resume.ts';
import { clearRetirement } from './retire.ts';
import { STARTUP_HOLD_MS, STARTUP_TIMEOUT_MS, childArgs, childEnv, childStartFiles, herdrLink, readsRefusal, hostName, nextLaunch, startHarness, startWithRetry, type NextLaunch, type RouteChange } from './spawn.ts';
import { launchLine, routeLabel, routeLaunch } from './routes.ts';
import { watchStartup, type StartupWatch } from './startup-dialogs.ts';
import { sessionFrom } from './transcript.ts';
import { requireHarness, resolveTranscript } from './harnesses/index.ts';
import type { CallerIdentity, ChildRecord, ChildRoute, ChildSession, ParentRecord, RestartFailure } from './types.ts';
import { openChildTab, parseWorkspaces, returnPlacement, undoChildTab, type ChildTab, type TabRequest, type WorkspacePlacement } from './workspace.ts';

export const RESTART_TOOL = 'agent_restart';

/** A restart the daemon refuses, with the reason a person can act on. */
export class RestartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartRefused';
  }
}

/**
 * How long agent_restart waits for another target's turn to end before
 * refusing. The daemon client gives a tool call 60 s, so the default leaves
 * room to answer.
 */
export const RESTART_WAIT_MS = 30_000;

/** The longest wait a caller may ask for, which still answers inside the client's 60 s. */
export const RESTART_WAIT_MAX_MS = 45_000;

/** How long a deferred self-restart watches for the caller's turn to end. */
export const RESTART_DEFER_MS = 15 * 60_000;

/** The one log line per restart outcome, beside the daemon's own state. */
export function restartLogPath(): string {
  return path.join(bellwetherHome(), 'restart.log');
}

function logRestart(line: Record<string, unknown>): void {
  fs.mkdirSync(bellwetherHome(), { recursive: true });
  fs.appendFileSync(restartLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

/**
 * What the daemon hands the restart code: how a deferred act is kept running
 * and stopped, how long the waits are, and the hooks a tool context provides.
 */
export interface RestartHooks {
  /**
   * Keep a deferred act running after the tool has answered. The daemon queues
   * it and aborts it on stop; a test collects the promise. One act per key.
   */
  defer?: (key: string, job: () => Promise<void>) => void;
  /** Bound on the wait for another target's turn to end. */
  waitTimeoutMs?: number;
  /** Bound on the deferred watch for the caller's own turn to end. */
  deferTimeoutMs?: number;
  /** How long a restarted Claude Code pane may spend on its startup dialogs. Tests shorten it. */
  startupTimeoutMs?: number;
  /** How long a screen takes to redraw after a key. Tests shorten it. */
  redrawMs?: number;
  /** Aborted when the session's service stops. It ends a wait; an act that began runs to the end. */
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** The pi extension a restarted pi child loads. Defaults to the packaged one; tests pass their own. */
  piExtension?: () => string;
  /** Forget the watcher's stale measurements for a child whose pane changed. */
  reset?: (childId: string) => void;
}

/** What a restart produced, for the reply and the log line. */
export interface RestartOutcome {
  target: 'child' | 'parent';
  /** The child id, parent record id, or pane the target was named by. */
  id: string;
  name: string;
  oldPane: string;
  newPane: string;
  newTab?: string;
  session: string;
  /** The harness kind the restart started. */
  kind: string;
  /** The resume arguments the harness got, as one string for the reply. */
  command: string;
  /** Set when the restart changed the child's route. */
  route?: string;
  /** Whether herdr reported the session the restart asked for on the new pane. */
  sessionMatched: boolean;
  /** Set when the act waited for the target's turn to end. */
  waitedMs?: number;
}

/** What a restart names: a child of a registry, a parent session, or a live agent no registry holds. */
export type RestartTarget =
  | { kind: 'child'; parent: ParentRecord; child: ChildRecord; self: boolean }
  | { kind: 'parent'; parent: ParentRecord; self: boolean }
  | { kind: 'agent'; pane: HerdrPane };

function matchesChild(record: ParentRecord, target: string): ChildRecord | undefined {
  return record.children.find((child) => child.id === target || child.name === target || (child.paneId !== '' && child.paneId === target));
}

function sameSessionValue(reported: string | undefined, wanted: string): boolean {
  if (!reported) return false;
  if (reported === wanted) return true;
  const id = (value: string): string => path.basename(value, '.jsonl');
  return id(reported) === id(wanted) || id(reported).endsWith(`_${id(wanted)}`) || id(wanted).endsWith(`_${id(reported)}`);
}

function agentInfo(result: unknown): Record<string, unknown> {
  const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
  return typeof agent === 'object' && agent !== null && !Array.isArray(agent) ? (agent as Record<string, unknown>) : {};
}

/**
 * Resolve what a call names: no target is the caller itself, then a child of
 * this session, a child of another local session, a parent session, and last a
 * live agent herdr shows that no registry holds.
 */
export async function resolveRestartTarget(client: HerdrClient, ownParentId: string, caller: CallerIdentity, target?: string): Promise<RestartTarget> {
  const own = readParent(ownParentId);
  if (!target) {
    const self = childOfCaller(caller);
    if (self) return { kind: 'child', parent: self.parent, child: self.child, self: true };
    if (!own) throw new RestartRefused(`No Bellwether registry for ${ownParentId}, so this session cannot be restarted.`);
    return { kind: 'parent', parent: own, self: true };
  }

  const isSelf = (child: ChildRecord): boolean => (caller.childId !== undefined && caller.childId === child.id) || (caller.paneId !== undefined && caller.paneId === child.paneId);
  const child = own ? matchesChild(own, target) : undefined;
  if (own && child) return { kind: 'child', parent: own, child, self: isSelf(child) };
  for (const parent of listParents()) {
    if (own && parent.id === own.id) continue;
    const other = matchesChild(parent, target);
    if (other) return { kind: 'child', parent, child: other, self: isSelf(other) };
  }
  for (const parent of listParents()) {
    if (parent.id === target || parent.session === target || (parent.paneId !== undefined && parent.paneId === target)) return { kind: 'parent', parent, self: parent.id === ownParentId };
  }

  const agents = await client.agentList();
  const byPane = agents.find((pane) => pane.paneId === target);
  if (byPane) return { kind: 'agent', pane: byPane };
  const byName = agents.filter((pane) => pane.name === target || pane.label === target);
  if (byName.length === 1) return { kind: 'agent', pane: byName[0] as HerdrPane };
  if (byName.length > 1) throw new RestartRefused(`More than one live agent matches "${target}": ${byName.map((pane) => `${pane.name ?? pane.label} in pane ${pane.paneId}`).join(', ')}. Name it by pane id.`);
  const bare = (await client.paneList().catch(() => [] as HerdrPane[])).find((pane) => pane.paneId === target);
  if (bare) throw new RestartRefused(`Pane ${target} holds no agent herdr recognizes, so there is nothing to restart.`);
  throw new RestartRefused(`No child, parent session or live agent matches "${target}". Call agent_list for this session's children, or pass a child name or id, a session id, a parent id, or a live agent's name or pane.`);
}

const STATUS_EVENTS = new Set(['pane.agent_status_changed', 'pane_agent_status_changed']);
const CLOSE_EVENTS = new Set(['pane.exited', 'pane_exited', 'pane.closed', 'pane_closed', 'tab.closed', 'tab_closed']);

/**
 * Wait for a pane's turn to end: herdr reporting idle or done, or the pane
 * going away. The subscription opens before the status is read, because herdr
 * does not replay events. With `freshOnly`, a status already on the record does
 * not count, which is how a caller's own restart waits for the turn that
 * contains its request to finish. Undefined means there was nothing to wait
 * for: the pane was already idle, or already gone.
 */
async function waitForTurnEnd(client: HerdrClient, label: string, pane: { paneId: string; tabId?: string }, options: { timeoutMs: number; freshOnly?: boolean; signal?: AbortSignal }): Promise<{ waitedMs: number } | undefined> {
  if (options.signal?.aborted) throw new RestartRefused(`The restart of ${label} was cancelled before it began.`);
  const started = Date.now();
  const controller = new AbortController();
  const relay = (): void => {
    controller.abort();
    fail(new RestartRefused(`The restart of ${label} was cancelled before its turn ended, so nothing was restarted.`));
  };
  options.signal?.addEventListener('abort', relay, { once: true });
  let status = 'unknown';
  let settled = false;
  let settle: (how: 'idle' | 'gone') => void = () => {};
  let fail: (error: Error) => void = () => {};
  const finished = new Promise<'idle' | 'gone'>((resolve, reject) => {
    settle = (how) => {
      if (settled) return;
      settled = true;
      resolve(how);
    };
    fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  let subscription: Subscription | undefined;
  try {
    subscription = await client.subscribe(
      [
        { type: 'pane.agent_status_changed', pane_id: pane.paneId },
        { type: 'pane.exited' },
        { type: 'pane.closed' },
        { type: 'tab.closed' },
      ],
      (event: HerdrEvent) => {
        const paneId = event.data['pane_id'];
        const tabId = event.data['tab_id'];
        if (CLOSE_EVENTS.has(event.event) && ((typeof paneId === 'string' && paneId === pane.paneId) || (pane.tabId !== undefined && tabId === pane.tabId))) settle('gone');
        if (STATUS_EVENTS.has(event.event) && paneId === pane.paneId) {
          const next = event.data['agent_status'];
          if (typeof next === 'string') status = next;
          if (next === 'idle' || next === 'done') settle('idle');
        }
      },
      controller.signal,
    );
  } catch (error) {
    options.signal?.removeEventListener('abort', relay);
    if (options.signal?.aborted) throw new RestartRefused(`The restart of ${label} was cancelled before it began.`);
    throw new RestartRefused(`herdr would not report pane ${pane.paneId} to agent_restart, so nothing was restarted: ${(error as Error).message}`);
  }
  // A subscription that drops is not a turn ending: fail the wait rather than
  // act on a pane that may still be working.
  void subscription.closed.then(
    () => {
      if (!controller.signal.aborted) fail(new RestartRefused(`the herdr subscription for pane ${pane.paneId} closed before its turn ended, so nothing was restarted.`));
    },
    (error: unknown) => fail(new RestartRefused(`the herdr subscription for pane ${pane.paneId} was lost before its turn ended, so nothing was restarted: ${String(error)}`)),
  );
  const timer = setTimeout(() => {
    fail(new RestartRefused(`${label} is still ${status} after the ${(options.timeoutMs / 1000).toFixed(1)} s wait; agent_restart never restarts a pane mid-turn. Ask it to finish, or call again once it is idle.`));
  }, options.timeoutMs);
  timer.unref?.();
  try {
    // The snapshot comes after the subscription, so nothing between the two is lost.
    let current: string | undefined;
    try {
      const result = await client.request('agent.get', { target: pane.paneId });
      const value = agentInfo(result)['agent_status'];
      if (typeof value === 'string' && value) current = value;
    } catch (error) {
      if (error instanceof HerdrApiError && (error.code === 'agent_not_found' || error.code === 'pane_not_found')) {
        settle('gone');
        return undefined;
      }
      throw new RestartRefused(`herdr could not report pane ${pane.paneId}, so agent_restart stopped without waiting for it: ${(error as Error).message}`);
    }
    if (current) {
      status = current;
      if (!options.freshOnly && (current === 'idle' || current === 'done')) {
        settle('idle');
        return undefined;
      }
    }
    await finished;
    return { waitedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    subscription.close();
    options.signal?.removeEventListener('abort', relay);
  }
}

export interface RestartOptions {
  /** Wait for the target's turn to end before closing or starting anything. */
  wait?: boolean;
  /** A change of route. Without one, the restart uses the request on the record, or keeps the child's route. */
  change?: RouteChange;
  waitTimeoutMs?: number;
}

/**
 * Restart a child in place of its session: close the tab Bellwether started,
 * then start the same harness on the same session in a new tab, under the same
 * child id, so history, receipts and retire state continue. The lock per child
 * is held across the wait and the act, so two callers produce one restart.
 */
export async function restartChild(client: HerdrClient, parentId: string, childId: string, hooks: RestartHooks = {}, options: RestartOptions = {}): Promise<RestartOutcome> {
  const first = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const label = first ? `${first.name} (child ${first.id})` : `child ${childId}`;
  return withChildLock(childId, label, `restart of ${first?.name ?? childId}`, () => restartChildLocked(client, parentId, childId, hooks, options), undefined, undefined, { action: 'restarted' });
}

async function restartChildLocked(client: HerdrClient, parentId: string, childId: string, hooks: RestartHooks, options: RestartOptions): Promise<RestartOutcome> {
  const parent = readParent(parentId);
  const child = parent?.children.find((entry) => entry.id === childId);
  if (!parent || !child) throw new RestartRefused(`child ${childId} is gone from the registry of ${parentId}, so there is nothing to restart.`);
  if (hostOf(child) !== LOCAL_HOST) throw new RestartRefused(`${child.name} runs on machine ${hostOf(child)}, and this daemon only restarts agents on its own machine. Restart it there with agent_restart.`);
  // A move closes and reopens the child itself, and outlasts the lock's stale age.
  if (isMoving(child)) throw new RestartRefused(`${child.name} (child ${child.id}) is being moved to ${child.moving?.to === LOCAL_HOST ? 'this machine' : `machine ${child.moving?.to}`}, since ${child.moving?.since}. Wait for the move to finish, then restart it.`);
  if (child.origin === 'adopt') throw new RestartRefused(`${child.name} (child ${child.id}) was adopted, not started by Bellwether, so agent_restart will not close pane ${child.paneId}: it closes only panes Bellwether started.`);
  const session = sessionOf(child);
  if (!session) throw new RestartRefused(await withSessionCause(`${child.name} (child ${child.id}, pane ${child.paneId || 'none'}) has no recorded session, so agent_restart cannot reopen it. Resume it once with agent_spawn and resume, which records the session herdr reports.`, client, requireHarness(child.kind), child));
  const resume = resumeArgs(child.kind, session);
  // Decided before the old pane closes, so a refused route leaves the child running.
  const change = options.change ?? child.restartRoute ?? {};
  const launch = nextLaunch(child, change, 'restarted');
  // A new read set goes on the record before the start files are written, which list it.
  if (change.reads !== undefined) {
    const entry = requireHarness(child.kind);
    if (change.reads.length && !entry.launchReads) throw new RestartRefused(readsRefusal(entry, child.name));
    if (change.reads.length) child.reads = change.reads;
    else delete child.reads;
    updateChild(parentId, child.id, (record) => {
      if (change.reads?.length) record.reads = change.reads;
      else delete record.reads;
    });
  }

  let waitedMs: number | undefined;
  if (options.wait && child.paneId) {
    const wait = await waitForTurnEnd(client, child.name, { paneId: child.paneId, tabId: child.tabId }, { timeoutMs: options.waitTimeoutMs ?? hooks.waitTimeoutMs ?? RESTART_WAIT_MS, signal: hooks.signal });
    waitedMs = wait?.waitedMs;
  }

  const oldPane = child.paneId;
  const oldTab = child.tabId;
  const workspaceId = child.workspaceId ?? parent.workspaceId;
  // 1. Open the new tab while the old one still holds its workspace open
  // (issue #185). Nothing has changed yet, so a failure here leaves the child
  // running where it was.
  let files: Awaited<ReturnType<typeof childStartFiles>>;
  let opened: ChildTab;
  try {
    // The same start files a spawn and a resume give it: a Claude Code
    // child's own MCP configuration, and the extension a pi child loads.
    files = await childStartFiles(parent, child, undefined, undefined, hooks.piExtension, launch.harnessModel);
    // A child in a workspace Bellwether made for it goes back there, or to a
    // new one under the same label once herdr has closed it.
    const placement = await returnPlacement(client, child, workspaceId);
    opened = await openReturnTab(client, placement, { cwd: child.cwd, label: child.name, env: { ...childEnv(parent, child, files.piExtension), ...files.env }, focus: false }, child.workspaceLabel || child.name);
  } catch (error) {
    throw new RestartRefused(`the new tab for ${child.name} did not open, so the restart stopped before closing ${oldTab ? `tab ${oldTab}` : `pane ${oldPane || '(none)'}`} and nothing changed: ${(error as Error).message}`);
  }
  const newPane = opened.paneId as string;
  const newTab = opened.tabId ?? newPane;
  const toolSource = files.toolSource;

  // 2. The record lets go of the old pane before herdr closes it, so the close
  // is read as part of this restart, not as the child exiting.
  // From here the act runs to the end. Closing the caller's own tab makes its
  // adapter say bye, which stops its service, so the act takes no signal.
  updateChild(parentId, child.id, (entry) => {
    entry.paneId = '';
    delete entry.tabId;
    delete entry.reportPending;
    delete entry.restartRequestedAt;
    delete entry.restartRoute;
    entry.startingUntil = new Date(Date.now() + STARTUP_HOLD_MS).toISOString();
  });
  // 3. Close what Bellwether started.
  try {
    if (oldTab) await client.tabClose(oldTab);
    else if (oldPane) await client.paneClose(oldPane);
  } catch (error) {
    await undoChildTab(client, opened);
    updateChild(parentId, child.id, (entry) => {
      entry.paneId = oldPane;
      if (oldTab) entry.tabId = oldTab;
      delete entry.startingUntil;
    });
    throw new RestartRefused(`closing ${child.name}'s ${oldTab ? `tab ${oldTab}` : `pane ${oldPane}`} failed, so the restart stopped and nothing else changed: ${(error as Error).message}`);
  }

  // 4. Start the same harness on the same session in the new tab, under the
  // same child id and with the same environment.
  let startup: StartupWatch | undefined;
  try {
    // The record names the new pane before the harness starts, as a spawn does.
    updateChild(parentId, child.id, (entry) => {
      entry.paneId = newPane;
      if (toolSource) entry.toolSource = toolSource;
      if (opened.tabId) entry.tabId = opened.tabId;
      if (opened.workspaceId) entry.workspaceId = opened.workspaceId;
      if (opened.workspaceLabel) entry.workspaceLabel = opened.workspaceLabel;
      if (opened.ownsWorkspace) entry.ownsWorkspace = true;
    });
    const dialogs = requireHarness(child.kind).startup;
    if (dialogs) {
      const timeoutMs = hooks.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      updateChild(parentId, child.id, (entry) => {
        entry.startingUntil = new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString();
      });
      // The watch opens before the start: the dialog appears with the harness.
      startup = await watchStartup(client, newPane, undefined, { timeoutMs, redrawMs: hooks.redrawMs, dialogs, by: 'restart' });
    }
    const harnessArgs = childArgs(child.kind, { model: launch.harnessModel, provider: launch.provider }, files, { resume });
    await startHarness(client, { name: child.name, kind: child.kind, paneId: newPane, args: harnessArgs, ...(launch.route && launch.config ? { launch: routeLaunch(launch.config, launch.route, child.kind, harnessArgs) } : {}) });
    if (startup) {
      await startup.answer();
      recordDecisions(parentId, child.id, startup.decisions);
      startup.close();
    }
  } catch (error) {
    startup?.close();
    await undoChildTab(client, opened);
    const message = (error as Error).message;
    const failure: RestartFailure = { at: new Date().toISOString(), oldPane, ...(workspaceId ? { workspaceId } : {}), session: session.value, error: message, reopen: `agent_spawn and resume ${session.value}` };
    updateChild(parentId, child.id, (entry) => {
      // The record names the pane the child last ran in, which the failure closed.
      entry.paneId = oldPane;
      delete entry.tabId;
      entry.exitedAt = failure.at;
      entry.lastStatus = 'unknown';
      entry.restartFailed = failure;
      delete entry.startingUntil;
      delete entry.restartRequestedAt;
    });
    hooks.log?.(`restart ${child.name} failed after closing ${oldPane}: ${message}`);
    logRestart({ outcome: 'failed', target: 'child', parent: parentId, child: child.id, name: child.name, oldPane, session: session.value, error: message });
    throw new RestartRefused(`${child.name} did not come back: ${message}. Its old pane ${oldPane} is closed, so it is gone; bring it back with agent_spawn and resume ${session.value}.`);
  }

  // 4. Read the session herdr reports for the new pane, and record whether it
  // is the one the restart asked for.
  let reported: ChildSession | undefined;
  let status: ChildRecord['lastStatus'] | undefined;
  try {
    const info = agentInfo(await client.request('agent.get', { target: newPane }));
    reported = sessionFrom(info['agent_session']);
    const value = info['agent_status'];
    if (typeof value === 'string' && value) status = value as ChildRecord['lastStatus'];
  } catch {
    // The watcher reads the session and the status on its next pass.
  }
  const matched = sameSessionValue(reported?.value, session.value);
  const at = new Date().toISOString();
  updateChild(parentId, child.id, (entry) => {
    entry.session = reported ?? { kind: session.kind, value: session.value };
    const transcript = requireHarness(entry.kind).conversation.locate(entry.session.value, entry.cwd).path;
    if (transcript) entry.transcript = transcript;
    if (status && entry.lastStatus !== status) entry.statusChangedAt = at;
    entry.lastStatus = status ?? 'unknown';
    entry.lastBusyAt = at;
    entry.resumedAt = at;
    entry.restartedAt = at;
    applyLaunch(entry, launch);
    delete entry.startingUntil;
    delete entry.exitedAt;
    delete entry.exitCode;
    delete entry.restartRequestedAt;
    delete entry.restartFailed;
    // The new harness has yet to show herdr it runs, and the watcher checks it once after its start window.
    delete entry.harnessSeenAt;
    delete entry.harnessEnded;
    delete entry.tabClosedAt;
    // A child brought back did not ask for this run to end its worktree.
    clearRetirement(entry);
  });
  hooks.reset?.(child.id);
  hooks.log?.(`restart ${child.name}: closed ${oldPane}, opened ${newPane} on session ${session.value}, ${matched ? 'the session matched' : `herdr reported ${reported?.value ?? 'no session'}`}`);
  logRestart({ outcome: 'restarted', target: 'child', parent: parentId, child: child.id, name: child.name, oldPane, newPane, ...(newTab ? { newTab } : {}), session: session.value, sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) });
  return { target: 'child', id: child.id, name: child.name, oldPane, newPane, ...(newTab ? { newTab } : {}), session: session.value, kind: child.kind, command: commandWords(child.kind, resume, launch), route: routeMove(child.route, launch), sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) };
}

/** The label herdr gives a workspace, or undefined when it lists none under that id. */
async function workspaceLabelOf(client: HerdrClient, workspaceId: string): Promise<string | undefined> {
  const listed = parseWorkspaces(await client.workspaceList().catch(() => [] as Record<string, unknown>[]));
  return listed.find((entry) => entry.id === workspaceId)?.label || undefined;
}

/**
 * Open the tab a restarted session runs in. When herdr no longer knows the
 * workspace, the session gets a new one under the old label: a session that
 * comes back somewhere is worth more than a tidy layout (issue #185).
 */
async function openReturnTab(client: HerdrClient, placement: WorkspacePlacement, tab: TabRequest, label: string): Promise<ChildTab> {
  let opened: ChildTab;
  try {
    opened = await openChildTab(client, placement, tab);
  } catch (error) {
    if (placement.mode === 'new' || !(error instanceof HerdrApiError) || error.code !== 'workspace_not_found') throw error;
    opened = await openChildTab(client, { mode: 'new', label: placement.mode === 'existing' ? (placement.label ?? label) : label }, tab);
  }
  if (!opened.paneId) {
    await undoChildTab(client, opened);
    throw new Error('herdr created no pane for the restarted tab');
  }
  return opened;
}

/**
 * The `bellwether doctor` lines for each restart that closed a session's pane
 * and did not bring the session back, newest first. Each names the session,
 * the pane it last ran in, the error and how to bring it back.
 */
export function restartFailureLines(parents: ParentRecord[]): string[] {
  const found: { at: string; line: string }[] = [];
  const where = (failure: RestartFailure): string => `last pane ${failure.oldPane || '(none)'}${failure.workspaceId ? ` in workspace ${failure.workspaceId}` : ''}`;
  for (const parent of parents) {
    const own = parent.restartFailed;
    if (own) found.push({ at: own.at, line: `fail  restart: session ${parent.id} (${parent.harness}, ${where(own)}) did not come back at ${own.at}: ${own.error}. Reopen it by hand with ${own.reopen}.` });
    for (const child of parent.children) {
      const failure = child.restartFailed;
      if (failure) found.push({ at: failure.at, line: `fail  restart: ${child.name} (child ${child.id} of ${parent.id}, ${where(failure)}) did not come back at ${failure.at}: ${failure.error}. Bring it back with ${failure.reopen}.` });
    }
  }
  return found.sort((a, b) => b.at.localeCompare(a.at)).map((entry) => entry.line);
}

/** The text of the event a child's parent receives about a restart that left the child gone. */
export function restartFailureText(child: Pick<ChildRecord, 'name' | 'id'>, failure: RestartFailure): string {
  return `${child.name} (child ${child.id}) did not come back from a restart at ${failure.at}: ${failure.error}. Its last pane ${failure.oldPane || '(none)'} is closed, so it is gone; bring it back with ${failure.reopen}.`;
}

/** The record's route after a start: the new route, or none for a bare start with its pi pair. */
function applyLaunch(entry: ChildRecord, launch: NextLaunch): void {
  if (launch.route) {
    entry.route = launch.route;
    delete entry.model;
    return;
  }
  delete entry.route;
  if (requireHarness(entry.kind).chosenBy === 'pair' && launch.provider && launch.harnessModel) entry.model = { provider: launch.provider, id: launch.harnessModel, source: 'caller' };
}

/** What the reply names as the command: the harness's resume flag, behind the route's launcher when there is one. */
function commandWords(kind: string, resume: string[], launch: NextLaunch): string {
  if (!launch.route || !launch.config) return resume.join(' ');
  return launchLine(routeLaunch(launch.config, launch.route, kind, resume));
}

/** A sentence for a route that changed, or undefined when it did not. */
function routeMove(before: ChildRoute | undefined, launch: NextLaunch): string | undefined {
  const from = routeLabel(before);
  const to = routeLabel(launch.route);
  return from === to ? undefined : `It moved from route ${from} to ${to}, on the same session.`;
}

/** The session a parent record names, and the arguments that reopen it. */
function parentSessionPlan(record: ParentRecord): { kind: string; sessionValue: string; resume: string[] } {
  if (!record.session) throw new RestartRefused(`session ${record.id} has no session id on its record, so there is nothing to resume.`);
  if (record.harness === 'claude-code' && record.session.startsWith('pid-')) {
    throw new RestartRefused(`session ${record.id} holds ${record.session}, a process marker, so there is no session to resume. A Claude Code session that started without CLAUDE_CODE_SESSION_ID cannot be restarted; start it again by hand.`);
  }
  const kind = record.harness === 'pi' ? 'pi' : 'claude';
  let sessionValue = record.session;
  if (record.harness === 'pi') {
    const file = resolveTranscript('pi', record.session, record.cwd);
    if (!file) throw new RestartRefused(`session ${record.id} names pi session ${record.session}, and no session file for it sits under ${path.join(os.homedir(), '.pi', 'agent', 'sessions')}, so pi cannot reopen it.`);
    sessionValue = file;
  }
  const session: HarnessSession = { value: sessionValue, kind: sessionValue.includes('/') ? 'path' : 'id' };
  return { kind, sessionValue, resume: resumeArgs(kind, session) };
}

/** The child record of a session that was itself started as a child, so a restart keeps its parent. */
function sessionAsChild(paneId: string | undefined): { parent: ParentRecord; child: ChildRecord } | undefined {
  if (!paneId) return undefined;
  for (const parent of listParents()) {
    const child = parent.children.find((entry) => !entry.exitedAt && entry.paneId === paneId && hostOf(entry) === LOCAL_HOST);
    if (child) return { parent, child };
  }
  return undefined;
}

/**
 * How the docs start a Claude Code parent: the Bellwether plugin channel,
 * which Claude Code loads only under the development-channel flag. A restart
 * carries it, or the new process would come back without Bellwether.
 */
export const PARENT_CHANNEL_ARG = '--dangerously-load-development-channels=plugin:bellwether@elecnix-plugins';

/**
 * Restart a parent session in place: close the pane its record names, then
 * start the same harness on the same session in a new tab. The daemon keeps
 * running after the client stops, so it can start the new pane after it
 * closed the caller's own. It closes the old pane only when herdr shows it
 * still holding that session, so two processes never share one session and
 * no pane is left for the person to close.
 */
export async function restartParent(client: HerdrClient, parentId: string, hooks: RestartHooks = {}, options: RestartOptions = {}): Promise<RestartOutcome> {
  return withChildLock(`parent:${parentId}`, `session ${parentId}`, `restart of ${parentId}`, () => restartParentLocked(client, parentId, hooks, options), undefined, undefined, { action: 'restarted' });
}

async function restartParentLocked(client: HerdrClient, parentId: string, hooks: RestartHooks, options: RestartOptions): Promise<RestartOutcome> {
  const record = readParent(parentId);
  if (!record) throw new RestartRefused(`No Bellwether registry for ${parentId}, so there is no session to restart.`);
  const here = hostName() || os.hostname();
  if (record.host !== here && record.host !== LOCAL_HOST) throw new RestartRefused(`session ${record.id} runs on ${record.host}, and this daemon only restarts sessions on its own machine.`);
  const plan = parentSessionPlan(record);

  // A session that was itself started as a child restarts as that child: the
  // same child id and MCP configuration, and its own parent reads the close as
  // part of the restart rather than as an exit.
  const asChild = sessionAsChild(record.paneId);
  if (asChild) {
    const outcome = await restartChild(client, asChild.parent.id, asChild.child.id, hooks, options);
    mutateParent(record.id, (entry) => {
      entry.paneId = outcome.newPane;
      entry.restartedAt = new Date().toISOString();
      delete entry.restartRequestedAt;
    });
    return outcome;
  }

  let agents: HerdrPane[];
  try {
    agents = await client.agentList();
  } catch (error) {
    throw new RestartRefused(`herdr could not list its agents, so agent_restart cannot tell what pane ${record.paneId ?? '(none)'} holds and changed nothing: ${(error as Error).message}`);
  }
  const live = record.paneId ? agents.find((pane) => pane.paneId === record.paneId) : undefined;
  if (live) {
    // The pane on the record must still be this session, or closing it would
    // end something else.
    if (live.agent && live.agent !== plan.kind) throw new RestartRefused(`pane ${live.paneId} now runs ${live.agent}, not the ${plan.kind} session ${record.id}, so agent_restart closed nothing and started nothing.`);
    if (live.agentSessionId && !sameSessionValue(live.agentSessionId, record.session) && !sameSessionValue(live.agentSessionId, plan.sessionValue)) {
      throw new RestartRefused(`pane ${live.paneId} now holds session ${live.agentSessionId}, not ${record.session}, so agent_restart closed nothing and started nothing.`);
    }
  }
  const label = live?.label ?? live?.name ?? record.harness;
  let waitedMs: number | undefined;
  if (options.wait && live) {
    const wait = await waitForTurnEnd(client, label, { paneId: live.paneId, tabId: live.tabId }, { timeoutMs: options.waitTimeoutMs ?? hooks.waitTimeoutMs ?? RESTART_WAIT_MS, signal: hooks.signal });
    waitedMs = wait?.waitedMs;
  }

  const oldPane = live?.paneId ?? '';
  const workspaceNow = live?.workspaceId ?? record.workspaceId;
  const args = plan.kind === 'claude' ? [PARENT_CHANNEL_ARG, ...plan.resume] : plan.resume;
  const reopen = `${plan.kind} ${args.join(' ')}`;
  // Open the new tab while the old pane still holds its workspace open (issue
  // #185): herdr closes a workspace with its last pane, so a session alone in
  // its workspace that closed first had nowhere left to open. Nothing has
  // changed yet, so a failure here leaves the session running.
  let opened: ChildTab;
  try {
    const workspaceLabel = workspaceNow ? await workspaceLabelOf(client, workspaceNow) : undefined;
    opened = await openReturnTab(client, { mode: 'default', workspaceId: workspaceNow }, { cwd: live?.cwd ?? record.cwd, label, env: {}, focus: false }, workspaceLabel ?? label);
  } catch (error) {
    throw new RestartRefused(`the new tab for session ${record.id} did not open, so the restart stopped before closing ${oldPane ? `pane ${oldPane}` : 'anything'} and nothing changed: ${(error as Error).message}`);
  }
  const newPane = opened.paneId as string;
  const newTab = opened.tabId ?? newPane;

  // From here the act runs to the end. Closing the caller's own pane makes its
  // adapter say bye, which stops its service, so the act takes no signal.
  mutateParent(record.id, (entry) => {
    delete entry.restartRequestedAt;
  });
  if (live) {
    try {
      await client.paneClose(live.paneId);
    } catch (error) {
      await undoChildTab(client, opened);
      throw new RestartRefused(`closing pane ${live.paneId} of session ${record.id} failed, so the restart stopped and nothing else changed: ${(error as Error).message}`);
    }
  }

  // The harness starts only now, so one process holds the session at a time.
  let startup: StartupWatch | undefined;
  try {
    // The channel flag always asks its question, and the new pane is the daemon's own to answer.
    if (plan.kind === 'claude') startup = await watchStartup(client, newPane, undefined, { timeoutMs: hooks.startupTimeoutMs ?? STARTUP_TIMEOUT_MS, redrawMs: hooks.redrawMs });
    await startWithRetry(client, { name: label, kind: plan.kind, paneId: newPane, args });
    if (startup) {
      await startup.answer();
      startup.close();
    }
  } catch (error) {
    startup?.close();
    await undoChildTab(client, opened);
    const message = (error as Error).message;
    const failure: RestartFailure = { at: new Date().toISOString(), oldPane, ...(workspaceNow ? { workspaceId: workspaceNow } : {}), session: record.session, error: message, reopen: `\`${reopen}\` in ${record.cwd}` };
    mutateParent(record.id, (entry) => {
      delete entry.paneId;
      entry.restartFailed = failure;
    });
    hooks.log?.(`restart of session ${record.id} failed${oldPane ? ` after closing ${oldPane}` : ''}: ${message}`);
    logRestart({ outcome: 'failed', target: 'parent', parent: record.id, oldPane, session: record.session, error: message });
    const closed = oldPane ? `Its old pane ${oldPane} is closed, so` : 'It had no pane, so';
    throw new RestartRefused(`Restarting session ${record.id} failed: ${message}. ${closed} reopen it by hand with \`${reopen}\` in ${record.cwd}.`);
  }

  let reported: ChildSession | undefined;
  try {
    reported = sessionFrom(agentInfo(await client.request('agent.get', { target: newPane }))['agent_session']);
  } catch {
    // The new adapter reports its session in its own hello; this is only the check.
  }
  const matched = sameSessionValue(reported?.value, record.session);
  const at = new Date().toISOString();
  mutateParent(record.id, (entry) => {
    entry.paneId = newPane;
    const workspace = opened.workspaceId ?? workspaceNow;
    if (workspace) entry.workspaceId = workspace;
    entry.restartedAt = at;
    delete entry.restartFailed;
  });
  hooks.log?.(`restart session ${record.id}: ${oldPane ? `closed ${oldPane}, ` : ''}opened ${newPane} on ${plan.sessionValue}, ${matched ? 'the session matched' : 'herdr reported another session'}`);
  logRestart({ outcome: 'restarted', target: 'parent', parent: record.id, oldPane, newPane, ...(newTab ? { newTab } : {}), session: record.session, sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) });
  return { target: 'parent', id: record.id, name: label, oldPane, newPane, ...(newTab ? { newTab } : {}), session: record.session, kind: plan.kind, command: plan.resume.join(' '), sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) };
}

/** The wait a caller asked for, kept inside the daemon client's own timeout. */
function waitFor(waitSeconds: number | undefined, hooks: RestartHooks): number {
  if (waitSeconds === undefined || !Number.isFinite(waitSeconds)) return hooks.waitTimeoutMs ?? RESTART_WAIT_MS;
  return Math.min(Math.max(1_000, Math.round(waitSeconds * 1000)), RESTART_WAIT_MAX_MS);
}

function matchNote(matched: boolean): string {
  return matched ? 'The session id matches.' : 'herdr reports another session for the new pane, so read it with agent_read before trusting it.';
}

function waitNote(outcome: RestartOutcome): string {
  return outcome.waitedMs === undefined ? '' : ` It waited ${outcome.waitedMs} ms for the turn to end.`;
}

function paneWords(outcome: RestartOutcome): string {
  return `pane ${outcome.newPane}${outcome.newTab ? ` (tab ${outcome.newTab})` : ''}`;
}

/**
 * The agent_restart tool. It resolves the target, refuses what it must, and
 * either acts and answers with the new identity or, for the caller itself,
 * records the request, arms the deferred act and answers first.
 */
export async function runAgentRestart(client: HerdrClient, ownParentId: string, caller: CallerIdentity, hooks: RestartHooks, target?: string, waitSeconds?: number, change?: RouteChange): Promise<string> {
  const changing = change && Object.values(change).some((value) => value !== undefined);
  // A child registered on another machine belongs to its parent's daemon.
  if (!target && caller.childId && readRelayRecord(caller.childId) && !childOfCaller(caller)) {
    throw new RestartRefused(`This session is child ${caller.childId}, registered on another machine, and only its parent's daemon can restart it in place. Report home and ask the parent to run agent_restart.`);
  }
  const resolved = await resolveRestartTarget(client, ownParentId, caller, target);
  const waitTimeoutMs = waitFor(waitSeconds, hooks);
  if (resolved.kind === 'child') {
    if (resolved.self) return deferChildRestart(client, resolved.parent, resolved.child, caller, hooks, changing ? change : undefined);
    const outcome = await restartChild(client, resolved.parent.id, resolved.child.id, hooks, { wait: true, waitTimeoutMs, ...(changing ? { change } : {}) });
    return `Restarted ${outcome.name} (child ${outcome.id}): closed pane ${outcome.oldPane}, started ${outcome.kind} in ${paneWords(outcome)} with ${outcome.command}.${outcome.route ? ` ${outcome.route}` : ''} ${matchNote(outcome.sessionMatched)}${waitNote(outcome)}\nherdr link: ${herdrLink('pane', outcome.newPane)}`;
  }
  if (changing) throw new RestartRefused(`via, model, key_file, provider and reads change how a child starts, and ${resolved.kind === 'parent' ? `session ${resolved.parent.id} is a parent session` : `pane ${resolved.pane.paneId} holds no child of a Bellwether registry`}. Drop them to restart it as it runs, or name a child.`);
  if (resolved.kind === 'parent') {
    if (resolved.self) return deferParentRestart(client, resolved.parent, caller, hooks);
    const outcome = await restartParent(client, resolved.parent.id, hooks, { wait: true, waitTimeoutMs });
    const closed = outcome.oldPane ? `closed pane ${outcome.oldPane}, ` : '';
    return `Restarted ${outcome.name}: ${closed}started ${outcome.kind} in ${paneWords(outcome)} with ${outcome.command}, on the same session. ${matchNote(outcome.sessionMatched)}${waitNote(outcome)}\nherdr link: ${herdrLink('pane', outcome.newPane)}`;
  }
  const pane = resolved.pane;
  throw new RestartRefused(`${pane.name ?? pane.label ?? pane.agent ?? 'The agent'} in pane ${pane.paneId} is not a session any Bellwether registry holds, so agent_restart neither closes that pane nor starts a second copy of its session. Restart it from the session that owns it, or close it and reopen its session by hand.`);
}

async function deferChildRestart(client: HerdrClient, parent: ParentRecord, childNow: ChildRecord, caller: CallerIdentity, hooks: RestartHooks, change?: RouteChange): Promise<string> {
  const child = readParent(parent.id)?.children.find((entry) => entry.id === childNow.id) ?? childNow;
  if (child.restartRequestedAt) return `${child.name} (child ${child.id}) already has a restart pending from ${child.restartRequestedAt}; the daemon acts once its turn ends.`;
  if (!hooks.defer) throw new RestartRefused('This daemon cannot defer a restart, so it cannot restart the session that asked.');
  if (hostOf(child) !== LOCAL_HOST) throw new RestartRefused(`${child.name} runs on machine ${hostOf(child)}, and this daemon only restarts agents on its own machine.`);
  if (child.origin === 'adopt') throw new RestartRefused(`${child.name} (child ${child.id}) was adopted, not started by Bellwether, so agent_restart will not close pane ${child.paneId}: it closes only panes Bellwether started.`);
  const session = sessionOf(child);
  if (!session) throw new RestartRefused(await withSessionCause(`${child.name} (child ${child.id}, pane ${child.paneId || 'none'}) has no recorded session, so agent_restart cannot reopen it. Resume it once with agent_spawn and resume, which records the session herdr reports.`, client, requireHarness(child.kind), child));
  const resume = resumeArgs(child.kind, session);
  // A wrong route, or reads for a harness that takes none, is refused now, while the caller can still read why.
  const launch = nextLaunch(child, change ?? {}, 'restarted');
  if (change?.reads?.length && !requireHarness(child.kind).launchReads) throw new RestartRefused(readsRefusal(requireHarness(child.kind), child.name));
  const paneId = caller.paneId ?? child.paneId;
  if (!paneId) throw new RestartRefused(`${child.name} (child ${child.id}) is in no pane the daemon can watch, so it cannot tell when this turn ends. Ask the parent to restart it with agent_restart.`);
  updateChild(parent.id, child.id, (entry) => {
    entry.restartRequestedAt = new Date().toISOString();
    if (change) entry.restartRoute = change;
    else delete entry.restartRoute;
  });
  hooks.defer(`child:${child.id}`, () => deferredChildRestart(client, parent.id, child.id, paneId, child.tabId, hooks));
  const moved = routeMove(child.route, launch);
  return `Restart requested for ${child.name} (child ${child.id}). Once this turn ends, the daemon closes pane ${paneId} and starts ${child.kind} in a new tab with ${commandWords(child.kind, resume, launch)}, keeping the same child id, so its history and receipts continue.${moved ? ` ${moved}` : ''} Finish your reply first; the new pane carries on this session.`;
}

function deferParentRestart(client: HerdrClient, record: ParentRecord, caller: CallerIdentity, hooks: RestartHooks): string {
  if (record.restartRequestedAt) return `This session already has a restart pending from ${record.restartRequestedAt}; the daemon acts once this turn ends.`;
  if (!hooks.defer) throw new RestartRefused('This daemon cannot defer a restart, so it cannot restart the session that asked.');
  const plan = parentSessionPlan(record);
  const paneId = record.paneId ?? caller.paneId;
  if (!paneId) throw new RestartRefused(`This session is in no herdr pane the daemon knows, so it cannot tell when this turn ends. Ask the operator to restart it.`);
  mutateParent(record.id, (entry) => {
    entry.restartRequestedAt = new Date().toISOString();
  });
  hooks.defer(`parent:${record.id}`, () => deferredParentRestart(client, record.id, paneId, hooks));
  return `Restart requested. Once this turn ends, the daemon closes this pane (${paneId}) and starts ${plan.kind} in a new tab with ${plan.resume.join(' ')} in ${record.cwd}, on the same session. Finish your reply first; the new pane carries on this session.`;
}

/** The deferred half: wait for the caller's turn to end, then restart it in place. */
async function deferredChildRestart(client: HerdrClient, parentId: string, childId: string, paneId: string, tabId: string | undefined, hooks: RestartHooks): Promise<void> {
  const name = readParent(parentId)?.children.find((entry) => entry.id === childId)?.name ?? childId;
  try {
    await waitForTurnEnd(client, name, { paneId, tabId }, { timeoutMs: hooks.deferTimeoutMs ?? RESTART_DEFER_MS, freshOnly: true, signal: hooks.signal });
  } catch (error) {
    // A daemon that stops mid-wait leaves the marker for its next start.
    if (hooks.signal?.aborted) return;
    updateChild(parentId, childId, (entry) => {
      delete entry.restartRequestedAt;
    });
    const message = (error as Error).message;
    hooks.log?.(`deferred restart of ${childId} did not run: ${message}`);
    logRestart({ outcome: 'timeout', target: 'child', parent: parentId, child: childId, error: message });
    return;
  }
  const current = readParent(parentId)?.children.find((entry) => entry.id === childId);
  if (!current?.restartRequestedAt) return;
  try {
    await restartChild(client, parentId, childId, hooks);
  } catch (error) {
    hooks.log?.(`deferred restart of ${childId} failed: ${(error as Error).message}`);
  }
}

async function deferredParentRestart(client: HerdrClient, parentId: string, paneId: string, hooks: RestartHooks): Promise<void> {
  try {
    await waitForTurnEnd(client, parentId, { paneId }, { timeoutMs: hooks.deferTimeoutMs ?? RESTART_DEFER_MS, freshOnly: true, signal: hooks.signal });
  } catch (error) {
    // A daemon that stops mid-wait leaves the marker for its next start.
    if (hooks.signal?.aborted) return;
    mutateParent(parentId, (entry) => {
      delete entry.restartRequestedAt;
    });
    const message = (error as Error).message;
    hooks.log?.(`deferred restart of session ${parentId} did not run: ${message}`);
    logRestart({ outcome: 'timeout', target: 'parent', parent: parentId, error: message });
    return;
  }
  if (!readParent(parentId)?.restartRequestedAt) return;
  try {
    await restartParent(client, parentId, hooks);
  } catch (error) {
    hooks.log?.(`deferred restart of session ${parentId} failed: ${(error as Error).message}`);
  }
}

/**
 * Arm the restarts a daemon stopped part of the way through: a record that
 * still carries `restartRequestedAt` with no `restartedAt` after it. Called
 * when a session's service starts, so a pending act is never lost with the
 * process that was watching it.
 */
export function armPendingRestarts(client: HerdrClient, parent: ParentRecord, hooks: RestartHooks): void {
  if (!hooks.defer) return;
  const fresh = readParent(parent.id) ?? parent;
  const acted = (record: { restartRequestedAt?: string; restartedAt?: string }): boolean => Boolean(record.restartRequestedAt && record.restartedAt && record.restartedAt >= record.restartRequestedAt);
  if (fresh.restartRequestedAt) {
    if (acted(fresh)) {
      mutateParent(fresh.id, (entry) => {
        delete entry.restartRequestedAt;
      });
    } else if (fresh.paneId) {
      const paneId = fresh.paneId;
      hooks.defer(`parent:${fresh.id}`, () => deferredParentRestart(client, fresh.id, paneId, hooks));
    }
  }
  for (const child of fresh.children) {
    if (!child.restartRequestedAt) continue;
    if (acted(child)) {
      updateChild(fresh.id, child.id, (entry) => {
        delete entry.restartRequestedAt;
      });
      continue;
    }
    if (!child.paneId) continue;
    const { paneId, tabId } = child;
    hooks.defer(`child:${child.id}`, () => deferredChildRestart(client, fresh.id, child.id, paneId, tabId, hooks));
  }
}
