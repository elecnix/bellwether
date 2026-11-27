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
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, formatRequest, type DaemonReply, type ParentHello, type RelayHostState, type ReportRequest } from './protocol.ts';
import { readLock } from './lock.ts';
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
}

interface Connection {
  socket: net.Socket;
  buffer: string;
}

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
  private readonly waiting = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();
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
  }

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
    return Object.assign(client, { parentId: hello.parentId, pid: hello.pid });
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
      .then(() => this.write(formatRequest({ type: 'watch', paneId })))
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
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the daemon did not answer ${name} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
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
    connection.socket.write(formatRequest({ type: 'bye' }));
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
   * A daemon from an older release is drained first, so the newer protocol
   * takes over; a newer daemon is left running, and the error says to update.
   */
  private async establish(): Promise<{ parentId: string; pid: number }> {
    try {
      return await this.handshake();
    } catch (error) {
      if (error instanceof ProtocolMismatch) {
        if (error.daemonProtocol === undefined || error.daemonProtocol > DAEMON_PROTOCOL) {
          throw new Error(`the running daemon speaks protocol ${error.daemonProtocol ?? 'unknown'}, newer than this client's ${DAEMON_PROTOCOL}. Update this Bellwether install.`);
        }
        this.log(`draining the daemon on protocol ${error.daemonProtocol}, older than ${DAEMON_PROTOCOL}`);
        const replaced = await this.drainOlder();
        if (replaced) return replaced;
      }
      if (!this.spawnAllowed) throw error;
      await this.startDaemon();
      return this.handshake();
    }
  }

  private async ensure(): Promise<void> {
    if (this.connection) return;
    if (this.stopped) throw new Error('the daemon client is closed');
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      const hello = await this.establish();
      Object.assign(this, { parentId: hello.parentId, pid: hello.pid });
      if (this.unsentReceipts.length) this.write(formatRequest({ type: 'receipt', receipts: this.unsentReceipts.splice(0) }));
    } finally {
      this.reconnecting = false;
    }
  }

  private async handshake(): Promise<{ parentId: string; pid: number }> {
    const connection = await this.open();
    const hello = { type: 'hello', protocol: DAEMON_PROTOCOL, client: BELLWETHER_VERSION, parent: this.parent } as const;
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
    return { parentId: reply.parentId, pid: reply.pid };
  }

  /**
   * Ask an older daemon to drain, and wait until its socket stops answering,
   * or answers with this protocol because another client started the new daemon first.
   */
  private async drainOlder(): Promise<{ parentId: string; pid: number } | undefined> {
    const connection = await this.open();
    await new Promise<void>((resolve) => {
      connection.socket.once('close', () => resolve());
      connection.socket.write(formatRequest({ type: 'drain' }));
      setTimeout(() => resolve(), START_TIMEOUT_MS).unref?.();
    });
    connection.socket.destroy();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (await canConnect(this.socketPath)) {
      try {
        return await this.handshake();
      } catch (error) {
        if (!(error instanceof ProtocolMismatch)) throw error;
      }
      if (Date.now() > deadline) throw new Error(`the daemon on ${this.socketPath} did not drain within ${START_TIMEOUT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
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
    connection.socket.on('data', (chunk: string) => this.read(connection, chunk));
    connection.socket.on('close', () => {
      if (this.connection === connection) this.connection = undefined;
      for (const waiting of this.waiting.values()) waiting.reject(new Error('the daemon connection closed'));
      this.waiting.clear();
      if (!this.stopped) setTimeout(() => void this.ensure().catch((error: Error) => this.log(`reconnect failed: ${error.message}`)), RECONNECT_DELAY_MS).unref?.();
    });
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

/** Start a detached daemon on a socket, with a marker so two clients do not start two. */
export async function startDaemonProcess(home: string, socketPath: string, entry?: string): Promise<void> {
  fs.mkdirSync(home, { recursive: true });
  const marker = path.join(home, 'daemon.starting');
  if (takeStartingMarker(marker)) {
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
    try {
      await waitForSocket(socketPath);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    return;
  }
  await waitForSocket(socketPath);
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

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canConnect(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the daemon did not answer on ${socketPath}`);
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await canConnect(socketPath))) {
      if (options.spawn === false) throw new Error(`no daemon answers on ${socketPath}`);
      await startDaemonProcess(home, socketPath, options.entry);
    }
    const reply = await askOnce(socketPath, line, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (reply.type === 'result') {
      if (reply.error !== undefined) throw new ReportRefused(reply.error);
      return { text: reply.text ?? '', duplicate: reply.duplicate === true };
    }
    if (reply.type === 'error' && (reply.code === 'unknown_type' || (reply.code === 'protocol_mismatch' && (reply.protocol ?? 0) < DAEMON_PROTOCOL)) && attempt === 0) {
      options.log?.(`draining the daemon on ${socketPath}, which predates the report request`);
      await drainSocket(socketPath);
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
 * Make sure this install's daemon answers on a socket: drain one that speaks
 * an older protocol, and start one when none answers. `bellwether
 * relay-bridge` runs it before it joins a parent's connection to the socket.
 */
export async function ensureDaemon(home: string, socketPath: string, entry?: string): Promise<void> {
  if (await canConnect(socketPath)) {
    const lock = readLock(home);
    if (!lock || lock.protocol >= DAEMON_PROTOCOL) return;
    await drainSocket(socketPath);
  }
  await startDaemonProcess(home, socketPath, entry);
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

/** Ask the daemon on a socket to drain, and wait until it stops answering. */
async function drainSocket(socketPath: string): Promise<void> {
  await askOnce(socketPath, formatRequest({ type: 'drain' }), START_TIMEOUT_MS).catch(() => undefined);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (await canConnect(socketPath)) {
    if (Date.now() > deadline) throw new Error(`the daemon on ${socketPath} did not drain within ${START_TIMEOUT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
