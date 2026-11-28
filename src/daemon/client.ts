// The daemon client: one connection per session, started on demand. A tool
// call, a receipt and an event all cross the same socket, and a reconnect
// replays the events the session missed while it was away.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BELLWETHER_BUILD_ID, BELLWETHER_PACKAGE_DIR, BELLWETHER_VERSION } from '../core/version.ts';
import { missingFeatureMessage, featureNamed, serves, unservedArgument, type DaemonOffer } from './features.ts';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, MIN_DAEMON_PROTOCOL, formatRequest, type DaemonReply, type InboxMessage, type MessageAckRequest, type ParentHello, type RelayHostState, type ReportRequest, type ServedTool, type SessionsReply } from './protocol.ts';
import { fallbackTools } from '../integrations/tools.ts';
import { isAlive, readLock } from './lock.ts';
import { HANDOVER_TIMEOUT_MS, decideHandOver, type DaemonIdentity } from './handover.ts';
import { canConnect } from './server.ts';
import type { ModelPair, OutboxEntry } from '../core/types.ts';
import type { AncestryAnswer } from '../core/ancestry.ts';
import { rosterFrom, type RosterChild } from '../core/roster.ts';

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

/** What a handshake learned: the session's parent id, which daemon answered, and the protocol the two speak. */
interface Hello {
  parentId: string;
  pid: number;
  daemon: DaemonIdentity;
  offer: DaemonOffer;
  spoken: number;
  /** The tools the daemon serves this session, when its hello listed them. */
  served?: ServedTool[];
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

/** A daemon that refused this client's hello, with the range it said it serves. */
class ProtocolMismatch extends Error {
  readonly daemonProtocol: number | undefined;
  readonly minProtocol: number | undefined;
  readonly version: string | undefined;
  readonly reason: string;

  constructor(reply: { message: string; protocol?: number; minProtocol?: number; version?: string }) {
    super(`protocol_mismatch: ${reply.message}`);
    this.reason = reply.message;
    this.daemonProtocol = typeof reply.protocol === 'number' ? reply.protocol : undefined;
    this.minProtocol = typeof reply.minProtocol === 'number' ? reply.minProtocol : undefined;
    this.version = typeof reply.version === 'string' ? reply.version : undefined;
    this.name = 'ProtocolMismatch';
  }
}

/**
 * The error for a daemon that refused this session outright. It quotes the
 * range the daemon serves, as the daemon gave it, and names the install that
 * has to change. Which one depends on the direction: a session too old for the
 * daemon updates its own install, and a daemon too old for the session is
 * upgraded on its machine.
 */
export function refusalMessage(socketPath: string, mismatch: { daemonProtocol?: number; minProtocol?: number; version?: string; reason: string }, own: DaemonIdentity, installDir = BELLWETHER_PACKAGE_DIR): string {
  const daemon = `the daemon on ${socketPath}${mismatch.version ? ` (Bellwether ${mismatch.version})` : ''}`;
  const range = mismatch.daemonProtocol === undefined ? 'did not say which protocols it serves' : mismatch.minProtocol !== undefined && mismatch.minProtocol !== mismatch.daemonProtocol ? `serves protocols ${mismatch.minProtocol} to ${mismatch.daemonProtocol}` : `serves protocol ${mismatch.daemonProtocol}`;
  const session = `this session speaks protocols ${MIN_DAEMON_PROTOCOL} to ${own.protocol} (Bellwether ${own.version ?? 'unknown'})`;
  const tooOldDaemon = mismatch.daemonProtocol !== undefined && mismatch.daemonProtocol < MIN_DAEMON_PROTOCOL;
  const fix = tooOldDaemon
    ? 'Upgrade the Bellwether install that started that daemon, or run bellwether drain so the next session starts one from its own install.'
    : `Update the Bellwether install at ${installDir}, then start this session again.`;
  return `${daemon} ${range}, and ${session}. It answered: ${mismatch.reason}. ${fix}`;
}

/** The daemon socket a client uses when none is given: the one under its home. */
export function defaultDaemonSocket(home: string): string {
  return path.join(home, 'daemon.sock');
}

export class DaemonClient {
  private connection: Connection | undefined;
  private readonly waiting = new Map<string, { tool: string; resolve: (text: string) => void; reject: (error: Error) => void; retry: () => void }>();
  /** Panes whose watch went out on the current connection, so a reconnect sends each again once. */
  private sentWatches = new Set<string>();
  private readonly handlers = new Set<(entries: OutboxEntry[]) => void>();
  private readonly toolHandlers = new Set<(tools: ServedTool[]) => void>();
  /** The tools the daemon last served this session, when it listed them. */
  private served: ServedTool[] | undefined;
  private readonly paneHandlers = new Map<string, Set<(status: string) => void>>();
  private readonly received = new Map<string, OutboxEntry>();
  private readonly unsentReceipts: string[] = [];
  private readonly messageHandlers = new Set<(message: InboxMessage, replay: boolean) => void>();
  /** Messages that arrived before the adapter set its handler, which a session that accepts messages holds for it. */
  private readonly heldMessages: { message: InboxMessage; replay: boolean }[] = [];
  /** Acknowledgements written while no connection was open, sent on the next one. */
  private readonly unsentAcks: string[] = [];
  private sequence = 0;
  private stopped = false;
  private reconnecting = false;
  private lastEvents: OutboxEntry[] = [];
  /** The parent's live children, as the daemon sent them with its newest push or hello. */
  private lastRoster: RosterChild[] | undefined;
  private closedReply: (() => void) | undefined;
  /** What was logged once already, so a daemon that repeats something this client does not know is not logged each time. */
  private readonly warned = new Set<string>();

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
    // A test that presents another release's identity presents no build.
    this.build = options.identity ? undefined : BELLWETHER_BUILD_ID;
  }

  private readonly identity: DaemonIdentity;
  private readonly build: string | undefined;
  /** The build of the daemon this client spoke to last, when its hello named one. */
  daemonBuild: string | undefined;
  /** The daemon this client spoke to last, as its hello described it. */
  daemon: DaemonIdentity | undefined;
  /** What that daemon serves, for naming a missing feature. */
  offer: DaemonOffer | undefined;
  /** The protocol this session speaks with that daemon: its own, or the daemon's when the daemon is older. */
  spoken: number | undefined;

  private readonly parent: ParentHello;
  private readonly log: (message: string) => void;
  private readonly entry: string | undefined;
  private readonly spawnAllowed: boolean;
  private readonly timeoutMs: number;

  static async connect(parent: ParentHello, options: ConnectOptions = {}): Promise<DaemonClient> {
    const home = options.home ?? process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
    const socketPath = options.socketPath ?? defaultDaemonSocket(home);
    const client = new DaemonClient(parent, home, socketPath, options);
    client.adopt(await client.establish());
    return client;
  }

  /** Take what a hello said, and tell the adapter when the tools it offers changed. */
  private adopt(hello: Hello): void {
    const before = this.offer ? this.tools() : undefined;
    Object.assign(this, { parentId: hello.parentId, pid: hello.pid, daemon: hello.daemon, offer: hello.offer, spoken: hello.spoken, served: hello.served });
    if (!before) return;
    const after = this.tools();
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    for (const handler of this.toolHandlers) handler(after);
  }

  /**
   * The tools this session offers its model. The daemon's list decides, from
   * its feature table. A daemon from before the list leaves it to this
   * client's own list, less each tool the daemon does not serve.
   */
  tools(): ServedTool[] {
    if (this.served) return this.served.map((tool) => ({ ...tool }));
    return fallbackTools({ reportsTo: this.parent.reportsTo, childId: this.parent.childId }, this.offer);
  }

  /** Hear when a reconnect, such as a hand-over to a newer daemon, changes the tools this session offers. */
  onTools(handler: (tools: ServedTool[]) => void): () => void {
    this.toolHandlers.add(handler);
    return () => this.toolHandlers.delete(handler);
  }

  /** Unread entries the daemon sent with the last hello. */
  pending(): Promise<OutboxEntry[]> {
    return Promise.resolve([...this.lastEvents]);
  }

  /**
   * The roster the daemon sent with its newest alert, once: the daemon sends
   * one only when a line is due, so a message composed later never repeats it.
   * A daemon from before issue #146 sends none, and the adapter adds no line.
   */
  takeRoster(): RosterChild[] | undefined {
    const roster = this.lastRoster;
    this.lastRoster = undefined;
    return roster;
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

  /** Run a tool. `model` is the provider and model the session runs on now, when its harness says. */
  async tool(name: string, args: Record<string, unknown>, model?: ModelPair): Promise<string> {
    if (this.stopped) throw new Error('the daemon client is closed');
    await this.ensure();
    // An older daemon ignores an argument it does not know, so the call would
    // run without it. Refuse it here, by name, instead.
    const offer = this.offer ?? (this.daemon ? { ...this.daemon } : undefined);
    const unserved = offer ? unservedArgument(offer, name, args) : undefined;
    if (unserved && offer) throw new Error(missingFeatureMessage(unserved, offer));
    const id = `c${++this.sequence}`;
    // The caller identity travels with every call, so the daemon routes by its
    // own records whichever client process asked.
    const caller = { ...(this.parent.paneId ? { paneId: this.parent.paneId } : {}), ...(this.parent.childId ? { childId: this.parent.childId } : {}), ...(model ? { model } : {}) };
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
        tool: name,
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

  /**
   * Hear a parent's message for this session. The daemon pushes one only to
   * a session whose hello accepts `message`, so the adapter names it there.
   */
  onMessage(handler: (message: InboxMessage, replay: boolean) => void): () => void {
    this.messageHandlers.add(handler);
    for (const held of this.heldMessages.splice(0)) handler(held.message, held.replay);
    return () => this.messageHandlers.delete(handler);
  }

  /** Tell the daemon what became of a parent's message: queued in the harness, read by the model, or refused. */
  messageAck(id: string, outcome: MessageAckRequest['outcome'], detail: { via?: string; reason?: string } = {}): void {
    const line = formatRequest({ type: 'message-ack', id, outcome, ...detail });
    if (!this.connection) {
      this.unsentAcks.push(line);
      return;
    }
    this.write(line);
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
   * Say hello again as another harness session, as a Claude Code server does
   * when a resume moves its process to another session (issue #184). The
   * daemon serves a connection by its hello: the session decides its parent
   * id, its tools, and the adoption it answers to. So the client leaves its
   * connection with a bye, once no call waits on it, and connects again under
   * the new session. The tool handlers hear a changed list as they do after a
   * hand-over, and the daemon replays the unread messages of the child this
   * session now is.
   */
  async reidentify(session: string): Promise<void> {
    if (this.stopped || this.parent.session === session) return;
    (this.parent as { session: string }).session = session;
    // A call in flight answers on the connection that carried it.
    const deadline = Date.now() + this.timeoutMs;
    while (this.waiting.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const connection = this.connection;
    if (connection) {
      this.connection = undefined;
      connection.abandoned = true;
      connection.socket.on('error', () => {});
      if (connection.socket.writable) connection.socket.write(formatRequest({ type: 'bye' }));
      connection.socket.end();
    }
    // Events and receipts belong to the parent id the old session had.
    this.received.clear();
    this.lastEvents = [];
    await this.reconnected();
  }

  /**
   * Connect, starting a daemon when nothing answers and spawning is allowed.
   * The client always says hello first and never refuses a daemon on its own:
   * only the daemon's answer decides. A daemon from an older release is handed
   * over: this client drains it and starts its own, and the sessions already
   * connected reconnect to the new one. An older daemon this client does not
   * replace, because it may not start daemons or cannot order the two
   * releases, is spoken to on the daemon's protocol, and the operations it
   * lacks are refused by name when called. A daemon that refuses the session
   * outright gets an error that quotes the range it serves.
   */
  private async establish(): Promise<Hello> {
    let lastError: Error | undefined;
    let offer = this.identity.protocol;
    for (let attempt = 0; attempt < ESTABLISH_ATTEMPTS; attempt += 1) {
      let hello: Hello;
      try {
        hello = await this.handshake(offer);
      } catch (error) {
        lastError = error as Error;
        if (error instanceof ProtocolMismatch) {
          const theirs = error.daemonProtocol;
          const daemon: DaemonIdentity = { protocol: theirs ?? 0, ...(error.version ? { version: error.version } : versionOf(readLock(this.home))) };
          const older = theirs !== undefined && theirs < offer;
          const decision = older ? decideHandOver(daemon, this.identity) : { kind: 'keep' as const };
          if (decision.kind === 'replace' && this.spawnAllowed) {
            this.log(`handing over: ${decision.reason}`);
            await handOverDaemon(this.home, this.socketPath, { entry: this.entry, log: this.log });
            offer = this.identity.protocol;
            continue;
          }
          if (older && theirs >= MIN_DAEMON_PROTOCOL) {
            this.warnOnce(`speak-${theirs}`, `the daemon on ${this.socketPath} serves protocol ${theirs}${daemon.version ? ` (Bellwether ${daemon.version})` : ''}, older than this session's ${this.identity.protocol}; speaking ${theirs}, and naming any operation it lacks when it is called`);
            offer = theirs;
            continue;
          }
          throw new Error(refusalMessage(this.socketPath, error, this.identity));
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
      offer = this.identity.protocol;
    }
    throw lastError ?? new Error(`the daemon on ${this.socketPath} was replaced ${ESTABLISH_ATTEMPTS} times while this client connected; another install keeps starting an older daemon`);
  }

  /** Log a message the first time its key comes up on this client, and never again. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }

  /**
   * The error for a call the daemon refused. A tool the daemon does not serve
   * is named with the release that brought it. The daemon says so with
   * unknown_tool from 0.1.5 on, and with a fixed text before. For a daemon
   * whose protocol predates the tool, the feature table judges, but only
   * after the daemon has refused the call.
   */
  private callError(tool: string, message: string, code?: string): Error {
    const feature = featureNamed(tool);
    const offer = this.offer ?? (this.daemon ? { ...this.daemon } : undefined);
    // A daemon before 0.1.5 sends no code, only this fixed text, for a tool it does not have.
    const unknown = code === 'unknown_tool' || code === 'unknown_type' || message === `Bellwether has no tool named ${tool}`;
    if (offer && (unknown || (feature && !serves(offer, feature)))) return new Error(missingFeatureMessage(tool, offer));
    return new Error(message);
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
      this.adopt(await this.establish());
      if (this.unsentReceipts.length) this.write(formatRequest({ type: 'receipt', receipts: this.unsentReceipts.splice(0) }));
      for (const line of this.unsentAcks.splice(0)) this.write(line);
    } finally {
      this.reconnecting = false;
    }
  }

  private async handshake(offer: number): Promise<Hello> {
    const connection = await this.open();
    const hello = { type: 'hello', protocol: offer, client: this.identity.version ?? 'unknown', ...(this.build ? { build: this.build } : {}), parent: this.parent } as const;
    const reply = await this.ask(connection, formatRequest(hello));
    if (reply.type === 'error') {
      connection.socket.destroy();
      if (reply.code === 'protocol_mismatch') throw new ProtocolMismatch(reply);
      throw new Error(`${reply.code}: ${reply.message}`);
    }
    // Strict: without a parent id the session has no outbox to read, so nothing else could work.
    if (reply.type !== 'hello' || typeof reply.parentId !== 'string') {
      connection.socket.destroy();
      throw new Error(`the daemon answered ${reply.type} to a hello`);
    }
    this.attach(connection);
    const pending = Array.isArray(reply.pending) ? reply.pending : [];
    this.lastEvents = pending;
    this.lastRoster = rosterFrom(reply.roster);
    for (const entry of pending) this.received.set(entry.receipt, entry);
    if (pending.length) for (const handler of this.handlers) handler(pending);
    // A daemon before 0.1.5 sends no version in its hello, and its lock is the only record of it.
    const daemon: DaemonIdentity = { protocol: reply.protocol, ...(reply.version ? { version: reply.version } : versionOf(readLock(this.home))) };
    this.daemonBuild = reply.build;
    const features = Array.isArray(reply.features) ? reply.features.filter((name): name is string => typeof name === 'string') : undefined;
    // Lines that arrived with the hello's answer, after the pending entries it carried.
    if (connection.buffer) this.read(connection, '');
    const served = Array.isArray(reply.tools) ? reply.tools.filter(isServedTool) : undefined;
    return { parentId: reply.parentId, pid: reply.pid, daemon, offer: { ...daemon, ...(features ? { features } : {}) }, spoken: offer, ...(served ? { served } : {}) };
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

  /**
   * Send a hello and wait for its answer: the first hello or error line. A
   * line of another type, which a newer daemon may send first, is logged once
   * and skipped, and what follows the answer stays in the buffer for attach.
   */
  private ask(connection: Connection, line: string): Promise<DaemonReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.socket.off('data', onData);
        reject(new Error('the daemon did not answer in time'));
      }, START_TIMEOUT_MS);
      timer.unref?.();
      const onData = (chunk: string): void => {
        connection.buffer += chunk;
        for (let index = connection.buffer.indexOf('\n'); index >= 0; index = connection.buffer.indexOf('\n')) {
          const first = connection.buffer.slice(0, index);
          connection.buffer = connection.buffer.slice(index + 1);
          if (!first.trim()) continue;
          let reply: DaemonReply;
          try {
            reply = JSON.parse(first) as DaemonReply;
          } catch {
            this.warnOnce('unparsed', 'the daemon sent a line that is not JSON; it was ignored');
            continue;
          }
          if (reply.type !== 'hello' && reply.type !== 'error') {
            this.warnOnce(`type-${String(reply.type)}`, `the daemon sent ${JSON.stringify(reply.type)} before answering the hello; this client does not know it and ignored it`);
            continue;
          }
          connection.socket.off('data', onData);
          clearTimeout(timer);
          resolve(reply);
          return;
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
    // A daemon that exits or drains resets the socket. The close below
    // reconnects, so the error is logged rather than thrown in the session's process.
    connection.socket.on('error', (error: Error) => this.log(`daemon connection: ${error.message}`));
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
        this.warnOnce('unparsed', 'the daemon sent a line that is not JSON; it was ignored');
        continue;
      }
      if (!reply || typeof reply !== 'object') continue;
      this.dispatch(reply);
    }
  }

  /**
   * Act on one line from the daemon. Each reply is read for the fields this
   * client knows, and any other field is ignored. A reply type this client
   * does not know is logged once and ignored, never fatal: a newer daemon may
   * push things an older session has no use for.
   */
  private dispatch(reply: DaemonReply): void {
    if (reply.type === 'events') {
      if (!Array.isArray(reply.entries)) {
        this.warnOnce('events-shape', 'the daemon sent events without a list of entries; they were ignored');
        return;
      }
      // The roster comes before the handlers run, so the message they compose carries it. A push without one leaves a roster not yet taken.
      if (reply.roster !== undefined) this.lastRoster = rosterFrom(reply.roster);
      // An entry that arrives read was settled in the daemon, by a newer state
      // or a newer event for the same child. Drop it, so no resend repeats it.
      const unread: OutboxEntry[] = [];
      for (const entry of reply.entries) {
        if (!entry || typeof entry.receipt !== 'string') continue;
        if (entry.read) this.received.delete(entry.receipt);
        else {
          this.received.set(entry.receipt, entry);
          unread.push(entry);
        }
      }
      if (unread.length) for (const handler of this.handlers) handler(unread);
      return;
    }
    if (reply.type === 'message') {
      const message = reply.message;
      if (!message || typeof message.id !== 'string' || typeof message.text !== 'string') {
        this.warnOnce('message-shape', 'the daemon sent a message without an id and text; it was ignored');
        return;
      }
      const replay = reply.replay === true;
      if (!this.messageHandlers.size) {
        // A replay arrives with the hello, before the adapter has set its handler.
        if (this.parent.accepts?.includes('message')) this.heldMessages.push({ message, replay });
        else this.messageAck(message.id, 'refused', { reason: 'this session has no handler for messages' });
        return;
      }
      for (const handler of this.messageHandlers) handler(message, replay);
      return;
    }
    if (reply.type === 'status') {
      for (const handler of this.paneHandlers.get(reply.paneId) ?? []) handler(reply.status);
      return;
    }
    if (reply.type === 'tools') {
      // The session's tools changed while it stayed connected, as when a parent adopts it.
      if (!Array.isArray(reply.tools) || !reply.tools.every((tool) => tool && typeof tool.name === 'string')) {
        this.warnOnce('tools-shape', 'the daemon sent a tool list without names; it was ignored');
        return;
      }
      const before = JSON.stringify(this.tools());
      this.served = reply.tools.map((tool) => ({ ...tool }));
      const after = this.tools();
      if (JSON.stringify(after) === before) return;
      for (const handler of this.toolHandlers) handler(after);
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
      if (reply.error !== undefined) waiting.reject(this.callError(waiting.tool, reply.error, reply.code));
      else waiting.resolve(reply.text ?? '');
      return;
    }
    if (reply.type === 'error') {
      // An error that names a call answers it, so the call fails now rather than at its timeout.
      const waiting = reply.id ? this.waiting.get(reply.id) : undefined;
      if (waiting && reply.id) {
        this.waiting.delete(reply.id);
        waiting.reject(this.callError(waiting.tool, `${reply.code}: ${reply.message}`, reply.code));
        return;
      }
      this.warnOnce(`error-${reply.code}`, `the daemon answered ${reply.code}: ${reply.message}`);
      return;
    }
    if (reply.type === 'closed') {
      this.closedReply?.();
      this.closedReply = undefined;
      return;
    }
    this.warnOnce(`type-${String((reply as { type?: unknown }).type)}`, `the daemon sent ${JSON.stringify((reply as { type?: unknown }).type)}, which this client does not know; it was ignored`);
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
  let offer = DAEMON_PROTOCOL;
  if (options.spawn !== false) await ensureDaemon(home, socketPath, options.entry, options.log);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const line = formatRequest({ type: 'report', id: 'r1', protocol: offer, report });
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
    const reportFeature = featureNamed('report');
    // An older daemon that has the report request but not this protocol: post on its protocol.
    if (reply.type === 'error' && reply.code === 'protocol_mismatch' && typeof reply.protocol === 'number' && reply.protocol < offer && reportFeature && reply.protocol >= reportFeature.protocol) {
      options.log?.(`the daemon on ${socketPath} serves protocol ${reply.protocol}; posting the report on it`);
      offer = reply.protocol;
      continue;
    }
    if (reply.type === 'error' && reply.code === 'unknown_type') {
      const lock = readLock(home);
      throw new Error(missingFeatureMessage('report', { protocol: lock?.protocol ?? 0, ...versionOf(lock) }));
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
      reject(new Error(`the daemon did not answer within ${timeoutMs} ms`));
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

/**
 * The agent tree above one agent, as the daemon on a socket answers it. A
 * daemon before 0.1.6 answers unknown_type, which this throws with its code.
 */
export async function daemonAncestry(socketPath: string, agent: string, timeoutMs = START_TIMEOUT_MS): Promise<AncestryAnswer> {
  const reply = await askOnce(socketPath, formatRequest({ type: 'ancestry', id: 'a1', agent }), timeoutMs);
  if (reply.type === 'ancestry') return reply.answer;
  if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
  throw new Error(`the daemon answered ${reply.type} to an ancestry request`);
}

/** How long `bellwether resume` waits: a tab, the harness start and its startup dialog. */
export const RESUME_TIMEOUT_MS = 90_000;

/**
 * Resume a session whose pane is gone, through this machine's daemon, which
 * it starts or hands over first as a report does (issue #187). Resolves with
 * the daemon's answer, and throws its refusal as the error's message.
 */
export async function daemonResume(request: { target: string; herdrSocket?: string; label?: string }, options: ConnectOptions = {}): Promise<string> {
  const home = options.home ?? process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
  const socketPath = options.socketPath ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? defaultDaemonSocket(home);
  await ensureDaemon(home, socketPath, options.entry, options.log);
  const line = formatRequest({ type: 'resume', id: 'resume1', target: request.target, ...(request.herdrSocket ? { herdrSocket: request.herdrSocket } : {}), ...(request.label ? { label: request.label } : {}) });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await askOnce(socketPath, line, options.timeoutMs ?? RESUME_TIMEOUT_MS);
    if (reply.type === 'result' && reply.retry) {
      await waitWhileMarkerHeld(startingMarker(home), Date.now() + HANDOVER_TIMEOUT_MS);
      continue;
    }
    if (reply.type === 'result') {
      if (reply.error !== undefined) throw new Error(reply.error);
      return reply.text ?? '';
    }
    if (reply.type === 'error' && reply.code === 'unknown_type') {
      const lock = readLock(home);
      throw new Error(missingFeatureMessage('resume', { protocol: lock?.protocol ?? 0, ...versionOf(lock) }));
    }
    if (reply.type === 'error') throw new Error(`${reply.code}: ${reply.message}`);
    throw new Error(`the daemon answered ${reply.type} to a resume`);
  }
  throw new Error(`the daemon on ${socketPath} did not take the resume`);
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

/** Whether a tool from a hello has what an adapter needs to offer it. */
function isServedTool(value: unknown): value is ServedTool {
  if (typeof value !== 'object' || value === null) return false;
  const tool = value as Record<string, unknown>;
  return typeof tool['name'] === 'string' && typeof tool['description'] === 'string' && typeof tool['schema'] === 'object' && tool['schema'] !== null;
}
