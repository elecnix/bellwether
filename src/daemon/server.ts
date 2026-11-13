// The daemon: one local socket that owns a herdr subscription, a registry and
// an outbox for every parent session on the machine. A client says hello, gets
// the events it missed, runs the Bellwether tools through the daemon, and marks
// receipts read. The daemon starts on demand, drains for an upgrade, and exits
// when no session needs it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, ProtocolError, formatReply, parseRequest, type DaemonReply, type ParentHello } from './protocol.ts';
import { defaultServiceFactory, parentIdOf, type ParentService, type ServiceFactory } from './service.ts';
import { acquire, isAlive, readLock, release } from './lock.ts';
import type { OutboxEntry } from '../core/types.ts';

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
}

interface Session {
  parentId: string;
  service: ParentService;
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

  if (await canConnect(options.socketPath)) throw new Error(`a daemon already listens on ${options.socketPath}`);
  const lock = acquire(home, options.socketPath, pid);
  if (lock.kind === 'held' && lock.record.pid !== pid) throw new Error(`a daemon with pid ${lock.record.pid} holds this home`);

  fs.mkdirSync(path.dirname(options.socketPath), { recursive: true });
  fs.rmSync(options.socketPath, { force: true });

  const services = new Map<string, ParentService>();
  const subscribers = new Map<string, Set<net.Socket>>();
  const sockets = new Set<net.Socket>();
  const paneWatches = new Map<net.Socket, (() => void)[]>();
  let lastActivity = now();
  let closed = false;
  let closing: Promise<void> | undefined;
  let closeResolve: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  const forgetSocket = (socket: net.Socket): void => {
    sockets.delete(socket);
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
    const service = factory(parent, id);
    services.set(id, service);
    service.onEvents((entries) => push(id, entries));
    return { parentId: id, service };
  };

  const close = async (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const stops of paneWatches.values()) for (const stop of stops) stop();
    paneWatches.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    subscribers.clear();
    for (const service of services.values()) service.stop();
    services.clear();
    fs.rmSync(options.socketPath, { force: true });
    release(home, pid);
    await serverClosed;
    closeResolve();
    closing = Promise.resolve();
    return closing;
  };

  const idle = setInterval(() => {
    if (closed) return;
    if (sockets.size === 0 && now() - lastActivity >= idleMs) {
      log('idle: closing the daemon');
      void close();
    }
  }, idleCheckMs);
  idle.unref?.();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let session: Session | undefined;

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
        reply({ type: 'error', code: fault.code, message: fault.message });
        return;
      }
      if (request.type === 'hello') {
        if (request.protocol !== DAEMON_PROTOCOL) {
          reply({ type: 'error', code: 'protocol_mismatch', message: 'the client spoke another protocol', protocol: DAEMON_PROTOCOL });
          socket.end();
          return;
        }
        session = serviceFor(request.parent);
        const set = subscribers.get(session.parentId) ?? new Set<net.Socket>();
        set.add(socket);
        subscribers.set(session.parentId, set);
        reply({ type: 'hello', protocol: DAEMON_PROTOCOL, parentId: session.parentId, pid, pending: session.service.pending() });
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
        log('drain: closing after the current calls');
        reply({ type: 'closed' });
        socket.end();
        void close();
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
        try {
          const text = await session.service.tool(request.tool, request.args);
          reply({ type: 'result', id: request.id, text });
        } catch (error) {
          reply({ type: 'result', id: request.id, error: (error as Error).message });
        }
      }
    };

    socket.on('error', () => forgetSocket(socket));
    socket.on('close', () => forgetSocket(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(options.socketPath, 0o600);

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
