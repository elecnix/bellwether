// A fake herdr server: a Unix socket that speaks the real newline-delimited
// JSON protocol, validates each request against the method table, and lets a
// test drive the frames it sends back. It never touches the live socket.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateRequest } from './herdr-methods.ts';

export interface RecordedRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface FakeHerdrOptions {
  /**
   * Take over the acknowledgement for `events.subscribe`, so a test can write
   * the ack and an event in one chunk. Return true when it answered.
   */
  subscribe?: (socket: net.Socket, request: RecordedRequest) => boolean;
  /**
   * Answer one request in place of the default: a result, or an error with a
   * code. Return undefined to fall through to the default answer.
   */
  respond?: (request: RecordedRequest) => { result: unknown } | { error: { code: string; message: string } } | undefined;
  /** Wait this long before each answer, as a busy herdr would. */
  delayMs?: number;
  /** The status herdr reports after it detects a typed start: idle by default, or null for none. */
  statusAfterStart?: string | null;
}

export interface FakeHerdr {
  readonly socketPath: string;
  readonly requests: RecordedRequest[];
  readonly connectionCount: number;
  /** Send one frame to every open connection, newline terminated. */
  send(frame: unknown): void;
  /** Send raw bytes to every open connection. */
  sendRaw(text: string): void;
  /** Drop every open connection. */
  hangUp(): void;
  /** Stop listening and remove the socket and its directory. */
  stop(): Promise<void>;
  /** Resolve once a request for this method has been recorded. */
  waitFor(method: string, timeoutMs?: number): Promise<RecordedRequest>;
}

function defaultResult(request: RecordedRequest): unknown {
  switch (request.method) {
    case 'events.subscribe':
      return { type: 'subscription_started' };
    case 'agent.list':
      return { type: 'agent_list', agents: [] };
    case 'pane.list':
      return { type: 'pane_list', panes: [] };
    case 'session.snapshot':
      return { type: 'session_snapshot', snapshot: { panes: [], agents: [] } };
    case 'tab.create':
      return { type: 'tab_created', tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: 'w1:p1' } };
    case 'agent.start':
      return { type: 'agent_started' };
    case 'pane.read':
      return { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'recent', format: 'text', text: 'screen' } };
    case 'agent.prompt':
      return { type: 'agent_prompted' };
    case 'workspace.list':
      return { type: 'workspace_list', workspaces: [] };
    case 'workspace.create': {
      const label = typeof request.params['label'] === 'string' ? request.params['label'] : '1';
      return { type: 'workspace_created', workspace: { workspace_id: 'w2', label, tab_count: 1 }, tab: { tab_id: 'w2:t1', workspace_id: 'w2', label: '1' }, root_pane: { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' } };
    }
    case 'tab.list':
      return { type: 'tab_list', tabs: [] };
    case 'integration.list':
      // herdr lists every integration it has; these two report pi and Claude Code sessions.
      return { type: 'integration_list', integrations: [{ target: 'pi', label: 'pi', command: 'pi', available: true, state: 'current' }, { target: 'claude', label: 'claude', command: 'claude', available: true, state: 'current' }] };
    default:
      return { type: 'ok' };
  }
}

/** One harness start a test asked herdr for: agent.start, or a bare launch line typed at the shell prompt. */
export interface HarnessStartRequest {
  request: RecordedRequest;
  paneId: string;
  kind: string;
  args: string[];
  /** How it started: herdr's agent.start, or a line typed behind `command`. */
  via: 'agent.start' | 'typed';
}

/**
 * Split a typed line into words, for the quoting `launchLine` writes: plain
 * words and single-quoted words with `'\''` for a quote.
 */
function typedWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === '\\' && index + 1 < line.length) {
      index += 1;
      word += line[index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The harness start a request makes, or undefined for any other request. */
export function harnessStart(request: RecordedRequest): HarnessStartRequest | undefined {
  const paneId = String(request.params['pane_id'] ?? '');
  if (request.method === 'agent.start') {
    const args = Array.isArray(request.params['args']) ? (request.params['args'] as string[]) : [];
    return { request, paneId, kind: String(request.params['kind']), args, via: 'agent.start' };
  }
  if (request.method !== 'pane.send_input') return undefined;
  const keys = Array.isArray(request.params['keys']) ? (request.params['keys'] as unknown[]) : [];
  if (!keys.includes('Enter') || typeof request.params['text'] !== 'string') return undefined;
  const words = typedWords(request.params['text']);
  if (words[0] !== 'command' || !words[1]) return undefined;
  return { request, paneId, kind: words[1] as string, args: words.slice(2), via: 'typed' };
}

/** What herdr was asked to type into one pane with agent.prompt, in order. */
export function prompted(fake: Pick<FakeHerdr, 'requests'>, paneId: string): string[] {
  return fake.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === paneId).map((request) => String(request.params['text']));
}

/** Every harness start the fake herdr received, in order. */
export function harnessStarts(fake: Pick<FakeHerdr, 'requests'>): HarnessStartRequest[] {
  return fake.requests.map(harnessStart).filter((start): start is HarnessStartRequest => start !== undefined);
}

/**
 * herdr types an agent's arguments into the pane's shell, and refuses one it
 * cannot quote for that shell. A line break is the case Bellwether met.
 */
function refuseUnsafeArguments(request: RecordedRequest): { error: { code: string; message: string } } | undefined {
  if (request.method !== 'agent.start') return undefined;
  const args = Array.isArray(request.params['args']) ? (request.params['args'] as unknown[]) : [];
  if (!args.some((arg) => typeof arg === 'string' && /[\r\n]/.test(arg))) return undefined;
  return { error: { code: 'invalid_agent_argument', message: 'herdr agent arguments cannot be encoded safely for the target shell' } };
}

export async function startFakeHerdr(options: FakeHerdrOptions = {}): Promise<FakeHerdr> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-fake-'));
  const socketPath = path.join(root, 'herdr.sock');
  const requests: RecordedRequest[] = [];
  const connections = new Set<net.Socket>();
  let seen = 0;

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
        const request: RecordedRequest = {
          id: typeof parsed.id === 'string' ? parsed.id : '',
          method: typeof parsed.method === 'string' ? parsed.method : '',
          params: typeof parsed.params === 'object' && parsed.params !== null ? (parsed.params as Record<string, unknown>) : {},
        };
        requests.push(request);
        seen += 1;

        if (request.method === 'events.subscribe' && options.subscribe?.(socket, request)) continue;

        const invalid = validateRequest(request.method, request.params);
        if (invalid) {
          socket.write(`${JSON.stringify({ id: request.id, error: { code: 'invalid_request', message: invalid } })}\n`);
          continue;
        }
        const own = options.respond?.(request);
        const answer = own ?? refuseUnsafeArguments(request) ?? { result: defaultResult(request) };
        const reply = `${JSON.stringify({ id: request.id, ...answer })}\n`;
        // herdr finds a harness typed at a shell prompt by its process, says
        // so, and then reports the harness at its prompt.
        const typed = own === undefined ? harnessStart(request) : undefined;
        if (typed?.via === 'typed') {
          const workspace = typed.paneId.split(':')[0];
          const emit = (frame: unknown): void => {
            for (const open of connections) open.write(`${JSON.stringify(frame)}\n`);
          };
          setTimeout(() => emit({ event: 'pane_agent_detected', data: { pane_id: typed.paneId, agent: typed.kind, workspace_id: workspace } }), 20);
          if (options.statusAfterStart !== null) setTimeout(() => emit({ event: 'pane_agent_status_changed', data: { pane_id: typed.paneId, agent: typed.kind, workspace_id: workspace, agent_status: options.statusAfterStart ?? 'idle' } }), 40);
        }
        if (options.delayMs) setTimeout(() => !socket.destroyed && socket.write(reply), options.delayMs);
        else socket.write(reply);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    requests,
    get connectionCount(): number {
      return connections.size;
    },
    send(frame: unknown): void {
      const line = `${JSON.stringify(frame)}\n`;
      for (const socket of connections) socket.write(line);
    },
    sendRaw(text: string): void {
      for (const socket of connections) socket.write(text);
    },
    hangUp(): void {
      for (const socket of connections) socket.destroy();
    },
    async stop(): Promise<void> {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
    async waitFor(method: string, timeoutMs = 2000): Promise<RecordedRequest> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = requests.find((request) => request.method === method);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`the fake herdr never saw a ${method} request`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}
