// The daemon client: one connection per session, started on demand. A tool
// call, a receipt and an event all cross the same socket, and a reconnect
// replays the events the session missed while it was away.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BELLWETHER_VERSION } from '../core/version.ts';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, formatRequest, type DaemonReply, type ParentHello, type RelayHostState, type ReportRequest, type SessionsReply } from './protocol.ts';
import { isAlive, readLock } from './lock.ts';
import { HANDOVER_TIMEOUT_MS, decideHandOver, type DaemonIdentity } from './handover.ts';
import { canConnect } from './server.ts';
import type { OutboxEntry } from '../core/types.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 200;

export interface ConnectOptions {
  home?: string;
  socketPath?: string;
  /** Start the daemon when nothing answers on the socket. Default true. */
  spawn?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** The daemon entry point, overridable so a test can point at its own. */
  entry?: string;
  /**
   * The version and protocol this client presents, which a test lowers to
   * play a session from an older release. A session never sets them.
   */
  identity?: DaemonIdentity;
}

interface Connection {
  socket: net.Socket;
  buffer: string;
  /** Left on purpose for a hand-over, so its close starts no reconnect. */
  abandoned?: boolean;
}

/** What a handshake learned: the session's parent id, and which daemon answered. */
interface Hello {
  parentId: string;
  pid: number;
  daemon: DaemonIdentity;
}

/** How many times a client hands over or restarts before it gives up on one connect. */
const ESTABLISH_ATTEMPTS = 4;

/**
 * The variables that name one session. The daemon serves every session on the
 * machine, so it starts without the identity of whichever session started it.
 */
export const SESSION_IDENTITY = ['BELLWETHER_PARENT', 'BELLWETHER_CHILD', 'BELLWETHER_CHILD_NAME', 'BELLWETHER_DEPTH', 'BELLWETHER_HARNESS', 'HERDR_PANE_ID', 'CLAUDE_CODE_SESSION_ID'] as const;

/** The environment a daemon starts with: the caller's, less any session identity. */
export function daemonEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, BELLWETHER_HOME: home };
  for (const key of SESSION_IDENTITY) delete next[key];
  return next;
}

/** A daemon that speaks another protocol, and the one it speaks. */
class ProtocolMismatch extends Error {
  readonly daemonProtocol: number | undefined;

  constructor(message: string, daemonProtocol: number | undefined) {
    super(`protocol_mismatch: ${message}`);
    this.daemonProtocol = daemonProtocol;
    this.name = 'ProtocolMismatch';
  }
}

/** The daemon socket a client uses when none is given: the one under its home. */
export function defaultDaemonSocket(home: string): string {
  return path.join(home, 'daemon.sock');
}

export class DaemonClient {
  private connection: Connection | undefined;
  private readonly waiting = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void; retry: () => void }>();
  /** Panes whose watch went out on the current connection, so a reconnect sends each again once. */
  private sentWatches = new Set<string>();
  private readonly handlers = new Set<(entries: OutboxEntry[]) => void>();
  private readonly paneHandlers = new Map<string, Set<(status: string) => void>>();
  private readonly received = new Map<string, OutboxEntry>();
  private readonly unsentReceipts: string[] = [];
  private sequence = 0;
  private stopped = false;
  private reconnecting = false;
  private lastEvents: OutboxEntry[] = [];
  private closedReply: (() => void) | undefined;

  parentId: string;
  pid: number;
  readonly socketPath: string;
  readonly home: string;

  private constructor(parent: ParentHello, home: string, socketPath: string, options: ConnectOptions) {
    this.parent = parent;
    this.parentId = '';
    this.pid = 0;
    this.home = home;
    this.socketPath = socketPath;
    this.log = options.log ?? (() => {});
    this.entry = options.entry;
    this.spawnAllowed = options.spawn !== false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.identity = options.identity ?? { version: BELLWETHER_VERSION, protocol: DAEMON_PROTOCOL };
  }

  private readonly identity: DaemonIdentity;
  /** The daemon this client spoke to last, as its hello described it. */
  daemon: DaemonIdentity | undefined;

  private readonly parent: ParentHello;
  private readonly log: (message: string) => void;
  private readonly entry: string | undefined;
  private readonly spawnAllowed: boolean;
  private readonly timeoutMs: number;

  static async connect(parent: ParentHello, options: ConnectOptions = {}): Promise<DaemonClient> {
    const home = options.home ?? process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
    const socketPath = options.socketPath ?? defaultDaemonSocket(home);
    const client = new DaemonClient(parent, home, socketPath, options);
    const hello = await client.establish();
    return Object.assign(client, { parentId: hello.parentId, pid: hello.pid, daemon: hello.daemon });
  }

  /** Unread entries the daemon sent with the last hello. */
  pending(): Promise<OutboxEntry[]> {
    return Promise.resolve([...this.lastEvents]);
  }

  /** Unread entries this client has seen, newest state per child. */
  unread(): OutboxEntry[] {
    return [...this.received.values()];
  }

  /** Ask the daemon to report one pane's status, until the returned function runs. */
  watchPane(paneId: string, handler: (status: string) => void): () => void {
    const set = this.paneHandlers.get(paneId) ?? new Set<(status: string) => void>();
    set.add(handler);
    this.paneHandlers.set(paneId, set);
    void this.ensure()
      .then(() => this.sendWatch(paneId))
      .catch((error: Error) => this.log(`watch failed: ${error.message}`));
    return () => {
      const current = this.paneHandlers.get(paneId);
      current?.delete(handler);
      if (current && current.size === 0) this.paneHandlers.delete(paneId);
    };
  }

  onEvents(handler: (entries: OutboxEntry[]) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.stopped) throw new Error('the daemon client is closed');
    await this.ensure();
    const id = `c${++this.sequence}`;
    // The caller identity travels with every call, so the daemon routes by its
    // own records whichever client process asked.
    const caller = { ...(this.parent.paneId ? { paneId: this.parent.paneId } : {}), ...(this.parent.childId ? { childId: this.parent.childId } : {}) };
    const line = formatRequest({ type: 'call', id, tool: name, args, caller });
    return new Promise<string>((resolve, reject) => {
      // A hand-over can outlast the usual timeout, because the old daemon finishes its calls first.
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the daemon did not answer ${name} within ${this.timeoutMs} ms`));
      }, this.timeoutMs + HANDOVER_TIMEOUT_MS);
      timer.unref?.();
      let retried = false;
      this.waiting.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        // The daemon refused the call unrun because it is handing over: send it once more on the next connection.
        retry: () => {
          if (retried) return;
          retried = true;
          void this.reconnected()
            .then(() => this.write(line))
            .catch((error: Error) => {
              this.waiting.delete(id);
              clearTimeout(timer);
              reject(error);
            });
        },
      });
      this.write(line);
    });
  }

  receipts(receipts: string[]): void {
    if (!receipts.length) return;
    for (const receipt of receipts) this.received.delete(receipt);
    if (!this.connection) {
      this.unsentReceipts.push(...receipts);
      return;
    }
    this.write(formatRequest({ type: 'receipt', receipts }));
  }

  /** Ask the daemon to close, which it does once the calls in flight finish. */
  drain(): Promise<void> {
    if (!this.connection) return Promise.resolve();
    const socket = this.connection.socket;
    return new Promise<void>((resolve) => {
      this.closedReply = resolve;
      this.write(formatRequest({ type: 'drain' }));
      socket.once('close', () => resolve());
      setTimeout(() => resolve(), 2_000).unref?.();
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    // The daemon may have closed first, after a drain: a bye to a closed socket is not an error.
    connection.socket.on('error', () => {});
    if (connection.socket.writable) connection.socket.write(formatRequest({ type: 'bye' }));
    await new Promise<void>((resolve) => {
      connection.socket.once('close', () => resolve());
      connection.socket.end();
      setTimeout(() => resolve(), 1_000).unref?.();
    });
    connection.socket.destroy();
    for (const waiting of this.waiting.values()) waiting.reject(new Error('the daemon client closed'));
    this.waiting.clear();
  }

  /**
   * Connect, starting a daemon when nothing answers and spawning is allowed.
   * A daemon from an older release is handed over: this client drains it and
   * starts its own, and the sessions already connected reconnect to the new
   * one. A newer daemon stays, and serves this client when it still speaks
   * this client's protocol; when it does not, the error says to update.
   */
  private async establish(): Promise<Hello> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < ESTABLISH_ATTEMPTS; attempt += 1) {
      let hello: Hello;
      try {
        hello = await this.handshake();
      } catch (error) {
        lastError = error as Error;
        if (error instanceof ProtocolMismatch) {
          const daemon: DaemonIdentity = { protocol: error.daemonProtocol ?? 0, ...versionOf(readLock(this.home)) };
          const decision = error.daemonProtocol === undefined ? { kind: 'keep' as const } : decideHandOver(daemon, this.identity);
          if (decision.kind === 'keep' || !this.spawnAllowed) {
            const newer = error.daemonProtocol === undefined || error.daemonProtocol > this.identity.protocol;
            throw new Error(`the running daemon speaks protocol ${error.daemonProtocol ?? 'unknown'}${newer ? ', newer than this client' : ''}, and does not serve this client's ${this.identity.protocol}. Update this Bellwether install.`);
          }
          this.log(`handing over: ${decision.reason}`);
          await handOverDaemon(this.home, this.socketPath, { entry: this.entry, log: this.log });
          continue;
        }
        if (!this.spawnAllowed) throw error;
        await this.startDaemon();
        continue;
      }
      const decision = decideHandOver(hello.daemon, this.identity);
      if (decision.kind === 'keep' || !this.spawnAllowed) return hello;
      this.log(`handing over: ${decision.reason}`);
      this.abandon();
      await handOverDaemon(this.home, this.socketPath, { entry: this.entry, log: this.log });
    }
    throw lastError ?? new Error(`the daemon on ${this.socketPath} was replaced ${ESTABLISH_ATTEMPTS} times while this client connected; another install keeps starting an older daemon`);
  }

  /** Leave the current connection for a hand-over, without the reconnect a dropped connection starts. */
  private abandon(): void {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    connection.abandoned = true;
    connection.socket.destroy();
  }

  /** Wait until the client holds a connection again, for a call the daemon asked to send again. */
  private async reconnected(): Promise<void> {
    const deadline = Date.now() + HANDOVER_TIMEOUT_MS;
    while (!this.connection) {
      if (this.stopped) throw new Error('the daemon client is closed');
      if (Date.now() > deadline) throw new Error(`the daemon did not come back within ${HANDOVER_TIMEOUT_MS} ms`);
      if (!this.reconnecting) await this.ensure().catch(() => undefined);
      if (!this.connection) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private sendWatch(paneId: string): void {
    if (!this.connection || this.sentWatches.has(paneId)) return;
    this.sentWatches.add(paneId);
    this.write(formatRequest({ type: 'watch', paneId }));
  }

  private async ensure(): Promise<void> {
    if (this.connection) return;
    if (this.stopped) throw new Error('the daemon client is closed');
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      const hello = await this.establish();
      Object.assign(this, { parentId: hello.parentId, pid: hello.pid, daemon: hello.daemon });
      if (this.unsentReceipts.length) this.write(formatRequest({ type: 'receipt', receipts: this.unsentReceipts.splice(0) }));
    } finally {
      this.reconnecting = false;
    }
  }

  private async handshake(): Promise<Hello> {
    const connection = await this.open();
    const hello = { type: 'hello', protocol: this.identity.protocol, client: this.identity.version ?? 'unknown', parent: this.parent } as const;
    const reply = await this.ask(connection, formatRequest(hello));
    if (reply.type === 'error') {
      connection.socket.destroy();
      if (reply.code === 'protocol_mismatch') throw new ProtocolMismatch(reply.message, reply.protocol);
      throw new Error(`${reply.code}: ${reply.message}`);
    }
    if (reply.type !== 'hello') {
      connection.socket.destroy();
      throw new Error(`the daemon answered ${reply.type} to a hello`);
    }
    this.attach(connection);
    this.lastEvents = reply.pending;
    for (const entry of reply.pending) this.received.set(entry.receipt, entry);
    if (reply.pending.length) for (const handler of this.handlers) handler(reply.pending);
    // A daemon before 0.1.5 sends no version in its hello, and its lock is the only record of it.
    const daemon: DaemonIdentity = { protocol: reply.protocol, ...(reply.version ? { version: reply.version } : versionOf(readLock(this.home))) };
    return { parentId: reply.parentId, pid: reply.pid, daemon };
  }

  private open(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const fail = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        socket.setEncoding('utf8');
        resolve({ socket, buffer: '' });
      });
    });
  }

  /** Send one line and wait for the first reply that is not a push. */
  private ask(connection: Connection, line: string): Promise<DaemonReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the daemon did not answer in time')), START_TIMEOUT_MS);
      timer.unref?.();
      const onData = (chunk: string): void => {
        connection.buffer += chunk;
        const index = connection.buffer.indexOf('\n');
        if (index < 0) return;
        const first = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        connection.socket.off('data', onData);
        clearTimeout(timer);
        try {
          resolve(JSON.parse(first) as DaemonReply);
        } catch (error) {
          reject(error as Error);
        }
      };
      connection.socket.on('data', onData);
      connection.socket.write(line);
    });
  }

  private attach(connection: Connection): void {
    this.connection = connection;
    this.sentWatches = new Set();
    connection.socket.on('data', (chunk: string) => this.read(connection, chunk));
    connection.socket.on('close', () => {
      if (this.connection === connection) this.connection = undefined;
      if (connection.abandoned) return;
      for (const waiting of this.waiting.values()) waiting.reject(new Error('the daemon connection closed'));
      this.waiting.clear();
      if (!this.stopped) setTimeout(() => void this.ensure().catch((error: Error) => this.log(`reconnect failed: ${error.message}`)), RECONNECT_DELAY_MS).unref?.();
    });
    // The daemon that answers now may be a new one, which knows nothing of the panes this session watched.
    for (const paneId of this.paneHandlers.keys()) this.sendWatch(paneId);
  }

  private read(connection: Connection, chunk: string): void {
    connection.buffer += chunk;
    if (connection.buffer.length > MAX_DAEMON_FRAME_BYTES) {
      connection.socket.destroy();
      return;
    }
    let index = connection.buffer.indexOf('\n');
    while (index >= 0) {
      const line = connection.buffer.slice(0, index);
      connection.buffer = connection.buffer.slice(index + 1);
      index = connection.buffer.indexOf('\n');
      if (!line.trim()) continue;
      let reply: DaemonReply;
      try {
        reply = JSON.parse(line) as DaemonReply;
      } catch {
        continue;
      }
      this.dispatch(reply);
    }
  }

  private dispatch(reply: DaemonReply): void {
    if (reply.type === 'events') {
      // An entry that arrives read was settled in the daemon, by a newer state
      // or a newer event for the same child. Drop it, so no resend repeats it.
      const unread: OutboxEntry[] = [];
      for (const entry of reply.entries) {
        if (entry.read) this.received.delete(entry.receipt);
        else {
          this.received.set(entry.receipt, entry);
          unread.push(entry);
        }
      }
      if (unread.length) for (const handler of this.handlers) handler(unread);
      return;
    }
    if (reply.type === 'status') {
      for (const handler of this.paneHandlers.get(reply.paneId) ?? []) handler(reply.status);
      return;
    }
    if (reply.type === 'result') {
      const waiting = this.waiting.get(reply.id);
      if (!waiting) return;
      if (reply.retry) {
        waiting.retry();
        return;
      }
      this.waiting.delete(reply.id);
      if (reply.error !== undefined) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply.text ?? '');
      return;
    }
    if (reply.type === 'closed') {
      this.closedReply?.();
      this.closedReply = undefined;
    }
  }

  private write(line: string): void {
    if (!this.connection) throw new Error('the daemon connection is not open');
    this.connection.socket.write(line);
  }

  /** Start a daemon, with a marker so two clients do not start two. */
  private startDaemon(): Promise<void> {
    return startDaemonProcess(this.home, this.socketPath, this.entry);
  }
}

/** The marker a client holds while it starts or hands over the daemon, so other clients wait for it. */
export function startingMarker(home: string): string {
  return path.join(home, 'daemon.starting');
}

/** Start a detached daemon on a socket, with a marker so two clients do not start two. */
export async function startDaemonProcess(home: string, socketPath: string, entry?: string): Promise<void> {
  fs.mkdirSync(home, { recursive: true });
  const marker = startingMarker(home);
  if (takeStartingMarker(marker)) {
    // Another client may have finished starting one between this client's failed connect and its marker.
    if (await canConnect(socketPath)) {
      removeOwnMarker(marker);
      return;
    }
    spawnDaemon(home, socketPath, entry);
    try {
      await waitForSocket(socketPath);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    return;
  }
  await waitForSocket(socketPath, marker);
}

/** Launch the daemon process from this install, detached. The caller holds the marker. */
function spawnDaemon(home: string, socketPath: string, entry?: string): void {
  // From the sources this file is client.ts and the entry is main.ts; from the build, both end in .js.
  const main = entry ?? fileURLToPath(new URL(`./main${path.extname(import.meta.url)}`, import.meta.url));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--socket', socketPath], {
    detached: true,
    stdio: 'ignore',
    // Never the caller's directory, which for a child is its worktree.
    cwd: home,
    env: daemonEnv(process.env, home),
  });
  child.unref();
}

export interface HandOverOptions {
  entry?: string;
  log?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Replace the daemon on a socket with one from this install. The client takes
 * the starting marker first, which a client of 0.1.4 or later respects: the
 * sessions the old daemon served wait for the new one instead of starting
 * another old one. It keeps the marker fresh while the old daemon finishes
 * its calls, waits until that daemon has let go of its socket and its lock,
 * which is what keeps two daemons from ever owning the same children, then
 * starts its own. When another client already holds the marker, this one
 * waits for that hand-over to finish and leaves the decision to its caller's
 * next handshake.
 *
 * A crash on either side leaves nothing that blocks the next attempt: an old
 * daemon that dies drops its lock with its pid, and a marker whose writer
 * died, or that has not been refreshed for 30 s, is taken over.
 */
export async function handOverDaemon(home: string, socketPath: string, options: HandOverOptions = {}): Promise<void> {
  fs.mkdirSync(home, { recursive: true });
  const marker = startingMarker(home);
  const timeoutMs = options.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  if (!takeStartingMarker(marker)) {
    await waitWhileMarkerHeld(marker, Date.now() + timeoutMs);
    return;
  }
  const refresh = setInterval(() => refreshMarker(marker), 5_000);
  refresh.unref?.();
  try {
    const old = readLock(home);
    await askOnce(socketPath, formatRequest({ type: 'drain' }), START_TIMEOUT_MS).catch(() => undefined);
    await waitForRelease(home, socketPath, timeoutMs);
    options.log?.(`the old daemon${old ? ` (pid ${old.pid})` : ''} has let go of ${socketPath}; starting this install's daemon`);
    spawnDaemon(home, socketPath, options.entry);
    await waitForSocket(socketPath);
  } finally {
    clearInterval(refresh);
    removeOwnMarker(marker);
  }
}

/**
 * Wait until no daemon answers on the socket and none holds the lock for it.
 * A lock that names another socket belongs to another daemon and is ignored.
 */
async function waitForRelease(home: string, socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = readLock(home);
    const held = lock !== undefined && (!lock.socket || lock.socket === socketPath) && isAlive(lock.pid);
    if (!held && !(await canConnect(socketPath))) return;
    if (Date.now() > deadline) {
      throw new Error(`the daemon${held ? ` with pid ${lock.pid}` : ''} on ${socketPath} did not let go within ${Math.round(timeoutMs / 1000)} s. Run bellwether doctor to see what holds it, then bellwether drain.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitWhileMarkerHeld(marker: string, deadline: number): Promise<void> {
  while (markerHeldByOther(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function markerHeldByOther(marker: string): boolean {
  const holder = readMarker(marker);
  return Boolean(holder && holder.pid !== process.pid && alive(holder.pid) && Date.now() - holder.at < 30_000);
}

function refreshMarker(marker: string): void {
  const holder = readMarker(marker);
  if (holder?.pid !== process.pid) return;
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 });
  } catch {
    // A marker that cannot be refreshed goes stale, and another client takes it over.
  }
}

function removeOwnMarker(marker: string): void {
  const holder = readMarker(marker);
  if (!holder || holder.pid === process.pid) fs.rmSync(marker, { force: true });
}

function takeStartingMarker(marker: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(marker, 'wx', 0o600);
      fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readMarker(marker);
      if (holder && holder.pid !== process.pid && alive(holder.pid) && Date.now() - holder.at < 30_000) return false;
      fs.rmSync(marker, { force: true });
    }
  }
  return false;
}

function readMarker(marker: string): { pid: number; at: number } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid?: number; at?: number };
    return typeof parsed.pid === 'number' ? { pid: parsed.pid, at: parsed.at ?? 0 } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait until a daemon answers on the socket. While another client holds the
 * marker, which it refreshes through a hand-over, the wait lasts as long as
 * that hand-over may.
 */
async function waitForSocket(socketPath: string, marker?: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await canConnect(socketPath)) return;
    const elapsed = Date.now() - started;
    const handingOver = marker !== undefined && markerHeldByOther(marker) && elapsed < HANDOVER_TIMEOUT_MS;
    if (elapsed >= START_TIMEOUT_MS && !handingOver) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the daemon did not answer on ${socketPath}`);
}

function versionOf(lock: { version?: string } | undefined): { version?: string } {
  return lock?.version ? { version: lock.version } : {};
}

/** The exit code `bellwether report` uses for a report its daemon refused, which a retry cannot fix. */
export const REFUSED_EXIT = 65;

/** The daemon took the report and refused it, which no retry changes. */
export class ReportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRefused';
  }
}

export interface PostedReport {
  text: string;
  duplicate: boolean;
}

/**
 * Post one report to this machine's daemon, starting it when nothing answers.
 * It needs no session, which is what lets `bellwether report` run as the far
 * end of an SSH hop. A daemon from an older release is drained first, as a
 * session's client does.
 */
export async function postReport(report: ReportRequest['report'], options: ConnectOptions = {}): Promise<PostedReport> {
  const home = options.home ?? process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
  const socketPath = options.socketPath ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? defaultDaemonSocket(home);
  const line = formatRequest({ type: 'report', id: 'r1', protocol: DAEMON_PROTOCOL, report });
  if (options.spawn !== false) await ensureDaemon(home, socketPath, options.entry, options.log);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await canConnect(socketPath))) {
      if (options.spawn === false) throw new Error(`no daemon answers on ${socketPath}`);
      await startDaemonProcess(home, socketPath, options.entry);
    }
    const reply = await askOnce(socketPath, line, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (reply.type === 'result' && reply.retry) {
      await waitWhileMarkerHeld(startingMarker(home), Date.now() + HANDOVER_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (reply.type === 'result') {
      if (reply.error !== undefined) throw new ReportRefused(reply.error);
      return { text: reply.text ?? '', duplicate: reply.duplicate === true };
    }
    if (reply.type === 'error' && (reply.code === 'unknown_type' || (reply.code === 'protocol_mismatch' && (reply.protocol ?? 0) < DAEMON_PROTOCOL)) && attempt === 0 && options.spawn !== false) {
      options.log?.(`handing over the daemon on ${socketPath}, which predates the report request`);
      await handOverDaemon(home, socketPath, { entry: options.entry, log: options.log });
      continue;
    }
    if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
    throw new Error(`the daemon answered ${reply.type} to a report`);
  }
  throw new Error(`the daemon on ${socketPath} did not take the report`);
}

/** Send one line on a fresh connection and resolve with the first reply. */
function askOnce(socketPath: string, line: string, timeoutMs: number): Promise<DaemonReply> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the daemon did not answer the report within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, index)) as DaemonReply);
      } catch (error) {
        reject(error as Error);
      }
    });
    socket.once('connect', () => socket.write(line));
  });
}

/**
 * Make sure a daemon at least as new as this install answers on a socket:
 * hand over one from an older release, and start one when none answers.
 * `bellwether relay-bridge` runs it before it joins a parent's connection to
 * the socket, which is how a parent's newer daemon brings the far machine's
 * daemon up to the far machine's own install.
 */
export async function ensureDaemon(home: string, socketPath: string, entry?: string, log?: (message: string) => void): Promise<void> {
  if (await canConnect(socketPath)) {
    const lock = readLock(home);
    if (!lock) return;
    const decision = decideHandOver({ protocol: lock.protocol, ...versionOf(lock) });
    if (decision.kind === 'keep') return;
    log?.(`handing over: ${decision.reason}`);
    await handOverDaemon(home, socketPath, { entry, log });
    return;
  }
  await startDaemonProcess(home, socketPath, entry);
}

/** Who is connected to the daemon on a socket and on which code. A daemon before 0.1.5 answers unknown_type. */
export async function daemonSessions(socketPath: string, timeoutMs = START_TIMEOUT_MS): Promise<SessionsReply> {
  const reply = await askOnce(socketPath, formatRequest({ type: 'sessions', id: 's1' }), timeoutMs);
  if (reply.type === 'sessions') return reply;
  if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
  throw new Error(`the daemon answered ${reply.type} to a sessions request`);
}

/** The state of every connection the daemon on a socket holds to a remote host. */
export async function relayStatus(socketPath: string, timeoutMs = START_TIMEOUT_MS): Promise<RelayHostState[]> {
  const reply = await askOnce(socketPath, formatRequest({ type: 'relay-status', id: 's1' }), timeoutMs);
  if (reply.type === 'relay-status') return reply.hosts;
  if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
  throw new Error(`the daemon answered ${reply.type} to a relay status request`);
}

/**
 * Drain the daemon on a socket, if one answers, and wait until it stops. Each
 * connected session reconnects and starts a daemon from its own install, so
 * the code that runs next is that of the first session to reconnect.
 */
export async function drainDaemon(socketPath: string): Promise<boolean> {
  if (!(await canConnect(socketPath))) return false;
  await drainSocket(socketPath);
  return true;
}

/** Ask the daemon on a socket to drain, and wait until it stops answering and lets go of its lock. */
async function drainSocket(socketPath: string): Promise<void> {
  await askOnce(socketPath, formatRequest({ type: 'drain' }), START_TIMEOUT_MS).catch(() => undefined);
  await waitForRelease(path.dirname(socketPath), socketPath, HANDOVER_TIMEOUT_MS);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
