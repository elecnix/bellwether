// Tier 2: a client and a daemon of different versions keep working together.
// An older client uses a newer daemon, a newer client speaks down to an older
// daemon it does not replace and has the operations it lacks refused by name,
// and neither side treats a reply it does not know as fatal. Every daemon
// here listens on a socket under a scratch home: the real one in process, the
// others scripted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DaemonClient, postReport } from '../../src/daemon/client.ts';
import { FEATURES } from '../../src/daemon/features.ts';
import { DAEMON_PROTOCOL } from '../../src/daemon/protocol.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import type { OutboxEntry } from '../../src/core/types.ts';

function parent(): { harness: 'pi'; session: string; cwd: string; host: string; depth: number; herdrSocket: string } {
  return { harness: 'pi', session: 'session-compat', cwd: '/tmp', host: 'machine', depth: 0, herdrSocket: '/tmp/herdr.sock' };
}

function workspace(): { home: string; socket: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-compat-'));
  return { home, socket: path.join(home, 'daemon.sock'), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function entry(childId: string): OutboxEntry {
  return { receipt: `bw-${childId}-done`, childId, name: childId, kind: 'pi', paneId: 'w1:p1', event: 'report', text: 'text', at: new Date(0).toISOString(), read: false };
}

/** A service that answers every tool by name and records what reached it. */
function recordingFactory(): { factory: ServiceFactory; tools: string[]; receipts: string[]; watched: string[] } {
  const seen = { tools: [] as string[], receipts: [] as string[], watched: [] as string[] };
  const factory: ServiceFactory = () => {
    const service: ParentService = {
      pending: () => [],
      async tool(name) {
        seen.tools.push(name);
        return `ran ${name}`;
      },
      markRead(receipts) {
        seen.receipts.push(...receipts);
      },
      onEvents() {},
      watchPane(paneId) {
        seen.watched.push(paneId);
        return () => {};
      },
      stop() {},
    };
    return service;
  };
  return { factory, ...seen };
}

interface ScriptedDaemon {
  /** The protocol each hello offered, in order. */
  hellos: number[];
  drained: () => boolean;
  close: () => Promise<void>;
}

/**
 * A daemon from another release, scripted. It serves `min` to `protocol` and
 * refuses any other hello the way that release would: a release before 0.1.5
 * sends no range or version with the refusal. It answers the tools it has,
 * and answers any other tool as a 0.1.4 daemon does, by its text alone.
 */
async function scriptedDaemon(
  socketPath: string,
  options: { protocol: number; min?: number; version?: string; range?: boolean; tools: string[]; afterHello?: string[]; beforeHello?: string[]; answer?: (tool: string, id: string) => string | undefined },
): Promise<ScriptedDaemon> {
  const hellos: number[] = [];
  let drained = false;
  const open = new Set<net.Socket>();
  const min = options.min ?? options.protocol;
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, index)) as { type: string; protocol?: number; id?: string; tool?: string };
        buffer = buffer.slice(index + 1);
        if (request.type === 'hello') {
          const offered = request.protocol ?? 0;
          hellos.push(offered);
          if (offered < min || offered > options.protocol) {
            const range = options.range ? { minProtocol: min, version: options.version } : {};
            socket.end(`${JSON.stringify({ type: 'error', code: 'protocol_mismatch', message: 'the client spoke another protocol', protocol: options.protocol, ...range })}\n`);
            continue;
          }
          const lines = [...(options.beforeHello ?? []), JSON.stringify({ type: 'hello', protocol: options.protocol, parentId: 'pi-compat', pid: 4242, pending: [], ...(options.version ? { version: options.version } : {}) }), ...(options.afterHello ?? [])];
          socket.write(`${lines.join('\n')}\n`);
        }
        if (request.type === 'call' && request.id && request.tool) {
          const scripted = options.answer?.(request.tool, request.id);
          if (scripted) socket.write(`${scripted}\n`);
          else if (options.tools.includes(request.tool)) socket.write(`${JSON.stringify({ type: 'result', id: request.id, text: `ran ${request.tool}` })}\n`);
          else socket.write(`${JSON.stringify({ type: 'result', id: request.id, error: `Bellwether has no tool named ${request.tool}` })}\n`);
        }
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
    hellos,
    drained: () => drained,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}

const toolsUpTo = (protocol: number): string[] => FEATURES.filter((feature) => feature.kind === 'tool' && feature.protocol <= protocol).map((feature) => feature.name);

test('a client on the previous protocol uses a newer daemon: every verb it knows works', async () => {
  const space = workspace();
  const recorded = recordingFactory();
  const daemon = await startDaemon({ socketPath: space.socket, factory: recorded.factory });
  try {
    const old = await DaemonClient.connect(parent(), { home: space.home, spawn: false, identity: { version: '0.1.3', protocol: DAEMON_PROTOCOL - 1 } });
    assert.equal(old.spoken, DAEMON_PROTOCOL - 1);
    for (const tool of toolsUpTo(DAEMON_PROTOCOL - 1)) assert.equal(await old.tool(tool, {}), `ran ${tool}`);
    old.receipts(['bw-c1-done']);
    old.watchPane('w1:p9', () => {});
    const until = Date.now() + 2_000;
    while ((!recorded.receipts.length || !recorded.watched.length) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(recorded.receipts, ['bw-c1-done']);
    assert.deepEqual(recorded.watched, ['w1:p9']);
    await old.close();
  } finally {
    await daemon.close();
    space.cleanup();
  }
});

test('a client speaks down to an older daemon it does not replace, and names each operation that daemon lacks', async () => {
  const space = workspace();
  const old = await scriptedDaemon(space.socket, {
    protocol: DAEMON_PROTOCOL - 1,
    version: '0.1.4',
    tools: toolsUpTo(DAEMON_PROTOCOL - 1),
    // A 0.1.4 daemon checks agent_restart's missing child before it notices the tool is unknown.
    answer: (tool, id) => (tool === 'agent_restart' ? JSON.stringify({ type: 'result', id, error: 'agent_restart needs a child' }) : undefined),
  });
  const log: string[] = [];
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false, log: (line) => log.push(line) });
    assert.deepEqual(old.hellos, [DAEMON_PROTOCOL, DAEMON_PROTOCOL - 1], 'the client tried its own protocol first, then the daemon\'s');
    assert.equal(client.spoken, DAEMON_PROTOCOL - 1);
    assert.equal(await client.tool('agent_list', {}), 'ran agent_list');
    await assert.rejects(client.tool('agent_move', { child: 'c1' }), (error: Error) => {
      assert.equal(error.message, '`agent_move` needs protocol 4 (Bellwether 0.1.5); this daemon serves protocol 3 (Bellwether 0.1.4). Upgrade the machine holding the daemon when convenient. Every other tool keeps working.');
      return true;
    });
    await assert.rejects(client.tool('agent_restart', {}), /^Error: `agent_restart` needs protocol 4 \(Bellwether 0\.1\.5\)/);
    // A refused operation leaves the session working.
    assert.equal(await client.tool('agent_spawn', {}), 'ran agent_spawn');
    assert.equal(old.drained(), false);
    assert.equal(log.filter((line) => line.includes('speaking 3')).length, 1);
    await client.close();
  } finally {
    await old.close();
    space.cleanup();
  }
});

test('a build on this protocol that lacks a tool is named from its fixed refusal text, not guessed from its version', async () => {
  const space = workspace();
  const build = await scriptedDaemon(space.socket, { protocol: DAEMON_PROTOCOL, version: '0.1.4', tools: ['agent_list'] });
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
    assert.equal(await client.tool('agent_list', {}), 'ran agent_list');
    await assert.rejects(client.tool('agent_move', { child: 'c1' }), /^Error: `agent_move` needs Bellwether 0\.1\.5 \(protocol 4\); this daemon is an earlier build on protocol 4 \(Bellwether 0\.1\.4\)\. Upgrade the machine holding the daemon when convenient\./);
    await client.close();
  } finally {
    await build.close();
    space.cleanup();
  }
});

test('a newer client against this daemon is refused by name for a tool this daemon does not have', async () => {
  const space = workspace();
  const daemon = await startDaemon({
    socketPath: space.socket,
    factory: () => ({ pending: () => [], tool: async (name) => { throw new (await import('../../src/integrations/tools.ts')).UnknownTool(name); }, markRead() {}, onEvents() {}, watchPane: () => () => {}, stop() {} }),
  });
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false });
    assert.ok(client.offer?.features?.includes('agent_move'), 'the daemon lists what it serves in its hello');
    await assert.rejects(client.tool('agent_clone', {}), /^Error: `agent_clone` is not served by the running daemon; this daemon serves protocol \d+/);
    await client.close();
  } finally {
    await daemon.close();
    space.cleanup();
  }
});

test('a reply type, a field or a line the client does not know is logged once and ignored', async () => {
  const space = workspace();
  const future = JSON.stringify({ type: 'telemetry', load: 1 });
  const old = await scriptedDaemon(space.socket, {
    protocol: DAEMON_PROTOCOL + 1,
    min: DAEMON_PROTOCOL,
    version: '9.0.0',
    tools: ['agent_list'],
    beforeHello: [JSON.stringify({ type: 'banner', text: 'hi' })],
    afterHello: [future, future, 'not json', JSON.stringify({ type: 'events', entries: [{ ...entry('c1'), mood: 'new field' }], shard: 2 }), JSON.stringify({ type: 'events' })],
    answer: (tool, id) => (tool === 'agent_adopt' ? JSON.stringify({ type: 'error', id, code: 'busy', message: 'try later' }) : undefined),
  });
  const log: string[] = [];
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, spawn: false, log: (line) => log.push(line) });
    const until = Date.now() + 2_000;
    while (client.unread().length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(client.unread().map((item) => item.receipt), ['bw-c1-done']);
    assert.equal(await client.tool('agent_list', {}), 'ran agent_list');
    // An error reply that names the call fails it at once, not at the call's timeout.
    const started = Date.now();
    await assert.rejects(client.tool('agent_adopt', {}), /busy: try later/);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(log.filter((line) => line.includes('"telemetry"')).length, 1, log.join('\n'));
    assert.equal(log.filter((line) => line.includes('"banner"')).length, 1, log.join('\n'));
    await client.close();
  } finally {
    await old.close();
    space.cleanup();
  }
});

test('a daemon that refuses the session gets an error quoting the range it serves and the install to update', async () => {
  const space = workspace();
  const newer = await scriptedDaemon(space.socket, { protocol: DAEMON_PROTOCOL + 2, min: DAEMON_PROTOCOL + 1, version: '9.0.0', range: true, tools: [] });
  try {
    await assert.rejects(DaemonClient.connect(parent(), { home: space.home, spawn: false }), (error: Error) => {
      assert.match(error.message, new RegExp(`\\(Bellwether 9\\.0\\.0\\) serves protocols ${DAEMON_PROTOCOL + 1} to ${DAEMON_PROTOCOL + 2}`));
      assert.match(error.message, /Update the Bellwether install at .+, then start this session again\./);
      assert.doesNotMatch(error.message, /newer than this client/);
      return true;
    });
    assert.equal(newer.drained(), false);
  } finally {
    await newer.close();
    space.cleanup();
  }
});

test('a client that cannot order its release against the daemon\'s leaves the daemon alone and speaks its protocol', async () => {
  const space = workspace();
  // Spawning is allowed, so a daemon the client could order as older would be drained.
  const entry = path.join(space.home, 'noop.mjs');
  fs.writeFileSync(entry, '');
  const old = await scriptedDaemon(space.socket, { protocol: DAEMON_PROTOCOL - 1, version: 'dev-build', range: true, tools: toolsUpTo(DAEMON_PROTOCOL - 1) });
  try {
    const client = await DaemonClient.connect(parent(), { home: space.home, entry });
    assert.equal(old.drained(), false);
    assert.equal(client.spoken, DAEMON_PROTOCOL - 1);
    assert.equal(await client.tool('agent_list', {}), 'ran agent_list');
    await client.close();
  } finally {
    await old.close();
    space.cleanup();
  }
});

/** A daemon that answers report requests only, on the protocols it lists, or not at all when it lists none. */
async function reportDaemon(socketPath: string, protocols: number[]): Promise<{ offered: number[]; close: () => Promise<void> }> {
  const offered: number[] = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8').split('\n')[0] ?? '{}') as { type: string; protocol: number; id: string };
      offered.push(request.protocol);
      if (!protocols.length) socket.end(`${JSON.stringify({ type: 'error', code: 'unknown_type', message: 'unknown request type "report"' })}\n`);
      else if (!protocols.includes(request.protocol)) socket.end(`${JSON.stringify({ type: 'error', code: 'protocol_mismatch', message: 'the report spoke another protocol', protocol: Math.max(...protocols) })}\n`);
      else socket.end(`${JSON.stringify({ type: 'result', id: request.id, text: 'taken' })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { offered, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('a report speaks down to an older daemon that has the report request, and names the request to one that lacks it', async () => {
  const space = workspace();
  const report = { childId: 'c1', status: 'done' as const, text: 'finished' };
  const older = await reportDaemon(space.socket, [DAEMON_PROTOCOL - 1]);
  try {
    assert.equal((await postReport(report, { home: space.home, socketPath: space.socket, spawn: false })).text, 'taken');
    assert.deepEqual(older.offered, [DAEMON_PROTOCOL, DAEMON_PROTOCOL - 1]);
  } finally {
    await older.close();
  }
  fs.writeFileSync(path.join(space.home, 'daemon.lock'), `${JSON.stringify({ pid: process.pid, startedAt: 0, protocol: 2, version: '0.1.3', socket: space.socket })}\n`);
  const oldest = await reportDaemon(space.socket, []);
  try {
    await assert.rejects(postReport(report, { home: space.home, socketPath: space.socket, spawn: false }), /^Error: `report` needs protocol 3 \(Bellwether 0\.1\.4\); this daemon serves protocol 2 \(Bellwether 0\.1\.3\)/);
  } finally {
    await oldest.close();
    space.cleanup();
  }
});
