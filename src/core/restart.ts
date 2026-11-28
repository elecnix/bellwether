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
// A session that is never idle never ends a turn, so a self-restart's wait is
// bounded (issue #188). While it waits, the daemon holds the Bellwether events
// bound for that session, which stay unread for the new session to take on its
// hello, because those events are what keeps an orchestrator busy. A wait that
// runs out gives up and records what held it, and a second call or
// `bellwether doctor` says what a pending restart waits for.
//
// A child on another machine restarts on that machine (issue #190). The
// parent's daemon sends relay-restart over the relay connection, and the
// daemon there runs the same act against its own herdr, keeping the record in
// memory and answering with the fields the parent's registry takes. A far
// daemon that predates the request answers unknown_type, and the parent
// refuses by name and puts its record back as it was.
//
// The mid-turn rule: never restart a pane that is mid-turn unless the target
// is the caller. For another target the actor waits for herdr to report idle
// or done, with a bounded timeout, and refuses when the wait runs out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMoving } from './move-plan.ts';
import { ChildBusyError, withChildLock } from './child-lock.ts';
import { HerdrApiError, HerdrClient, resolveSocketPath, type HerdrEvent, type HerdrPane, type Subscription } from './herdr-client.ts';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { bellwetherHome } from './paths.ts';
import { withSessionCause } from './herdr-integration.ts';
import { sameSession } from './pane-fate.ts';
import { readRelayRecord } from './relay-records.ts';
import { childOfCaller } from './report.ts';
import { listParents, mutateParent, readParent, recordDecisions, updateChild } from './registry.ts';
import { resumeArgs, sessionOf, type HarnessSession } from './resume.ts';
import { clearRetirement } from './retire.ts';
import { STARTUP_HOLD_MS, STARTUP_TIMEOUT_MS, childArgs, childEnv, childStartFiles, farChildFiles, herdrLink, readsRefusal, hostName, nextLaunch, startHarness, startWithRetry, type NextLaunch, type RouteChange } from './spawn.ts';
import { launchLine, routeLabel, routeLaunch } from './routes.ts';
import { watchStartup, type StartupWatch } from './startup-dialogs.ts';
import { sessionFrom } from './transcript.ts';
import { harnessFor, requireHarness, resolveTranscript } from './harnesses/index.ts';
import type { ChildFiles } from './harnesses/types.ts';
import { REGISTRY_SCHEMA, type CallerIdentity, type ChildRecord, type ChildRoute, type ChildSession, type DialogDecision, type ParentRecord, type RestartFailure, type RestartInDoubt, type RestartStall, type RestartWait } from './types.ts';
import { openReturnTab, parseWorkspaces, returnPlacement, undoChildTab, type ChildTab, type TabRequest, type WorkspacePlacement } from './workspace.ts';
import { RelayAnswerLost } from './relay-answer.ts';

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

/**
 * How long a deferred self-restart watches for the caller's turn to end before
 * it gives up and says what held it (issue #188).
 */
export const RESTART_DEFER_MS = 5 * 60_000;

/**
 * How long the record marks an old pane as closing. herdr answers a close
 * within its 5 s request bound, and the pane list after an error takes as
 * long, so the mark outlasts both and still expires for a daemon that stopped.
 */
export const CLOSING_HOLD_MS = 30_000;

/** The pane and tab a restart is closing for this child, while its mark holds. */
export function closingNow(child: Pick<ChildRecord, 'closing'>, now = Date.now()): ChildRecord['closing'] {
  return child.closing && Date.parse(child.closing.until) > now ? child.closing : undefined;
}

/** Whether herdr still lists a pane or tab, or `undefined` when herdr does not answer. */
async function stillListed(client: HerdrClient, pane: string, tab: string | undefined): Promise<boolean | undefined> {
  try {
    const panes = await client.paneList();
    return panes.some((entry) => (pane && entry.paneId === pane) || (tab !== undefined && entry.tabId === tab));
  } catch {
    return undefined;
  }
}

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
  /**
   * Hold, or release, the Bellwether events bound for the session these hooks
   * serve while its own restart waits for a quiet turn end (issue #188).
   */
  hold?: (held: boolean) => void;
  /** How many events the hold keeps back for the session right now. */
  held?: () => number;
  /** Ask the daemon on a child's machine to restart it there, over the relay. Absent when this daemon holds no relay. */
  relay?: RelayRestart;
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
  /** The workspace the new pane opened in. */
  workspaceId?: string;
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
  /** The machine the child runs on, when it is another one. */
  host?: string;
}

/** What a restart names: a child of a registry, a parent session, or a live agent no registry holds. */
export type RestartTarget =
  | { kind: 'child'; parent: ParentRecord; child: ChildRecord; self: boolean }
  | { kind: 'parent'; parent: ParentRecord; self: boolean }
  | { kind: 'agent'; pane: HerdrPane };

function matchesChild(record: ParentRecord, target: string): ChildRecord | undefined {
  return record.children.find((child) => child.id === target || child.name === target || (child.paneId !== '' && child.paneId === target));
}

const sameSessionValue = sameSession;

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
export async function waitForTurnEnd(client: HerdrClient, label: string, pane: { paneId: string; tabId?: string }, options: { timeoutMs: number; freshOnly?: boolean; readAtDeadline?: boolean; signal?: AbortSignal; onStatus?: (status: string) => void }): Promise<{ waitedMs: number } | undefined> {
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
          if (typeof next === 'string' && next !== status) {
            status = next;
            options.onStatus?.(next);
          }
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
  const timedOut = (): void => fail(new RestartRefused(`${label} is still ${status} after the ${(options.timeoutMs / 1000).toFixed(1)} s wait; agent_restart never restarts a pane mid-turn. Ask it to finish, or call again once it is idle.`));
  const timer = setTimeout(() => {
    if (!options.readAtDeadline) return timedOut();
    // herdr sends no change for a pane whose status stays as it was, so a
    // turn that ended while it read idle never ends the wait. One read at
    // the deadline takes the fact that is there rather than wait for an event
    // that may never come (issue #220). It is a snapshot at a bound, not a poll.
    client.request('agent.get', { target: pane.paneId }).then(
      (result) => {
        const value = agentInfo(result)['agent_status'];
        if (typeof value === 'string' && value && value !== status) {
          status = value;
          options.onStatus?.(value);
        }
        if (value === 'idle' || value === 'done') settle('idle');
        else timedOut();
      },
      (error: unknown) => {
        if (error instanceof HerdrApiError && (error.code === 'agent_not_found' || error.code === 'pane_not_found')) settle('gone');
        else timedOut();
      },
    );
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
      options.onStatus?.(current);
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
  /** The tab label for a parent session whose pane is gone, when its record keeps none. */
  label?: string;
  /**
   * For `bellwether resume`, which has checked that no pane holds the session:
   * the pane on the parent's record is gone or holds someone else now, so the
   * start neither closes it nor reads it as the session.
   */
  paneGone?: boolean;
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
  // A move closes and reopens the child itself, and outlasts the lock's stale age.
  if (isMoving(child)) throw new RestartRefused(`${child.name} (child ${child.id}) is being moved to ${child.moving?.to === LOCAL_HOST ? 'this machine' : `machine ${child.moving?.to}`}, since ${child.moving?.since}. Wait for the move to finish, then restart it.`);
  // A lost answer leaves the far side's state unknown: the session may already run in a new pane there (issue #211).
  if (child.restartInDoubt) throw new RestartRefused(`the outcome of the last restart of ${child.name} on machine ${child.restartInDoubt.host} is unknown since ${child.restartInDoubt.at}, so a second restart could start the session twice. The daemon there keeps its answer, and this daemon takes it when the connection to ${child.restartInDoubt.host} returns; restart it after that.`);
  if (child.origin === 'adopt') throw new RestartRefused(`${child.name} (child ${child.id}) was adopted, not started by Bellwether, so agent_restart will not close pane ${child.paneId}: it closes only panes Bellwether started.`);
  const session = sessionOf(child);
  if (!session) throw new RestartRefused(await withSessionCause(`${child.name} (child ${child.id}, pane ${child.paneId || 'none'}) has no recorded session, so agent_restart cannot reopen it. Resume it once with agent_spawn and resume, which records the session herdr reports.`, client, requireHarness(child.kind), child));
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
  if (hostOf(child) !== LOCAL_HOST) return restartRemoteChild(parent, child, session, launch, hooks, options);

  const store: RestartStore = {
    parent,
    update: (change) => void updateChild(parentId, child.id, change),
    decisions: (decisions) => recordDecisions(parentId, child.id, decisions),
    // The same start files a spawn and a resume give it: a Claude Code
    // child's own MCP configuration, and the extension a pi child loads.
    startFiles: (entry, model) => childStartFiles(parent, entry, undefined, undefined, hooks.piExtension, model),
  };
  return restartInPlace(client, store, child, session, launch, hooks, options);
}

/**
 * Where a restart keeps the child's record while it acts: the parent's
 * registry on the parent's machine, or, on a child's machine that restarts it
 * for a parent elsewhere, a copy in memory whose fields go back to that
 * parent's daemon in the answer.
 */
interface RestartStore {
  parent: ParentRecord;
  update(change: (entry: ChildRecord) => void): void;
  decisions(decisions: readonly DialogDecision[]): void;
  /** The files the child starts with, and the variables its tab adds. */
  startFiles(child: ChildRecord, model?: string): Promise<ChildFiles>;
}

/**
 * The act of a restart on the machine the child runs on: open the new tab,
 * close the old pane, start the same harness on the same session in the new
 * tab under the same child id, and read the session herdr reports there.
 */
async function restartInPlace(client: HerdrClient, store: RestartStore, child: ChildRecord, session: HarnessSession, launch: NextLaunch, hooks: RestartHooks, options: RestartOptions): Promise<RestartOutcome> {
  const parentId = store.parent.id;
  const resume = resumeArgs(child.kind, session);
  let waitedMs: number | undefined;
  if (options.wait && child.paneId) {
    const wait = await waitForTurnEnd(client, child.name, { paneId: child.paneId, tabId: child.tabId }, { timeoutMs: options.waitTimeoutMs ?? hooks.waitTimeoutMs ?? RESTART_WAIT_MS, signal: hooks.signal });
    waitedMs = wait?.waitedMs;
  }

  const oldPane = child.paneId;
  const oldTab = child.tabId;
  const workspaceId = child.workspaceId ?? store.parent.workspaceId;
  // 1. Open the new tab while the old one still holds its workspace open
  // (issue #185). Nothing has changed yet, so a failure here leaves the child
  // running where it was.
  let files: ChildFiles;
  let opened: ChildTab;
  try {
    files = await store.startFiles(child, launch.harnessModel);
    // A child in a workspace Bellwether made for it goes back there, or to a
    // new one under the same label once herdr has closed it.
    const placement = await returnPlacement(client, child, workspaceId);
    opened = await openRestartTab(client, placement, { cwd: child.cwd, label: child.name, env: { ...childEnv(store.parent, child, files.piExtension), ...files.env }, focus: false }, child.workspaceLabel || child.name);
  } catch (error) {
    throw new RestartRefused(`the new tab for ${child.name} did not open, so the restart stopped before closing ${oldTab ? `tab ${oldTab}` : `pane ${oldPane || '(none)'}`} and nothing changed: ${(error as Error).message}`);
  }
  const newPane = opened.paneId as string;
  const newTab = opened.tabId ?? newPane;
  const toolSource = files.toolSource;

  // 2. The record marks the old pane as closing before herdr closes it, so the
  // close is read as part of this restart, not as the child exiting. It keeps
  // naming that pane, which exists until herdr closes it: a daemon that stops
  // mid-close leaves a record that names a real pane (issue #211).
  // From here the act runs to the end. Closing the caller's own tab makes its
  // adapter say bye, which stops its service, so the act takes no signal.
  store.update((entry) => {
    delete entry.reportPending;
    delete entry.restartRequestedAt;
    delete entry.restartRoute;
    entry.closing = { pane: oldPane, ...(oldTab ? { tab: oldTab } : {}), until: new Date(Date.now() + CLOSING_HOLD_MS).toISOString() };
    entry.startingUntil = new Date(Date.now() + STARTUP_HOLD_MS).toISOString();
  });
  // 3. Close what Bellwether started. herdr can close the tab and still answer
  // an error, as a timeout does, so an error is checked against herdr's pane
  // list before the restart decides what the close did (issue #211).
  const closed = oldTab ? `tab ${oldTab}` : `pane ${oldPane}`;
  let closeError: string | undefined;
  try {
    if (oldTab) await client.tabClose(oldTab);
    else if (oldPane) await client.paneClose(oldPane);
  } catch (error) {
    closeError = (error as Error).message;
    const listed = await stillListed(client, oldPane, oldTab);
    if (listed !== false) {
      await undoChildTab(client, opened);
      store.update((entry) => {
        delete entry.closing;
        delete entry.startingUntil;
      });
      if (listed) throw new RestartRefused(`closing ${child.name}'s ${closed} failed, and herdr still lists pane ${oldPane}, so the restart stopped and nothing else changed: ${closeError}`);
      // herdr answered neither the close nor the pane list. The record keeps
      // naming the old pane, and the watcher's next pass reads whether it is gone.
      hooks.log?.(`restart ${child.name}: closing ${closed} failed and herdr did not list its panes, so whether ${oldPane} is open is unknown: ${closeError}`);
      logRestart({ outcome: 'failed', target: 'child', parent: parentId, child: child.id, name: child.name, oldPane, session: session.value, error: closeError, oldPaneState: 'unknown' });
      throw new RestartRefused(`closing ${child.name}'s ${closed} failed, and herdr then did not list its panes, so Bellwether cannot tell whether pane ${oldPane} is still open. The restart stopped and closed the new tab. The record still names ${oldPane}, and the watcher reports the child exited if herdr no longer has it: ${closeError}`);
    }
    // herdr no longer lists the old pane: the close did its work, so the restart goes on.
    hooks.log?.(`restart ${child.name}: herdr answered an error to closing ${closed} but no longer lists ${oldPane}, so the restart goes on: ${closeError}`);
  }

  // 4. Start the same harness on the same session in the new tab, under the
  // same child id and with the same environment.
  let startup: StartupWatch | undefined;
  try {
    // The record names the new pane before the harness starts, as a spawn does.
    store.update((entry) => {
      entry.paneId = newPane;
      delete entry.closing;
      if (toolSource) entry.toolSource = toolSource;
      if (opened.tabId) entry.tabId = opened.tabId;
      if (opened.workspaceId) entry.workspaceId = opened.workspaceId;
      if (opened.workspaceLabel) entry.workspaceLabel = opened.workspaceLabel;
      if (opened.ownsWorkspace) entry.ownsWorkspace = true;
    });
    const dialogs = requireHarness(child.kind).startup;
    if (dialogs) {
      const timeoutMs = hooks.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      store.update((entry) => {
        entry.startingUntil = new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString();
      });
      // The watch opens before the start: the dialog appears with the harness.
      startup = await watchStartup(client, newPane, undefined, { timeoutMs, redrawMs: hooks.redrawMs, dialogs, by: 'restart' });
    }
    const harnessArgs = childArgs(child.kind, { model: launch.harnessModel, provider: launch.provider }, files, { resume });
    await startHarness(client, { name: child.name, kind: child.kind, paneId: newPane, args: harnessArgs, ...(launch.route && launch.config ? { launch: routeLaunch(launch.config, launch.route, child.kind, harnessArgs) } : {}) });
    if (startup) {
      await startup.answer();
      store.decisions(startup.decisions);
      startup.close();
    }
  } catch (error) {
    startup?.close();
    await undoChildTab(client, opened);
    const message = (error as Error).message;
    const failure: RestartFailure = { at: new Date().toISOString(), oldPane, ...(workspaceId ? { workspaceId } : {}), session: session.value, error: message, reopen: `agent_spawn and resume ${session.value}` };
    store.update((entry) => markRestartFailed(entry, failure));
    hooks.log?.(`restart ${child.name} failed after closing ${oldPane}: ${message}`);
    logRestart({ outcome: 'failed', target: 'child', parent: parentId, child: child.id, name: child.name, oldPane, session: session.value, error: message });
    throw new RestartRefused(`${child.name} did not come back: ${message}. Its old pane ${oldPane} is closed, so it is gone; bring it back with agent_spawn and resume ${session.value}.`);
  }

  // 5. Read the session herdr reports for the new pane, and record whether it
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
  store.update((entry) => {
    markRestarted(entry, { session: reported ?? { kind: session.kind, value: session.value }, ...(status ? { status } : {}), launch });
    const transcript = requireHarness(entry.kind).conversation.locate(entry.session?.value, entry.cwd).path;
    if (transcript) entry.transcript = transcript;
  });
  hooks.reset?.(child.id);
  hooks.log?.(`restart ${child.name}: closed ${oldPane}, opened ${newPane} on session ${session.value}, ${matched ? 'the session matched' : `herdr reported ${reported?.value ?? 'no session'}`}`);
  logRestart({ outcome: 'restarted', target: 'child', parent: parentId, child: child.id, name: child.name, oldPane, newPane, ...(newTab ? { newTab } : {}), session: session.value, sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}), ...(closeError ? { closeError } : {}) });
  const landed = opened.workspaceId ?? workspaceId;
  return { target: 'child', id: child.id, name: child.name, oldPane, newPane, ...(newTab ? { newTab } : {}), ...(landed ? { workspaceId: landed } : {}), session: session.value, kind: child.kind, command: commandWords(child.kind, resume, launch), route: routeMove(child.route, launch), sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) };
}

/** Put on a record that a restart closed the child's pane and could not start it again. */
function markRestartFailed(entry: ChildRecord, failure: RestartFailure): void {
  // The record names the pane the child last ran in, which the failure closed.
  entry.paneId = failure.oldPane;
  delete entry.tabId;
  entry.exitedAt = failure.at;
  entry.lastStatus = 'unknown';
  entry.restartFailed = failure;
  delete entry.closing;
  entry.paneEnd = { pane: failure.oldPane, ...(failure.workspaceId ? { workspaceId: failure.workspaceId } : {}), how: 'restart', at: failure.at };
  delete entry.startingUntil;
  delete entry.restartRequestedAt;
}

/** Put on a record that the child runs again on its session, after a restart on whichever machine it runs on. */
function markRestarted(entry: ChildRecord, back: { session: ChildSession; status?: ChildRecord['lastStatus']; launch: NextLaunch }): void {
  const at = new Date().toISOString();
  entry.session = back.session;
  if (back.status && entry.lastStatus !== back.status) entry.statusChangedAt = at;
  entry.lastStatus = back.status ?? 'unknown';
  entry.lastBusyAt = at;
  entry.resumedAt = at;
  entry.restartedAt = at;
  applyLaunch(entry, back.launch);
  delete entry.startingUntil;
  delete entry.closing;
  delete entry.restartInDoubt;
  delete entry.exitedAt;
  delete entry.exitCode;
  delete entry.paneEnd;
  delete entry.restartRequestedAt;
  delete entry.restartFailed;
  // The new harness has yet to show herdr it runs, and the watcher checks it once after its start window.
  delete entry.harnessSeenAt;
  delete entry.harnessEnded;
  delete entry.tabClosedAt;
  // A child brought back did not ask for this run to end its worktree.
  clearRetirement(entry);
}

/**
 * What the parent's registry holds about a child on another machine, and the
 * daemon there needs to restart it: where it runs, how it starts, and its
 * session. The parent decides the launch, so a model or provider change is
 * checked on the parent's machine, where the child's record lives.
 */
export interface RelayRestartChild {
  name: string;
  kind: string;
  harness: string;
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  ownsWorkspace?: boolean;
  cwd?: string;
  depth: number;
  maxDepth?: number;
  reads?: string[];
  session: { kind: string; value: string };
  launch?: { harnessModel?: string; provider?: string };
}

/** The fields of the child's record that a restart on its own machine hands back to the parent's registry. */
export interface RelayRestartRecord {
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  ownsWorkspace?: boolean;
  session?: ChildSession;
  lastStatus?: ChildRecord['lastStatus'];
  toolSource?: ChildRecord['toolSource'];
}

/**
 * The answer of the daemon on a child's machine to a relay restart. A refusal
 * changed nothing there. A failure after the old pane closed carries the
 * failure, so the parent's record says the child is gone.
 */
export type RelayRestartAnswer =
  | { restarted: true; outcome: RestartOutcome; record: RelayRestartRecord; decisions?: DialogDecision[] }
  | { restarted: false; reason: string; failure?: RestartFailure; decisions?: DialogDecision[] };

/** What a parent's daemon sends to restart a child on another machine. */
export interface RelayRestartAsk {
  parentId: string;
  childId: string;
  child: RelayRestartChild;
  waitTimeoutMs?: number;
  /** Names the request, so the far daemon keeps its answer in the relay outbox too (issue #211). */
  requestId?: string;
}

/** Ask the daemon on a child's machine to restart the child there, over the relay. */
export type RelayRestart = (host: string, ask: RelayRestartAsk) => Promise<RelayRestartAnswer>;

/**
 * Restart a child on another machine, from its parent's daemon (issue #190).
 * The daemon there holds the child's pane, its herdr and its start files, so
 * it does the act, as this daemon does for a child here, and answers with the
 * new pane. This daemon's record marks the old pane as closing first, so its
 * watcher reads the close there as part of the restart, and takes the new
 * pane from the answer. A refusal there puts the record back as it was. A
 * connection that ends after the request went out leaves the record in doubt,
 * never claiming an outcome, until the far side's kept answer arrives.
 */
async function restartRemoteChild(parent: ParentRecord, child: ChildRecord, session: HarnessSession, launch: NextLaunch, hooks: RestartHooks, options: RestartOptions): Promise<RestartOutcome> {
  const host = hostOf(child);
  const refused = (reason: string): RestartRefused => new RestartRefused(`${child.name} runs on machine ${host}, and it was not restarted: ${reason}`);
  if (!hooks.relay) throw refused('this daemon holds no relay connection to that machine, which a restart there goes through.');
  const waitTimeoutMs = options.wait ? (options.waitTimeoutMs ?? hooks.waitTimeoutMs ?? RESTART_WAIT_MS) : undefined;
  const ask: RelayRestartAsk = {
    parentId: parent.id,
    childId: child.id,
    child: {
      name: child.name,
      kind: child.kind,
      harness: child.harness,
      paneId: child.paneId,
      ...(child.tabId ? { tabId: child.tabId } : {}),
      ...(child.workspaceId ? { workspaceId: child.workspaceId } : {}),
      ...(child.workspaceLabel ? { workspaceLabel: child.workspaceLabel } : {}),
      ...(child.ownsWorkspace ? { ownsWorkspace: true } : {}),
      ...(child.cwd ? { cwd: child.cwd } : {}),
      depth: child.depth,
      ...(child.maxDepth === undefined ? {} : { maxDepth: child.maxDepth }),
      ...(child.reads?.length ? { reads: child.reads } : {}),
      session: { kind: session.kind, value: session.value },
      ...(launch.harnessModel || launch.provider ? { launch: { ...(launch.harnessModel ? { harnessModel: launch.harnessModel } : {}), ...(launch.provider ? { provider: launch.provider } : {}) } } : {}),
    },
    ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
  };
  const oldPane = child.paneId;
  const oldTab = child.tabId;
  const held = { startingUntil: child.startingUntil };
  const restore = (): void => {
    updateChild(parent.id, child.id, (entry) => {
      delete entry.closing;
      if (held.startingUntil) entry.startingUntil = held.startingUntil;
      else delete entry.startingUntil;
    });
  };
  // The hold covers the wait for a turn there, the startup dialogs and the start.
  const holdMs = (waitTimeoutMs ?? 0) + Math.max(STARTUP_HOLD_MS, (hooks.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) + 15_000);
  // The record keeps naming the old pane, marked as closing, so the watcher
  // reads the close there as part of the restart, and a record left by a
  // daemon that stops mid-restart names a real pane (issue #211). The mark
  // outlasts the relay's own bound on the answer.
  updateChild(parent.id, child.id, (entry) => {
    entry.closing = { pane: oldPane, ...(oldTab ? { tab: oldTab } : {}), until: new Date(Date.now() + holdMs + 2 * STARTUP_TIMEOUT_MS + CLOSING_HOLD_MS).toISOString() };
    entry.startingUntil = new Date(Date.now() + holdMs).toISOString();
  });
  const requestId = `rs-${crypto.randomBytes(8).toString('hex')}`;
  let answer: RelayRestartAnswer;
  try {
    answer = await hooks.relay(host, { ...ask, requestId });
  } catch (error) {
    const message = (error as Error).message;
    if (!(error instanceof RelayAnswerLost)) {
      // The request never went out, so nothing there changed.
      restore();
      throw refused(message);
    }
    // The request went out and its answer did not come back. The far side may
    // have closed the old pane and started the session in a new one, so the
    // record claims neither until that side's kept answer arrives.
    const doubt: RestartInDoubt = { host, requestId, at: new Date().toISOString(), oldPane, ...(oldTab ? { oldTab } : {}), error: message, launch: launchOnRecord(launch) };
    updateChild(parent.id, child.id, (entry) => {
      delete entry.closing;
      delete entry.startingUntil;
      entry.restartInDoubt = doubt;
    });
    hooks.log?.(`restart ${child.name} on machine ${host}: the answer was lost with the connection, so the outcome is unknown until ${host} hands over its kept answer: ${message}`);
    logRestart({ outcome: 'unknown', target: 'child', host, parent: parent.id, child: child.id, name: child.name, oldPane, session: session.value, requestId, error: message });
    throw new RestartRefused(`${child.name} runs on machine ${host}, and the connection to ${host} ended after the restart request went out and before its answer came back, so Bellwether does not know whether ${host} restarted it: ${message}. The daemon on ${host} keeps its answer, and this daemon takes it when the connection returns. Until then the record marks the outcome as unknown.`);
  }
  return settleRemoteRestart(parent.id, child, host, session.value, launchOnRecord(launch), answer, hooks, { undo: restore, refused });
}

/** What a restart puts on the record about the route, without the route's launcher settings. */
function launchOnRecord(launch: NextLaunch): RestartInDoubt['launch'] {
  return { ...(launch.route ? { route: launch.route } : {}), ...(launch.harnessModel ? { harnessModel: launch.harnessModel } : {}), ...(launch.provider ? { provider: launch.provider } : {}) };
}

/**
 * Put a far daemon's answer to a restart on the parent's record: the new pane,
 * the failure after the old pane closed, or the refusal that changed nothing
 * there. It serves the answer to the request and the answer kept in the relay
 * outbox after a lost connection alike (issue #211).
 */
function settleRemoteRestart(parentId: string, child: ChildRecord, host: string, sessionValue: string, launch: RestartInDoubt['launch'], answer: RelayRestartAnswer, hooks: RestartHooks, how: { undo: () => void; refused: (reason: string) => RestartRefused; learned?: boolean }): RestartOutcome {
  const learned = how.learned ? { learned: true } : {};
  if (answer.decisions?.length) recordDecisions(parentId, child.id, answer.decisions);
  if (!answer.restarted) {
    if (!answer.failure) {
      how.undo();
      if (how.learned) logRestart({ outcome: 'refused', target: 'child', host, parent: parentId, child: child.id, name: child.name, session: sessionValue, error: answer.reason, ...learned });
      throw how.refused(answer.reason);
    }
    const failure = answer.failure;
    updateChild(parentId, child.id, (entry) => {
      delete entry.restartInDoubt;
      markRestartFailed(entry, failure);
    });
    hooks.log?.(`restart ${child.name} on machine ${host} failed after closing ${failure.oldPane}: ${failure.error}`);
    logRestart({ outcome: 'failed', target: 'child', host, parent: parentId, child: child.id, name: child.name, oldPane: failure.oldPane, session: sessionValue, error: failure.error, ...learned });
    throw new RestartRefused(`${child.name} did not come back on machine ${host}: ${failure.error}. Its old pane ${failure.oldPane} there is closed, so it is gone; bring it back with agent_spawn and resume ${sessionValue}.`);
  }
  const { record, outcome } = answer;
  updateChild(parentId, child.id, (entry) => {
    entry.paneId = record.paneId;
    if (record.tabId) entry.tabId = record.tabId;
    else delete entry.tabId;
    if (record.workspaceId) entry.workspaceId = record.workspaceId;
    if (record.workspaceLabel) entry.workspaceLabel = record.workspaceLabel;
    if (record.ownsWorkspace) entry.ownsWorkspace = true;
    if (record.toolSource) entry.toolSource = record.toolSource;
    delete entry.reportPending;
    delete entry.restartRoute;
    delete entry.restartInDoubt;
    // A remote child's transcript stays on its own machine's disk.
    markRestarted(entry, { session: record.session ?? { kind: child.session?.kind ?? 'id', value: sessionValue }, ...(record.lastStatus ? { status: record.lastStatus } : {}), launch });
  });
  hooks.reset?.(child.id);
  hooks.log?.(`restart ${child.name} on machine ${host}: closed ${outcome.oldPane}, opened ${outcome.newPane} on session ${sessionValue}${how.learned ? ', learned from the answer kept there' : ''}`);
  logRestart({ outcome: 'restarted', target: 'child', host, parent: parentId, child: child.id, name: child.name, oldPane: outcome.oldPane, newPane: outcome.newPane, ...(outcome.newTab ? { newTab: outcome.newTab } : {}), session: sessionValue, sessionMatched: outcome.sessionMatched, ...(outcome.waitedMs !== undefined ? { waitedMs: outcome.waitedMs } : {}), ...learned });
  return { ...outcome, target: 'child', id: child.id, name: child.name, host, route: routeMove(child.route, launch) };
}

/**
 * The answer a far daemon kept in its relay outbox for a restart whose
 * answer was lost with the connection (issue #211). It settles the record
 * only while the record is in doubt about that very request: an answer that
 * already came back on the request, or one for an older request, changes
 * nothing. Returns what it did, for the daemon's log.
 */
export function learnRelayRestart(parentId: string, childId: string, host: string, requestId: string, answer: RelayRestartAnswer, hooks: RestartHooks = {}): string {
  const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
  const doubt = child?.restartInDoubt;
  if (!child || !doubt || doubt.requestId !== requestId || doubt.host !== host) return `the answer of restart ${requestId} of child ${childId} from machine ${host} was already settled`;
  const undo = (): void => {
    updateChild(parentId, childId, (entry) => {
      delete entry.restartInDoubt;
    });
  };
  const refused = (reason: string): RestartRefused => new RestartRefused(reason);
  try {
    const outcome = settleRemoteRestart(parentId, child, host, child.session?.value ?? '', doubt.launch, answer, hooks, { undo, refused, learned: true });
    return `child ${childId} came back on machine ${host} in pane ${outcome.newPane}, as the answer kept there says`;
  } catch (error) {
    return `child ${childId} on machine ${host}: ${(error as Error).message}`;
  }
}

/** What a far daemon needs to restart a child here for a parent on another machine. */
export interface FarRestartOptions {
  /** The herdr session the parent reaches this machine through. Absent or `default`, the socket herdr itself would pick. */
  herdrSession?: string;
  waitTimeoutMs?: number;
  /** Hooks for the act: waits, startup timing and the log. */
  hooks?: RestartHooks;
  /** A herdr client for a socket, which tests replace. */
  connect?: (socketPath: string) => HerdrClient;
}

/**
 * The daemon on a child's machine restarts the child for its parent on
 * another machine (issue #190): the same act as a restart here, against this
 * machine's herdr, with the child's start files written here as
 * `bellwether relay-register` wrote them. It refuses, and changes nothing,
 * when this machine holds no relay record of the child for that parent, when
 * the child's session is not on this machine, and when no herdr answers here.
 */
export async function restartForRelay(parentId: string, childId: string, wanted: RelayRestartChild, options: FarRestartOptions = {}): Promise<RelayRestartAnswer> {
  const relay = readRelayRecord(childId);
  if (!relay || relay.parentId !== parentId || relay.retiredAt) return { restarted: false, reason: `that machine holds no running child ${childId} for parent ${parentId}.` };
  if (relay.adopted) return { restarted: false, reason: `${wanted.name} was adopted on that machine, not started by Bellwether, so agent_restart will not close pane ${wanted.paneId}: it closes only panes Bellwether started.` };
  const entry = harnessFor(wanted.kind);
  if (!entry) return { restarted: false, reason: `that machine's Bellwether knows no ${wanted.kind} harness, so it cannot start the child again.` };
  const cwd = wanted.cwd ?? relay.cwd;
  const found = entry.conversation.locate(wanted.session.value, cwd);
  if (!found.path) return { restarted: false, reason: `session ${wanted.session.value} is not on that machine: ${found.missing ?? 'its harness keeps no file for it there'}` };
  const socketPath = options.herdrSession && options.herdrSession !== 'default' ? resolveSocketPath({ session: options.herdrSession }) : resolveSocketPath();
  if (!fs.existsSync(socketPath)) return { restarted: false, reason: `no herdr answers on that machine at ${socketPath}, so nothing there can close the child's pane or open its new tab.` };
  const client = options.connect?.(socketPath) ?? new HerdrClient({ socketPath });
  try {
    await client.request('agent.list', {});
  } catch (error) {
    return { restarted: false, reason: `no herdr answers on that machine at ${socketPath}, so nothing there can close the child's pane or open its new tab: ${(error as Error).message}` };
  }

  const at = new Date().toISOString();
  const session: HarnessSession = { value: wanted.session.value, kind: wanted.session.kind === 'path' ? 'path' : 'id' };
  // The child as this machine runs it: here, under the parent's child id.
  let held: ChildRecord = {
    id: childId,
    name: wanted.name,
    kind: wanted.kind,
    harness: wanted.harness,
    paneId: wanted.paneId,
    ...(wanted.tabId ? { tabId: wanted.tabId } : {}),
    ...(wanted.workspaceId ? { workspaceId: wanted.workspaceId } : {}),
    ...(wanted.workspaceLabel ? { workspaceLabel: wanted.workspaceLabel } : {}),
    ...(wanted.ownsWorkspace ? { ownsWorkspace: true } : {}),
    ...(cwd ? { cwd } : {}),
    host: LOCAL_HOST,
    origin: 'spawn',
    startedAt: relay.registeredAt,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    depth: wanted.depth,
    ...(wanted.maxDepth === undefined ? {} : { maxDepth: wanted.maxDepth }),
    ...(wanted.reads?.length ? { reads: wanted.reads } : {}),
    session: { kind: session.kind, value: session.value },
  };
  const decisions: DialogDecision[] = [];
  // The parent's registry is on its own machine. The act reads only its id, for the child's environment.
  const parent: ParentRecord = { schema: REGISTRY_SCHEMA, id: parentId, harness: wanted.harness as ParentRecord['harness'], session: parentId, host: 'another machine', cwd: cwd ?? '', depth: Math.max(0, wanted.depth - 1), children: [], updatedAt: at };
  const store: RestartStore = {
    parent,
    update: (change) => {
      const next = structuredClone(held);
      change(next);
      held = next;
    },
    decisions: (list) => void decisions.push(...list),
    // The files relay-register wrote at the spawn, written again here, so the
    // new tab gets this machine's paths and variables.
    startFiles: async (child) => farChildFiles(child),
  };
  const launch: NextLaunch = { ...(wanted.launch?.harnessModel ? { harnessModel: wanted.launch.harnessModel } : {}), ...(wanted.launch?.provider ? { provider: wanted.launch.provider } : {}) };
  const hooks = options.hooks ?? {};
  try {
    const outcome = await withChildLock(childId, `${wanted.name} (child ${childId})`, `restart of ${wanted.name} for a parent on another machine`, () =>
      restartInPlace(client, store, held, session, launch, hooks, { wait: options.waitTimeoutMs !== undefined, ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }) }), undefined, undefined, { action: 'restarted' });
    const record: RelayRestartRecord = {
      paneId: held.paneId,
      ...(held.tabId ? { tabId: held.tabId } : {}),
      ...(held.workspaceId ? { workspaceId: held.workspaceId } : {}),
      ...(held.workspaceLabel ? { workspaceLabel: held.workspaceLabel } : {}),
      ...(held.ownsWorkspace ? { ownsWorkspace: true } : {}),
      ...(held.session ? { session: held.session } : {}),
      lastStatus: held.lastStatus,
      ...(held.toolSource ? { toolSource: held.toolSource } : {}),
    };
    return { restarted: true, outcome, record, ...(decisions.length ? { decisions } : {}) };
  } catch (error) {
    if (!(error instanceof RestartRefused) && !(error instanceof ChildBusyError)) throw error;
    return { restarted: false, reason: error.message, ...(held.restartFailed ? { failure: held.restartFailed } : {}), ...(decisions.length ? { decisions } : {}) };
  }
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
async function openRestartTab(client: HerdrClient, placement: WorkspacePlacement, tab: TabRequest, label: string): Promise<ChildTab> {
  const opened = await openReturnTab(client, placement, tab, label);
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
    if (own) found.push({ at: own.at, line: `fail  restart: session ${parent.id} (${parent.harness}, ${where(own)}) did not come back at ${own.at}: ${own.error}. Bring it back with ${own.reopen}.` });
    for (const child of parent.children) {
      const failure = child.restartFailed;
      if (failure) found.push({ at: failure.at, line: `fail  restart: ${child.name} (child ${child.id} of ${parent.id}, ${where(failure)}) did not come back at ${failure.at}: ${failure.error}. Bring it back with ${failure.reopen}.` });
    }
  }
  return found.sort((a, b) => b.at.localeCompare(a.at)).map((entry) => entry.line);
}

/**
 * The `bellwether doctor` lines for each pending self-restart, saying what it
 * waits for, and for each one that gave up, saying what held it (issue #188),
 * and for each restart on another machine whose answer was lost (issue #211).
 */
export function restartWaitLines(parents: ParentRecord[]): string[] {
  const pendingLine = (who: string, requestedAt: string, wait: RestartWait | undefined, facts: { messages?: number; working?: ChildRecord[] }): string =>
    wait ? `info  restart: ${restartWaitText(who, requestedAt, wait, facts)}` : `warn  restart: ${who} has a restart requested at ${requestedAt} that nothing waits on, so it never runs on its own. Call agent_restart again from the session to replace it (issue #220).`;
  const stallLine = (who: string, stall: RestartStall): string =>
    `warn  restart: ${who} gave up ${stall.requestedAt ? `the restart it requested at ${stall.requestedAt}${stall.paneId ? ` on pane ${stall.paneId}` : ''}, at ${stall.at}` : `a restart at ${stall.at}`}: ${stall.reason}`;
  const restartedSince = (record: { restartedAt?: string }, stall: RestartStall): boolean => Boolean(record.restartedAt && record.restartedAt >= stall.at);
  const lines: string[] = [];
  for (const parent of parents) {
    if (parent.restartRequestedAt) lines.push(pendingLine(`session ${parent.id}`, parent.restartRequestedAt, parent.restartWait, { working: workingChildren(parent.id) }));
    else if (parent.restartStalled && !restartedSince(parent, parent.restartStalled)) lines.push(stallLine(`session ${parent.id}`, parent.restartStalled));
    for (const child of parent.children) {
      const who = `${child.name} (child ${child.id} of ${parent.id})`;
      if (child.restartRequestedAt) lines.push(pendingLine(who, child.restartRequestedAt, child.restartWait, { messages: messagesSince(child, child.restartRequestedAt) }));
      else if (child.restartStalled && !restartedSince(child, child.restartStalled)) lines.push(stallLine(who, child.restartStalled));
      const doubt = child.restartInDoubt;
      if (doubt) lines.push(`warn  restart: ${who} on machine ${doubt.host}: the answer to its restart at ${doubt.at} was lost with the connection, so the outcome is unknown until the daemon there hands over the answer it kept (${doubt.error}). Its pane before the restart was ${doubt.oldPane || '(none)'}.`);
    }
  }
  return lines;
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
  const asChild = options.paneGone ? undefined : sessionAsChild(record.paneId);
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
  const live = record.paneId && !options.paneGone ? agents.find((pane) => pane.paneId === record.paneId) : undefined;
  // The session running in a pane its record does not name is not this
  // daemon's to close, and starting it again would make a second copy.
  const elsewhere = agents.find((pane) => pane.paneId !== live?.paneId && (sameSessionValue(pane.agentSessionId, record.session) || sameSessionValue(pane.agentSessionId, plan.sessionValue)));
  if (elsewhere) throw new RestartRefused(`session ${record.id} already runs in pane ${elsewhere.paneId} (workspace ${elsewhere.workspaceId}), not in pane ${record.paneId ?? '(none)'} that its record names, so agent_restart closed nothing and started nothing. Its record follows it to pane ${elsewhere.paneId} once its Bellwether adapter connects from there.`);
  if (live) {
    // The pane on the record must still be this session, or closing it would
    // end something else.
    if (live.agent && live.agent !== plan.kind) throw new RestartRefused(`pane ${live.paneId} now runs ${live.agent}, not the ${plan.kind} session ${record.id}, so agent_restart closed nothing and started nothing.`);
    if (live.agentSessionId && !sameSessionValue(live.agentSessionId, record.session) && !sameSessionValue(live.agentSessionId, plan.sessionValue)) {
      throw new RestartRefused(`pane ${live.paneId} now holds session ${live.agentSessionId}, not ${record.session}, so agent_restart closed nothing and started nothing.`);
    }
  }
  const label = live?.label ?? live?.name ?? options.label ?? record.label ?? record.harness;
  let waitedMs: number | undefined;
  if (options.wait && live) {
    const wait = await waitForTurnEnd(client, label, { paneId: live.paneId, tabId: live.tabId }, { timeoutMs: options.waitTimeoutMs ?? hooks.waitTimeoutMs ?? RESTART_WAIT_MS, signal: hooks.signal });
    waitedMs = wait?.waitedMs;
  }

  const oldPane = live?.paneId ?? '';
  const workspaceNow = live?.workspaceId ?? record.workspaceId;
  const args = plan.kind === 'claude' ? [PARENT_CHANNEL_ARG, ...plan.resume] : plan.resume;
  const reopen = `${plan.kind} ${args.join(' ')}`;
  const bringBack = `\`bellwether resume ${record.id}\`, or by hand with \`${reopen}\` in ${record.cwd}`;
  // Open the new tab while the old pane still holds its workspace open (issue
  // #185): herdr closes a workspace with its last pane, so a session alone in
  // its workspace that closed first had nowhere left to open. Nothing has
  // changed yet, so a failure here leaves the session running.
  let opened: ChildTab;
  try {
    const workspaceLabel = workspaceNow ? await workspaceLabelOf(client, workspaceNow) : undefined;
    opened = await openRestartTab(client, { mode: 'default', workspaceId: workspaceNow }, { cwd: live?.cwd ?? record.cwd, label, env: {}, focus: false }, workspaceLabel ?? label);
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
  // herdr can close the pane and still answer an error, so an error is checked
  // against herdr's pane list before the restart decides (issue #211).
  let closeError: string | undefined;
  if (live) {
    try {
      await client.paneClose(live.paneId);
    } catch (error) {
      closeError = (error as Error).message;
      const listed = await stillListed(client, live.paneId, undefined);
      if (listed !== false) {
        await undoChildTab(client, opened);
        if (listed) throw new RestartRefused(`closing pane ${live.paneId} of session ${record.id} failed, and herdr still lists it, so the restart stopped and nothing else changed: ${closeError}`);
        logRestart({ outcome: 'failed', target: 'parent', parent: record.id, oldPane, session: record.session, error: closeError, oldPaneState: 'unknown' });
        throw new RestartRefused(`closing pane ${live.paneId} of session ${record.id} failed, and herdr then did not list its panes, so Bellwether cannot tell whether that pane is still open. The restart stopped and closed the new tab: ${closeError}`);
      }
      hooks.log?.(`restart of session ${record.id}: herdr answered an error to closing ${live.paneId} but no longer lists it, so the restart goes on: ${closeError}`);
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
    const failure: RestartFailure = { at: new Date().toISOString(), oldPane: oldPane || record.paneId || record.restartFailed?.oldPane || '', ...(workspaceNow ? { workspaceId: workspaceNow } : {}), session: record.session, error: message, reopen: bringBack };
    mutateParent(record.id, (entry) => {
      delete entry.paneId;
      entry.restartFailed = failure;
    });
    hooks.log?.(`restart of session ${record.id} failed${oldPane ? ` after closing ${oldPane}` : ''}: ${message}`);
    logRestart({ outcome: 'failed', target: 'parent', parent: record.id, oldPane, session: record.session, error: message });
    const closed = oldPane ? `Its old pane ${oldPane} is closed, so` : 'It had no pane, so';
    throw new RestartRefused(`Restarting session ${record.id} failed: ${message}. ${closed} bring it back with ${bringBack}.`);
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
    entry.label = label;
    entry.restartedAt = at;
    delete entry.restartFailed;
  });
  hooks.log?.(`restart session ${record.id}: ${oldPane ? `closed ${oldPane}, ` : ''}opened ${newPane} on ${plan.sessionValue}, ${matched ? 'the session matched' : 'herdr reported another session'}`);
  logRestart({ outcome: 'restarted', target: 'parent', parent: record.id, oldPane, newPane, ...(newTab ? { newTab } : {}), session: record.session, sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}), ...(closeError ? { closeError } : {}) });
  const landed = opened.workspaceId ?? workspaceNow;
  return { target: 'parent', id: record.id, name: label, oldPane, newPane, ...(newTab ? { newTab } : {}), ...(landed ? { workspaceId: landed } : {}), session: record.session, kind: plan.kind, command: plan.resume.join(' '), sessionMatched: matched, ...(waitedMs !== undefined ? { waitedMs } : {}) };
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
    if (resolved.self) return deferChildRestart(client, ownParentId, resolved.parent, resolved.child, caller, hooks, changing ? change : undefined);
    const outcome = await restartChild(client, resolved.parent.id, resolved.child.id, hooks, { wait: true, waitTimeoutMs, ...(changing ? { change } : {}) });
    return `Restarted ${outcome.name} (child ${outcome.id})${outcome.host ? ` on machine ${outcome.host}` : ''}: closed pane ${outcome.oldPane}, started ${outcome.kind} in ${paneWords(outcome)} with ${outcome.command}.${outcome.route ? ` ${outcome.route}` : ''} ${matchNote(outcome.sessionMatched)}${waitNote(outcome)}\nherdr link: ${herdrLink('pane', outcome.newPane)}`;
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

/** The bound a deferred self-restart waits under, in words. */
function boundWords(hooks: RestartHooks): string {
  const ms = hooks.deferTimeoutMs ?? RESTART_DEFER_MS;
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${(ms / 1000).toFixed(1)} s`;
}

/** The live children of a session's own registry that herdr reports working. */
function workingChildren(sessionParentId: string): ChildRecord[] {
  return (readParent(sessionParentId)?.children ?? []).filter((entry) => !entry.exitedAt && entry.lastStatus === 'working');
}

/** The messages that reached a child's session since a time, by either path. */
function messagesSince(child: ChildRecord | undefined, since: string): number {
  return (child?.messages ?? []).filter((message) => message.at >= since && !message.undelivered).length;
}

/**
 * What a pending self-restart waits for, as one paragraph: the pane and the
 * status herdr reports for it, what came in since the request, and when the
 * wait gives up (issue #188).
 */
export function restartWaitText(who: string, requestedAt: string, wait: RestartWait | undefined, facts: { held?: number; messages?: number; working?: ChildRecord[] }): string {
  const pane = wait?.paneId ?? 'its pane';
  const status = wait?.status ? `herdr reports it ${wait.status}${wait.statusSince ? ` since ${wait.statusSince}` : ''}` : 'herdr has reported no status for it yet';
  const held = facts.held ? ` Bellwether holds ${facts.held} event${facts.held === 1 ? '' : 's'} for the new session, so they do not start another turn.` : '';
  const messages = facts.messages ? ` ${facts.messages} message${facts.messages === 1 ? '' : 's'} reached the session since the request, each a turn of its own.` : '';
  const working = facts.working?.length ? ` ${facts.working.length} of its children ${facts.working.length === 1 ? 'is' : 'are'} working: ${facts.working.map((entry) => entry.name).join(', ')}.` : '';
  const until = wait?.until ? ` At ${wait.until} it reads the pane from herdr once more: idle restarts it, and anything else gives up and says why.` : '';
  return `${who} has a restart pending since ${requestedAt}. It waits for pane ${pane} to end its turn, and ${status}.${held}${messages}${working}${until}`;
}

/** Why a wait that ran out did not restart the session, naming what held it. */
function stallReason(pane: string, wait: RestartWait | undefined, bound: string, facts: { messages: number; working: ChildRecord[]; error: string }): string {
  const status = wait?.status;
  const parts = [
    status && status !== 'unknown'
      ? `pane ${pane} did not end a turn within ${bound}: herdr reported it ${status}${wait?.statusSince ? ` since ${wait.statusSince}` : ''}, so the turn was live the whole time`
      : `herdr reported no status for pane ${pane} within ${bound}, nor when the daemon read the pane at the deadline, so the daemon could not tell that its turn had ended`,
  ];
  if (facts.messages) parts.push(`${facts.messages} message${facts.messages === 1 ? '' : 's'} reached the session during the wait`);
  if (facts.working.length) parts.push(`${facts.working.length} of its children ${facts.working.length === 1 ? 'was' : 'were'} working (${facts.working.map((entry) => entry.name).join(', ')})`);
  const timeout = /still \S+ after/.test(facts.error) ? '' : ` (${facts.error})`;
  return `${parts.join('; ')}${timeout}. Nothing was closed. End the turn and call agent_restart again, or ask the parent or the operator to restart it.`;
}

/** The clause a reply adds when its request replaces one that nothing was waiting on. */
function replaces(orphan: string | undefined): string {
  return orphan ? ` It replaces the request from ${orphan}, which nothing was waiting on.` : '';
}

/** What a deferred act refused after its wait leaves on the record, so the request ends (issue #220). */
function refusedStall(requestedAt: string, paneId: string, message: string): RestartStall {
  return { at: new Date().toISOString(), requestedAt, paneId, reason: `the restart did not run: ${message.replace(/\.?\s*$/, '.')} Call agent_restart again once the cause is settled.` };
}

async function deferChildRestart(client: HerdrClient, ownParentId: string, parent: ParentRecord, childNow: ChildRecord, caller: CallerIdentity, hooks: RestartHooks, change?: RouteChange): Promise<string> {
  const child = readParent(parent.id)?.children.find((entry) => entry.id === childNow.id) ?? childNow;
  if (child.restartRequestedAt && child.restartWait) return restartWaitText(`${child.name} (child ${child.id})`, child.restartRequestedAt, child.restartWait, { held: hooks.held?.(), messages: messagesSince(child, child.restartRequestedAt), working: workingChildren(ownParentId) });
  // A request with no wait on its record has nothing that would ever end it (issue #220): a new call replaces it.
  const orphan = child.restartRequestedAt;
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
  const now = Date.now();
  updateChild(parent.id, child.id, (entry) => {
    entry.restartRequestedAt = new Date(now).toISOString();
    entry.restartWait = { until: new Date(now + (hooks.deferTimeoutMs ?? RESTART_DEFER_MS)).toISOString(), paneId };
    delete entry.restartStalled;
    if (change) entry.restartRoute = change;
    else delete entry.restartRoute;
  });
  hooks.hold?.(true);
  hooks.defer(`child:${child.id}`, () => deferredChildRestart(client, ownParentId, parent.id, child.id, paneId, child.tabId, hooks));
  const moved = routeMove(child.route, launch);
  return `Restart requested for ${child.name} (child ${child.id}).${replaces(orphan)} Once this turn ends, the daemon closes pane ${paneId} and starts ${child.kind} in a new tab with ${commandWords(child.kind, resume, launch)}, keeping the same child id, so its history and receipts continue.${moved ? ` ${moved}` : ''} Until then Bellwether holds the events bound for this session, which the new session receives. If the turn has not ended within ${boundWords(hooks)}, the daemon reads the pane from herdr once: idle restarts it, and anything else gives up and says what held it. Finish your reply first; the new pane carries on this session.`;
}

function deferParentRestart(client: HerdrClient, record: ParentRecord, caller: CallerIdentity, hooks: RestartHooks): string {
  if (record.restartRequestedAt && record.restartWait) return restartWaitText('This session', record.restartRequestedAt, record.restartWait, { held: hooks.held?.(), working: workingChildren(record.id) });
  const orphan = record.restartRequestedAt;
  if (!hooks.defer) throw new RestartRefused('This daemon cannot defer a restart, so it cannot restart the session that asked.');
  const plan = parentSessionPlan(record);
  const paneId = record.paneId ?? caller.paneId;
  if (!paneId) throw new RestartRefused(`This session is in no herdr pane the daemon knows, so it cannot tell when this turn ends. Ask the operator to restart it.`);
  const now = Date.now();
  mutateParent(record.id, (entry) => {
    entry.restartRequestedAt = new Date(now).toISOString();
    entry.restartWait = { until: new Date(now + (hooks.deferTimeoutMs ?? RESTART_DEFER_MS)).toISOString(), paneId };
    delete entry.restartStalled;
  });
  hooks.hold?.(true);
  hooks.defer(`parent:${record.id}`, () => deferredParentRestart(client, record.id, paneId, hooks));
  return `Restart requested.${replaces(orphan)} Once this turn ends, the daemon closes this pane (${paneId}) and starts ${plan.kind} in a new tab with ${plan.resume.join(' ')} in ${record.cwd}, on the same session. Until then Bellwether holds the events bound for this session, which the new session receives. If the turn has not ended within ${boundWords(hooks)}, the daemon reads the pane from herdr once: idle restarts it, and anything else gives up and says what held it. Finish your reply first; the new pane carries on this session.`;
}

/** Keep the status herdr reports for the waiting pane on the record, for a second call and doctor. */
export function noteStatus(update: (change: (wait: RestartWait) => void) => void): (status: string) => void {
  return (status) =>
    update((wait) => {
      wait.status = status;
      wait.statusSince = new Date().toISOString();
    });
}

/** The deferred half: wait for the caller's turn to end, then restart it in place. */
async function deferredChildRestart(client: HerdrClient, sessionParentId: string, parentId: string, childId: string, paneId: string, tabId: string | undefined, hooks: RestartHooks): Promise<void> {
  const name = readParent(parentId)?.children.find((entry) => entry.id === childId)?.name ?? childId;
  const onStatus = noteStatus((change) =>
    updateChild(parentId, childId, (entry) => {
      if (entry.restartWait) change(entry.restartWait);
    }),
  );
  try {
    try {
      await waitForTurnEnd(client, name, { paneId, tabId }, { timeoutMs: hooks.deferTimeoutMs ?? RESTART_DEFER_MS, freshOnly: true, readAtDeadline: true, signal: hooks.signal, onStatus });
    } catch (error) {
      // A daemon that stops mid-wait leaves the marker for its next start.
      if (hooks.signal?.aborted) return;
      const child = readParent(parentId)?.children.find((entry) => entry.id === childId);
      const reason = stallReason(paneId, child?.restartWait, boundWords(hooks), { messages: child?.restartRequestedAt ? messagesSince(child, child.restartRequestedAt) : 0, working: workingChildren(sessionParentId), error: (error as Error).message });
      updateChild(parentId, childId, (entry) => {
        const requestedAt = entry.restartRequestedAt;
        delete entry.restartRequestedAt;
        delete entry.restartWait;
        entry.restartStalled = { at: new Date().toISOString(), ...(requestedAt ? { requestedAt } : {}), paneId, reason };
      });
      hooks.log?.(`deferred restart of ${childId} did not run: ${reason}`);
      logRestart({ outcome: 'timeout', target: 'child', parent: parentId, child: childId, error: reason });
      return;
    }
    const current = readParent(parentId)?.children.find((entry) => entry.id === childId);
    if (!current?.restartRequestedAt) return;
    // The wait stays on the record until the act ends, so a request is never
    // left pending with nothing that would end it (issue #220).
    try {
      await restartChild(client, parentId, childId, hooks);
    } catch (error) {
      const message = (error as Error).message;
      hooks.log?.(`deferred restart of ${childId} failed: ${message}`);
      // An act refused before it closed anything still holds the request open.
      let refused = false;
      updateChild(parentId, childId, (entry) => {
        if (!entry.restartRequestedAt) return;
        entry.restartStalled = refusedStall(entry.restartRequestedAt, paneId, message);
        delete entry.restartRequestedAt;
        delete entry.restartRoute;
        refused = true;
      });
      if (refused) logRestart({ outcome: 'refused', target: 'child', parent: parentId, child: childId, error: message });
    }
  } finally {
    updateChild(parentId, childId, (entry) => {
      delete entry.restartWait;
    });
    hooks.hold?.(false);
  }
}

async function deferredParentRestart(client: HerdrClient, parentId: string, paneId: string, hooks: RestartHooks): Promise<void> {
  const onStatus = noteStatus((change) =>
    mutateParent(parentId, (entry) => {
      if (entry.restartWait) change(entry.restartWait);
    }),
  );
  try {
    try {
      await waitForTurnEnd(client, parentId, { paneId }, { timeoutMs: hooks.deferTimeoutMs ?? RESTART_DEFER_MS, freshOnly: true, readAtDeadline: true, signal: hooks.signal, onStatus });
    } catch (error) {
      // A daemon that stops mid-wait leaves the marker for its next start.
      if (hooks.signal?.aborted) return;
      const reason = stallReason(paneId, readParent(parentId)?.restartWait, boundWords(hooks), { messages: 0, working: workingChildren(parentId), error: (error as Error).message });
      mutateParent(parentId, (entry) => {
        const requestedAt = entry.restartRequestedAt;
        delete entry.restartRequestedAt;
        delete entry.restartWait;
        entry.restartStalled = { at: new Date().toISOString(), ...(requestedAt ? { requestedAt } : {}), paneId, reason };
      });
      hooks.log?.(`deferred restart of session ${parentId} did not run: ${reason}`);
      logRestart({ outcome: 'timeout', target: 'parent', parent: parentId, error: reason });
      return;
    }
    if (!readParent(parentId)?.restartRequestedAt) return;
    try {
      await restartParent(client, parentId, hooks);
    } catch (error) {
      const message = (error as Error).message;
      hooks.log?.(`deferred restart of session ${parentId} failed: ${message}`);
      let refused = false;
      mutateParent(parentId, (entry) => {
        if (!entry.restartRequestedAt) return;
        entry.restartStalled = refusedStall(entry.restartRequestedAt, paneId, message);
        delete entry.restartRequestedAt;
        refused = true;
      });
      if (refused) logRestart({ outcome: 'refused', target: 'parent', parent: parentId, error: message });
    }
  } finally {
    mutateParent(parentId, (entry) => {
      delete entry.restartWait;
    });
    hooks.hold?.(false);
  }
}

/** Why a request a new daemon finds with no pane gives up at once (issue #220). */
const NO_PANE_REASON = 'the daemon that took this request stopped, and the request has no pane on its record, so no daemon can tell when its turn ends. Nothing was closed. Call agent_restart again from the session.';

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
    } else if (!(fresh.restartWait?.paneId ?? fresh.paneId)) {
      mutateParent(fresh.id, (entry) => {
        entry.restartStalled = { at: new Date().toISOString(), requestedAt: fresh.restartRequestedAt, reason: NO_PANE_REASON };
        delete entry.restartRequestedAt;
        delete entry.restartWait;
      });
    } else {
      const paneId = (fresh.restartWait?.paneId ?? fresh.paneId) as string;
      // The wait starts again with its full bound, and the session's events wait with it.
      mutateParent(fresh.id, (entry) => {
        entry.restartWait = { until: new Date(Date.now() + (hooks.deferTimeoutMs ?? RESTART_DEFER_MS)).toISOString(), paneId };
      });
      hooks.hold?.(true);
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
    const paneId = child.restartWait?.paneId ?? child.paneId;
    if (!paneId) {
      const requestedAt = child.restartRequestedAt;
      updateChild(fresh.id, child.id, (entry) => {
        entry.restartStalled = { at: new Date().toISOString(), requestedAt, reason: NO_PANE_REASON };
        delete entry.restartRequestedAt;
        delete entry.restartWait;
        delete entry.restartRoute;
      });
      continue;
    }
    const { tabId } = child;
    updateChild(fresh.id, child.id, (entry) => {
      entry.restartWait = { until: new Date(Date.now() + (hooks.deferTimeoutMs ?? RESTART_DEFER_MS)).toISOString(), paneId };
    });
    // These hooks serve the parent's session, not the child's, so nothing is held for it.
    const { hold: _hold, held: _held, ...parentHooks } = hooks;
    hooks.defer(`child:${child.id}`, () => deferredChildRestart(client, child.id, fresh.id, child.id, paneId, tabId, parentHooks));
  }
}
