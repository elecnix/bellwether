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
    default:
      return { type: 'ok' };
  }
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
        socket.write(`${JSON.stringify({ id: request.id, result: defaultResult(request) })}\n`);
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
