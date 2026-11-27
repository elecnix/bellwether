// The parent's side of the relay. For each machine that runs a child of a
// parent this daemon holds, the daemon keeps one SSH connection open to that
// machine, through the operator's SSH configuration, the same way a spawn
// reaches it. The far end runs `bellwether relay-bridge`, which joins the
// connection to that machine's daemon socket, so the two daemons speak the
// daemon protocol to each other. This daemon subscribes to the reports that
// wait there for its parents, writes each into the parent's spool once per
// receipt, and acknowledges it, so the child's machine never connects out.
//
// A connection that fails or drops is retried with backoff, and its state is
// kept per host: connected or reconnecting, the last error, and when the
// parent last held every report that waited there. `bellwether doctor` and
// the daemon log both show it, and a parent's reads of a remote child's
// transcript go over the same connection.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_HOST, hostOf, resolveMachine, type MachineResolver } from '../core/machine.ts';
import { relayHostsPath } from '../core/paths.ts';
import { listParents } from '../core/registry.ts';
import { NO_BELLWETHER_EXIT, relayBridgeArgv } from '../core/ssh.ts';
import type { ChildRecord } from '../core/types.ts';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, formatRequest, type DaemonReply, type RelayHostState, type RelayReport } from './protocol.ts';

export interface RelayLinksOptions {
  /** Turns a child's herdr machine into its SSH target. Defaults to herdr's saved machines. */
  resolve?: MachineResolver;
  /** The ssh binary. Defaults to `ssh` on PATH, which is what tests replace. */
  ssh?: string;
  log?: (message: string) => void;
  now?: () => number;
  /** The first reconnect delay. Each failure doubles it, up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** How long a read waits for a connection and its answer. */
  readTimeoutMs?: number;
  /**
   * How often the parent writes a heartbeat line on each connection. The
   * bridge on the child's machine exits after three intervals without a
   * line, so a connection that died without closing ends there too.
   */
  heartbeatMs?: number;
}

/** What the daemon does with a report that arrived: take it, or refuse it for good. */
export type AcceptRelayed = (host: string, report: RelayReport) => { refused?: string };

interface PendingRead {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Link {
  host: string;
  state: RelayHostState;
  process?: ChildProcess;
  buffer: string;
  stderr: string;
  /** The protocol error the far end sent, which explains the close that follows. */
  farError?: string;
  timer?: NodeJS.Timeout;
  /** Writes the heartbeat while the connection is up. */
  heartbeat?: NodeJS.Timeout;
  /** Whether the far end answered the relay on this attempt, so a failure before it can say what to update. */
  answered: boolean;
  /** The parents the last subscribe named. */
  parentIds: string[];
  subscribed: boolean;
  /** When this daemon last asked the far end to send everything again. */
  drainAskedAt: number;
  closing: boolean;
  reads: Map<string, PendingRead>;
  waiters: Set<() => void>;
}

interface Wanted {
  parentIds: Set<string>;
  /** Children whose reports this daemon is still waiting for. */
  children: string[];
  /** The newest exit among them that came after the last drain. */
  exitedSinceDrain: number;
}

export class RelayLinks {
  private readonly resolve: MachineResolver;
  private readonly ssh: string;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly readTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly links = new Map<string, Link>();
  /** Hosts a read holds open, though no child there needs a connection. */
  private readonly pins = new Map<string, number>();
  /** What earlier daemons learnt about each host, kept across a restart. */
  private memory: Record<string, { lastDrainAt?: string; lastConnectedAt?: string; lastError?: string }> = {};
  private accept: AcceptRelayed = () => ({ refused: 'this daemon takes no reports' });
  private sequence = 0;
  private stopped = true;

  constructor(options: RelayLinksOptions = {}) {
    this.resolve = options.resolve ?? resolveMachine;
    this.ssh = options.ssh ?? 'ssh';
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.initialDelayMs = options.initialDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  /** Start connecting to every host a child of this machine's parents runs on. */
  start(accept: AcceptRelayed): void {
    this.accept = accept;
    this.stopped = false;
    this.memory = readMemory();
    this.sync();
  }

  stop(): void {
    this.stopped = true;
    for (const link of this.links.values()) this.close(link, 'the daemon is stopping');
    this.links.clear();
  }

  /** The state of every connection, for doctor and the log. */
  states(): RelayHostState[] {
    return [...this.links.values()].map((link) => ({ ...link.state, children: [...link.state.children] })).sort((a, b) => a.host.localeCompare(b.host));
  }

  state(host: string): RelayHostState | undefined {
    const link = this.links.get(host);
    return link ? { ...link.state, children: [...link.state.children] } : undefined;
  }

  /**
   * Open a connection to every host that needs one and close the rest. A
   * host needs one while a child there runs, and after a child there exits
   * until the parent has drained that host once since the exit, so a report
   * the child wrote last is collected.
   */
  sync(): void {
    if (this.stopped) return;
    const wanted = this.wanted();
    for (const [host, want] of wanted) {
      const needed = want.children.length > 0 || (this.pins.get(host) ?? 0) > 0;
      if (!needed) continue;
      const parentIds = [...want.parentIds].sort();
      let link = this.links.get(host);
      if (!link) {
        link = this.open(host, parentIds);
        this.links.set(host, link);
      }
      link.state.children = want.children;
      const changed = parentIds.join('\n') !== link.parentIds.join('\n');
      link.parentIds = parentIds;
      if (!link.subscribed) continue;
      // A new parent, or a child that exited after the last drain: ask for everything that waits.
      if (changed || want.exitedSinceDrain > link.drainAskedAt) this.subscribe(link);
    }
    for (const [host, link] of this.links) {
      const want = wanted.get(host);
      if ((want && want.children.length > 0) || (this.pins.get(host) ?? 0) > 0) continue;
      this.close(link, 'no child there needs it');
      this.links.delete(host);
      this.log(`relay: closed the connection to machine ${host}, which runs no child this daemon waits for`);
    }
  }

  /**
   * A remote child's last assistant message, read from the transcript on its
   * own machine over the open connection. It fails at once, saying so, when
   * the host is known to be unreachable.
   */
  async lastMessage(child: Pick<ChildRecord, 'host' | 'harness' | 'session' | 'cwd'>): Promise<string | undefined> {
    if (!child.session?.value) return undefined;
    const host = hostOf(child);
    if (host === LOCAL_HOST) throw new Error('a local child is read on this machine');
    const known = this.links.get(host);
    if (known && known.state.status === 'reconnecting') throw new Error(unreachable(known.state));
    this.pins.set(host, (this.pins.get(host) ?? 0) + 1);
    try {
      this.sync();
      const link = this.links.get(host) ?? this.ensure(host);
      await this.connected(link);
      const id = `r${++this.sequence}`;
      const text = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          link.reads.delete(id);
          reject(new Error(`machine ${host} did not answer a read within ${this.readTimeoutMs} ms`));
        }, this.readTimeoutMs);
        timer.unref?.();
        link.reads.set(id, { resolve, reject, timer });
        this.write(link, formatRequest({ type: 'relay-read', id, harness: child.harness, session: child.session!.value, ...(child.cwd ? { cwd: child.cwd } : {}) }));
      });
      return text.trim() ? text : undefined;
    } finally {
      const left = (this.pins.get(host) ?? 1) - 1;
      if (left > 0) this.pins.set(host, left);
      else this.pins.delete(host);
      this.sync();
    }
  }

  /** A link for a host no child needs yet, for a read. */
  private ensure(host: string): Link {
    const link = this.open(host, []);
    this.links.set(host, link);
    return link;
  }

  /** Wait until a link is connected, or fail with what keeps it from connecting. */
  private connected(link: Link): Promise<void> {
    if (link.state.status === 'connected' && link.subscribed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.waiters.delete(done);
        reject(new Error(unreachable(link.state)));
      }, this.readTimeoutMs);
      timer.unref?.();
      const done = (): void => {
        clearTimeout(timer);
        link.waiters.delete(done);
        if (link.state.status === 'connected') resolve();
        else reject(new Error(unreachable(link.state)));
      };
      link.waiters.add(done);
    });
  }

  /** Which hosts the registries on this machine have children on, and which of them still matter. */
  private wanted(): Map<string, Wanted> {
    const wanted = new Map<string, Wanted>();
    for (const parent of listParents()) {
      for (const child of parent.children) {
        // A child that moved away left its old machine as an exited child leaves
        // its own: that machine is drained once more, for a report it left there.
        const places: { host: string; left?: number }[] = [{ host: hostOf(child), left: child.exitedAt ? Date.parse(child.exitedAt) : undefined }];
        if (child.movedFrom && child.movedFrom.host !== places[0]?.host) places.push({ host: child.movedFrom.host, left: Date.parse(child.movedFrom.at) || 0 });
        for (const { host, left } of places) {
          if (host === LOCAL_HOST) continue;
          const want = wanted.get(host) ?? { parentIds: new Set<string>(), children: [], exitedSinceDrain: 0 };
          wanted.set(host, want);
          want.parentIds.add(parent.id);
          const drained = Date.parse(this.links.get(host)?.state.lastDrainAt ?? this.memory[host]?.lastDrainAt ?? '') || 0;
          if (left === undefined) want.children.push(child.id);
          else if (left >= drained) {
            want.children.push(child.id);
            want.exitedSinceDrain = Math.max(want.exitedSinceDrain, left);
          }
        }
      }
    }
    return wanted;
  }

  private open(host: string, parentIds: string[]): Link {
    const remembered = this.memory[host] ?? {};
    const link: Link = {
      host,
      state: { host, status: 'connecting', since: this.iso(), attempts: 0, children: [], ...(remembered.lastDrainAt ? { lastDrainAt: remembered.lastDrainAt } : {}), ...(remembered.lastConnectedAt ? { lastConnectedAt: remembered.lastConnectedAt } : {}) },
      buffer: '',
      stderr: '',
      parentIds,
      subscribed: false,
      answered: false,
      drainAskedAt: 0,
      closing: false,
      reads: new Map(),
      waiters: new Set(),
    };
    this.connect(link);
    return link;
  }

  private connect(link: Link): void {
    if (this.stopped || link.closing) return;
    link.timer = undefined;
    link.buffer = '';
    link.stderr = '';
    link.farError = undefined;
    link.subscribed = false;
    link.answered = false;
    delete link.state.nextAttemptAt;
    this.resolve(link.host)
      .then((profile) => {
        if (this.stopped || link.closing) return;
        link.state.target = profile.target;
        this.log(`relay: connecting to machine ${link.host} as ${profile.target}${link.state.attempts ? `, attempt ${link.state.attempts + 1}` : ''}`);
        const child = spawn(this.ssh, relayBridgeArgv(profile.target, this.heartbeatMs), { stdio: ['pipe', 'pipe', 'pipe'] });
        link.process = child;
        child.stdin.on('error', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => this.read(link, child, chunk));
        child.stderr.on('data', (chunk: Buffer) => {
          link.stderr = `${link.stderr}${chunk.toString('utf8')}`.slice(-2_000);
        });
        child.on('error', (error) => this.lost(link, child, `ssh could not start: ${error.message}`));
        child.on('close', (code, signal) => this.lost(link, child, this.why(link, profile.target, code, signal)));
        this.subscribe(link);
      })
      .catch((error: unknown) => this.lost(link, undefined, `machine ${link.host} could not be resolved: ${(error as Error).message}`));
  }

  private why(link: Link, target: string, code: number | null, signal: NodeJS.Signals | null): string {
    const lines = link.stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    // A Node program that throws prints its stack after the error line, so the last lines are frames, not the reason.
    const thrown = lines.find((line) => /^[A-Za-z]*Error\b.*:/.test(line));
    const detail = link.farError ?? thrown ?? lines.slice(-3).join(' / ');
    let hint = '';
    if (code === NO_BELLWETHER_EXIT) hint = ' Install @elecnix/bellwether on that machine.';
    else if (!link.farError && thrown && !link.answered && code !== 255) {
      // The bellwether there ran and failed before it spoke the relay: most likely a version from before relay-bridge.
      hint = ` The bellwether command on machine ${link.host} failed before it answered the relay; if it predates relay-bridge, Update @elecnix/bellwether on machine ${link.host}.`;
    }
    return `ssh ${target} ${code === null ? `ended on ${signal ?? 'a signal'}` : `exited with ${code}`}${detail ? `: ${detail}` : ''}${hint}`;
  }

  /** A connection ended or never started: say so, and try again after the backoff. */
  private lost(link: Link, child: ChildProcess | undefined, reason: string): void {
    if (child && link.process !== child) return;
    link.process = undefined;
    link.subscribed = false;
    this.stopHeartbeat(link);
    for (const read of link.reads.values()) {
      clearTimeout(read.timer);
      read.reject(new Error(`the connection to machine ${link.host} ended: ${reason}`));
    }
    link.reads.clear();
    if (link.closing || this.stopped) return;
    const was = link.state.status;
    link.state.attempts += 1;
    link.state.lastError = reason;
    if (was !== 'reconnecting') {
      link.state.status = 'reconnecting';
      link.state.since = this.iso();
    }
    const delay = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.min(link.state.attempts - 1, 20));
    link.state.nextAttemptAt = new Date(this.now() + delay).toISOString();
    this.log(`relay: ${was === 'connected' ? 'lost' : 'could not reach'} machine ${link.host}, retry in ${Math.max(1, Math.round(delay / 1000))} s: ${reason}`);
    this.remember(link);
    for (const waiter of [...link.waiters]) waiter();
    link.timer = setTimeout(() => this.connect(link), delay);
    link.timer.unref?.();
  }

  private subscribe(link: Link): void {
    link.drainAskedAt = this.now();
    this.write(link, formatRequest({ type: 'relay-subscribe', protocol: DAEMON_PROTOCOL, parentIds: link.parentIds }));
  }

  private read(link: Link, child: ChildProcess, chunk: string): void {
    if (link.process !== child) return;
    link.buffer += chunk;
    let index = link.buffer.indexOf('\n');
    while (index >= 0) {
      const line = link.buffer.slice(0, index);
      link.buffer = link.buffer.slice(index + 1);
      index = link.buffer.indexOf('\n');
      if (!line.trim()) continue;
      let reply: DaemonReply;
      try {
        reply = JSON.parse(line) as DaemonReply;
      } catch {
        // An older bellwether there prints its usage for a command it does not know, and exits.
        link.farError ??= `the bellwether command on machine ${link.host} does not speak the relay protocol; it printed ${JSON.stringify(line.slice(0, 120))}. Update @elecnix/bellwether on machine ${link.host}.`;
        this.log(`relay: machine ${link.host} sent a line that is not the relay protocol`);
        continue;
      }
      this.dispatch(link, child, reply);
    }
    // Only the unfinished line counts against the limit, so two whole lines in one chunk never trip it.
    if (link.buffer.length > MAX_DAEMON_FRAME_BYTES) {
      link.farError = `machine ${link.host} sent a line over ${MAX_DAEMON_FRAME_BYTES} characters`;
      child.kill('SIGTERM');
    }
  }

  private dispatch(link: Link, child: ChildProcess, reply: DaemonReply): void {
    if (reply.type === 'relay-hello') {
      const was = link.state.status;
      link.subscribed = true;
      link.answered = true;
      this.startHeartbeat(link);
      link.state.attempts = 0;
      link.state.lastConnectedAt = this.iso();
      delete link.state.nextAttemptAt;
      // An older daemon there names neither, and then neither is kept from an earlier connection.
      if (reply.version) link.state.farVersion = reply.version;
      else delete link.state.farVersion;
      if (reply.build) link.state.farBuild = reply.build;
      else delete link.state.farBuild;
      if (was !== 'connected') {
        link.state.status = 'connected';
        link.state.since = this.iso();
        this.log(`relay: connected to machine ${link.host} as ${link.state.target}, which runs ${runsOn(reply)}, where ${reply.waiting} report(s) wait`);
      }
      this.remember(link);
      for (const waiter of [...link.waiters]) waiter();
      return;
    }
    if (reply.type === 'relay-report') {
      const outcome = this.take(link.host, reply.report);
      this.write(link, formatRequest({ type: 'relay-ack', receipt: reply.report.receipt, ...(outcome.refused ? { refused: outcome.refused } : {}) }));
      return;
    }
    if (reply.type === 'relay-drained') {
      link.state.lastDrainAt = this.iso();
      if (reply.sent) this.log(`relay: drained machine ${link.host}, ${reply.sent} report(s)`);
      this.remember(link);
      // The drain may have been the last thing an exited child's host was kept open for.
      this.sync();
      return;
    }
    if (reply.type === 'result') {
      const read = link.reads.get(reply.id);
      if (!read) return;
      link.reads.delete(reply.id);
      clearTimeout(read.timer);
      if (reply.error !== undefined) read.reject(new Error(reply.error));
      else read.resolve(reply.text ?? '');
      return;
    }
    if (reply.type === 'error') {
      // The far end refused the subscribe: an older daemon, most likely. End the connection with its reason.
      link.farError = `the daemon on machine ${link.host} answered ${reply.code}: ${reply.message}${reply.code === 'protocol_mismatch' || reply.code === 'unknown_type' ? '. Update @elecnix/bellwether on that machine.' : ''}`;
      child.kill('SIGTERM');
    }
  }

  /** Write a report into the parent it names, once per receipt, or refuse it. */
  private take(host: string, report: RelayReport): { refused?: string } {
    try {
      return this.accept(host, report);
    } catch (error) {
      return { refused: (error as Error).message };
    }
  }

  private write(link: Link, line: string): void {
    const stdin = link.process?.stdin;
    if (stdin?.writable) stdin.write(line);
  }

  /**
   * Write a blank line at the heartbeat interval. Every daemon on protocol 4
   * skips a blank line, so the heartbeat needs no protocol change, and the
   * bridge counts it as a sign the parent is still there.
   */
  private startHeartbeat(link: Link): void {
    this.stopHeartbeat(link);
    link.heartbeat = setInterval(() => this.write(link, '\n'), this.heartbeatMs);
    link.heartbeat.unref?.();
  }

  private stopHeartbeat(link: Link): void {
    if (link.heartbeat) clearInterval(link.heartbeat);
    link.heartbeat = undefined;
  }

  private close(link: Link, reason: string): void {
    link.closing = true;
    this.stopHeartbeat(link);
    if (link.timer) clearTimeout(link.timer);
    link.timer = undefined;
    for (const read of link.reads.values()) {
      clearTimeout(read.timer);
      read.reject(new Error(`the connection to machine ${link.host} closed: ${reason}`));
    }
    link.reads.clear();
    for (const waiter of [...link.waiters]) waiter();
    const child = link.process;
    link.process = undefined;
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }

  private remember(link: Link): void {
    const { lastDrainAt, lastConnectedAt, lastError } = link.state;
    this.memory[link.host] = { ...(lastDrainAt ? { lastDrainAt } : {}), ...(lastConnectedAt ? { lastConnectedAt } : {}), ...(lastError ? { lastError } : {}) };
    writeMemory(this.memory);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** One sentence that says a host cannot be reached, and what is known about why. */
export function unreachable(state: RelayHostState): string {
  const parts = [`machine ${state.host} is unreachable: ${state.lastError ?? 'no connection has been made yet'}`];
  parts.push(`Bellwether is ${state.status === 'reconnecting' ? `reconnecting${state.nextAttemptAt ? `, next attempt at ${state.nextAttemptAt}` : ''}` : 'still connecting'}`);
  parts.push(state.lastConnectedAt ? `last connected at ${state.lastConnectedAt}` : 'never connected');
  return `${parts.join('; ')}.`;
}

/** What earlier daemons on this machine learnt about each remote host. */
export function readMemory(): Record<string, { lastDrainAt?: string; lastConnectedAt?: string; lastError?: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(relayHostsPath(), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, { lastDrainAt?: string }>) : {};
  } catch {
    return {};
  }
}

function writeMemory(memory: Record<string, unknown>): void {
  const file = relayHostsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // The state in memory still holds; a restart only forgets the last drain.
  }
}

/** Which Bellwether a child machine's daemon runs, as its relay hello said, in a few words. */
export function runsOn(hello: { version?: string; build?: string }): string {
  if (!hello.version) return 'a Bellwether that predates naming its version and build';
  return `bellwether ${hello.version}${hello.build ? ` build ${hello.build}` : ', a build that names no commit'}`;
}
