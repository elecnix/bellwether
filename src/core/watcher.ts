// The watcher: subscribe to the child panes, reconcile against a snapshot,
// turn herdr states into events, and hand new events to the parent's adapter.
//
// The order matters and comes from herdr-lantern: subscribe first, then take a
// snapshot on a second connection, then reconcile. herdr does not replay
// events, so a subscription opened after the snapshot would miss whatever
// happened in between. After a disconnect the watcher takes a fresh snapshot
// for the same reason.
import { closingNow, restartFailureText } from './restart.ts';
import fs from 'node:fs';
import type { HerdrClient, HerdrEvent, Subscription } from './herdr-client.ts';
import { DEFAULT_LIMITS, advance, limitsFor, markReported, seedFor, seqHere, type ClassifierState, type SettleLimits } from './classifier.ts';
import { LOCAL_HOST, hostOf, type ClientFor } from './machine.ts';
import { Outbox } from './outbox.ts';
import { describeDecisions, mutateParent, readParent, recordDecisions, takeUntoldDecisions, updateChild } from './registry.ts';
import { detectDialog, dialogName, watchStartup } from './startup-dialogs.ts';
import { harnessFor, harnessNamed } from './harnesses/index.ts';
import { detectModal } from './modal.ts';
import { BLANK_SCREEN, shownScreen } from './screen.ts';
import { agentNameOf, lastAssistantMessage, sessionFrom } from './transcript.ts';
import { keepsBriefs } from './brief-history.ts';
import { removeChildFiles } from './mcp-config.ts';
import { childLabel } from './label.ts';
import { reportViaLine } from './report.ts';
import { spoolPath } from './paths.ts';
import { realRetireOps, reapChild, retirementPending, type ReapDeps, type RetireOps } from './retire.ts';
import { isMoving } from './move-plan.ts';
import type { AgentStatus, ChildEventKind, ChildMessage, ChildRecord, DialogDecision, OutboxEntry, PaneEnd, RelayHostState, ReportVia, SpoolReport } from './types.ts';
import { unreadSessionMessages } from './send.ts';
import { backInPane } from './adopt.ts';
import { parsePane, type HerdrPane } from './herdr-client.ts';
import { ClaimRefused, claimantOf, decideClaim } from './pane-claims.ts';
import { removeRelayRecord } from './relay-records.ts';
import { ClaimHeldElsewhere } from './remote.ts';
import { releaseWorkspace } from './workspace.ts';
import { harnessSeen, reportPending, runEnds, sessionSeen, statusSeen, stopAwaiting, tabClosed, viewOf } from './incarnation.ts';
import { heldByAdoption } from './acquisition.ts';

/** herdr's status for a pane, or the child's last known status. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusOf(pane: Record<string, unknown> | undefined, fallback: AgentStatus): AgentStatus {
  const value = pane?.['agent_status'];
  return typeof value === 'string' && ['idle', 'working', 'blocked', 'done', 'unknown'].includes(value) ? (value as AgentStatus) : fallback;
}

/** How long an idle event waits for a far child's last message over the relay connection (issue #272). */
const REMOTE_READ_MS = 5_000;

export interface WatcherOptions {
  /** The parent's own herdr. */
  client: HerdrClient;
  /** The herdr for a child on another host. Defaults to refusing every host but the local one. */
  clientFor?: ClientFor;
  parentId: string;
  limits?: SettleLimits;
  /** Called with every unread entry once new events appear. */
  onEntries: (entries: OutboxEntry[]) => void;
  now?: () => number;
  /** How often the local clock is checked for the stuck threshold. */
  tickMs?: number;
  /** How often a child with no transcript has its screen read. 0 turns it off. */
  screenPollMs?: number;
  log?: (message: string) => void;
  /** git, gh and the process table, for the retirement cleanup. Tests pass a fake. */
  retireOps?: RetireOps;
  /** Ask the daemon on another machine to retire a worktree there, over the relay (issue #242). Absent without a relay. */
  retireFar?: ReapDeps['retireFar'];
  /** Remove a child's brief and MCP config on its own machine, for a child on another one. */
  cleanupRemote?: (child: ChildRecord) => Promise<void>;
  /**
   * Claim an adopted child's pane again on its own machine, under its child
   * id, once its harness came back there under the same session (issue #191).
   * Rejects with `ClaimHeldElsewhere` when that machine holds the session
   * under another id.
   */
  reclaimRemote?: (child: ChildRecord) => Promise<void>;
  /** Hear that a child came back without an event, so the daemon's relay links hold its machine open again. */
  childrenChanged?: () => void;
  /** How many times the cleanup looks again for a process leaving the worktree, and how long it waits. */
  retireBusyRetries?: number;
  retireBusyDelayMs?: number;
  /** How the daemon's connection to a remote child's machine stands, so a notice can say the parent is not hearing from it. */
  relayState?: (host: string) => RelayHostState | undefined;
  /**
   * Read a child's last message on its own machine, over the relay connection
   * the daemon holds there, as agent_read does (issue #272). Without it, an
   * idle event from a child on another machine says it cannot read the message.
   */
  remoteLastMessage?: (child: ChildRecord) => Promise<string | undefined>;
  /** How long after its start a child herdr has not seen run is checked for a harness that already ended. */
  startConfirmMs?: number;
}

/**
 * Whether herdr's new status ends a dialog that a Claude Code child's
 * Notification hook named. Claude Code sends no notice when a dialog closes,
 * so the dialog holds until herdr sees the child work again, as an approval
 * makes it, or sees it leave blocked, as a refusal does. herdr calling the
 * child idle or blocked while the dialog is up, and the turn count that idle
 * moves, are the same dialog.
 */
// TODO(api): a Claude Code hook that fires when a dialog closes would end the
// wait exactly, including a dialog refused while herdr kept reporting idle,
// which holds here until the child next works.
export function hookDialogClosed(prompt: ChildRecord['prompt'], previous: AgentStatus, status: AgentStatus): boolean {
  return harnessNamed(prompt?.source)?.classify.dialogs.from === 'hook' && status !== previous && (status === 'working' || previous === 'blocked');
}

/**
 * How long a new child's harness has to show herdr it runs before the watcher
 * asks whether it ended. herdr detects a harness within a second or two, and
 * a harness loading a large session can take longer, so this is generous.
 */
export const START_CONFIRM_MS = 20_000;

export class Watcher {
  private readonly clientFor: ClientFor;
  private readonly parentId: string;
  private readonly limits: SettleLimits;
  private readonly onEntries: (entries: OutboxEntry[]) => void;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly screenPollMs: number;
  private readonly log: (message: string) => void;
  private readonly retireOps: RetireOps;
  private readonly retireFar: ReapDeps['retireFar'];
  private readonly cleanupRemote: ((child: ChildRecord) => Promise<void>) | undefined;
  private readonly reclaimRemote: ((child: ChildRecord) => Promise<void>) | undefined;
  private readonly childrenChanged: (() => void) | undefined;
  /** The cleanup on another machine that an exit started, which a child coming back waits for, so the cleanup cannot remove the claim made after it. */
  private readonly remoteCleanups = new Map<string, Promise<void>>();
  /** Adoptions in doubt being asked about now, and when each may be asked again. */
  private readonly settling = new Set<string>();
  private readonly doubtRetry = new Map<string, { at: number; delay: number }>();
  private readonly retireBusy: { retries?: number; delayMs?: number };
  private readonly relayState: ((host: string) => RelayHostState | undefined) | undefined;
  private readonly remoteLastMessage: ((child: ChildRecord) => Promise<string | undefined>) | undefined;
  private readonly startConfirmMs: number;
  /** Children whose start was checked once in this process, so the check never repeats. */
  private readonly startChecked = new Set<string>();
  /** Retirements in flight, so an exit event and a start never clean the same child at once. */
  private readonly retiring = new Map<string, Promise<void>>();
  /** Children with a notice that came while their cleanup ran, so it runs once more after. */
  private readonly retireAgain = new Set<string>();
  private readonly outbox: Outbox;
  private readonly states = new Map<string, ClassifierState>();
  private readonly screenReadAt = new Map<string, number>();
  private readonly transcriptSizes = new Map<string, number>();
  /** Each store-backed child's activity stamp at the last look, read from its harness's store. */
  private readonly storeStamps = new Map<string, number>();
  private readonly transcriptLookAt = new Map<string, number>();

  private controller: AbortController | undefined;
  /** One subscription per herdr host, since pane ids are scoped to one server. */
  private readonly links = new Map<string, { subscription: Subscription; key: string }>();
  /** When a host that failed may be tried again, so a dead machine is not dialled every tick. */
  private readonly retryAt = new Map<string, { at: number; delay: number }>();
  /**
   * Each other machine whose herdr the watcher cannot reach now: since when,
   * and why. Its children are unreachable, not exited, and the classifier
   * holds their events until the machine answers again.
   */
  private readonly away = new Map<string, { since: string; error: string }>();
  private ticker: NodeJS.Timeout | undefined;
  /** The classifier pass that runs now, and the one that waits for it. */
  private evaluating: Promise<void> | undefined;
  private nextEvaluation: Promise<void> | undefined;
  private reconnecting = false;
  private spoolOffset = 0;
  private stopped = true;

  constructor(options: WatcherOptions) {
    const local = options.client;
    this.clientFor = options.clientFor ?? ((host) => (host === LOCAL_HOST ? Promise.resolve(local) : Promise.reject(new Error(`no herdr client for host ${host}`))));
    this.parentId = options.parentId;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.onEntries = options.onEntries;
    this.now = options.now ?? (() => Date.now());
    this.tickMs = options.tickMs ?? 5_000;
    this.screenPollMs = options.screenPollMs ?? 30_000;
    this.log = options.log ?? (() => {});
    this.retireOps = options.retireOps ?? realRetireOps();
    this.retireFar = options.retireFar;
    this.cleanupRemote = options.cleanupRemote;
    this.reclaimRemote = options.reclaimRemote;
    this.childrenChanged = options.childrenChanged;
    this.retireBusy = { retries: options.retireBusyRetries, delayMs: options.retireBusyDelayMs };
    this.relayState = options.relayState;
    this.remoteLastMessage = options.remoteLastMessage;
    this.startConfirmMs = options.startConfirmMs ?? START_CONFIRM_MS;
    this.outbox = Outbox.load(this.parentId);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Resume the child spool where the last run stopped, so a restart neither
    // replays old reports nor drops one written while the parent was down.
    this.spoolOffset = readParent(this.parentId)?.spoolOffset ?? 0;
    this.controller = new AbortController();
    this.ticker = setInterval(() => void this.tick(), this.tickMs);
    this.ticker.unref?.();
    void this.reconcileAndSubscribe();
    // A daemon that stopped part of the way through a retirement finishes it.
    for (const child of readParent(this.parentId)?.children ?? []) {
      if (child.exitedAt && retirementPending(child)) void this.retire(child.id);
    }
  }

  /** Wait for the retirements in flight, for a test or a drain. */
  async retirements(): Promise<void> {
    while (this.retiring.size) await Promise.all([...this.retiring.values()]);
  }

  /**
   * Start the cleanup of a child that agent_stop closed. The stop marks the
   * child exited itself, so the pane_closed that follows finds the exit
   * already recorded. Both start the cleanup, and whichever comes first does
   * the work. agent_stop records a retirement for a child that never asked,
   * so the parent's stop is the child's retirement. The promise settles when
   * this pass ends, which may leave the work pending until herdr drops the pane.
   */
  childStopped(childId: string): Promise<void> {
    return this.retire(childId);
  }

  /**
   * Clean up after a child that asked to be retired, once it has exited. The
   * cleanup itself refuses anything still alive or out of bounds.
   */
  private retire(childId: string): Promise<void> {
    const running = this.retiring.get(childId);
    if (running) {
      // The running pass may have found the pane still listed and left the
      // work pending. This notice can be the one that says the pane is gone,
      // so look once more after it. A finished retirement makes that a no-op.
      this.retireAgain.add(childId);
      return running;
    }
    const job = reapChild(this.parentId, childId, {
      ops: this.retireOps,
      ...(this.retireFar ? { retireFar: this.retireFar } : {}),
      paneOrTabLive: (child) => this.paneOrTabLive(child),
      log: this.log,
      busyRetries: this.retireBusy.retries,
      busyDelayMs: this.retireBusy.delayMs,
    })
      .then(() => undefined)
      .catch((error: unknown) => this.log(`retirement of ${childId} failed: ${String(error)}`))
      .finally(() => {
        this.retiring.delete(childId);
        if (this.retireAgain.delete(childId)) void this.retire(childId);
      });
    this.retiring.set(childId, job);
    return job;
  }

  /** Whether herdr still lists the child's pane, or any pane in its tab. */
  private async paneOrTabLive(child: ChildRecord): Promise<boolean> {
    const client = await this.clientFor(hostOf(child));
    const result = await client.request('pane.list', {});
    const panes = isRecord(result) && Array.isArray(result['panes']) ? (result['panes'] as Record<string, unknown>[]) : [];
    return panes.some((pane) => (child.paneId && pane['pane_id'] === child.paneId) || (child.tabId && pane['tab_id'] === child.tabId));
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const link of this.links.values()) link.subscription.close();
    this.links.clear();
    this.controller?.abort();
    this.controller = undefined;
  }

  /**
   * Forget what the watcher measured for a child, for one that comes back in a
   * new pane: its classifier state and baselines belong to the old one.
   */
  reset(childId: string): void {
    this.states.delete(childId);
    this.startChecked.delete(childId);
    this.screenReadAt.delete(childId);
    this.transcriptSizes.delete(childId);
    this.storeStamps.delete(childId);
    this.transcriptLookAt.delete(childId);
    this.lastScreen.delete(childId);
  }

  /** Since when, and why, the herdr on another machine has not answered, or undefined while it answers. */
  unreachable(host: string): { since: string; error: string } | undefined {
    const state = this.away.get(host);
    return state ? { ...state } : undefined;
  }

  /** A host's herdr stopped answering. Its children stay as they were: a dropped link is not an exit. */
  private lostHost(host: string, error: unknown): void {
    if (host === LOCAL_HOST || this.away.has(host)) return;
    this.away.set(host, { since: new Date(this.now()).toISOString(), error: String(error) });
    this.log(`machine ${host} is unreachable; its children are not exited, and are read again once it answers: ${String(error)}`);
  }

  /** A host answered again, and the snapshot that follows brings its children's state up to date. */
  private foundHost(host: string): void {
    const was = this.away.get(host);
    if (!was) return;
    this.away.delete(host);
    this.log(`machine ${host} answers again, after being unreachable since ${was.since}`);
  }

  outboxEntries(): OutboxEntry[] {
    return this.outbox.all();
  }

  /**
   * Unread entries ready to deliver, after any a newer child state made stale
   * has been settled. A reconnect replays these, so it never replays a dialog
   * someone already answered.
   */
  pendingEntries(): OutboxEntry[] {
    this.settleStale();
    return this.outbox.pending();
  }

  markRead(receipt: string): void {
    if (!this.outbox.markRead(receipt)) return;
    this.outbox.save(this.parentId);
  }

  /** Forget a child whose spawn failed: no state, and no event left to send. */
  forget(childId: string): void {
    this.states.delete(childId);
    this.screenReadAt.delete(childId);
    this.transcriptSizes.delete(childId);
    this.storeStamps.delete(childId);
    this.transcriptLookAt.delete(childId);
    this.lastScreen.delete(childId);
    if (this.outbox.drop(childId)) this.outbox.save(this.parentId);
  }

  /**
   * Subscribe to the current child panes, then reconcile against a snapshot.
   * A pane that has gone away must be dropped first: herdr rejects the whole
   * subscription when one pane id no longer exists, which would silence every
   * other child.
   */
  private async reconcileAndSubscribe(): Promise<void> {
    if (this.stopped) return;
    const signal = this.controller?.signal;
    if (!signal) return;
    const record = readParent(this.parentId);
    const byHost = groupByHost((record?.children ?? []).filter(watched));
    // A host whose last child left needs no subscription.
    for (const [host, link] of this.links) {
      if (byHost.has(host)) continue;
      link.subscription.close();
      this.links.delete(host);
    }
    for (const host of this.away.keys()) if (!byHost.has(host)) this.away.delete(host);
    let failed = false;
    for (const [host, children] of byHost) {
      if ((this.retryAt.get(host)?.at ?? 0) > Date.now()) continue;
      try {
        const client = await this.clientFor(host);
        const live = await this.livePanes(client, signal);
        const addressable: ChildRecord[] = [];
        const awaiting: ChildRecord[] = [];
        for (const child of children) {
          // An adopted harness that ended in its pane: the pane is watched for its return while it stays open.
          if (child.exitedAt) {
            if (live.has(child.paneId)) awaiting.push(child);
            else this.stopAwaiting(child, 'its pane closed');
            continue;
          }
          // A child changing machines closed its old pane on purpose, and a
          // restart closing it has yet to name the new one.
          if (isMoving(child) || closingNow(child) || child.restartInDoubt) continue;
          // An adoption whose far answer was lost is watched once that machine confirms it.
          if (child.adoptInDoubt) continue;
          // A record written a moment ago may predate its pane. Leave it be.
          if (!child.paneId || Date.now() - Date.parse(child.startedAt) < 15_000 || live.has(child.paneId)) {
            if (child.paneId) addressable.push(child);
            continue;
          }
          this.markExited(child, undefined, undefined, 'missing');
        }
        await this.ensureSubscription(host, client, addressable, signal);
        this.foundHost(host);
        await this.reconcile(client, addressable, signal);
        // A harness that came back while no subscription watched, as when the daemon was down.
        if (awaiting.length) {
          const agents = await client.agentList(signal);
          for (const child of awaiting) {
            const agent = agents.find((pane) => pane.paneId === child.paneId);
            if (agent?.agent) await this.comeBack(host, child, agent);
          }
        }
        this.retryAt.delete(host);
      } catch (error) {
        this.lostHost(host, error);
        const delay = Math.min((this.retryAt.get(host)?.delay ?? 500) * 2, 60_000);
        this.retryAt.set(host, { at: Date.now() + delay, delay });
        // One unreachable host must not silence the children on the others.
        this.log(`reconcile failed on ${host}: ${String(error)}`);
        this.links.get(host)?.subscription.close();
        this.links.delete(host);
        failed = true;
      }
    }
    this.publish();
    if (failed) this.scheduleReconnect();
  }

  /**
   * Every pane id one herdr currently knows about. A failure throws, because
   * an empty answer would read as every child having exited.
   */
  private async livePanes(client: HerdrClient, signal: AbortSignal): Promise<Set<string>> {
    const result = await client.request('pane.list', {}, { signal });
    const list = isRecord(result) && Array.isArray(result['panes']) ? (result['panes'] as Record<string, unknown>[]) : [];
    return new Set(list.map((pane) => pane['pane_id']).filter((id): id is string => typeof id === 'string'));
  }

  /**
   * A child herdr has not seen run since its start window closed: ask herdr
   * once whether its harness is there. herdr keeps an agent it launched as
   * pending when the process ends before detection, and then the pane's
   * foreground process is its shell again. That child never started, and the
   * parent hears it as an exit. Returns true when the child turned out gone.
   */
  private async endedBeforeSeen(child: ChildRecord): Promise<boolean> {
    if (child.harnessSeenAt || heldByAdoption(child) || !child.paneId || this.startChecked.has(child.id)) return false;
    const since = Date.parse(child.resumedAt ?? child.startedAt);
    if (!(Date.now() - since >= this.startConfirmMs)) return false;
    this.startChecked.add(child.id);
    try {
      const client = await this.clientFor(hostOf(child));
      const result = await client.request('agent.get', { target: child.paneId }, { signal: this.controller?.signal }).catch(() => undefined);
      const agent = isRecord(result) && isRecord(result['agent']) ? result['agent'] : undefined;
      if (typeof agent?.['agent'] === 'string' && agent['agent']) {
        updateChild(this.parentId, child.id, (entry) => {
          harnessSeen(entry, new Date().toISOString());
        });
        return false;
      }
      const reply = await client.request('pane.process_info', { pane_id: child.paneId }, { signal: this.controller?.signal });
      const info = isRecord(reply) && isRecord(reply['process_info']) ? reply['process_info'] : undefined;
      const shell = info?.['shell_pid'];
      const foreground = info?.['foreground_process_group_id'];
      if (typeof shell !== 'number' || foreground !== shell) return false;
      this.log(`${child.name}'s harness is not running in pane ${child.paneId}: herdr never detected it, and the pane's foreground process is its shell`);
      this.markExited(child, undefined, 'in-pane');
      this.dropLink(hostOf(child));
      void this.reconcileAndSubscribe();
      return true;
    } catch (error) {
      this.log(`could not check whether ${child.name} started: ${String(error)}`);
      return false;
    }
  }

  /** Whether a child got to its task: a report, a finished turn, a busy status, or an event the parent was sent. */
  private heardFrom(child: ChildRecord): boolean {
    if (child.lastReport || (child.completionSeq ?? 0) > 0) return true;
    if (child.lastStatus === 'working' || child.lastStatus === 'blocked' || child.lastStatus === 'done') return true;
    return this.outbox.all().some((entry) => entry.childId === child.id);
  }

  /** The tab of a child whose harness already ended was closed: forget the pane, and say nothing. */
  private closeQuietly(child: ChildRecord): void {
    // herdr can name one tab close twice, as pane_closed and tab_closed. Both
    // reach the watcher when they arrive with a subscription's acknowledgement,
    // before dropLink knows that subscription. The record decides, as it does
    // for an exit, so the workspace is released and retirement started once.
    if (readParent(this.parentId)?.children.find((entry) => entry.id === child.id)?.tabClosedAt) return;
    updateChild(this.parentId, child.id, (entry) => {
      tabClosed(entry, new Date().toISOString());
    });
    removeChildFiles(child.id, hostOf(child) === LOCAL_HOST ? child.cwd : undefined, { briefs: !this.keepsBriefs(child) });
    void this.releaseWorkspace(child);
    void this.retire(child.id);
  }

  /** Whether the record, as saved now, shows the child has a brief it never read. */
  private keepsBriefs(child: ChildRecord): boolean {
    return keepsBriefs(readParent(this.parentId)?.children.find((entry) => entry.id === child.id) ?? child);
  }

  /**
   * Close the workspace Bellwether made for a child once nothing is left in
   * it. A tab kept open on the child's last screen, another child, or a
   * person's shell keeps it, and a workspace Bellwether did not make is never
   * touched.
   */
  private async releaseWorkspace(child: ChildRecord): Promise<void> {
    if (!child.ownsWorkspace) return;
    try {
      const outcome = await releaseWorkspace(await this.clientFor(hostOf(child)), child);
      if (outcome === 'closed') this.log(`closed workspace ${child.workspaceId}, which Bellwether made for ${child.name} and which nothing else used`);
    } catch (error) {
      this.log(`could not check ${child.name}'s workspace ${child.workspaceId}: ${(error as Error).message}`);
    }
  }

  /** Stop watching an exited adopted child's pane for its return. */
  private stopAwaiting(child: ChildRecord, why: string): void {
    updateChild(this.parentId, child.id, (entry) => {
      stopAwaiting(entry);
    });
    this.log(`stopped watching pane ${child.paneId} for ${child.name}'s return: ${why}`);
  }

  /**
   * An agent in the pane of an adopted child whose harness ended there. The
   * same session is the same child, which comes back under its id: its claim
   * on its machine is made again, and the watcher follows its status again.
   * Another session in the pane is another agent, and the wait ends (issue #191).
   */
  private async comeBack(host: string, child: ChildRecord, seen: HerdrPane | undefined): Promise<void> {
    let agent = seen;
    if (!agent?.agentSessionId) {
      try {
        // The event did not carry the session, so herdr's agent.get answers for it.
        agent = parsePane(await (await this.clientFor(host)).request('agent.get', { target: child.paneId }, { signal: this.controller?.signal }).then((result) => (isRecord(result) && isRecord(result['agent']) ? result['agent'] : result))) ?? agent;
      } catch {
        return;
      }
    }
    if (!agent?.agent || !agent.agentSessionId) return;
    if (agent.agentSessionId !== child.session?.value) {
      this.stopAwaiting(child, `pane ${child.paneId} now runs session ${agent.agentSessionId}, not ${child.session?.value ?? 'an unrecorded one'}`);
      return;
    }
    if (hostOf(child) === LOCAL_HOST) {
      // A parent on another machine may have adopted the pane before this
      // watcher heard the session come back. Its claim stands, as a far
      // child's reclaim yields to one, so the session answers to one parent (issue #244).
      const holder = claimantOf(child.paneId);
      const decision = decideClaim({ parentId: this.parentId, paneId: child.paneId, session: agent.agentSessionId }, holder);
      if (decision.kind === 'refuse') {
        this.stopAwaiting(child, decision.reason);
        return;
      }
      if (decision.kind === 'take' && holder?.where === 'away') removeRelayRecord(holder.record.childId);
    } else if (this.reclaimRemote) {
      await this.remoteCleanups.get(child.id);
      try {
        await this.reclaimRemote(child);
      } catch (error) {
        if (error instanceof ClaimHeldElsewhere) {
          updateChild(this.parentId, child.id, (entry) => {
            entry.replacedBy = error.childId;
            stopAwaiting(entry);
          });
          this.log(`${child.name} came back in pane ${child.paneId}, and ${error.message}; adopt the pane again to watch it under that id`);
          return;
        }
        this.log(`${child.name} came back in pane ${child.paneId}, but its claim on machine ${host} failed: ${(error as Error).message}`);
      }
    }
    const back = agent;
    updateChild(this.parentId, child.id, (entry) => backInPane(entry, back));
    this.reset(child.id);
    this.log(`${child.name} came back in pane ${child.paneId} under session ${back.agentSessionId}, as the same child ${child.id}`);
    this.childrenChanged?.();
    this.dropLink(host);
    void this.reconcileAndSubscribe();
  }

  private markExited(child: ChildRecord, code: number | undefined, ended?: 'in-pane', how: PaneEnd['how'] = ended ? 'harness-ended' : 'closed', detail: Pick<PaneEnd, 'session' | 'reason'> = {}): void {
    // One exit can arrive twice: the reconcile after a subscribe finds the pane
    // gone, and the pane_closed event for it lands too. agent_stop also marks
    // the exit before herdr's event arrives. The record decides, so the exit is
    // offered and the workspace released once. Retirement starts either way:
    // agent_stop starts it too, retire() runs one pass at a time, and the
    // cleanup skips a child whose outcome is already recorded.
    if (readParent(this.parentId)?.children.find((entry) => entry.id === child.id)?.exitedAt) {
      void this.retire(child.id);
      return;
    }
    // A child that exits between two looks wrote its file after the last one,
    // so look once more. The session and transcript stay on the record, so a
    // retired child can still be read and resumed.
    if (!child.transcript && child.session && hostOf(child) === LOCAL_HOST) this.recordTranscript(child, child.session.value);
    // A child the parent never heard from never ran its task, whatever ended it.
    const beforeStart = !this.heardFrom(child);
    const harnessEnded = ended ? (beforeStart ? 'before-start' : 'in-pane') : undefined;
    // An adopted harness that ended in its open pane may come back there, as a
    // quit and a resume of the same session do, and it is the same child then (issue #191).
    // A pane that went to another session holds another agent, so nothing waits there.
    const awaitsResume = Boolean(harnessEnded) && heldByAdoption(child) && how !== 'session-changed';
    let unread: ChildMessage[] = [];
    updateChild(this.parentId, child.id, (entry) => {
      const at = new Date().toISOString();
      // What became of the pane, for agent_list and doctor (issue #187).
      runEnds(entry, { at, code, statusUnknown: true, paneEnd: { pane: entry.paneId, ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}), how, at, ...(code === undefined ? {} : { code }), ...detail }, ...(harnessEnded ? { harnessEnded } : {}), awaitsResume });
      // A message in the session that the model never received is undelivered, and the exit event says so.
      unread = unreadSessionMessages(entry);
      for (const message of unread) {
        message.undelivered = 'the child exited before its model received it';
        delete message.text;
        delete message.from;
      }
    });
    child = viewOf(child, { ...(harnessEnded ? { harnessEnded } : {}), ...(detail.session || detail.reason ? { paneEnd: { pane: child.paneId, how, at: new Date().toISOString(), ...detail } } : {}) });
    // A brief nothing shows the child read stays for the resume that hands it over (issue #132).
    removeChildFiles(child.id, hostOf(child) === LOCAL_HOST ? child.cwd : undefined, { briefs: !this.keepsBriefs(child) });
    if (hostOf(child) !== LOCAL_HOST && this.cleanupRemote) {
      const cleanup = this.cleanupRemote(child).catch((error: unknown) => this.log(`could not remove ${child.name}'s files on machine ${hostOf(child)}: ${(error as Error).message}`));
      this.remoteCleanups.set(child.id, cleanup);
      void cleanup.finally(() => {
        if (this.remoteCleanups.get(child.id) === cleanup) this.remoteCleanups.delete(child.id);
      });
    }
    const watching = awaitsResume ? ` Bellwether keeps watching pane ${child.paneId}, and a resume of the same session there is the same child again.` : '';
    this.offer(child, 'exited', `${this.describeExit(child, code, beforeStart)}${watching}${unreadNote(unread)}`);
    void this.releaseWorkspace(child);
    void this.retire(child.id);
  }

  /**
   * herdr's status subscriptions are per pane, so the subscription is rebuilt
   * whenever the set of child panes changes.
   */
  private async ensureSubscription(host: string, client: HerdrClient, children: ChildRecord[], signal: AbortSignal): Promise<void> {
    const key = paneKey(children);
    const current = this.links.get(host);
    if (current && current.key === key) return;
    current?.subscription.close();
    this.links.delete(host);
    const subscriptions: Record<string, unknown>[] = [
      { type: 'pane.exited' },
      { type: 'pane.closed' },
      // A tab close sends tab_closed and no pane event, so this is the only
      // signal that a child whose tab went away is gone.
      { type: 'tab.closed' },
      { type: 'pane.agent_detected' },
      ...children.filter((child) => !child.exitedAt).map((child) => ({ type: 'pane.agent_status_changed', pane_id: child.paneId })),
    ];
    const subscription = await client.subscribe(subscriptions, (event) => void this.onHerdrEvent(host, event), signal);
    this.links.set(host, { subscription, key });
    this.log(`subscribed to ${children.length} child pane(s) on ${host}`);
    void subscription.closed.catch((error: unknown) => {
      this.log(`subscription lost on ${host}: ${String(error)}`);
      if (this.links.get(host)?.subscription === subscription) {
        this.links.delete(host);
        if (!this.stopped) this.lostHost(host, error);
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    let delay = 250;
    const attempt = (): void => {
      if (this.stopped) return;
      void this.reconcileAndSubscribe()
        .then(() => {
          this.reconnecting = false;
        })
        .catch(() => {
          delay = Math.min(delay * 2, 10_000);
          setTimeout(attempt, delay).unref?.();
        });
    };
    setTimeout(attempt, delay).unref?.();
  }

  private async onHerdrEvent(host: string, event: HerdrEvent): Promise<void> {
    const paneId = typeof event.data['pane_id'] === 'string' ? event.data['pane_id'] : undefined;
    const tabId = typeof event.data['tab_id'] === 'string' ? event.data['tab_id'] : undefined;
    if (!paneId && !tabId) {
      if (event.event === 'events.lost' || event.event === 'events_lost') {
        this.log(`herdr on ${host} reported lost events; resubscribing`);
        this.dropLink(host);
        void this.reconcileAndSubscribe();
      }
      return;
    }
    const record = readParent(this.parentId);
    // A tab close names a tab and carries no pane id, so match either.
    // A pane can hold a live child and an older record of one that exited there: the live one, then one awaiting its return, answers.
    const matching = (record?.children ?? []).filter((entry) => hostOf(entry) === host && ((paneId !== undefined && entry.paneId === paneId) || (tabId !== undefined && entry.tabId === tabId)));
    const child = matching.find((entry) => !entry.exitedAt) ?? matching.find((entry) => entry.awaitsResume) ?? matching[0];
    if (!child) return;
    if (CLOSE_EVENTS.has(event.event)) {
      // agent_move closed this pane, and the child goes on elsewhere under the
      // same id; or agent_restart closed it, and the child goes on in a new tab.
      if (isMoving(child) || closingNow(child) || child.restartInDoubt) {
        this.dropLink(host);
        void this.reconcileAndSubscribe();
        return;
      }
      const code = typeof event.data['exit_code'] === 'number' ? (event.data['exit_code'] as number) : undefined;
      if (child.awaitsResume) this.stopAwaiting(child, 'its pane closed');
      // A harness that already ended in this pane was reported then; the tab closing says nothing new.
      if (child.exitedAt && child.harnessEnded) this.closeQuietly(child);
      else this.markExited(child, code, undefined, event.event === 'pane.exited' || event.event === 'pane_exited' ? 'exited' : 'closed');
      // The subscription named that pane, so it has to be rebuilt without it.
      this.dropLink(host);
      void this.reconcileAndSubscribe();
      return;
    }
    // An adoption in doubt says nothing until its machine confirms it (issue #211).
    if (child.adoptInDoubt) return;
    if (STATUS_EVENTS.has(event.event)) {
      // A harness that ended in its pane is reported; the pane's last status changes say nothing more.
      if (child.exitedAt && child.harnessEnded) return;
      const status = statusOf(event.data, child.lastStatus);
      const stateSeq = typeof event.data['state_change_seq'] === 'number' ? (event.data['state_change_seq'] as number) : undefined;
      // herdr numbers the turn on the event that ends it. Read the number here,
      // as reconcile does from a snapshot, so the turn has one number from its
      // end on: a later snapshot that reads the same turn finds it already known.
      const seq = typeof event.data['completion_seq'] === 'number' ? (event.data['completion_seq'] as number) : undefined;
      updateChild(this.parentId, child.id, (entry) => {
        if (seq !== undefined && (seq !== entry.completionSeq || entry.completionPane !== entry.paneId)) {
          entry.completionSeq = seq;
          entry.completionPane = entry.paneId;
          entry.lastBusyAt = new Date().toISOString();
        }
        if (status !== 'unknown') harnessSeen(entry, new Date().toISOString());
        if (entry.prompt?.source === 'screen' && (entry.lastStatus !== status || (stateSeq !== undefined && stateSeq !== entry.stateChangeSeq))) delete entry.prompt;
        if (hookDialogClosed(entry.prompt, entry.lastStatus, status)) delete entry.prompt;
        if (entry.lastStatus !== status) {
          entry.statusChangedAt = new Date().toISOString();
          // herdr 0.9.5 sends no state_change_seq on this event, so a seq
          // read before the change no longer describes the status.
          entry.stateChangeSeq = stateSeq;
        } else if (stateSeq !== undefined) entry.stateChangeSeq = stateSeq;
        statusSeen(entry, status);
      });
      // A pi child can reach herdr's detection after the spawn looked, and
      // after the agent_detected event, so a status change of a child with no
      // session is when to ask herdr for it.
      if (!child.session) await this.learnAgent(host, child, event.data);
      // Read the registry again rather than reusing the copy taken above,
      // which still holds the status from before this event.
      await this.evaluate();
      return;
    }
    if (AGENT_EVENTS.has(event.event)) {
      // The harness of an adopted child that ended here may be back.
      if (child.exitedAt && child.awaitsResume) {
        if (event.data['released'] !== true) await this.comeBack(host, child, parsePane(event.data));
        return;
      }
      // herdr releases a pane's agent when the harness process ends and the
      // shell it ran in stays: the child is gone, though its tab is not.
      if (event.data['released'] === true) {
        if (!child.exitedAt && !isMoving(child) && !closingNow(child) && !child.restartInDoubt) {
          this.markExited(child, undefined, 'in-pane');
          this.dropLink(host);
          void this.reconcileAndSubscribe();
        }
        return;
      }
      if (typeof event.data['agent'] === 'string' && event.data['agent'] && !child.harnessSeenAt) {
        updateChild(this.parentId, child.id, (entry) => {
          harnessSeen(entry, new Date().toISOString());
        });
      }
      const signal = this.controller?.signal;
      if (signal) await this.reconcile(await this.clientFor(host), (record?.children ?? []).filter((entry) => hostOf(entry) === host), signal);
    }
  }

  /**
   * Record the session and the harness's own name for a child herdr knows by
   * now: from the event when it carries them, otherwise from one agent.get.
   * A local child's transcript is looked up with the session.
   */
  private async learnAgent(host: string, child: ChildRecord, data: Record<string, unknown>): Promise<void> {
    let agent = data;
    if (!sessionFrom(agent['agent_session'])) {
      try {
        const result = await (await this.clientFor(host)).request('agent.get', { target: child.paneId }, { signal: this.controller?.signal });
        agent = isRecord(result) && isRecord(result['agent']) ? result['agent'] : isRecord(result) ? result : {};
      } catch {
        return;
      }
    }
    const session = sessionFrom(agent['agent_session']);
    const agentName = agentNameOf(agent, child.name);
    if (!session && !agentName) return;
    updateChild(this.parentId, child.id, (entry) => {
      if (session) sessionSeen(entry, session);
      if (agentName) entry.agentName = agentName;
    });
    if (session && host === LOCAL_HOST && !child.transcript) this.recordTranscript(child, session.value);
  }

  private dropLink(host: string): void {
    this.links.get(host)?.subscription.close();
    this.links.delete(host);
  }

  /** Read the live status of every child and fold it into the classifier. */
  private async reconcile(client: HerdrClient, children: ChildRecord[], signal: AbortSignal): Promise<void> {
    if (!children.length) return;
    let panes: Record<string, unknown>[] = [];
    let agents: Record<string, unknown>[] = [];
    try {
      // session.snapshot answers {type, snapshot: {panes, agents, tabs, ...}}.
      const result = await client.snapshot(signal);
      const snapshot = isRecord(result['snapshot']) ? result['snapshot'] : result;
      const paneList = snapshot['panes'] ?? snapshot['pane_list'];
      panes = Array.isArray(paneList) ? (paneList as Record<string, unknown>[]) : [];
      const agentList = snapshot['agents'];
      agents = Array.isArray(agentList) ? (agentList as Record<string, unknown>[]) : [];
    } catch (error) {
      this.log(`snapshot failed: ${String(error)}`);
      return;
    }
    // A pane entry is a PaneInfo, which carries no completion_seq. The agent
    // entry beside it is an AgentInfo, which does, so the agent entry wins.
    const byId = new Map<string, Record<string, unknown>>();
    for (const pane of [...panes, ...agents]) {
      const paneId = pane['pane_id'];
      if (typeof paneId === 'string') byId.set(paneId, pane);
    }
    for (const child of children) {
      const pane = byId.get(child.paneId);
      if (!pane) continue;
      const status = statusOf(pane, child.lastStatus);
      const seq = typeof pane['completion_seq'] === 'number' ? (pane['completion_seq'] as number) : undefined;
      const stateSeq = typeof pane['state_change_seq'] === 'number' ? (pane['state_change_seq'] as number) : undefined;
      const session = sessionFrom(pane['agent_session']);
      const sessionChanged = session !== undefined && (session.value !== child.session?.value || session.kind !== child.session?.kind);
      // An adopted child stands for the session it was adopted on: Bellwether
      // started nothing in the pane, so no child id rides in the session, and
      // the pane and session are the child's whole identity. Another session in
      // the pane, after a /clear, a /resume or herdr reusing the pane id, is
      // another agent, which no parent adopted (issue #211, item 7).
      if (heldByAdoption(child) && child.session && session && session.value !== child.session.value) {
        this.markExited(child, undefined, 'in-pane', 'session-changed', { session: session.value });
        this.dropLink(hostOf(child));
        void this.reconcileAndSubscribe();
        continue;
      }
      const agentName = agentNameOf(pane, child.name);
      const nameChanged = agentName !== undefined && agentName !== child.agentName;
      const seen = !child.harnessSeenAt && ((typeof pane['agent'] === 'string' && pane['agent'] !== '') || status !== 'unknown');
      if (seen) {
        updateChild(this.parentId, child.id, (entry) => {
          harnessSeen(entry, new Date().toISOString());
        });
      }
      if (status !== child.lastStatus || (seq !== undefined && seq !== child.completionSeq) || (stateSeq !== undefined && stateSeq !== child.stateChangeSeq) || sessionChanged || nameChanged) {
        updateChild(this.parentId, child.id, (entry) => {
          const at = new Date().toISOString();
          // A dialog read off the screen holds only until herdr says something new.
          if (entry.prompt?.source === 'screen' && (status !== entry.lastStatus || (seq !== undefined && seq !== entry.completionSeq) || (stateSeq !== undefined && stateSeq !== entry.stateChangeSeq))) delete entry.prompt;
          if (hookDialogClosed(entry.prompt, entry.lastStatus, status)) delete entry.prompt;
          if (entry.lastStatus !== status) entry.statusChangedAt = at;
          // A new turn is activity even when the status did not change. The
          // record keeps it, so a restarted parent does not lose the period.
          if (seq !== undefined && seq !== entry.completionSeq) entry.lastBusyAt = at;
          statusSeen(entry, status);
          if (seq !== undefined) {
            entry.completionSeq = seq;
            entry.completionPane = entry.paneId;
          }
          if (stateSeq !== undefined) entry.stateChangeSeq = stateSeq;
          if (session) sessionSeen(entry, session);
          if (agentName) entry.agentName = agentName;
        });
        // A new session is a new file to read, and for pi the session is the file.
        if (session && sessionChanged && hostOf(child) === LOCAL_HOST) this.recordTranscript({ ...child, transcript: undefined }, session.value);
      }
    }
    await this.evaluate();
  }

  /**
   * Run one classifier pass, or join the pass that waits for the running one.
   * A pass reads each child's state, waits on herdr or the disk, then stores
   * the state it computed. The ticker and every herdr event start a pass, so
   * without this two passes would read the same state, and the slower one
   * would raise its event again and store an older state over the newer one.
   * A caller that arrives during a pass gets the next one, which reads the
   * registry after the running pass has stored what it found.
   */
  private evaluate(): Promise<void> {
    if (!this.evaluating) {
      this.evaluating = this.evaluateOnce().finally(() => {
        this.evaluating = undefined;
      });
      return this.evaluating;
    }
    this.nextEvaluation ??= this.evaluating
      .catch(() => {})
      .then(() => {
        this.nextEvaluation = undefined;
        return this.evaluate();
      });
    return this.nextEvaluation;
  }

  /**
   * One classifier pass over every child. It reads the registry itself, so a
   * caller can never hand it a stale copy.
   */
  private async evaluateOnce(): Promise<void> {
    const record = readParent(this.parentId);
    if (!record) return;
    const now = this.now();
    for (const child of record.children) {
      // A restart that closed the child's pane and could not start it again
      // left the child gone, and the parent hears of it once (issue #185). The
      // restart may have run in another session's service, so the record
      // carries it here.
      if (child.restartFailed && !child.restartFailed.told) {
        const failure = child.restartFailed;
        updateChild(this.parentId, child.id, (entry) => {
          if (entry.restartFailed) entry.restartFailed.told = true;
        });
        this.offer(child, 'exited', restartFailureText(child, failure));
      }
      if (child.exitedAt) continue;
      // The spawn is answering this child's startup dialogs. Its first state
      // is read once the spawn is done.
      if (child.startingUntil && Date.parse(child.startingUntil) > Date.now()) {
        this.states.delete(child.id);
        continue;
      }
      // A child changing machines is read again once it runs on the new one,
      // and a child whose restart answer was lost, once that answer arrives.
      if (isMoving(child) || child.restartInDoubt || child.adoptInDoubt) {
        this.states.delete(child.id);
        continue;
      }
      // A machine the watcher cannot reach says nothing new about its children.
      const away = this.away.has(hostOf(child));
      if (!away && (await this.endedBeforeSeen(child))) continue;
      if (child.lastStatus !== 'blocked') this.gaveUp.delete(child.id);
      // A state built for another pane counts that pane's turns: a restart,
      // resume, move or teleport gave the child a new one (issue #271).
      const held = this.states.get(child.id);
      const state = held && held.paneId === child.paneId ? held : seedFor(child, now, { crossed: held !== undefined });
      const busy = away ? false : await this.childIsBusy(child, now);
      // A spawn can set its own stuck and inactivity thresholds. The stuck one
      // is what the lab uses to reach that event in seconds rather than minutes.
      // While its machine is unreachable a child is never stuck, because its
      // quiet is the link's; the inactivity notice still comes, and says so.
      const limits = limitsFor(child, this.limits);
      const { state: next, event } = advance(state, { status: child.lastStatus, completionSeq: seqHere(child), busy, prompt: child.prompt?.line }, now, away ? { ...limits, stuckMs: Number.POSITIVE_INFINITY } : limits);
      this.states.set(child.id, next);
      if (!event) continue;
      if (event === 'inactive') {
        // Written before the offer, so a restart cannot send the same period again.
        const notifiedFor = new Date(next.lastActivityAt).toISOString();
        updateChild(this.parentId, child.id, (entry) => {
          entry.inactiveNotifiedFor = notifiedFor;
        });
      }
      // Bellwether reports a dialog and never answers it, apart from the
      // dialogs in the harness's set, which answerStartupDialog owns: Claude
      // Code's startup questions, and the two questions it declines for a
      // child it started. Approving a permission question is the operator's
      // decision, not the tool's: do not add a keystroke on this path.
      // test/integration/blocked-modal.test.ts fails when one reaches the pane.
      if (event === 'blocked') {
        // A dialog the hook already named reaches the parent as it is: herdr
        // reports a Claude Code dialog blocked at 3 s, before the hook's 6 s, so
        // a question Bellwether answers is read from the screen below first.
        if (child.prompt) {
          this.offer(child, event, this.describeBlocked(child, child.prompt.line));
          continue;
        }
        // TODO(api): the screen decides whether this blocked child is on a Claude
        // Code startup question, which the watcher answers itself. herdr's blocked
        // status does not say which dialog is up, and Claude Code runs no hook for
        // its startup questions: the Notification hook fires for a permission or
        // MCP dialog only, about 6 s after it opens, which is after this event
        // settles. A field on herdr's status event naming the pending dialog, or a
        // Claude Code hook that fires as any dialog opens, would retire the read
        // as evidence. The same text names the dialog for the parent.
        const dialog = await this.clientFor(hostOf(child))
          .then((client) => client.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }))
          .catch(() => BLANK_SCREEN);
        if (this.answerStartupDialog(child, dialog.plain)) continue;
        this.offer(child, event, this.describeBlocked(child, detectModal(dialog)));
        continue;
      }
      if (event === 'idle') {
        // herdr reports a harness that waits on a dialog as idle when the
        // harness never told it otherwise, as pi does for an extension's dialog.
        // TODO(api): the screen tells a finished turn from a dialog for a harness
        // that does not report its prompts. A child whose harness reported one
        // never gets here: the open prompt holds idle back. pi's ui_prompt_start
        // retires this read for a local pi child, and the Notification hook in a
        // local Claude Code child's own settings retires it for a permission or
        // MCP dialog that outlasts Claude Code's 6 s wait before it notifies.
        // Three cases still come here: a Claude Code dialog younger than that
        // wait when idle settles at 5 s, a dialog Claude Code sends no notification
        // for (its startup questions, a free-text box, a custom screen), a child
        // started with CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS, and any child on
        // another machine, whose hook and pi notice reach only that machine's
        // daemon. A Claude Code hook that fires as any dialog opens, with no
        // delay, or a herdr status that maps every harness's dialog to blocked,
        // would retire the rest.
        // detectModal decides a dialog first, on every line, and needs its marker
        // or y/n question solid, so a faint suggestion in the box is no dialog.
        const screen = await this.clientFor(hostOf(child))
          .then((client) => client.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }))
          .catch(() => BLANK_SCREEN);
        const line = detectModal(screen);
        if (line) {
          // The turn stays unreported, so the idle event still comes once the
          // dialog closes and the child settles.
          const held: ClassifierState = { ...next, reportedFor: state.reportedFor, prompt: line, promptSince: now, firedBlocked: true };
          if (this.answerStartupDialog(child, screen.plain)) {
            this.states.set(child.id, state);
            continue;
          }
          updateChild(this.parentId, child.id, (entry) => {
            entry.prompt = { line, source: 'screen', since: new Date(now).toISOString() };
          });
          this.states.set(child.id, held);
          this.offer(child, 'blocked', this.describeBlocked(child, line));
          continue;
        }
      }
      const quietSince = event === 'inactive' ? next.lastActivityAt : next.lastBusyAt;
      // Written before the offer, so a watcher that starts again cannot send the same turn twice.
      this.remember(child);
      this.offer(child, event, await this.describe(child, event, quietSince, now));
    }
    for (const child of record.children) this.remember(child);
    this.publish();
  }

  /**
   * Keep on the child record the turn the parent last heard about, and a final
   * report that waits for its turn to end. A watcher seeds a child from these,
   * so a new service, a daemon that took over, or a reconnect compares against
   * what the parent was told rather than against herdr's current answer.
   */
  private remember(child: ChildRecord): void {
    const state = this.states.get(child.id);
    if (!state || !child.paneId || state.paneId !== child.paneId) return;
    const pending = Boolean(state.reportPending);
    // In a pane the child crossed into, before a turn there was told, the
    // record keeps where counting starts rather than a turn (issue #271): a
    // turn number would read as a turn the child finished in this pane.
    const told = state.reportedFor !== undefined && !state.fresh && state.reportedFor !== state.base ? state.reportedFor : undefined;
    const crossing = state.fresh || state.base !== undefined;
    const baseline = crossing && told === undefined ? { paneId: child.paneId, ...(state.base === undefined ? {} : { seq: state.base }), ...(state.fresh ? {} : { worked: true as const }) } : undefined;
    const known = child.turnNotified?.paneId === child.paneId ? child.turnNotified.seq : undefined;
    const sameBaseline = JSON.stringify(child.turnBaseline ?? null) === JSON.stringify(baseline ?? null);
    if (crossing ? known === told && sameBaseline : known === state.reportedFor) {
      if (Boolean(child.reportPending) === pending) return;
    }
    updateChild(this.parentId, child.id, (entry) => {
      // The record moved to another pane since this pass read it: that pane counts its own turns.
      if (entry.paneId !== child.paneId) return;
      if (crossing) {
        if (told !== undefined) entry.turnNotified = { paneId: child.paneId, seq: told };
        if (baseline) entry.turnBaseline = baseline;
        else delete entry.turnBaseline;
      } else if (state.reportedFor === undefined) delete entry.turnNotified;
      else {
        entry.turnNotified = { paneId: child.paneId, seq: state.reportedFor };
        delete entry.turnBaseline;
      }
      reportPending(entry, pending);
    });
    const fresh = readParent(this.parentId)?.children.find((entry) => entry.id === child.id);
    child.turnNotified = fresh?.turnNotified;
    child.turnBaseline = fresh?.turnBaseline;
    reportPending(child, pending);
  }

  private readonly answering = new Set<string>();
  /** Children whose startup dialog outlasted its wait in this blocked spell. */
  private readonly gaveUp = new Set<string>();

  /**
   * A Claude Code startup dialog on a child's screen is Bellwether's to
   * answer, never the operator's: a resumed session shows the development
   * channel question again, long after its spawn returned. Answer it here and
   * publish nothing. Returns false for any other dialog, and for one whose
   * answer already failed, which then reaches the parent as blocked.
   */
  private answerStartupDialog(child: ChildRecord, screen: string): boolean {
    const dialogs = harnessFor(child.kind)?.startup;
    const dialog = dialogs && this.answers(child) ? detectDialog(screen, dialogs) : undefined;
    if (!dialogs || !dialog || this.gaveUp.has(child.id)) return false;
    if (this.answering.has(child.id)) return true;
    this.answering.add(child.id);
    this.log(`${child.name} is on ${dialogName(dialog, dialogs)}; answering it`);
    void (async () => {
      // Each decision goes on the record as its Enter goes out, ahead of the idle event it causes.
      const onDecision = (decision: DialogDecision): void => recordDecisions(this.parentId, child.id, [decision]);
      const watch = await watchStartup(await this.clientFor(hostOf(child)), child.paneId, this.controller?.signal, { dialogs, by: 'watcher', onDecision });
      try {
        await watch.answer();
      } finally {
        watch.close();
      }
    })()
      .catch((error: unknown) => {
        this.log(`answering ${child.name}'s startup dialog failed: ${String(error)}`);
        this.gaveUp.add(child.id);
        const state = this.states.get(child.id);
        if (state) this.states.set(child.id, { ...state, firedBlocked: undefined });
      })
      .finally(() => this.answering.delete(child.id));
    return true;
  }

  /**
   * Whether Bellwether answers this child's dialogs: only for a child it
   * started. An adopted child's session began under someone else's settings,
   * and a parent never types into a pane it does not own, so each of its
   * dialogs reaches the parent as blocked.
   */
  private answers(child: ChildRecord): boolean {
    return !heldByAdoption(child) && Boolean(harnessFor(child.kind)?.startup);
  }

  /**
   * The child's transcript. A spawn can finish before herdr has detected the
   * agent, and Claude Code writes its file only at the first turn, so the path
   * is resolved lazily rather than only at spawn time.
   */
  private async transcriptFor(child: ChildRecord): Promise<string | undefined> {
    // A remote child's transcript sits on its own machine's disk. A child that
    // moved away keeps the path of the one it left here, which ends before the
    // move, so that path never stands for it (issue #272).
    if (hostOf(child) !== LOCAL_HOST) return undefined;
    if (child.transcript) return child.transcript;
    // With the session known, a look is a file check, so it runs every pass.
    if (child.session) return this.recordTranscript(child, child.session.value);
    // Without it, a look costs a herdr call. A child whose harness reports no
    // session would otherwise cost one per tick forever, so look again once a
    // minute at most, because herdr can report the session a little after the
    // spawn returns.
    const lastLook = this.transcriptLookAt.get(child.id) ?? 0;
    if (this.now() - lastLook < TRANSCRIPT_LOOK_INTERVAL_MS) return undefined;
    this.transcriptLookAt.set(child.id, this.now());
    try {
      const result = await (await this.clientFor(LOCAL_HOST)).request('agent.get', { target: child.paneId });
      const record = isRecord(result) && isRecord(result['agent']) ? result['agent'] : isRecord(result) ? result : undefined;
      const session = sessionFrom(record?.['agent_session']);
      if (!session) return undefined;
      updateChild(this.parentId, child.id, (entry) => {
        sessionSeen(entry, session);
      });
      return this.recordTranscript(child, session.value);
    } catch {
      return undefined;
    }
  }

  /**
   * Look for the transcript of a session on this machine and write what was
   * found to the record: the path, or why there is none. The registry is
   * written only when that changes.
   */
  private recordTranscript(child: ChildRecord, session: string): string | undefined {
    const conversation = harnessFor(child.kind)?.conversation;
    const found = conversation ? conversation.locate(session, child.cwd) : { missing: `Bellwether knows no ${child.kind} harness` };
    if (found.path) {
      // A pi child started on pi's default names it in its session file.
      const model = !child.model ? conversation?.modelOf?.(found.path) : undefined;
      updateChild(this.parentId, child.id, (entry) => {
        entry.transcript = found.path;
        delete entry.transcriptMissing;
        if (model && !entry.model) entry.model = { ...model, source: 'session' };
      });
      return found.path;
    }
    if (found.missing !== child.transcriptMissing) {
      updateChild(this.parentId, child.id, (entry) => {
        entry.transcriptMissing = found.missing;
      });
    }
    return undefined;
  }

  /** Whether the child moved since the last look. Transcript growth, then screen. */
  private async childIsBusy(child: ChildRecord, now: number): Promise<boolean> {
    // A harness with a store of its own, such as OpenCode, changes a row with
    // each step its session takes, and the store says so without a screen read.
    const activity = harnessFor(child.kind)?.conversation.activity;
    if (activity) {
      const stamp = activity(child);
      if (stamp === undefined) return false;
      const previous = this.storeStamps.get(child.id);
      this.storeStamps.set(child.id, stamp);
      if (previous === undefined || stamp <= previous) return false;
      updateChild(this.parentId, child.id, (entry) => {
        entry.lastBusyAt = new Date().toISOString();
      });
      return true;
    }
    const transcript = await this.transcriptFor(child);
    if (transcript) {
      try {
        const size = fs.statSync(transcript).size;
        const previous = this.transcriptSizes.get(child.id);
        this.transcriptSizes.set(child.id, size);
        // The first look only sets the baseline.
        if (previous === undefined || size <= previous) return false;
        if (!conversationGrowth(readRange(transcript, previous, size))) return false;
        updateChild(this.parentId, child.id, (entry) => {
          entry.lastBusyAt = new Date().toISOString();
        });
        return true;
      } catch {
        return false;
      }
    }
    // A harness with no transcript moves only its screen, which costs a read.
    if (this.screenPollMs <= 0) return false;
    const last = this.screenReadAt.get(child.id) ?? 0;
    if (now - last < this.screenPollMs) return false;
    this.screenReadAt.set(child.id, now);
    try {
      // TODO(api): a screen diff stands in for an activity signal on a harness with
      // no transcript. herdr's schema lists a `pane_output_changed` event carrying the
      // pane's output revision, but herdr 0.9.5 offers it neither in events.subscribe
      // nor in events.wait, which answers that it supports only agent status matches.
      // A subscribable `pane_output_changed` would replace this read.
      // A suggestion that changes in the box is not the child at work, so the diff reads content only.
      const screen = (await (await this.clientFor(hostOf(child))).paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 })).content;
      const lines = screen.split('\n').filter((line) => line.trim().length > 0 && !/⏱|\[\d+% ·/.test(line));
      const previous = this.lastScreen.get(child.id);
      this.lastScreen.set(child.id, lines.join('\n'));
      if (previous !== undefined && previous !== lines.join('\n')) {
        updateChild(this.parentId, child.id, (entry) => {
          entry.lastBusyAt = new Date().toISOString();
        });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private readonly lastScreen = new Map<string, string>();

  /** What the parent is told about a child event. */
  private async describe(child: ChildRecord, event: ChildEventKind, quietSince: number, now: number): Promise<string> {
    const age = this.age(Date.parse(child.startedAt));
    if (event === 'exited') return this.describeExit(child, child.exitCode, child.harnessEnded === 'before-start');
    if (event === 'blocked') {
      if (child.prompt) return this.describeBlocked(child, child.prompt.line);
      // Pane feature: the parent's event text names the dialog its child is blocked on.
      const dialog = await this.clientFor(hostOf(child))
        .then((client) => client.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }))
        .catch(() => BLANK_SCREEN);
      return this.describeBlocked(child, detectModal(dialog));
    }
    // Measure the quiet period on the classifier's own clock. The registry's
    // lastBusyAt can be written by another process that only sees file size.
    if (event === 'stuck') return `${childLabel(child)} has been quiet for ${this.age(quietSince, now)}. Last screen lines:\n${trim(await this.screenTail(child))}`;
    if (event === 'inactive') return `${childLabel(child)} has shown no activity for ${this.age(quietSince, now)}, and its status is ${child.lastStatus}.${this.awayWarning(child)}${this.relayWarning(child)} Last screen lines:\n${trim(await this.screenTail(child))}`;
    // The turn's own last message, never the last report: a report is an event
    // of its own, and the record keeps it after the turn it belonged to.
    const last = await this.lastMessage(child);
    if (last.text) return `${childLabel(child)} went idle after ${age}${silence(child)}:\n${last.text}`;
    const screen = trim(await this.screenTail(child));
    // A child on another machine whose message the relay could not fetch: say
    // so, and label the screen, so an empty prompt never reads as its answer.
    if (last.why) return `${childLabel(child)} went idle after ${age}${silence(child)}. ${last.why}${this.relayWarning(child)}${screen ? ` Last screen lines:\n${screen}` : ' Its screen shows nothing readable either.'}`;
    return `${childLabel(child)} went idle after ${age}${silence(child)}:${screen ? `\n${screen}` : ' no message and no readable screen.'}`;
  }

  /** For a child whose machine's herdr the watcher cannot reach, one sentence that says it is unreachable, not exited. */
  private awayWarning(child: ChildRecord): string {
    const away = this.away.get(hostOf(child));
    if (!away) return '';
    return ` Bellwether cannot reach herdr on machine ${hostOf(child)} since ${away.since} (${away.error}), so that status is the last one it saw: the child is unreachable, not exited, and Bellwether reads it again once the machine answers.`;
  }

  /**
   * For a child on another machine the daemon cannot reach, one sentence that
   * says so: its quiet may be the connection's, and a report may be waiting there.
   */
  private relayWarning(child: ChildRecord): string {
    const host = hostOf(child);
    if (host === LOCAL_HOST || !this.relayState) return '';
    const state = this.relayState(host);
    if (state?.status === 'connected') return '';
    if (!state) return ` Bellwether holds no connection to machine ${host}, so it is not hearing from it.`;
    const heard = state.lastConnectedAt ? `last connected at ${state.lastConnectedAt}` : 'never connected';
    return ` Bellwether is not hearing from machine ${host}: it is ${state.status} (${heard})${state.lastError ? `, and the last attempt failed with ${state.lastError}` : ''}. A report the child made waits there and arrives once the connection returns.`;
  }

  /**
   * One line for the dialog, not the screen: enough to tell a trust question
   * from a permission question. agent_read shows the whole screen.
   */
  private describeBlocked(child: ChildRecord, line: string | undefined): string {
    const what = line ? `: ${line}` : ', which Bellwether could not name from the screen';
    return `${childLabel(child)} is blocked on a dialog after ${this.age(Date.parse(child.startedAt))}${what}\nIt waits for a person to answer, and Bellwether does not answer it. Read the screen with agent_read, then answer with agent_send keys.`;
  }

  private describeExit(child: ChildRecord, code: number | undefined, beforeStart = false): string {
    if (child.paneEnd?.how === 'claim-lost') return `${childLabel(child)} is not a child of this session any more: once the relay came back, machine ${hostOf(child)} no longer held this session's claim on pane ${child.paneId} and refused it: ${child.paneEnd.reason ?? 'it gave no reason'}. Bellwether stopped watching the pane.`;
    if (child.paneEnd?.how === 'adopt-refused') return `${childLabel(child)} is not a child of this session: machine ${hostOf(child)} refused the adoption Bellwether was not sure of: ${child.paneEnd.reason ?? 'it gave no reason'}. Bellwether stopped watching pane ${child.paneId}.`;
    if (child.paneEnd?.how === 'session-changed') return `${childLabel(child)} left its pane: herdr reports ${child.paneEnd.session ? `session ${child.paneEnd.session}` : 'another session'} in pane ${child.paneId} now, not ${child.session?.value ?? 'the adopted one'}, the session this parent adopted. Bellwether stopped watching the pane: adopt it again to watch the new session.`;
    const coded = code === undefined ? '' : ` with code ${code}`;
    const tab = child.harnessEnded ? ' Its tab stays open on the shell the harness ran in, with what the harness printed before it ended: agent_read shows that screen, and agent_stop closes the tab.' : '';
    if (beforeStart) return `${childLabel(child)} never started: its ${child.kind} process ended${coded} before it reported anything, so it did not run its task.${tab}`;
    return `${childLabel(child)} exited${coded}.${tab}`;
  }

  private async screenTail(child: ChildRecord, lines = 40): Promise<string> {
    // Pane feature: the last screen lines go into the parent's event text, for a
    // stuck or inactive child, or an idle one with no report and no transcript.
    // A suggestion in the input box stays out of it, and its last line says what
    // the box holds, so a parent never reads a suggestion as somebody's words.
    return this.clientFor(hostOf(child))
      .then((client) => client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines }))
      .then(shownScreen)
      .catch(() => '');
  }

  /**
   * The child's last assistant message: from its transcript or store on this
   * machine, or over the relay connection for a child on another machine
   * (issue #272). `why` says, for a far child, why no message came back.
   */
  private async lastMessage(child: ChildRecord): Promise<{ text?: string; why?: string }> {
    const host = hostOf(child);
    if (host !== LOCAL_HOST) {
      if (!this.remoteLastMessage) return { why: `Bellwether could not read its last message on machine ${host}, because this session holds no connection there.` };
      // The read goes only over a connection that is open, and waits a bounded
      // time: the watcher's pass serves every child, and a read that waited on
      // a reconnect would hold back each event behind it.
      const link = this.relayState?.(host);
      if (this.relayState && link?.status !== 'connected') return { why: `Bellwether could not read its last message on machine ${host}, because its connection there is not open.` };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${REMOTE_READ_MS} ms`)), REMOTE_READ_MS);
        });
        const text = (await Promise.race([this.remoteLastMessage(child), late]))?.trim();
        return text ? { text } : { why: `Bellwether could not read its last message on machine ${host}: that machine has no transcript message for it.` };
      } catch (error) {
        return { why: `Bellwether could not read its last message on machine ${host}: ${(error as Error).message}.` };
      } finally {
        clearTimeout(timer);
      }
    }
    const fromStore = harnessFor(child.kind)?.conversation.lastMessage;
    if (fromStore) return { text: fromStore(child) };
    const transcript = await this.transcriptFor(child);
    return { text: transcript ? lastAssistantMessage(transcript) : undefined };
  }

  private offer(child: ChildRecord, event: ChildEventKind, given: string, via?: ReportVia): void {
    // The parent hears each answer Bellwether gave for the child once, with
    // the first event after it, right under the event's first line.
    const { taken, earlier } = takeUntoldDecisions(this.parentId, child.id);
    const [headline = '', ...rest] = given.split('\n');
    const text = taken.length ? [headline, describeDecisions(childLabel(child), taken, earlier), ...rest].join('\n') : given;
    const state = event === 'blocked' || event === 'stuck' || event === 'idle' ? { status: child.lastStatus, stateChangeSeq: child.stateChangeSeq } : {};
    this.outbox.offer({ childId: child.id, name: child.name, kind: child.kind, paneId: child.paneId, event, text, at: new Date().toISOString(), ...state, ...(via ? { via } : {}) });
    this.outbox.prune();
    this.outbox.save(this.parentId);
  }

  /** Settle the entries a newer child state made stale, against the registry as it is now. */
  private settleStale(): void {
    const children = readParent(this.parentId)?.children ?? [];
    if (this.outbox.settleSuperseded(children).length) this.outbox.save(this.parentId);
  }

  /**
   * Hand the adapter every unread entry, plus each entry settled without a
   * receipt since the last call, marked read, so a client holding one drops
   * it instead of sending it again.
   */
  private publish(): void {
    this.settleStale();
    const settled = this.outbox.takeSettled();
    const pending = this.outbox.pending();
    if (!pending.length && !settled.length) return;
    this.onEntries([...settled, ...pending]);
  }

  /** Read parent_report lines the children appended to the spool. */
  private tailSpool(): void {
    const file = spoolPath(this.parentId);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (content.length <= this.spoolOffset) return;
    const fresh = content.slice(this.spoolOffset);
    this.spoolOffset = content.length;
    mutateParent(this.parentId, (record) => {
      record.spoolOffset = content.length;
    });
    for (const line of fresh.split('\n')) {
      if (!line.trim()) continue;
      try {
        const report = JSON.parse(line) as SpoolReport;
        this.acceptReport(report);
      } catch {
        this.log('ignored an unreadable spool line');
      }
    }
  }

  private acceptReport(report: SpoolReport): void {
    const record = readParent(this.parentId);
    const child = record?.children.find((entry) => entry.id === report.childId || entry.name === report.childName);
    if (!child) return;
    updateChild(this.parentId, child.id, (entry) => {
      entry.lastReport = { status: report.status, text: report.text, at: report.at, seq: report.seq, ...(report.via ? { via: report.via } : {}), ...(report.toolOffered !== undefined ? { toolOffered: report.toolOffered } : {}) };
      entry.lastBusyAt = report.at;
    });
    // A child this watcher has not evaluated yet starts from its record, so the
    // report covers the right turn either way.
    const now = this.now();
    const held = this.states.get(child.id);
    this.states.set(child.id, markReported(held && held.paneId === child.paneId ? held : seedFor(child, now, { crossed: held !== undefined }), now, report.status !== 'progress'));
    this.remember(child);
    const label = report.status === 'needs-input' ? 'needs input' : report.status;
    const path = report.via ? `, ${reportViaLine(report.via, report.toolOffered)}` : '';
    this.offer(child, 'report', `${childLabel(child)} reported ${label}${path}:\n${report.text}`, report.via);
    this.publish();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.tailSpool();
    const record = readParent(this.parentId);
    const byHost = groupByHost((record?.children ?? []).filter(watched));
    // A new child, or one that left, changes the set of panes to watch. The
    // tick reads only the local registry, so the steady state stays at zero
    // herdr calls.
    const due = (host: string): boolean => (this.retryAt.get(host)?.at ?? 0) <= Date.now();
    const changed = [...byHost].some(([host, children]) => due(host) && this.links.get(host)?.key !== paneKey(children)) || [...this.links.keys()].some((host) => !byHost.has(host));
    for (const child of record?.children ?? []) if (child.adoptInDoubt && !child.exitedAt) void this.settleAdoption(child);
    for (const child of record?.children ?? []) if (child.claimUnconfirmed && !child.adoptInDoubt && !child.exitedAt) void this.confirmClaim(child);
    if (changed) {
      await this.reconcileAndSubscribe();
      return;
    }
    await this.evaluate();
  }

  /**
   * The relay to a machine is up, after a first connection or a reconnect:
   * confirm each claim this parent holds there by adoption (issue #257).
   * While the relay was down, the watcher could not see the pane, and another
   * parent may have taken the claim over. The pane's session may since have
   * come back, so the record matches the pane again, and only that machine
   * can say whether it still holds the claim for this child.
   */
  confirmClaims(host: string): void {
    for (const child of readParent(this.parentId)?.children ?? []) {
      if (hostOf(child) !== host || child.exitedAt || child.adoptInDoubt || !heldByAdoption(child)) continue;
      this.doubtRetry.delete(child.id);
      void this.confirmClaim(child);
    }
  }

  /**
   * Send one child's claim to its machine again. A kept or restored claim
   * clears the mark. A refusal, or the pane held for this session under
   * another id, ends the child with the reason. Any other failure leaves the
   * child as it is, marked unconfirmed for doctor, and the tick asks again,
   * up to once a minute.
   */
  private async confirmClaim(child: ChildRecord): Promise<void> {
    if (!this.reclaimRemote || this.settling.has(child.id)) return;
    const retry = this.doubtRetry.get(child.id);
    if (retry && retry.at > Date.now()) return;
    this.settling.add(child.id);
    try {
      await this.reclaimRemote(child);
      this.doubtRetry.delete(child.id);
      updateChild(this.parentId, child.id, (entry) => {
        delete entry.claimUnconfirmed;
        delete entry.farRecordLost;
      });
      this.log(`machine ${hostOf(child)} confirmed the claim on pane ${child.paneId} for ${child.name}, as child ${child.id}`);
    } catch (error) {
      if (error instanceof ClaimRefused || error instanceof ClaimHeldElsewhere) {
        this.doubtRetry.delete(child.id);
        this.endRefusedClaim(child, error, 'claim-lost');
        return;
      }
      const delay = Math.min((retry?.delay ?? 500) * 2, 60_000);
      this.doubtRetry.set(child.id, { at: Date.now() + delay, delay });
      const reason = (error as Error).message.trim().replace(/\.$/, '');
      updateChild(this.parentId, child.id, (entry) => {
        entry.claimUnconfirmed = { at: entry.claimUnconfirmed?.at ?? new Date().toISOString(), host: hostOf(child), reason };
      });
      this.log(`could not confirm the claim on pane ${child.paneId} for ${child.name} on machine ${hostOf(child)}: ${reason}`);
    } finally {
      this.settling.delete(child.id);
    }
  }

  /** End a child whose machine refused its claim, or holds the pane for this session under another id. */
  private endRefusedClaim(child: ChildRecord, error: ClaimRefused | ClaimHeldElsewhere, how: 'adopt-refused' | 'claim-lost'): void {
    const reason = error instanceof ClaimHeldElsewhere ? `it holds pane ${child.paneId} for this session as child ${error.childId}; adopt the pane again to watch it under that id` : error.message.trim().replace(/\.$/, '');
    updateChild(this.parentId, child.id, (entry) => {
      delete entry.adoptInDoubt;
      delete entry.claimUnconfirmed;
      if (error instanceof ClaimHeldElsewhere) entry.replacedBy = error.childId;
    });
    this.markExited({ ...child, adoptInDoubt: undefined, claimUnconfirmed: undefined }, undefined, undefined, how, { reason });
    this.dropLink(hostOf(child));
    void this.reconcileAndSubscribe();
  }

  /**
   * Ask the far machine again about an adoption whose first answer the relay
   * lost (issue #211, item 6). The ask is the same claim, so it settles the
   * doubt either way: that machine holds the pane for this child, refuses it,
   * or holds it for this parent under another id. A failed ask waits longer
   * before the next one, up to a minute.
   */
  private async settleAdoption(child: ChildRecord): Promise<void> {
    if (!this.reclaimRemote || this.settling.has(child.id)) return;
    const retry = this.doubtRetry.get(child.id);
    if (retry && retry.at > Date.now()) return;
    this.settling.add(child.id);
    try {
      await this.reclaimRemote(child);
      this.doubtRetry.delete(child.id);
      updateChild(this.parentId, child.id, (entry) => {
        delete entry.adoptInDoubt;
      });
      this.log(`machine ${hostOf(child)} confirmed the adoption of ${child.name} in pane ${child.paneId}, as child ${child.id}`);
      this.childrenChanged?.();
      this.dropLink(hostOf(child));
      void this.reconcileAndSubscribe();
    } catch (error) {
      if (error instanceof ClaimRefused || error instanceof ClaimHeldElsewhere) {
        this.doubtRetry.delete(child.id);
        this.endRefusedClaim(child, error, 'adopt-refused');
        return;
      }
      const delay = Math.min((retry?.delay ?? 500) * 2, 60_000);
      this.doubtRetry.set(child.id, { at: Date.now() + delay, delay });
      this.log(`could not ask machine ${hostOf(child)} again about ${child.name}'s adoption: ${(error as Error).message}`);
    } finally {
      this.settling.delete(child.id);
    }
  }

  private age(since: number, now = this.now()): string {
    const seconds = Math.max(0, Math.round((now - since) / 1000));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    return `${Math.round(minutes / 60)} h`;
  }
}

function trim(value: string, limit = 3000): string {
  return value.trim().slice(-limit);
}

/** Read a byte range of a file, for the part appended since the last look. */
function readRange(file: string, from: number, to: number): string {
  const length = to - from;
  if (length <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, from);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether appended transcript bytes show the agent working. A session file also
 * collects entries an extension writes, and this machine's `pi-cpu-sample`
 * appends one every thirty seconds, so file size alone says nothing. Only an
 * entry that is not a `custom` one counts as the conversation moving.
 */
function conversationGrowth(added: string): boolean {
  for (const line of added.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry['type'] !== 'custom') return true;
    } catch {
      // A half-written line is not evidence of work either way.
    }
  }
  return false;
}

/**
 * herdr names an event in a subscription request with dots and sends the frame
 * with underscores, so both spellings are accepted here. A tab close arrives
 * as `tab_closed` and names the tab rather than the pane.
 */
const CLOSE_EVENTS = new Set(['pane.exited', 'pane_exited', 'pane.closed', 'pane_closed', 'tab.closed', 'tab_closed']);

const STATUS_EVENTS = new Set(['pane.agent_status_changed', 'pane_agent_status_changed']);

/** herdr names an event by its subscription type in some places and with underscores on the wire. */
const AGENT_EVENTS = new Set(['pane.agent_detected', 'pane_agent_detected']);

/** How often to ask herdr for a child's session when no transcript is known. */
const TRANSCRIPT_LOOK_INTERVAL_MS = 60_000;

/** A child the watcher follows: a live one, or an adopted one whose pane it watches for the harness's return. */
function watched(child: ChildRecord): boolean {
  return !child.exitedAt || Boolean(child.awaitsResume);
}

/** Live children grouped by the herdr host they run on. */
function groupByHost(children: ChildRecord[]): Map<string, ChildRecord[]> {
  const groups = new Map<string, ChildRecord[]>();
  for (const child of children) {
    const host = hostOf(child);
    const group = groups.get(host) ?? [];
    group.push(child);
    groups.set(host, group);
  }
  return groups;
}

/** The set of panes the subscription must cover, as one comparable string. */
function paneKey(children: ChildRecord[]): string {
  return children
    .filter((child) => !child.exitedAt && !child.adoptInDoubt && child.paneId)
    .map((child) => `${child.paneId}:${child.harness === 'other' ? 'raw' : 'agent'}`)
    .sort()
    .join(',');
}

/**
 * For an idle event, the clause that says the child has not called
 * parent_report since its latest start, resume or adoption, or nothing when it
 * has. A harness that refuses the child's own report, or a model that never
 * calls it, ends the turn the same way a quiet finish does, so the parent needs
 * the fact to look closer. It names the fact, not a reason: the record cannot
 * tell a refused call from one never made. It rides on the turn's one idle
 * event, so it adds no wake.
 */
export function silence(child: ChildRecord): string {
  const started = child.resumedAt ?? child.startedAt;
  const reportedAt = child.lastReport ? Date.parse(child.lastReport.at) : NaN;
  if (Number.isFinite(reportedAt) && reportedAt >= Date.parse(started)) return '';
  const since = child.resumedAt ? 'it resumed' : heldByAdoption(child) ? 'Bellwether adopted it' : 'it started';
  return `, and it has not called parent_report since ${since} at ${started}`;
}

/** The sentence an exit event adds for each session message the child never read. */
function unreadNote(unread: readonly ChildMessage[]): string {
  if (!unread.length) return '';
  const list = unread.map((message) => `${message.id} (sent at ${message.at}: "${message.preview}")`).join(', ');
  return ` It never read ${unread.length === 1 ? 'message' : 'messages'} ${list}, which ${unread.length === 1 ? 'is' : 'are'} undelivered: send ${unread.length === 1 ? 'it' : 'them'} again once the child runs, if ${unread.length === 1 ? 'it' : 'they'} still matter.`;
}
