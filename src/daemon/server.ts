// The daemon: one local socket that owns a herdr subscription, a registry and
// an outbox for every parent session on the machine. A client says hello, gets
// the events it missed, runs the Bellwether tools through the daemon, and marks
// receipts read. The daemon starts on demand, drains for an upgrade, and exits
// when no session needs it.
import { locateHerdr } from '../core/herdr-bin.ts';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, MIN_CLIENT_PROTOCOL, ProtocolError, acceptsClientProtocol, formatReply, parseRequest, type DaemonReply, type ParentHello, type SessionInfo } from './protocol.ts';
import { DRAIN_GRACE_MS, drainDecision } from './handover.ts';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from '../core/version.ts';
import { listParents, mutateParent, readParent } from '../core/registry.ts';
import { HerdrClient } from '../core/herdr-client.ts';
import { resumeSession } from '../core/session-resume.ts';
import { ancestry } from '../core/ancestry.ts';
import { PRUNE_DELAY_MS, PRUNE_EVERY_MS, pruneState } from '../core/hygiene.ts';
import { defaultServiceFactory, parentIdOf, type ParentService, type ServiceFactory } from './service.ts';
import { acquire, isAlive, readLock, release } from './lock.ts';
import { RelayOutbox } from './relay.ts';
import { RelayLinks, relayInbox } from './relay-links.ts';
import { LOCAL_HOST, hostOf } from '../core/machine.ts';
import { acceptLocalReport, isReportStatus, localParentOf, routeReport, type ReportInput } from '../core/report.ts';
import { readRelayRecord, updateRelayRecord } from '../core/relay-records.ts';
import { restartForRelay, type RelayRestartAnswer } from '../core/restart.ts';
import { claimPane } from '../core/pane-claims.ts';
import { adoptedInboxGap, adoptedParentOf, type SessionReach } from '../core/adopted-session.ts';
import { lastAssistantMessage } from '../core/transcript.ts';
import { harnessFor, resolveTranscript } from '../core/harnesses/index.ts';
import type { CallerIdentity, OutboxEntry } from '../core/types.ts';
import type { RosterChild } from '../core/roster.ts';
import type { InboxMessage, MessageAckRequest, RelayHostState, RelayReport, ServedTool } from './protocol.ts';
import { BRIEF_SESSION_WAIT_MS, BRIEF_TURN_WAIT_MS, unreadSessionMessages, type Inbox, type InboxAnswer } from '../core/send.ts';
import { updateChild } from '../core/registry.ts';
import { UnknownTool, servedTools, type ToolScope } from '../integrations/tools.ts';
import { FEATURES } from './features.ts';

/**
 * The roster for entries about to reach a parent, when one is due. Only an
 * unread entry is an alert, so a push that only settles entries asks for none
 * and spends nothing. A test's fake service may keep no roster.
 */
function rosterFor(service: ParentService, entries: OutboxEntry[]): { roster?: RosterChild[] } {
  const alerts = entries.filter((entry) => !entry.read);
  if (!alerts.length) return {};
  const roster = service.roster?.(alerts.map((entry) => entry.childId));
  return roster ? { roster } : {};
}

/** What this daemon serves, by name, sent in its hello so a client and doctor need not infer it. */
const SERVED = FEATURES.map((feature) => feature.name);

/** The protocols this daemon serves, sent with a protocol_mismatch so the client can quote them. */
const servedRange = { protocol: DAEMON_PROTOCOL, minProtocol: MIN_CLIENT_PROTOCOL, version: BELLWETHER_VERSION };

export type { ParentService, ServiceFactory } from './service.ts';

export interface DaemonOptions {
  socketPath: string;
  /** The home whose lock and registry the daemon uses. */
  home?: string;
  /** Exit after this long with no client and no call. Default 5 min. */
  idleMs?: number;
  /** How often the idle clock is checked. Default 30 s. */
  idleCheckMs?: number;
  factory?: ServiceFactory;
  log?: (message: string) => void;
  now?: () => number;
  pid?: number;
  /** The reports children on this machine made for parents on other machines, which those parents' daemons collect. */
  relayOutbox?: RelayOutbox;
  /** The connections this daemon holds to the machines its parents' children run on. Tests pass one with a fake ssh. */
  links?: RelayLinks;
  /** The entry point this daemon process runs, which the lock records. The process entry passes its own file, and `bellwether daemon` its install's. */
  entry?: string;
  /** Whether `bellwether daemon` runs this daemon in the foreground, which the lock records. */
  foreground?: boolean;
  /** How long a drain waits for calls in flight before it closes anyway. Default 60 s. */
  drainGraceMs?: number;
  /** How often the idle tick prunes the state no live session needs, after the first prune. Default an hour; false never prunes. */
  pruneEveryMs?: number | false;
  /** How long after start the first prune waits, so the sessions of a hand-over reconnect first. Default 1 min. */
  pruneDelayMs?: number;
  /** How long a child's session has to take a parent's message before it is typed instead. Default 5 s. */
  messageAckMs?: number;
  /** How long a start's brief waits for the child's session to connect before it is typed instead. Default 30 s. */
  sessionWaitMs?: number;
  /** How long a start's brief waits for the child's model after its adapter received it, before it goes once more. Default 20 s. */
  briefTurnWaitMs?: number;
  /** The tools a session gets, by its hello. Default the feature table's tools for its identity; a test passes a newer table. */
  tools?: (parent: ParentHello) => ServedTool[];
}

export interface Daemon {
  socketPath: string;
  pid: number;
  readonly closed: boolean;
  /** Close the daemon now, stopping every parent service. */
  close(): Promise<void>;
  parents(): string[];
  connections(): number;
  /** Wait until the daemon has closed for any reason. */
  whenClosed(): Promise<void>;
  /** The state of every connection to a remote host. */
  relay(): RelayHostState[];
  /** Whether a drain has started, so the daemon takes no new call and closes once its calls finish. */
  readonly draining: boolean;
}

interface Session {
  parentId: string;
  service: ParentService;
}

/** What a hello told the daemon about the session on one connection. */
interface Attached {
  parentId: string;
  parent: ParentHello;
  client: string;
  build?: string;
  protocol: number;
  connectedAt: string;
  /** The tool list this session was last served, as JSON, so a push goes only when it changes. */
  tools?: string;
}

/**
 * Who a session answers to, for its tool list: the parent and child id its
 * start gave it, or else the parent that adopted its pane, so a session
 * Bellwether did not start offers parent_report once it has someone to
 * report to.
 */
function scopeOf(parent: ParentHello): ToolScope {
  if (parent.reportsTo || parent.childId) return { ...(parent.reportsTo ? { reportsTo: parent.reportsTo } : {}), ...(parent.childId ? { childId: parent.childId } : {}) };
  const adopted = adoptedParentOf(parent);
  return adopted ? { reportsTo: adopted.parentId } : {};
}

/**
 * Start the daemon on a socket. Another live daemon on the same home wins, and
 * this call refuses rather than stealing its socket.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const pid = options.pid ?? process.pid;
  const home = options.home ?? path.dirname(options.socketPath);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const factory = options.factory ?? defaultServiceFactory;
  const sessionTools = options.tools ?? ((parent: ParentHello): ServedTool[] => servedTools(scopeOf(parent)));
  const idleMs = options.idleMs ?? 5 * 60_000;
  const idleCheckMs = options.idleCheckMs ?? 30_000;
  const outbox = options.relayOutbox ?? new RelayOutbox({ log });
  const links = options.links ?? new RelayLinks({ log });

  if (await canConnect(options.socketPath)) throw new Error(`a daemon already listens on ${options.socketPath}`);
  const lock = acquire(home, options.socketPath, pid, undefined, { ...(options.entry ? { entry: options.entry } : {}), ...(options.foreground ? { foreground: true } : {}) });
  if (lock.kind === 'held' && lock.record.pid !== pid) throw new Error(`a daemon with pid ${lock.record.pid} holds this home`);

  fs.mkdirSync(path.dirname(options.socketPath), { recursive: true });
  fs.rmSync(options.socketPath, { force: true });

  const services = new Map<string, ParentService>();
  const subscribers = new Map<string, Set<net.Socket>>();
  const sockets = new Set<net.Socket>();
  const paneWatches = new Map<net.Socket, (() => void)[]>();
  const attached = new Map<net.Socket, Attached>();
  const relaySockets = new Set<net.Socket>();
  const startedAt = new Date(now()).toISOString();
  const drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS;
  let lastActivity = now();
  let closed = false;
  let inFlight = 0;
  let drainingSince: number | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let closeResolve: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  // A parent's message waits here for the child's session to take it.
  const messageAckMs = options.messageAckMs ?? MESSAGE_ACK_MS;
  const inboxWaits = new Map<string, { socket: net.Socket; settle: (answer: InboxAnswer) => void }>();
  /** Messages whose wait ran out, so a late acceptance is logged as a second copy. */
  const lapsed = new Set<string>();
  // A start's brief waits here for the child's session to say hello.
  const sessionWaitMs = options.sessionWaitMs ?? BRIEF_SESSION_WAIT_MS;
  // A start waits on these for its brief's read receipt (issue #176), from
  // this machine's adapter or across the relay.
  const readWaits = new Map<string, Set<(at: string) => void>>();
  const messageRead = (messageId: string, at: string): void => {
    const waiting = readWaits.get(messageId);
    readWaits.delete(messageId);
    for (const settle of waiting ?? []) settle(at);
  };
  const arrivals = new Map<string, Set<() => void>>();

  /**
   * The child a connected session is: the child id its start gave it, or,
   * for a session Bellwether did not start, the child id of the adoption that
   * claims its pane, here or from a parent on another machine. An adoption
   * made after the hello is found at once, and a stop drops it, because the
   * claim is read each time rather than copied onto the connection.
   */
  const childIdOf = (entry: Attached): string | undefined => entry.parent.childId ?? adoptedParentOf(entry.parent)?.childId;

  /** The live connections of one child's session, newest last. */
  const childSockets = (childId: string): [net.Socket, Attached][] => [...attached].filter(([socket, entry]) => socket.writable && childIdOf(entry) === childId);

  /** The newest connection of a child's own session that takes messages. */
  const inboxSocket = (childId: string): net.Socket | undefined =>
    childSockets(childId)
      .filter(([, entry]) => entry.parent.accepts?.includes('message'))
      .at(-1)?.[0];

  /** Whether a child is a session a parent adopted, by this machine's registry or by a claim a parent on another machine left here. */
  const isAdopted = (childId: string): boolean => {
    const found = localParentOf(childId);
    return found ? found.child.origin === 'adopt' : readRelayRecord(childId)?.adopted === true;
  };

  /** Why no session of a child takes a message, naming an adopted session's own case rather than a child's. */
  const noInboxReason = (child: { id: string; name: string; kind: string }, waitMs = 0): string => {
    if (isAdopted(child.id)) {
      const held = childSockets(child.id).at(-1)?.[1];
      if (!held) return `${child.name} is an adopted session with no Bellwether server or extension connected to this machine's daemon, so nothing in it can take a message`;
      const gap = adoptedInboxGap(held.parent.harness);
      return `${child.name} is an adopted session whose Bellwether ${gap.adapter} ${gap.why}`;
    }
    const connected = waitMs > 0 ? `connected to this machine's Bellwether daemon within ${Math.round(waitMs / 100) / 10} s of the start` : "is connected to this machine's Bellwether daemon";
    return `no session of ${child.name} that takes messages ${connected}: its harness has not started its Bellwether ${harnessFor(child.kind)?.inbox.via === 'claude-channel' ? 'channel server' : 'extension'} yet, or that copy predates messages`;
  };

  /**
   * Send each connected session that takes a tool list the tools it has now,
   * when they changed: an adoption gave a session a parent, or a stop took
   * its parent away. A session whose adapter predates the push gets the same
   * list in the hello of its next connection.
   */
  const pushTools = (): void => {
    for (const [socket, entry] of attached) {
      if (!entry.parent.accepts?.includes('tools') || !socket.writable) continue;
      const tools = sessionTools(entry.parent);
      const json = JSON.stringify(tools);
      if (json === entry.tools) continue;
      entry.tools = json;
      socket.write(formatReply({ type: 'tools', tools }));
    }
  };

  /** Whether the adapter connected from an adopted pane takes a parent's message, or undefined when none from that pane is connected. */
  const sessionMessages = (paneId: string): boolean | undefined => {
    let found: boolean | undefined;
    for (const [socket, entry] of attached) {
      if (entry.parent.paneId !== paneId || !socket.writable || !adoptedParentOf(entry.parent)) continue;
      if (entry.parent.accepts?.includes('message')) return true;
      found = false;
    }
    return found;
  };

  /** Whether the session in an adopted pane holds a Bellwether adapter connected here, and whether it takes a new tool list. */
  const sessionReach = (paneId: string): SessionReach => {
    let older = false;
    for (const [socket, entry] of attached) {
      if (entry.parent.paneId !== paneId || !socket.writable || !adoptedParentOf(entry.parent)) continue;
      if (entry.parent.accepts?.includes('tools')) return 'tools';
      older = true;
    }
    return older ? 'older' : 'none';
  };

  /**
   * Wait until a session of this child that takes messages is connected, or
   * the bound runs out. A hello wakes the wait, so nothing polls.
   */
  const awaitSession = (childId: string, ms: number): Promise<boolean> => {
    if (inboxSocket(childId)) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const set = arrivals.get(childId) ?? new Set<() => void>();
      arrivals.set(childId, set);
      const finish = (connected: boolean): void => {
        clearTimeout(timer);
        set.delete(arrive);
        if (set.size === 0) arrivals.delete(childId);
        resolve(connected);
      };
      const arrive = (): void => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      set.add(arrive);
    });
  };

  /** Put a message in the session of a child whose Bellwether adapter is connected to this daemon. */
  const sessionInbox = async (child: { id: string; name: string; kind: string }, message: InboxMessage, waitMs = 0): Promise<InboxAnswer> => {
    await awaitSession(child.id, waitMs);
    const socket = inboxSocket(child.id);
    if (!socket) return { delivered: false, reason: noInboxReason(child, waitMs) };
    return new Promise<InboxAnswer>((resolve) => {
      const timer = setTimeout(() => {
        inboxWaits.delete(message.id);
        lapsed.add(message.id);
        resolve({ delivered: false, reason: `its session did not take the message within ${Math.round(messageAckMs / 100) / 10} s` });
      }, messageAckMs);
      timer.unref?.();
      inboxWaits.set(message.id, {
        socket,
        settle: (answer) => {
          clearTimeout(timer);
          inboxWaits.delete(message.id);
          resolve(answer);
        },
      });
      socket.write(formatReply({ type: 'message', message }));
    });
  };

  /**
   * A parent's message: to the session of a child on this machine, or over
   * the relay to the daemon on the child's machine, which answers whether
   * that session took it. A far daemon that predates relay-message, or a
   * machine out of reach, gives the reason the caller records for typing.
   */
  const inbox: Inbox = async (parentId, child, message, options = {}) => {
    const host = hostOf(child);
    if (host === LOCAL_HOST) return sessionInbox(child, message, options.awaitSession ? sessionWaitMs : 0);
    return relayInbox(links, parentId, child, message, options);
  };
  inbox.turnWaitMs = options.briefTurnWaitMs ?? BRIEF_TURN_WAIT_MS;
  inbox.read = (parentId, childId, messageId, signal) =>
    new Promise<string>((resolve) => {
      // The check and the wait run in one tick, so a read that lands between them cannot slip past.
      const already = readParent(parentId)?.children.find((entry) => entry.id === childId)?.messages?.find((entry) => entry.id === messageId)?.readAt;
      if (already) return resolve(already);
      const waiting = readWaits.get(messageId) ?? new Set();
      const settle = (at: string): void => resolve(at);
      waiting.add(settle);
      readWaits.set(messageId, waiting);
      signal.addEventListener(
        'abort',
        () => {
          waiting.delete(settle);
          if (!waiting.size && readWaits.get(messageId) === waiting) readWaits.delete(messageId);
        },
        { once: true },
      );
    });

  /** Keep a message that crossed from the parent's machine on the child's relay record until its model reads it, or drop it. */
  const keepRelayMessage = (childId: string, message: InboxMessage | undefined, drop?: string): void => {
    updateRelayRecord(childId, (record) => {
      const kept = (record.messages ?? []).filter((entry) => entry.id !== (message?.id ?? drop));
      if (message) kept.push({ id: message.id, text: message.text, from: message.from, at: message.at });
      if (kept.length) record.messages = kept.slice(-20);
      else delete record.messages;
    });
  };

  /** Put each message a child's session has not read in front of that session again, after it connects. */
  const replayMessages = (socket: net.Socket, childId: string): void => {
    const found = localParentOf(childId);
    // A child of a parent on another machine keeps its unread messages on its relay record here.
    const unread: InboxMessage[] = found ? unreadSessionMessages(found.child).map((message) => ({ id: message.id, from: message.from ?? 'your parent', text: message.text ?? '', at: message.at })) : (readRelayRecord(childId)?.messages ?? []);
    for (const message of unread) if (socket.writable) socket.write(formatReply({ type: 'message', message, replay: true }));
  };

  /** An adapter's answer about one message. A read lands on the child's record, whichever daemon pushed it. */
  const messageAck = (socket: net.Socket, ack: MessageAckRequest): void => {
    const wait = inboxWaits.get(ack.id);
    if (ack.outcome === 'refused') {
      wait?.settle({ delivered: false, reason: ack.reason ? `its session refused the message: ${ack.reason}` : 'its session refused the message' });
      return;
    }
    wait?.settle({ delivered: true, via: ack.via ?? 'session' });
    if (!wait && ack.outcome === 'queued' && lapsed.has(ack.id)) log(`message ${ack.id} reached the child's session after its wait ran out, so the child also has the typed copy`);
    if (ack.outcome !== 'read') return;
    const entry = attached.get(socket);
    const childId = entry ? childIdOf(entry) : undefined;
    if (!childId) return;
    const found = localParentOf(childId);
    if (!found) {
      // The parent runs on another machine: the read crosses back in the relay outbox, delivered once like a report.
      const record = readRelayRecord(childId);
      if (!record?.messages?.some((entry) => entry.id === ack.id)) return;
      keepRelayMessage(childId, undefined, ack.id);
      outbox.messageRead(record, ack.id);
      return;
    }
    let readAt: string | undefined;
    updateChild(found.parent.id, childId, (child) => {
      const message = child.messages?.find((entry) => entry.id === ack.id);
      if (!message || message.readAt) return;
      message.readAt = readAt = new Date(now()).toISOString();
      if (ack.via) message.via ??= ack.via;
      delete message.text;
      delete message.from;
    });
    if (readAt) messageRead(ack.id, readAt);
    log(`message ${ack.id} reached the model of child ${childId}`);
  };

  const forgetSocket = (socket: net.Socket): void => {
    for (const wait of [...inboxWaits.values()]) if (wait.socket === socket) wait.settle({ delivered: false, reason: "its session's connection to the daemon closed before it took the message" });
    sockets.delete(socket);
    attached.delete(socket);
    relaySockets.delete(socket);
    for (const stop of paneWatches.get(socket) ?? []) stop();
    paneWatches.delete(socket);
    for (const [parentId, set] of subscribers) {
      if (!set.delete(socket)) continue;
      if (set.size === 0) {
        subscribers.delete(parentId);
        leftDaemon(parentId);
      }
    }
  };

  /** The session's last connection closed: the record says when, so doctor can tell a session that left (issue #187). */
  const leftDaemon = (parentId: string): void => {
    try {
      mutateParent(parentId, (entry) => {
        entry.disconnectedAt = new Date(now()).toISOString();
      });
    } catch (error) {
      log(`could not record that session ${parentId} left: ${(error as Error).message}`);
    }
  };

  const push = (parentId: string, entries: OutboxEntry[], service: ParentService): void => {
    const set = subscribers.get(parentId);
    if (!set || entries.length === 0) return;
    // Asked only once a session listens, so a roster nobody reads does not count as sent.
    const line = formatReply({ type: 'events', entries, ...rosterFor(service, entries) });
    for (const socket of set) if (socket.writable) socket.write(line);
  };

  const serviceFor = (parent: ParentHello): Session => {
    const id = parentIdOf(parent);
    const existing = services.get(id);
    if (existing) return { parentId: id, service: existing };
    const service = factory(parent, id, { links, log, inbox, sessionReach, sessionMessages });
    services.set(id, service);
    service.onEvents((entries) => {
      push(id, entries, service);
      // A child that started or exited changes which hosts need a connection.
      links.sync();
    });
    return { parentId: id, service };
  };

  const close = async (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    if (drainTimer) clearInterval(drainTimer);
    const serverClosed = new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    for (const stops of paneWatches.values()) for (const stop of stops) stop();
    paneWatches.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    subscribers.clear();
    for (const service of services.values()) service.stop();
    services.clear();
    links.stop();
    fs.rmSync(options.socketPath, { force: true });
    release(home, pid);
    await serverClosed;
    closeResolve();
    closing = Promise.resolve();
    return closing;
  };

  const pruneEveryMs = options.pruneEveryMs ?? PRUNE_EVERY_MS;
  const pruneAfter = now() + (options.pruneDelayMs ?? PRUNE_DELAY_MS);
  let lastPrune: number | undefined;
  /**
   * Remove what no live session needs. A parent with a service here counts as
   * connected, which is why the first prune waits for the sessions of a
   * hand-over to say hello again.
   */
  const prune = (): void => {
    if (pruneEveryMs === false || closed || drainingSince !== undefined || now() < pruneAfter) return;
    if (lastPrune !== undefined && now() - lastPrune < pruneEveryMs) return;
    lastPrune = now();
    try {
      pruneState({ connected: new Set(services.keys()), now: now(), log });
    } catch (error) {
      log(`prune failed: ${(error as Error).message}`);
    }
  };

  const idle = setInterval(() => {
    if (closed) return;
    prune();
    // A report for a parent on another machine waits on disk, and that parent's daemon starts this one to collect it.
    if (sockets.size === 0 && now() - lastActivity >= idleMs) {
      log('idle: closing the daemon');
      void close();
    }
  }, idleCheckMs);
  idle.unref?.();

  /**
   * Start a drain: stop taking connections at once, so the next daemon can
   * start as soon as this one lets go of the lock, and close once the calls
   * in flight have answered. A connected session keeps its socket until then,
   * so a spawn halfway through still gets its reply.
   */
  const drain = (): void => {
    if (closed || drainingSince !== undefined) return;
    drainingSince = now();
    log(`drain: ${inFlight} call(s) in flight; closing once they answer, or after ${Math.round(drainGraceMs / 1000)} s`);
    server.close();
    const check = (): void => {
      if (drainDecision({ inFlight, drainingSince: drainingSince ?? now(), now: now(), graceMs: drainGraceMs }) === 'close') void close();
    };
    drainTimer = setInterval(check, 20);
    drainTimer.unref?.();
    check();
  };

  const sessionInfo = (entry: Attached): SessionInfo => {
    const record = readParent(entry.parentId);
    const service = services.get(entry.parentId);
    const info: SessionInfo = {
      parentId: entry.parentId,
      harness: entry.parent.harness,
      session: entry.parent.session,
      client: entry.client,
      ...(entry.build ? { build: entry.build } : {}),
      protocol: entry.protocol,
      connectedAt: entry.connectedAt,
      liveChildren: record ? record.children.filter((child) => !child.exitedAt).length : 0,
      unread: service ? service.pending().length : 0,
    };
    if (entry.parent.childId) info.childId = entry.parent.childId;
    if (entry.parent.paneId) info.paneId = entry.parent.paneId;
    return info;
  };

  /**
   * A report posted without a session, from `bellwether report`. A parent
   * this daemon holds takes it once per receipt; a relay child's report waits
   * in the relay outbox for its parent's daemon to collect.
   */
  const postReport = async (input: ReportInput): Promise<{ text: string; duplicate: boolean }> => {
    const route = routeReport(input);
    if (route.kind === 'relay') return { text: await outbox.report(route.record, input.status, input.text), duplicate: false };
    const { duplicate } = acceptLocalReport(route.parent, route.child, input);
    if (duplicate) log(`report ${input.receipt} for child ${route.child.id} was already accepted, so the copy was dropped`);
    else log(`report${input.receipt ? ` ${input.receipt}` : ''} from child ${route.child.id} accepted for parent ${route.parent.id}`);
    return { text: duplicate ? `Report ${input.receipt} was already received; this copy was dropped.` : `Reported ${input.status} to ${route.parent.id}, as ${route.child.name}.`, duplicate };
  };

  /**
   * parent_report from a child whose parent runs on another machine. A child
   * this daemon holds a parent record for is served locally, by the session's
   * own tool, so it never reaches the relay. A session with no child id
   * answers for the pane a parent on another machine adopted, by the claim
   * that parent left here, as long as it is the session that was adopted.
   */
  const relayCall = async (args: Record<string, unknown>, caller: CallerIdentity, session: string | undefined): Promise<string | undefined> => {
    const adopted = caller.childId ? undefined : adoptedParentOf({ paneId: caller.paneId, session });
    const childId = caller.childId ?? (adopted?.where === 'away' ? adopted.childId : undefined);
    if (!childId || !readRelayRecord(childId) || localParentOf(childId)) return undefined;
    const status = typeof args['status'] === 'string' ? args['status'].trim() : undefined;
    const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
    if (!status || !text) throw new Error('parent_report needs both status and text');
    if (!isReportStatus(status)) throw new Error('parent_report status must be done, needs-input or progress');
    const route = routeReport({ childId, paneId: caller.paneId });
    if (route.kind !== 'relay') return undefined;
    return outbox.report(route.record, status, text);
  };

  /**
   * A report a child's machine handed over a relay connection. It must name a
   * parent this daemon holds and a child of that parent on that very host;
   * anything else is refused, which the far end keeps and does not resend.
   */
  const acceptRelayed = (host: string, report: RelayReport): { refused?: string } => {
    const route = routeReport({ parentId: report.parentId, childId: report.childId });
    if (route.kind !== 'local') return { refused: `this machine holds no parent ${report.parentId} with child ${report.childId}` };
    // A report the child left on the machine it moved away from still counts.
    if (hostOf(route.child) !== host && route.child.movedFrom?.host !== host) return { refused: `child ${report.childId} runs on machine ${hostOf(route.child)}, not ${host}` };
    if (report.messageRead) {
      // Not a report: the child's model read a message this daemon sent over the relay.
      let readAt: string | undefined;
      updateChild(route.parent.id, route.child.id, (child) => {
        const message = child.messages?.find((entry) => entry.id === report.messageRead);
        if (!message || message.readAt) return;
        message.readAt = readAt = report.at;
        delete message.text;
        delete message.from;
      });
      if (readAt) messageRead(report.messageRead, readAt);
      log(`message ${report.messageRead} reached the model of child ${report.childId} on machine ${host}`);
      return {};
    }
    const { duplicate } = acceptLocalReport(route.parent, route.child, { parentId: report.parentId, childId: report.childId, receipt: report.receipt, status: report.status, text: report.text });
    if (duplicate) log(`report ${report.receipt} for child ${report.childId} from machine ${host} was already accepted, so the copy was dropped`);
    else log(`report ${report.receipt} from child ${report.childId} on machine ${host} accepted for parent ${report.parentId}`);
    return {};
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let session: Session | undefined;
    let relaySubscription: (() => void) | undefined;

    const reply = (value: DaemonReply): void => {
      if (socket.writable) socket.write(formatReply(value));
    };

    socket.on('data', (chunk: string) => {
      if (closed) return;
      lastActivity = now();
      buffer += chunk;
      if (buffer.length > MAX_DAEMON_FRAME_BYTES) {
        reply({ type: 'error', code: 'frame_too_large', message: 'the frame exceeds the daemon limit' });
        socket.destroy();
        return;
      }
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void handle(line);
        index = buffer.indexOf('\n');
      }
    });

    const handle = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      let request;
      try {
        request = parseRequest(line);
      } catch (error) {
        const fault = error as ProtocolError;
        reply({ type: 'error', code: fault.code, message: fault.message, ...(fault.code === 'protocol_mismatch' ? servedRange : {}) });
        return;
      }
      if (request.type === 'sessions') {
        // Whether this process can run herdr, which its environment decides and doctor's own process cannot see (issue #186).
        const herdr = await locateHerdr();
        reply({
          type: 'sessions',
          id: request.id,
          daemon: { pid, version: BELLWETHER_VERSION, build: BELLWETHER_BUILD_ID, protocol: DAEMON_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL, startedAt, draining: drainingSince !== undefined, features: SERVED, herdr },
          sessions: [...attached.values()].map(sessionInfo),
          relaySubscribers: relaySockets.size,
        });
        return;
      }
      if (request.type === 'ancestry') {
        // A query over the registry this daemon writes, the sessions connected now and the parents it watches.
        const connected = [...attached.values()].map((entry) => ({ parentId: entry.parentId, connectedAt: entry.connectedAt, ...(entry.parent.childId ? { childId: entry.parent.childId } : {}) }));
        reply({ type: 'ancestry', id: request.id, answer: ancestry(request.agent, listParents(), { connected, watched: [...services.keys()] }) });
        return;
      }
      if (request.type === 'resume') {
        // `bellwether resume`: a session whose pane is gone, brought back from its record.
        if (drainingSince !== undefined) {
          reply({ type: 'result', id: request.id, error: 'the daemon is handing over to a newer one; run the resume again in a moment', retry: true });
          return;
        }
        inFlight += 1;
        try {
          const text = await resumeSession(new HerdrClient({ socketPath: request.herdrSocket }), request.target, { log }, request.label ? { label: request.label } : {});
          log(`resume ${request.target}: ${text.split('\n')[0]}`);
          reply({ type: 'result', id: request.id, text });
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message });
        } finally {
          inFlight -= 1;
        }
        return;
      }
      if (request.type === 'report') {
        if (drainingSince !== undefined) {
          reply({ type: 'result', id: request.id, error: 'the daemon is handing over to a newer one; send the report again in a moment', retry: true });
          return;
        }
        inFlight += 1;
        try {
          const outcome = await postReport(request.report);
          reply({ type: 'result', id: request.id, text: outcome.text, duplicate: outcome.duplicate });
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message });
        } finally {
          inFlight -= 1;
        }
        return;
      }
      if (request.type === 'relay-subscribe') {
        // A parent's daemon on another machine, through a bridge. A second subscribe replaces the first.
        relaySubscription?.();
        relaySockets.add(socket);
        const parentIds = new Set(request.parentIds);
        const waiting = outbox.waiting(parentIds).length;
        reply({ type: 'relay-hello', protocol: DAEMON_PROTOCOL, pid, waiting, version: BELLWETHER_VERSION, build: BELLWETHER_BUILD_ID });
        const { sent, stop } = outbox.subscribe({ parentIds, send: (report) => reply({ type: 'relay-report', report }) });
        relaySubscription = stop;
        reply({ type: 'relay-drained', sent });
        return;
      }
      if (request.type === 'relay-ack') {
        outbox.ack(request.receipt, request.refused);
        return;
      }
      if (request.type === 'relay-read') {
        try {
          const transcript = resolveTranscript(request.harness, request.session, request.cwd);
          reply({ type: 'result', id: request.id, text: (transcript && lastAssistantMessage(transcript)) || '' });
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message });
        }
        return;
      }
      if (request.type === 'relay-adopt') {
        // A parent on another machine adopts a pane here. This machine holds both its own parents and the claims of parents elsewhere, so it answers who watches the pane.
        try {
          const answer = claimPane({ parentId: request.parentId, childId: request.childId, name: request.name, kind: request.kind, paneId: request.paneId, ...(request.session ? { session: request.session } : {}) });
          log(`relay-adopt: pane ${request.paneId} ${answer.held ? 'was already' : 'is now'} a child of ${request.parentId} on another machine, as ${answer.childId}`);
          // The adopted session's adapter, when one is connected here, now answers to that parent.
          pushTools();
          const messages = sessionMessages(request.paneId);
          reply({ type: 'result', id: request.id, text: JSON.stringify({ ...answer, session: sessionReach(request.paneId), ...(messages === undefined ? {} : { messages }) }) });
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message, code: 'pane_watched' });
        }
        return;
      }
      if (request.type === 'relay-message') {
        // A parent's daemon on another machine, for a child this machine holds a relay record for.
        const record = readRelayRecord(request.childId);
        if (!record || record.parentId !== request.parentId || record.retiredAt) {
          reply({ type: 'result', id: request.id, text: JSON.stringify({ delivered: false, reason: `this machine holds no running child ${request.childId} for parent ${request.parentId}` }) });
          return;
        }
        // A start's brief waits for the child's session first. It is kept on
        // the relay record only once that session is here, so the hello's
        // replay cannot hand the session a second copy.
        if (request.awaitSession) await awaitSession(request.childId, sessionWaitMs);
        // Kept before the push, so a read that comes back at once finds it.
        keepRelayMessage(request.childId, request.message);
        const answer = await sessionInbox({ id: record.childId, name: record.name, kind: record.kind }, request.message);
        if (!answer.delivered) keepRelayMessage(request.childId, undefined, request.message.id);
        log(`relay-message ${request.message.id} for child ${request.childId}: ${answer.delivered ? `taken by its session (${answer.via})` : answer.reason}`);
        reply({ type: 'result', id: request.id, text: JSON.stringify(answer) });
        return;
      }
      if (request.type === 'relay-restart') {
        // A parent's daemon on another machine restarts its child here (issue #190), as a restart here would.
        let answer: RelayRestartAnswer;
        try {
          answer = await restartForRelay(request.parentId, request.childId, request.child, { ...(request.herdrSession ? { herdrSession: request.herdrSession } : {}), ...(request.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: request.waitTimeoutMs }), hooks: { log } });
        } catch (error) {
          answer = { restarted: false, reason: `the restart there failed before it closed anything: ${(error as Error).message}` };
        }
        log(`relay-restart of child ${request.childId} for ${request.parentId}: ${answer.restarted ? `closed ${answer.outcome.oldPane}, opened ${answer.outcome.newPane}` : answer.reason}`);
        reply({ type: 'result', id: request.id, text: JSON.stringify(answer) });
        return;
      }
      if (request.type === 'message-ack') {
        messageAck(socket, request);
        return;
      }
      if (request.type === 'relay-status') {
        reply({ type: 'relay-status', id: request.id, hosts: links.states() });
        return;
      }
      if (request.type === 'hello') {
        // Every protocol back to the last breaking bump is served, so a session that predates a hand-over keeps working.
        if (!acceptsClientProtocol(request.protocol)) {
          reply({ type: 'error', code: 'protocol_mismatch', message: `the client spoke protocol ${request.protocol}, and this daemon serves ${MIN_CLIENT_PROTOCOL} to ${DAEMON_PROTOCOL}`, ...servedRange });
          socket.end();
          return;
        }
        session = serviceFor(request.parent);
        // The pane a session says hello from is where it runs now, even after a resume by hand (issue #187).
        const hello = request.parent;
        mutateParent(session.parentId, (entry) => {
          if (hello.paneId) entry.paneId = hello.paneId;
          if (hello.paneId && hello.workspaceId) entry.workspaceId = hello.workspaceId;
          delete entry.disconnectedAt;
        });
        const set = subscribers.get(session.parentId) ?? new Set<net.Socket>();
        set.add(socket);
        subscribers.set(session.parentId, set);
        const tools = sessionTools(request.parent);
        attached.set(socket, { parentId: session.parentId, parent: request.parent, client: request.client, ...(request.build ? { build: request.build } : {}), protocol: request.protocol, connectedAt: new Date(now()).toISOString(), tools: JSON.stringify(tools) });
        const pending = session.service.pending();
        reply({ type: 'hello', protocol: DAEMON_PROTOCOL, parentId: session.parentId, pid, pending, ...rosterFor(session.service, pending), version: BELLWETHER_VERSION, build: BELLWETHER_BUILD_ID, minProtocol: MIN_CLIENT_PROTOCOL, features: SERVED, tools });
        // A child's session that reconnects, after a hand-over or a restart of its server, takes again what it has not read.
        // An adopted session's adapter, which says hello without a child id, takes them by the adoption of its pane.
        const replayTo = childIdOf(attached.get(socket) as Attached);
        if (replayTo && request.parent.accepts?.includes('message')) {
          replayMessages(socket, replayTo);
          // A start that waits to hand this child its brief goes on now.
          for (const arrive of [...(arrivals.get(replayTo) ?? [])]) arrive();
        }
        return;
      }
      if (request.type === 'bye') {
        if (session) {
          subscribers.get(session.parentId)?.delete(socket);
          const remaining = subscribers.get(session.parentId);
          if (!remaining || remaining.size === 0) {
            session.service.stop();
            services.delete(session.parentId);
            if (remaining) leftDaemon(session.parentId);
            subscribers.delete(session.parentId);
          }
        }
        socket.end();
        return;
      }
      if (request.type === 'drain') {
        reply({ type: 'closed' });
        socket.end();
        drain();
        return;
      }
      if (!session) {
        if (request.type === 'call') reply({ type: 'error', id: request.id, code: 'no_hello', message: 'say hello before calling a tool' });
        return;
      }
      if (request.type === 'receipt') {
        session.service.markRead(request.receipts);
        return;
      }
      if (request.type === 'watch') {
        const stop = session.service.watchPane(request.paneId, (status) => reply({ type: 'status', paneId: request.paneId, status }));
        const stops = paneWatches.get(socket) ?? [];
        stops.push(stop);
        paneWatches.set(socket, stops);
        return;
      }
      if (request.type === 'call') {
        if (drainingSince !== undefined) {
          reply({ type: 'result', id: request.id, error: 'the daemon is handing over to a newer one; call the tool again in a moment', retry: true });
          return;
        }
        inFlight += 1;
        try {
          const relayed = request.tool === 'parent_report' ? await relayCall(request.args, request.caller ?? {}, attached.get(socket)?.parent.session) : undefined;
          const text = relayed ?? (await session.service.tool(request.tool, request.args, request.caller ?? {}));
          reply({ type: 'result', id: request.id, text });
          // A spawn or a stop may have added or removed the last child on a host.
          links.sync();
          // An adoption gives a session here a parent, and a stop takes it away.
          if (request.tool === 'agent_adopt' || request.tool === 'agent_stop') pushTools();
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message, ...(error instanceof UnknownTool ? { code: 'unknown_tool' } : {}) });
        } finally {
          inFlight -= 1;
        }
      }
    };

    const forget = (): void => {
      relaySubscription?.();
      relaySubscription = undefined;
      forgetSocket(socket);
    };
    socket.on('error', forget);
    socket.on('close', forget);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(options.socketPath, 0o600);
  links.start(acceptRelayed);

  return {
    socketPath: options.socketPath,
    pid,
    get closed() {
      return closed;
    },
    close,
    parents: () => [...services.keys()],
    connections: () => sockets.size,
    whenClosed: () => closedPromise,
    relay: () => links.states(),
    get draining() {
      return drainingSince !== undefined;
    },
  };
}

/** How long a child's session has to take a parent's message, before the daemon types it into the pane instead. */
export const MESSAGE_ACK_MS = 5_000;

/** Whether something answers on the socket, used to spot a live daemon. */
export async function canConnect(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 300).unref?.();
  });
}

/** Whether a lock names a daemon that still runs. */
export function daemonIsLive(home: string): boolean {
  const record = readLock(home);
  return Boolean(record && isAlive(record.pid));
}
