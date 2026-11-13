// Tier 2: the daemon over a real Unix socket. A fake service factory stands in
// for herdr, so the cases cover only what the daemon owns: one service per
// parent, events pushed to every attached client, receipts, replay after a
// reconnect, bye, drain and the idle exit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DaemonClient } from '../../src/daemon/client.ts';
import { DAEMON_PROTOCOL } from '../../src/daemon/protocol.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import type { OutboxEntry } from '../../src/core/types.ts';

interface FakeService extends ParentService {
  emit(entries: OutboxEntry[]): void;
  calls: { tool: string; args: Record<string, unknown> }[];
  read: string[];
  stopped: boolean;
}

function entry(childId: string, event: OutboxEntry['event']): OutboxEntry {
  return { receipt: `bw-${childId}-${event}`, childId, name: childId, kind: 'pi', paneId: 'w1:p1', event, text: 'text', at: new Date(0).toISOString(), read: false };
}

/** A factory whose services share one pending list, so a reconnect replays it. */
function fakeFactory(): { factory: ServiceFactory; services: FakeService[]; emit: (entries: OutboxEntry[]) => void } {
  const pending = new Set<OutboxEntry>();
  const services: FakeService[] = [];
  const handlers = new Set<(entries: OutboxEntry[]) => void>();
  const build = (): FakeService => {
    const service: FakeService = {
      calls: [],
      read: [],
      stopped: false,
      pending: () => [...pending],
      async tool(name, args) {
        service.calls.push({ tool: name, args });
        if (name === 'agent_list') return 'two children';
        throw new Error(`no tool ${name}`);
      },
      markRead(receipts) {
        service.read.push(...receipts);
        for (const receipt of receipts) for (const item of pending) if (item.receipt === receipt) pending.delete(item);
      },
      onEvents(handler) {
        handlers.add(handler);
      },
      watchPane(_paneId, _handler) {
        return () => {};
      },
      stop() {
        service.stopped = true;
      },
      emit(entries) {
        handlers.add(() => {});
        for (const item of entries) pending.add(item);
        for (const handler of handlers) handler(entries);
      },
    };
    services.push(service);
    return service;
  };
  return {
    factory: () => build(),
    services,
    emit: (entries) => {
      for (const service of services) service.emit(entries);
    },
  };
}

function workspace(): { home: string; socket: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-daemon-'));
  const socket = path.join(home, 'daemon.sock');
  return { home, socket, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function parent(name = 'session-1'): { harness: 'pi'; session: string; cwd: string; host: string; depth: number; herdrSocket: string } {
  return { harness: 'pi', session: name, cwd: '/tmp', host: 'machine', depth: 0, herdrSocket: '/tmp/herdr.sock' };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('two clients of one parent share one service', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const first = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  const second = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  assert.equal(first.parentId, second.parentId);
  assert.equal(first.pid, daemon.pid);
  assert.equal(fake.services.length, 1);
  await first.close();
  await second.close();
  await daemon.close();
  space.cleanup();
});

test('a tool call returns its text, and a failure returns its message', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  assert.equal(await client.tool('agent_list', {}), 'two children');
  await assert.rejects(() => client.tool('agent_stop', { child: 'one' }), /no tool agent_stop/);
  assert.deepEqual(fake.services[0]?.calls.map((call) => call.tool), ['agent_list', 'agent_stop']);
  await client.close();
  await daemon.close();
  space.cleanup();
});

test('an event reaches every client of the parent, and a receipt marks it read', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const first = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  const second = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  const seen: OutboxEntry[][] = [];
  first.onEvents((entries) => seen.push(entries));
  second.onEvents((entries) => seen.push(entries));
  fake.emit([entry('c1', 'idle')]);
  await until(() => seen.length === 2);
  first.receipts(['bw-c1-idle']);
  await until(() => fake.services[0]?.read.includes('bw-c1-idle') === true);
  await first.close();
  await second.close();
  await daemon.close();
  space.cleanup();
});

test('a client that reconnects receives what it missed', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const first = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  fake.emit([entry('c1', 'report')]);
  await first.close();
  const second = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  const pending = await second.pending();
  assert.deepEqual(pending.map((item) => item.receipt), ['bw-c1-report']);
  await second.close();
  await daemon.close();
  space.cleanup();
});

test('the last bye stops the parent service, and a reconnect builds a new one', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const first = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  await first.close();
  await until(() => fake.services[0]?.stopped === true);
  const second = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  assert.equal(fake.services.length, 2);
  await second.close();
  await daemon.close();
  space.cleanup();
});

test('drain closes the daemon and its socket', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  await client.drain();
  await until(() => !fs.existsSync(space.socket));
  assert.equal(daemon.closed, true);
  await daemon.close();
  space.cleanup();
});

test('the daemon exits when idle past its threshold', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory, idleMs: 50, idleCheckMs: 10 });
  const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  await client.close();
  await until(() => daemon.closed, 2000);
  await daemon.close();
  space.cleanup();
});

test('a hello with another protocol is refused and names the daemon protocol', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const socket = net.createConnection(space.socket);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  let reply = '';
  socket.on('data', (chunk) => { reply += chunk.toString('utf8'); });
  socket.write(`${JSON.stringify({ type: 'hello', protocol: DAEMON_PROTOCOL + 1, client: '9', parent: parent() })}\n`);
  await until(() => reply.includes('protocol_mismatch'));
  const parsed = JSON.parse(reply.trim()) as { type: string; code: string; protocol: number };
  assert.equal(parsed.code, 'protocol_mismatch');
  assert.equal(parsed.protocol, DAEMON_PROTOCOL);
  socket.destroy();
  await daemon.close();
  space.cleanup();
});
