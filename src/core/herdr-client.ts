// The herdr socket client: newline-delimited JSON, one connection per request,
// and one held-open connection for the subscription. The subscription checks
// the `subscription_started` acknowledgement and buffers frames that arrive
// before it, because herdr can deliver an event in the same read as the ack.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { detectModal } from './modal.ts';
import { parseScreen, type Screen } from './screen.ts';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_EVENTS = 4096;
const DEFAULT_TIMEOUT_MS = 5000;

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** A parsed event frame: `{event, data}`, or an id-carrying frame. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface Subscription {
  close(): void;
  closed: Promise<void>;
}

export class HerdrApiError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(`herdr ${message}`);
    this.name = 'HerdrApiError';
    this.code = code;
  }
}

/**
 * One connection to a herdr server. A Unix socket is one; the stdio of a
 * machine bridge is another, so the same framing serves a saved SSH machine.
 */
export interface HerdrConnection {
  write(line: string): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  destroy(): unknown;
  /** Let the process exit while this connection is open. */
  unref(): unknown;
}

/** Open a connection, calling `onReady` once it can take a request. */
export type HerdrDialer = (onReady: () => void) => HerdrConnection;

/** A socket path, or a dialer for a transport that is not a local socket. */
export type HerdrEndpoint = string | HerdrDialer;

function dial(endpoint: HerdrEndpoint, onReady: () => void): HerdrConnection {
  if (typeof endpoint !== 'string') return endpoint(onReady);
  const socket = net.createConnection(endpoint);
  socket.on('connect', onReady);
  return socket;
}

let sequence = 0;

export function nextRequestId(prefix = 'bellwether'): string {
  sequence += 1;
  return `${prefix}:${process.pid}:${sequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** herdr's own config root, which is also where a named session's socket lives. */
export function configHome(): string {
  return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
}

function sessionSocket(session: string): string {
  return path.join(configHome(), 'herdr', 'sessions', session, 'herdr.sock');
}

/**
 * herdr's documented socket order: an explicit path, then the session flag,
 * then HERDR_SOCKET_PATH, then HERDR_SESSION, then the default session.
 */
export function resolveSocketPath(options: { session?: string; socketPath?: string } = {}): string {
  if (options.socketPath) return options.socketPath;
  if (options.session) return sessionSocket(options.session);
  const fromEnv = process.env['HERDR_SOCKET_PATH'];
  if (fromEnv) return fromEnv;
  const envSession = process.env['HERDR_SESSION'];
  if (envSession) return sessionSocket(envSession);
  return path.join(configHome(), 'herdr', 'herdr.sock');
}

class NdjsonFrames {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_FRAME_BYTES) throw new Error('herdr sent a frame over the size limit');
      frames.push(JSON.parse(line.toString('utf8')));
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error('herdr sent a frame over the size limit');
    return frames;
  }
}

function errorFrom(frame: Record<string, unknown>): HerdrApiError | undefined {
  if (!('error' in frame)) return undefined;
  const error = frame.error;
  if (!isRecord(error)) return new HerdrApiError(undefined, 'returned an invalid error');
  return new HerdrApiError(typeof error['code'] === 'string' ? error['code'] : undefined, typeof error['message'] === 'string' ? error['message'] : 'request failed');
}

/** One request on its own connection, resolving with `result` or rejecting with HerdrApiError. */
export function requestHerdr(endpoint: HerdrEndpoint, request: HerdrRequest, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('herdr request aborted'));
    const socket = dial(endpoint, () => socket.write(`${JSON.stringify(request)}\n`));
    const frames = new NdjsonFrames();
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`herdr ${request.method} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
    };
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => finish(new Error('herdr request aborted'));

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(new Error(`herdr closed the connection before answering ${request.method}`)));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        for (const frame of frames.push(chunk)) {
          if (!isRecord(frame)) continue;
          const error = errorFrom(frame);
          if (error && (frame['id'] === undefined || frame['id'] === '')) return finish(error);
          if (frame['id'] !== request.id) continue;
          if (error) return finish(error);
          if (!('result' in frame)) return finish(new Error(`herdr ${request.method} answered without a result`));
          return finish(undefined, frame['result']);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/**
 * Hold a subscription open. Frames that arrive before the acknowledgement are
 * buffered and replayed, so no event is lost between connect and ack.
 */
export function openHerdrSubscription(
  endpoint: HerdrEndpoint,
  request: HerdrRequest,
  onEvent: (event: HerdrEvent) => void,
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Subscription> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('herdr subscription aborted'));
    const socket = dial(endpoint, () => socket.write(`${JSON.stringify(request)}\n`));
    const frames = new NdjsonFrames();
    const pending: HerdrEvent[] = [];
    let ready = false;
    let finished = false;
    let intentional = false;
    let resolveClosed: () => void = () => {};
    let rejectClosed: (error: Error) => void = () => {};
    const closed = new Promise<void>((res, rej) => {
      resolveClosed = res;
      rejectClosed = rej;
    });
    void closed.catch(() => undefined);
    const timer = setTimeout(() => finish(new Error('herdr subscription was not acknowledged')), timeoutMs);
    timer.unref?.();

    function teardown(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
    }
    /** End the subscription. Before the ack it rejects the caller; after it, it closes. */
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      teardown();
      if (!ready) {
        reject(error ?? new Error('herdr subscription aborted'));
        resolveClosed();
        return;
      }
      if (error && !intentional) rejectClosed(error);
      else resolveClosed();
    }
    function onAbort(): void {
      intentional = true;
      finish();
    }
    function deliver(event: HerdrEvent): void {
      if (finished) return;
      try {
        onEvent(event);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    function handle(frame: unknown): void {
      if (isRecord(frame)) {
        const error = errorFrom(frame);
        const id = frame['id'];
        if (error && (id === request.id || id === undefined || id === '')) return finish(error);
        if (id !== undefined && id !== '' && id !== request.id) return;
      }
      if (!ready) {
        if (isRecord(frame) && frame['id'] === request.id) {
          if (!isRecord(frame['result']) || frame['result']['type'] !== 'subscription_started') {
            return finish(new Error('herdr returned an invalid subscription acknowledgement'));
          }
          ready = true;
          clearTimeout(timer);
          socket.unref();
          resolve({ close(): void { intentional = true; finish(); }, closed });
          for (const event of pending.splice(0)) deliver(event);
          return;
        }
        if (pending.length >= MAX_PENDING_EVENTS) return finish(new Error('too many herdr events arrived before the acknowledgement'));
        if (isRecord(frame) && typeof frame['event'] === 'string') pending.push({ event: frame['event'], data: isRecord(frame['data']) ? frame['data'] : {} });
        return;
      }
      if (isRecord(frame) && typeof frame['event'] === 'string') deliver({ event: frame['event'], data: isRecord(frame['data']) ? frame['data'] : {} });
    }

    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(intentional ? undefined : new Error('herdr closed the subscription')));
    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      try {
        for (const frame of frames.push(chunk)) {
          if (finished) return;
          handle(frame);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string;
  focused: boolean;
  revision: number;
  cwd?: string;
  agent?: string;
  name?: string;
  agentStatus: AgentStatus;
  agentSessionId?: string;
  completionSeq?: number;
  terminalTitle?: string;
  label?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function agentStatus(value: unknown): AgentStatus | undefined {
  return typeof value === 'string' && AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : undefined;
}

/**
 * The text of a pane.read answer. herdr nests it: the frame is
 * `{type: 'pane_read', read: {pane_id, source, format, text}}`.
 */
export function paneText(result: unknown): { text: string; format: string | undefined } {
  if (typeof result === 'string') return { text: result, format: undefined };
  if (isRecord(result)) {
    const read = result['read'];
    if (isRecord(read) && typeof read['text'] === 'string') return { text: read['text'], format: optionalString(read['format']) };
    if (typeof result['text'] === 'string') return { text: result['text'], format: optionalString(result['format']) };
  }
  return { text: '', format: undefined };
}

/** Read the fields Bellwether needs, and nothing else, from a raw pane object. */
export function parsePane(value: unknown): HerdrPane | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = optionalString(value['pane_id']);
  const workspaceId = optionalString(value['workspace_id']);
  const tabId = optionalString(value['tab_id']);
  const terminalId = optionalString(value['terminal_id']);
  const status = agentStatus(value['agent_status']);
  if (!paneId || !workspaceId || !tabId || !terminalId || !status) return undefined;
  const session = isRecord(value['agent_session']) ? optionalString(value['agent_session']['value']) : undefined;
  return {
    paneId,
    workspaceId,
    tabId,
    terminalId,
    focused: value['focused'] === true,
    revision: optionalNumber(value['revision']) ?? 0,
    cwd: optionalString(value['foreground_cwd']) ?? optionalString(value['cwd']),
    agent: optionalString(value['agent']),
    name: optionalString(value['name']),
    agentStatus: status,
    agentSessionId: session,
    completionSeq: optionalNumber(value['completion_seq']),
    terminalTitle: optionalString(value['terminal_title_stripped']) ?? optionalString(value['terminal_title']),
    label: optionalString(value['label']),
  };
}

/** A thin typed wrapper over one herdr server, local or on a saved machine. */
export class HerdrClient {
  /** The local socket, or a `machine:` label for a client that dials a bridge. */
  readonly socketPath: string;
  private readonly endpoint: HerdrEndpoint;

  constructor(options: { session?: string; socketPath?: string; dial?: HerdrDialer; label?: string } = {}) {
    if (options.dial) {
      this.endpoint = options.dial;
      this.socketPath = options.label ?? 'machine';
    } else {
      this.socketPath = resolveSocketPath(options);
      this.endpoint = this.socketPath;
    }
  }

  request(method: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number; id?: string } = {}): Promise<unknown> {
    return requestHerdr(this.endpoint, { id: options.id ?? nextRequestId(), method, params }, options.signal, options.timeoutMs);
  }

  async agentList(signal?: AbortSignal): Promise<HerdrPane[]> {
    const result = await this.request('agent.list', {}, { signal });
    if (!isRecord(result) || !Array.isArray(result['agents'])) throw new Error('herdr returned an invalid agent list');
    return result['agents'].map(parsePane).filter((pane): pane is HerdrPane => pane !== undefined);
  }

  async paneList(signal?: AbortSignal): Promise<HerdrPane[]> {
    const result = await this.request('pane.list', {}, { signal });
    if (!isRecord(result) || !Array.isArray(result['panes'])) throw new Error('herdr returned an invalid pane list');
    return result['panes'].map(parsePane).filter((pane): pane is HerdrPane => pane !== undefined);
  }

  snapshot(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('session.snapshot', {}, { signal }).then((result) => (isRecord(result) ? result : {}));
  }

  tabCreate(params: { workspaceId?: string; cwd?: string; label?: string; env?: Record<string, string>; focus?: boolean }, signal?: AbortSignal): Promise<{ tabId?: string; paneId?: string }> {
    return this.request(
      'tab.create',
      {
        workspace_id: params.workspaceId ?? null,
        cwd: params.cwd ?? null,
        label: params.label ?? null,
        env: params.env ?? {},
        focus: params.focus ?? false,
      },
      { signal },
    ).then((result) => {
      if (!isRecord(result)) return {};
      const tab = isRecord(result['tab']) ? result['tab'] : undefined;
      // herdr answers with root_pane; keep the pane alias for older servers.
      const pane = isRecord(result['root_pane']) ? result['root_pane'] : isRecord(result['pane']) ? result['pane'] : undefined;
      return { tabId: optionalString(tab?.['tab_id']), paneId: optionalString(pane?.['pane_id']) };
    });
  }

  agentStart(params: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number }, signal?: AbortSignal): Promise<void> {
    return this.request('agent.start', { name: params.name, kind: params.kind, pane_id: params.paneId, args: params.args ?? [], timeout_ms: params.timeoutMs ?? null }, { signal }).then(() => undefined);
  }

  /**
   * A pane's screen, read in herdr's ANSI format so faint text, which a
   * harness draws for a suggestion, stays apart from content. A server that
   * answers in text leaves the screen unstyled, and the Screen says so.
   */
  async paneRead(params: { paneId: string; source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }, signal?: AbortSignal): Promise<Screen> {
    const result = await this.request('pane.read', { pane_id: params.paneId, source: params.source, lines: params.lines ?? null, format: 'ansi' }, { signal, timeoutMs: 8000 });
    const { text, format } = paneText(result);
    return parseScreen(text, format, (content) => detectModal(content) !== undefined);
  }

  agentPrompt(target: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.request('agent.prompt', { target, text }, { signal, timeoutMs: 12000 }).then(() => undefined);
  }

  sendKeys(target: string, keys: string[], signal?: AbortSignal): Promise<void> {
    return this.request('agent.send_keys', { target, keys }, { signal }).then(() => undefined);
  }

  /** Type text into a pane's terminal, then press keys, in one request. */
  sendInput(paneId: string, text: string, keys: string[], signal?: AbortSignal): Promise<void> {
    return this.request('pane.send_input', { pane_id: paneId, text, keys }, { signal }).then(() => undefined);
  }

  agentRename(target: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.request('agent.rename', { target, name }, { signal }).then(() => undefined);
  }

  paneClose(paneId: string, signal?: AbortSignal): Promise<void> {
    return this.request('pane.close', { pane_id: paneId }, { signal }).then(() => undefined);
  }

  tabClose(tabId: string, signal?: AbortSignal): Promise<void> {
    return this.request('tab.close', { tab_id: tabId }, { signal }).then(() => undefined);
  }

  /**
   * Create a workspace. herdr answers with the workspace, its first tab and
   * that tab's root pane, which already carries the env and cwd given here.
   */
  workspaceCreate(params: { label?: string; cwd?: string; env?: Record<string, string>; focus?: boolean }, signal?: AbortSignal): Promise<{ workspaceId?: string; label?: string; tabId?: string; paneId?: string }> {
    return this.request('workspace.create', { label: params.label ?? null, cwd: params.cwd ?? null, env: params.env ?? {}, focus: params.focus ?? false }, { signal }).then((result) => {
      if (!isRecord(result)) return {};
      const workspace = isRecord(result['workspace']) ? result['workspace'] : undefined;
      const tab = isRecord(result['tab']) ? result['tab'] : undefined;
      const pane = isRecord(result['root_pane']) ? result['root_pane'] : undefined;
      return { workspaceId: optionalString(workspace?.['workspace_id']), label: optionalString(workspace?.['label']), tabId: optionalString(tab?.['tab_id']), paneId: optionalString(pane?.['pane_id']) };
    });
  }

  workspaceClose(workspaceId: string, signal?: AbortSignal): Promise<void> {
    return this.request('workspace.close', { workspace_id: workspaceId }, { signal }).then(() => undefined);
  }

  /** The tabs of one workspace. herdr refuses a workspace it does not know with workspace_not_found. */
  tabList(workspaceId: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return this.request('tab.list', { workspace_id: workspaceId }, { signal }).then((result) => (isRecord(result) && Array.isArray(result['tabs']) ? (result['tabs'] as Record<string, unknown>[]) : []));
  }

  tabRename(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
    return this.request('tab.rename', { tab_id: tabId, label }, { signal }).then(() => undefined);
  }

  workspaceList(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return this.request('workspace.list', {}, { signal }).then((result) => (isRecord(result) && Array.isArray(result['workspaces']) ? (result['workspaces'] as Record<string, unknown>[]) : []));
  }

  paneCurrent(signal?: AbortSignal): Promise<HerdrPane | undefined> {
    return this.request('pane.current', {}, { signal }).then((result) => (isRecord(result) ? parsePane(result['pane']) : undefined));
  }

  subscribe(subscriptions: Record<string, unknown>[], onEvent: (event: HerdrEvent) => void, signal: AbortSignal, timeoutMs?: number): Promise<Subscription> {
    return openHerdrSubscription(this.endpoint, { id: nextRequestId('sub'), method: 'events.subscribe', params: { subscriptions } }, onEvent, signal, timeoutMs);
  }
}
