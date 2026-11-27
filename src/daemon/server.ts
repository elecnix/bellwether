// The daemon: one local socket that owns a herdr subscription, a registry and
// an outbox for every parent session on the machine. A client says hello, gets
// the events it missed, runs the Bellwether tools through the daemon, and marks
// receipts read. The daemon starts on demand, drains for an upgrade, and exits
// when no session needs it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, MIN_CLIENT_PROTOCOL, ProtocolError, acceptsClientProtocol, formatReply, parseRequest, type DaemonReply, type ParentHello, type SessionInfo } from './protocol.ts';
import { DRAIN_GRACE_MS, drainDecision } from './handover.ts';
import { BELLWETHER_VERSION } from '../core/version.ts';
import { readParent } from '../core/registry.ts';
import { defaultServiceFactory, parentIdOf, type ParentService, type ServiceFactory } from './service.ts';
import { acquire, isAlive, readLock, release } from './lock.ts';
import { RelayOutbox } from './relay.ts';
import { RelayLinks } from './relay-links.ts';
import { hostOf } from '../core/machine.ts';
import { acceptLocalReport, isReportStatus, localParentOf, routeReport, type ReportInput } from '../core/report.ts';
import { readRelayRecord } from '../core/relay-records.ts';
import { lastAssistantMessage, resolveTranscript } from '../core/transcript.ts';
import type { CallerIdentity, OutboxEntry } from '../core/types.ts';
import type { RelayHostState, RelayReport } from './protocol.ts';

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
  /** The entry point this daemon process runs, which the lock records. The process entry passes its own file. */
  entry?: string;
  /** How long a drain waits for calls in flight before it closes anyway. Default 60 s. */
  drainGraceMs?: number;
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
  protocol: number;
  connectedAt: string;
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
  const idleMs = options.idleMs ?? 5 * 60_000;
  const idleCheckMs = options.idleCheckMs ?? 30_000;
  const outbox = options.relayOutbox ?? new RelayOutbox({ log });
  const links = options.links ?? new RelayLinks({ log });

  if (await canConnect(options.socketPath)) throw new Error(`a daemon already listens on ${options.socketPath}`);
  const lock = acquire(home, options.socketPath, pid, undefined, options.entry);
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

  const forgetSocket = (socket: net.Socket): void => {
    sockets.delete(socket);
    attached.delete(socket);
    relaySockets.delete(socket);
    for (const stop of paneWatches.get(socket) ?? []) stop();
    paneWatches.delete(socket);
    for (const [parentId, set] of subscribers) {
      set.delete(socket);
      if (set.size === 0) subscribers.delete(parentId);
    }
  };

  const push = (parentId: string, entries: OutboxEntry[]): void => {
    const set = subscribers.get(parentId);
    if (!set || entries.length === 0) return;
    const line = formatReply({ type: 'events', entries });
    for (const socket of set) if (socket.writable) socket.write(line);
  };

  const serviceFor = (parent: ParentHello): Session => {
    const id = parentIdOf(parent);
    const existing = services.get(id);
    if (existing) return { parentId: id, service: existing };
    const service = factory(parent, id, { links, log });
    services.set(id, service);
    service.onEvents((entries) => {
      push(id, entries);
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

  const idle = setInterval(() => {
    if (closed) return;
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
   * own tool, so it never reaches the relay.
   */
  const relayCall = async (args: Record<string, unknown>, caller: CallerIdentity): Promise<string | undefined> => {
    if (!caller.childId || !readRelayRecord(caller.childId) || localParentOf(caller.childId)) return undefined;
    const status = typeof args['status'] === 'string' ? args['status'].trim() : undefined;
    const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
    if (!status || !text) throw new Error('parent_report needs both status and text');
    if (!isReportStatus(status)) throw new Error('parent_report status must be done, needs-input or progress');
    const route = routeReport({ childId: caller.childId, paneId: caller.paneId });
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
        reply({ type: 'error', code: fault.code, message: fault.message, ...(fault.code === 'protocol_mismatch' ? { protocol: DAEMON_PROTOCOL } : {}) });
        return;
      }
      if (request.type === 'sessions') {
        reply({
          type: 'sessions',
          id: request.id,
          daemon: { pid, version: BELLWETHER_VERSION, protocol: DAEMON_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL, startedAt, draining: drainingSince !== undefined },
          sessions: [...attached.values()].map(sessionInfo),
          relaySubscribers: relaySockets.size,
        });
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
        reply({ type: 'relay-hello', protocol: DAEMON_PROTOCOL, pid, waiting });
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
      if (request.type === 'relay-status') {
        reply({ type: 'relay-status', id: request.id, hosts: links.states() });
        return;
      }
      if (request.type === 'hello') {
        // The previous protocol is served too, so a session that predates a hand-over keeps working.
        if (!acceptsClientProtocol(request.protocol)) {
          reply({ type: 'error', code: 'protocol_mismatch', message: `the client spoke protocol ${request.protocol}, and this daemon serves ${MIN_CLIENT_PROTOCOL} to ${DAEMON_PROTOCOL}`, protocol: DAEMON_PROTOCOL });
          socket.end();
          return;
        }
        session = serviceFor(request.parent);
        const set = subscribers.get(session.parentId) ?? new Set<net.Socket>();
        set.add(socket);
        subscribers.set(session.parentId, set);
        attached.set(socket, { parentId: session.parentId, parent: request.parent, client: request.client, protocol: request.protocol, connectedAt: new Date(now()).toISOString() });
        reply({ type: 'hello', protocol: DAEMON_PROTOCOL, parentId: session.parentId, pid, pending: session.service.pending(), version: BELLWETHER_VERSION });
        return;
      }
      if (request.type === 'bye') {
        if (session) {
          subscribers.get(session.parentId)?.delete(socket);
          const remaining = subscribers.get(session.parentId);
          if (!remaining || remaining.size === 0) {
            session.service.stop();
            services.delete(session.parentId);
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
          const relayed = request.tool === 'parent_report' ? await relayCall(request.args, request.caller ?? {}) : undefined;
          const text = relayed ?? (await session.service.tool(request.tool, request.args, request.caller ?? {}));
          reply({ type: 'result', id: request.id, text });
          // A spawn or a stop may have added or removed the last child on a host.
          links.sync();
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message });
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
