// A parent service: everything the daemon keeps for one parent session. The
// herdr-backed service wraps the same tool list, watcher and outbox the
// adapters used to run in-process; the daemon now runs it once for every
// client of the session, and tests pass a fake in its place.
import { HerdrClient } from '../core/herdr-client.ts';
import { LOCAL_HOST, hostOf, knownHosts, machineClients } from '../core/machine.ts';
import type { ChildRecord } from '../core/types.ts';
import { reclaimRemote, remoteOps } from '../core/remote.ts';
import { armPendingRestarts, type RestartHooks } from '../core/restart.ts';
import { recoverCrossings } from '../core/recover-crossing.ts';
import { armPendingTeleports, armTeleportFor } from '../core/teleport.ts';
import { moveEndpoints } from '../core/move-endpoint.ts';
import { emptyParent, mutateParent, parentId, readParent, saveParent } from '../core/registry.ts';
import { Watcher } from '../core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../integrations/tools.ts';
import { rosterDue, rosterOf, type RosterChild } from '../core/roster.ts';
import type { CallerIdentity, OutboxEntry } from '../core/types.ts';
import type { ParentHello } from './protocol.ts';
import type { RelayLinks } from './relay-links.ts';
import type { Inbox } from '../core/send.ts';
import type { SessionReach } from '../core/adopted-session.ts';

export interface ParentService {
  /** Run one Bellwether tool for a client, and return its text. `caller` says who asked. */
  tool(name: string, args: Record<string, unknown>, caller: CallerIdentity): Promise<string>;
  /** Mark receipts read, which settles their outbox entries. */
  markRead(receipts: string[]): void;
  /** Subscribe to new events. One handler per service, set by the daemon. */
  onEvents(handler: (entries: OutboxEntry[]) => void): void;
  /** Unread entries, ready to send again after a reconnect. */
  pending(): OutboxEntry[];
  /**
   * The parent's live children for the roster line of an alert about to go
   * out, which names the children in `named`. Undefined when no line is due:
   * nothing to say, the same line as the last one, or too soon after it.
   * A roster this returns counts as sent.
   */
  roster?(named: string[]): RosterChild[] | undefined;
  /** Clean up after a child that asked to be retired and has exited, as its exit would (issue #227). */
  retire?(childId: string): void;
  /** Start the wait for a teleport a child on another machine asked for, which the record now holds (issue #226). */
  teleport?(childId: string): void;
  /** Report one pane's status changes, and stop when the returned function runs. */
  watchPane(paneId: string, handler: (status: string) => void): () => void;
  stop(): void;
}

/** What the daemon lends every parent service: the connections to remote hosts it holds. */
export interface ServiceDeps {
  links?: RelayLinks;
  /** The daemon's log, for what a tool does that a person may need to trace, such as a move. */
  log?: (message: string) => void;
  /** The daemon's way into a child's own session, for a parent's message. */
  inbox?: Inbox;
  /** Whether a Bellwether adapter from a pane on this machine is connected, so an adoption can say whether the session can report. */
  sessionReach?: (paneId: string) => SessionReach;
  /** Whether the adapter connected from an adopted pane on this machine takes a parent's message, or undefined when none is. */
  sessionMessages?: (paneId: string) => boolean | undefined;
}

export type ServiceFactory = (parent: ParentHello, id: string, deps: ServiceDeps) => ParentService;

/** The herdr-backed service, one per parent session. */
export function createHerdrService(parent: ParentHello, id: string, deps: ServiceDeps = {}): ParentService {
  const existing = readParent(id);
  const identity = { ...(parent.childId ? { childId: parent.childId } : {}), ...(parent.maxDepth === undefined || parent.depth === 0 ? {} : { maxDepth: parent.maxDepth }) };
  const record = existing ?? saveParent(emptyParent(parent.harness, parent.session, parent.cwd, { host: parent.host, paneId: parent.paneId, workspaceId: parent.workspaceId, depth: parent.depth, ...identity }));
  // A session resumed under a new spawn carries the child id and ceiling that spawn gave it.
  if (existing && Object.entries(identity).some(([key, value]) => existing[key as keyof typeof identity] !== value)) saveParent(Object.assign(existing, identity));
  const client = new HerdrClient({ socketPath: parent.herdrSocket });
  let handler: ((entries: OutboxEntry[]) => void) | undefined;
  // One client per herdr host, shared by the tools and the watcher, so a
  // machine's bridge is dialled per request and its profile looked up once.
  const clientFor = machineClients(client);
  const remote = remoteOps(undefined, {}, deps.links);
  const relayState = deps.links ? (host: string) => deps.links?.state(host) : undefined;
  // While this session's own restart waits for a quiet turn end, its events
  // stay unread in the outbox: each one would start another turn (issue #188).
  let holding = false;
  const watcher = new Watcher({ client, clientFor, parentId: record.id, onEntries: (entries) => (holding ? undefined : handler?.(entries)), cleanupRemote: (child) => remote.cleanup(child), reclaimRemote: (child) => reclaimRemote(remote, record.id, child), childrenChanged: () => deps.links?.sync(), relayState });
  // A remote child's reports and reads both go over the connection the daemon holds to its machine.
  // A restart the caller asked for runs after the tool answered, and stops
  // with the service. One act per target, so a second request joins the first.
  const restartStop = new AbortController();
  const restartJobs = new Map<string, Promise<void>>();
  const restart: RestartHooks = {
    signal: restartStop.signal,
    reset: (childId) => watcher.reset(childId),
    hold: (held) => {
      if (holding === held) return;
      holding = held;
      // A restart that gave up hands the session what waited.
      const waiting = held ? [] : watcher.pendingEntries();
      if (waiting.length) handler?.(waiting);
    },
    held: () => (holding ? watcher.pendingEntries().length : 0),
    defer: (key, job) => {
      if (restartJobs.has(key)) return;
      const running = job()
        .catch(() => undefined)
        .finally(() => restartJobs.delete(key));
      restartJobs.set(key, running);
    },
  };
  const context: ToolContext = { client, clientFor, parentId: record.id, watcher, remote, relayState, restart, log: deps.log, inbox: deps.inbox, ...(deps.sessionReach ? { sessionReach: deps.sessionReach } : {}), ...(deps.sessionMessages ? { sessionMessages: deps.sessionMessages } : {}) };
  const paneWatches = new Set<{ close: () => void }>();
  watcher.start();
  // Finish a restart a daemon stopped part of the way through.
  armPendingRestarts(client, record, restart);
  // A teleport this session asked for itself, which a stopped daemon never ran (issue #226).
  const teleportDeps = { clientFor, endpointFor: moveEndpoints(), knownHosts: () => knownHosts(), registerFor: (parentId: string) => (child: ChildRecord, brief?: string) => remote.register({ id: parentId }, child, brief), cleanupRemote: (child: ChildRecord) => remote.cleanup(child), log: deps.log, ...(deps.inbox ? { inbox: deps.inbox } : {}), from: 'Bellwether, at your own request' };
  // And one a child of this parent on another machine asked for over the relay: its own session is on that machine's daemon.
  for (const child of readParent(record.id)?.children ?? []) if (child.teleportRequest && hostOf(child) !== LOCAL_HOST) armTeleportFor(teleportDeps, record.id, child.id, restart);
  armPendingTeleports({ clientFor, endpointFor: moveEndpoints(), knownHosts: () => knownHosts(), registerFor: (parentId) => (child, brief) => remote.register({ id: parentId }, child, brief), cleanupRemote: (child) => remote.cleanup(child), log: deps.log, ...(deps.inbox ? { inbox: deps.inbox } : {}), from: 'Bellwether, at your own request' }, record, restart);
  // Finish or undo a move or a teleport a stopped daemon left half done (issue #226).
  void recoverCrossings({ clientFor, endpointFor: moveEndpoints(), knownHosts: () => knownHosts(), registerRemote: (child, brief) => remote.register({ id: record.id }, child, brief), cleanupRemote: (child) => remote.cleanup(child), log: deps.log }, record.id).then((done) => {
    for (const recovery of done) if (recovery.outcome !== 'unknown') watcher.reset(recovery.childId);
  });
  // A session whose restart failed is connected again, so it came back by hand.
  if (readParent(record.id)?.restartFailed) {
    mutateParent(record.id, (parentRecord) => {
      delete parentRecord.restartFailed;
    });
  }
  return {
    tool: (name, args, caller) => runBellwetherTool(context, name, args, caller),
    markRead: (receipts) => {
      for (const receipt of receipts) watcher.markRead(receipt);
    },
    onEvents: (next) => {
      handler = next;
    },
    pending: () => watcher.pendingEntries().map((entry) => ({ ...entry, deliveredAt: undefined })),
    // The registry file is the record of each child's newest state; the daemon is its only writer.
    roster: (named) => {
      let due: RosterChild[] | undefined;
      mutateParent(record.id, (current) => {
        const roster = rosterOf(current.children);
        const sent = rosterDue(roster, named, current.rosterSent, Date.now());
        if (!sent) return;
        current.rosterSent = sent;
        due = roster;
      });
      return due;
    },
    retire: (childId) => {
      void watcher.childStopped(childId);
    },
    teleport: (childId) => {
      armTeleportFor(teleportDeps, record.id, childId, restart);
    },
    watchPane: (paneId, handler) => {
      const controller = new AbortController();
      const watch = { close: () => controller.abort() };
      paneWatches.add(watch);
      void client
        .subscribe([{ type: 'pane.agent_status_changed', pane_id: paneId }], (event) => {
          const id = event.data['pane_id'];
          const status = event.data['agent_status'];
          if (id === paneId && typeof status === 'string') handler(status);
        }, controller.signal)
        .catch((error: unknown) => {
          paneWatches.delete(watch);
          handler(`unavailable: ${String(error)}`);
        });
      return () => {
        paneWatches.delete(watch);
        controller.abort();
      };
    },
    stop: () => {
      restartStop.abort();
      for (const watch of paneWatches) watch.close();
      paneWatches.clear();
      watcher.stop();
    },
  };
}

export const defaultServiceFactory: ServiceFactory = createHerdrService;

/** The parent id a hello stands for, so a resumed session finds its children. */
export function parentIdOf(parent: ParentHello): string {
  return parentId(parent.harness, parent.session);
}
