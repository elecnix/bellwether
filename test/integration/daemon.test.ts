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
import { DaemonClient, drainDaemon, startDaemonProcess } from '../../src/daemon/client.ts';
import { describeDaemonEntry, readLock } from '../../src/daemon/lock.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { BELLWETHER_VERSION } from '../../src/core/version.ts';
import { DAEMON_PROTOCOL } from '../../src/daemon/protocol.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import type { CallerIdentity, OutboxEntry } from '../../src/core/types.ts';

interface FakeService extends ParentService {
  emit(entries: OutboxEntry[]): void;
  calls: { tool: string; args: Record<string, unknown>; caller?: CallerIdentity }[];
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
      async tool(name, args, caller) {
        service.calls.push({ tool: name, args, caller });
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

test('every call carries the caller identity from the client hello', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const client = await DaemonClient.connect({ ...parent('child-session'), paneId: 'w1:p4', childId: 'kid-1' }, { home: space.home, spawn: false });
  await client.tool('agent_list', {});
  assert.deepEqual(fake.services[0]?.calls[0]?.caller, { childId: 'kid-1', paneId: 'w1:p4' });
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

test('an entry the daemon settled arrives read, and the client drops it rather than resending it', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
  const seen: OutboxEntry[][] = [];
  client.onEvents((entries) => seen.push(entries));
  const blocked = entry('c1', 'blocked');
  fake.emit([blocked]);
  await until(() => client.unread().length === 1);
  // The child moved on before the parent read the dialog.
  fake.emit([{ ...blocked, read: true, supersededBy: 'state:working' }, entry('c2', 'idle')]);
  await until(() => seen.length === 2);
  assert.deepEqual(client.unread().map((item) => item.receipt), ['bw-c2-idle']);
  assert.deepEqual(seen[1]?.map((item) => item.receipt), ['bw-c2-idle']);
  await client.close();
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

test('bellwether drain stops a running daemon, and reports when none answers', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  assert.equal(await drainDaemon(space.socket), true);
  assert.equal(daemon.closed, true);
  assert.equal(await drainDaemon(space.socket), false);
  await daemon.close();
  space.cleanup();
});

test('the daemon lock records the package version and protocol', async () => {
  const space = workspace();
  const fake = fakeFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: fake.factory });
  const lock = readLock(space.home);
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(lock?.version, manifest.version);
  assert.equal(BELLWETHER_VERSION, manifest.version);
  assert.equal(lock?.protocol, DAEMON_PROTOCOL);
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

/** A daemon from an older release: it refuses a newer hello and closes on drain. */
async function olderDaemon(socketPath: string, protocol: number): Promise<{ drained: () => boolean; close: () => Promise<void> }> {
  let drained = false;
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, index)) as { type: string };
        buffer = buffer.slice(index + 1);
        if (request.type === 'hello') socket.write(`${JSON.stringify({ type: 'error', code: 'protocol_mismatch', message: 'the client spoke another protocol', protocol })}\n`);
        if (request.type === 'drain') {
          drained = true;
          socket.end(`${JSON.stringify({ type: 'closed' })}\n`);
          server.close();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    drained: () => drained,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}

test('a client newer than the running daemon drains it and starts its own', async () => {
  const space = workspace();
  const old = await olderDaemon(space.socket, DAEMON_PROTOCOL - 1);
  // The replacement comes up in-process once the old one is gone; the entry the
  // client would spawn does nothing, so no detached daemon outlives the case.
  const entry = path.join(space.home, 'noop.mjs');
  fs.writeFileSync(entry, '');
  const fake = fakeFactory();
  let replacement: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const watcher = setInterval(() => {
    if (old.drained() && !replacement && !fs.existsSync(space.socket)) {
      void startDaemon({ socketPath: space.socket, factory: fake.factory }).then((started) => (replacement = started));
    }
  }, 10);
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, entry });
    assert.equal(old.drained(), true, 'the older daemon was asked to drain');
    assert.equal(client.pid, replacement?.pid);
    await client.close();
  } finally {
    clearInterval(watcher);
    await old.close();
    await replacement?.close();
    space.cleanup();
  }
});

test('a client older than the running daemon leaves it alone and says so', async () => {
  const space = workspace();
  const newer = await olderDaemon(space.socket, DAEMON_PROTOCOL + 1);
  try {
    await assert.rejects(DaemonClient.connect(parent(), { home: space.home, spawn: false }), /newer than this client/);
    assert.equal(newer.drained(), false);
  } finally {
    await newer.close();
    space.cleanup();
  }
});

test('a daemon started from a checkout records the checkout entry point in its lock', async () => {
  const space = workspace();
  try {
    await startDaemonProcess(space.home, space.socket);
    const lock = readLock(space.home);
    // From the sources, the client starts src/daemon/main.ts beside itself, in this repository's working tree.
    assert.equal(lock?.entry, fs.realpathSync(new URL('../../src/daemon/main.ts', import.meta.url)));
    assert.equal(lock?.origin, 'checkout');
    assert.equal(lock?.version, BELLWETHER_VERSION);
    assert.equal(lock?.protocol, DAEMON_PROTOCOL);
  } finally {
    await drainDaemon(space.socket);
    await stopDaemonsUnder(space.home);
    space.cleanup();
  }
});

test('the lock tells a package entry point from a checkout one', async () => {
  const space = workspace();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-origin-'));
  try {
    const checkout = path.join(scratch, 'repo');
    fs.mkdirSync(path.join(checkout, 'dist', 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), '{}');
    // A worktree has .git as a file.
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: elsewhere\n');
    const installed = path.join(scratch, 'lib', 'node_modules', '@elecnix', 'bellwether');
    fs.mkdirSync(path.join(installed, 'dist', 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{}');
    // A symbolic link, like the bin link a package manager writes, resolves to the real file.
    const linked = path.join(scratch, 'linked-main.js');
    fs.writeFileSync(path.join(installed, 'dist', 'daemon', 'main.js'), '');
    fs.symlinkSync(path.join(installed, 'dist', 'daemon', 'main.js'), linked);

    const fake = fakeFactory();
    const fromCheckout = await startDaemon({ socketPath: space.socket, factory: fake.factory, entry: path.join(checkout, 'dist', 'daemon', 'main.js') });
    assert.deepEqual([readLock(space.home)?.entry, readLock(space.home)?.origin], [path.join(fs.realpathSync(checkout), 'dist', 'daemon', 'main.js'), 'checkout']);
    await fromCheckout.close();

    const fromPackage = await startDaemon({ socketPath: space.socket, factory: fake.factory, entry: linked });
    assert.deepEqual([readLock(space.home)?.entry, readLock(space.home)?.origin], [fs.realpathSync(path.join(installed, 'dist', 'daemon', 'main.js')), 'package']);
    await fromPackage.close();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    space.cleanup();
  }
});

test('a lock an older daemon wrote still reads, with no entry point', () => {
  const space = workspace();
  try {
    fs.mkdirSync(space.home, { recursive: true });
    fs.writeFileSync(path.join(space.home, 'daemon.lock'), `${JSON.stringify({ pid: 4242, startedAt: 1, protocol: 3, socket: space.socket })}\n`);
    assert.deepEqual(readLock(space.home), { pid: 4242, startedAt: 1, protocol: 3, socket: space.socket });
    assert.match(describeDaemonEntry(readLock(space.home), '/somewhere/dist/daemon/main.js'), /^info {2}daemon entry: not recorded/);
  } finally {
    space.cleanup();
  }
});

test('doctor says whether the running daemon is the copy this command runs', () => {
  const own = fs.realpathSync(new URL('../../src/daemon/main.ts', import.meta.url));
  const base = { pid: 1, startedAt: 1, protocol: DAEMON_PROTOCOL, socket: '/s' };
  assert.match(describeDaemonEntry({ ...base, entry: own, origin: 'checkout' }, own), /^ok {4}daemon entry: .*main\.ts \(a git checkout\), the one this command runs$/);
  const other = '/home/linuxbrew/.linuxbrew/lib/node_modules/@elecnix/bellwether/dist/daemon/main.js';
  const line = describeDaemonEntry({ ...base, entry: other, origin: 'package' }, own);
  assert.match(line, /^info {2}daemon entry: \/home\/linuxbrew\/.*main\.js \(an installed package\), not this command's .*main\.ts \(a git checkout\)/);
});
