// Tier 2: a parent's message to a child on another machine (issue #140). Two
// machines are two Bellwether homes in one temporary root, joined by the fake
// ssh, as in remote-report.test.ts. The parent's daemon runs in this process.
// The child's machine runs its own daemon, which `bellwether relay-bridge`
// starts there, and the child's own Claude Code channel server runs as a
// process against that daemon. herdr on the child's machine is a fake that
// records every agent.prompt, so a case knows whether anything was typed into
// the far pane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, readRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildMessage, ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient, daemonSessions } from '../../src/daemon/client.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { installFakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const channelServer = path.join(here, '..', '..', 'bin', 'bellwether-mcp.js');

const PARENT_ID = 'claude-code-the-parent';
const CHILD_ID = 'child-far';
const NAME = 'first-mate';
const PANE = 'w1:p5';
const SESSION = '5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716';

const profiles: MachineProfile[] = [{ id: 'child-box', label: 'child-box', target: 'child-box', session: 'default', enabled: true }];
const resolve = async (label: string): Promise<MachineProfile> => pickMachine(profiles, label);

function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

/** herdr on the child's machine: one idle Claude Code agent in the child's pane. */
function farHerdr(kind: string): (request: RecordedRequest) => { result: unknown } | undefined {
  const info = { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t5', terminal_id: `term-${PANE}`, agent: kind, name: NAME, agent_status: 'idle', agent_session: { value: SESSION }, completion_seq: 1, state_change_seq: 1 };
  return (request) => {
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: info } };
    if (request.method === 'agent.list') return { result: { type: 'agent_list', agents: [info] } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [info] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t5', terminal_id: `term-${PANE}`, agent_status: 'idle' }] } };
    return undefined;
  };
}

interface Room {
  root: string;
  parentHome: string;
  childHome: string;
  far: FakeHerdr;
  links: RelayLinks;
  parent: DaemonClient;
}

/** A parent daemon in this process whose service runs the real tools, with the far machine reached through the relay links. */
function serviceFactory(clientFor: (host: string) => Promise<HerdrClient>, near: HerdrClient, links: RelayLinks): ServiceFactory {
  return (_parent, id, deps): ParentService => {
    const watcher = new Watcher({ client: near, clientFor, parentId: id, onEntries: () => {}, relayState: (host) => links.state(host) });
    watcher.start();
    const ctx: ToolContext = { client: near, clientFor, parentId: id, watcher, remote: remoteOps(resolve, {}, links), relayState: (host) => links.state(host), ...(deps.inbox ? { inbox: deps.inbox } : {}) };
    return {
      tool: (name, args, caller) => runBellwetherTool(ctx, name, args, caller),
      markRead: () => {},
      onEvents: () => {},
      pending: () => [],
      watchPane: () => () => {},
      stop: () => watcher.stop(),
    };
  };
}

async function room(t: test.TestContext, options: { farDaemon?: (socketPath: string) => Promise<() => Promise<void>>; kind?: 'claude' | 'pi' } = {}): Promise<Room> {
  const kind = options.kind ?? 'claude';
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-msg-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const stopFar = options.farDaemon ? await options.farDaemon(path.join(childHome, 'daemon.sock')) : undefined;

  const far = await startFakeHerdr({ respond: farHerdr(kind) });
  const near = await startFakeHerdr();
  const farClient = new HerdrClient({
    label: 'machine:child-box',
    dial: (onReady) => {
      const socket = net.createConnection(far.socketPath);
      socket.on('connect', onReady);
      return socket;
    },
  });
  const nearClient = new HerdrClient({ socketPath: near.socketPath });
  const clientFor = async (host: string): Promise<HerdrClient> => (host === 'local' ? nearClient : (await resolve(host), farClient));

  const at = new Date().toISOString();
  const record: ChildRecord = { id: CHILD_ID, name: NAME, kind, harness: kind === 'pi' ? 'pi' : 'claude-code', paneId: PANE, tabId: 'w1:t5', host: 'child-box', origin: 'spawn', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, session: { kind: 'id', value: SESSION } };
  saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, record);
  // What the spawn's relay-register wrote on the child's machine.
  inHome(childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: CHILD_ID, name: NAME, kind, parentId: PARENT_ID, registeredAt: at }));

  const links = new RelayLinks({ resolve, initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, heartbeatMs: 1_000 });
  const socketPath = path.join(parentHome, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home: parentHome, links, factory: serviceFactory(clientFor, nearClient, links), pruneEveryMs: false });
  const parent = await DaemonClient.connect({ harness: 'claude-code', session: 'the-parent', cwd: '/work', host: 'parent-box', paneId: 'w1:p1', depth: 0, herdrSocket: near.socketPath }, { socketPath, home: parentHome, spawn: false });
  t.after(async () => {
    await parent.close();
    await daemon.close();
    await ssh.drop();
    await stopFar?.();
    await stopDaemonsUnder(root, childHome);
    await far.stop();
    await near.stop();
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, parentHome, childHome, far, links, parent };
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** What herdr on the child's machine was asked to type into the child's pane. */
function typed(far: FakeHerdr): string[] {
  return far.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === PANE).map((request) => String(request.params['text']));
}

function messages(): ChildMessage[] {
  return readParent(PARENT_ID)?.children.find((child) => child.id === CHILD_ID)?.messages ?? [];
}

interface FarChannel {
  notifications: { method: string; params: { content: string; meta?: Record<string, string> } }[];
  transcript: string;
}

/** The child's own Bellwether channel server, on the child's machine, against that machine's daemon. */
async function farChannel(t: test.TestContext, space: Room): Promise<FarChannel> {
  const user = path.dirname(space.childHome);
  const cwd = path.join(user, 'work');
  const config = path.join(user, '.claude');
  const transcript = path.join(config, 'projects', claudeProjectDir(cwd), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const notifications: FarChannel['notifications'] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    notifications.push(notification as FarChannel['notifications'][number]);
  };
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: user,
    BELLWETHER_HOME: space.childHome,
    BELLWETHER_DAEMON_SOCKET: path.join(space.childHome, 'daemon.sock'),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_SESSION_ID: SESSION,
    CLAUDE_PROJECT_DIR: cwd,
    HERDR_SOCKET_PATH: space.far.socketPath,
    HERDR_PANE_ID: PANE,
    BELLWETHER_PARENT: PARENT_ID,
    BELLWETHER_DEPTH: '1',
    ...(process.env['NODE_COMPILE_CACHE'] ? { NODE_COMPILE_CACHE: process.env['NODE_COMPILE_CACHE'] } : {}),
  };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [channelServer, '--child', CHILD_ID], env, stderr: 'pipe' }));
  t.after(() => client.close());
  await until('the far session to connect to its own daemon', async () => (await daemonSessions(path.join(space.childHome, 'daemon.sock')).catch(() => undefined))?.sessions.some((entry) => entry.childId === CHILD_ID));
  return { notifications, transcript };
}

/** Open the relay to the child's machine, as the daemon does for a parent with a child there. */
async function relayUp(space: Room): Promise<void> {
  space.links.sync();
  await until('the relay to child-box', () => space.links.state('child-box')?.status === 'connected');
}

test("a child on another machine gets the message through its channel, herdr there types nothing, and its read comes back over the relay", async (t) => {
  const space = await room(t);
  const channel = await farChannel(t, space);
  await relayUp(space);

  const reply = await space.parent.tool('agent_send', { child: NAME, text: 'Pull before you rebase.' });
  const id = /Delivered to first-mate's session as message (m-[0-9a-f]{8}), through its Bellwether channel; nothing was typed into its pane\./.exec(reply)?.[1];
  assert.ok(id, reply);
  const note = await until('the far channel notification', () => channel.notifications.find((entry) => entry.method === 'notifications/claude/channel'));
  assert.match(note.params.content, new RegExp(`^\\[bellwether\\] Message ${id} from your parent, .*:\\nPull before you rebase\\.$`, 's'));
  // The guard that fails if the remote path falls back to typing.
  assert.deepEqual(typed(space.far), [], 'nothing typed into the far pane of a child whose channel took the message');
  const [sent] = messages();
  assert.equal(sent?.path, 'session');
  assert.equal(sent?.via, 'claude-channel');
  assert.equal(sent?.reason, undefined, 'no keystroke reason for a message the far session took');
  assert.equal(inHome(space.childHome, () => readRelayRecord(CHILD_ID))?.messages?.[0]?.id, id, 'the far machine keeps the unread text, so a reconnected session takes it again');

  // Claude Code on the child's machine records the channel message reaching the model.
  fs.appendFileSync(channel.transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: note.params.content, commandMode: 'prompt', origin: { kind: 'channel', server: 'bellwether' } } })}\n`);
  await until('the read on the parent record', () => messages().find((message) => message.id === id && message.readAt));
  await until('the far machine to drop the read text', () => !inHome(space.childHome, () => readRelayRecord(CHILD_ID))?.messages?.length);
  assert.match(await space.parent.tool('agent_list', {}), new RegExp(`first-mate: message ${id} at .*, into its session through Bellwether channel; read at `));
});

test('a far session that is not connected gets the message typed into its pane on that machine, and the reason comes from that machine', async (t) => {
  const space = await room(t);
  await relayUp(space);
  const reply = await space.parent.tool('agent_send', { child: NAME, text: 'Are you there?' });
  assert.match(reply, /^Prompted first-mate: herdr typed message m-[0-9a-f]{8} into its pane, because machine child-box answered: no session of first-mate that takes messages is connected to this machine's Bellwether daemon/);
  assert.deepEqual(typed(space.far), ['Are you there?']);
  assert.equal(messages()[0]?.path, 'keystrokes');
});

test('a pi child on another machine gets the message as a steered pi message there, and message_end sends the read back', async (t) => {
  const space = await room(t, { kind: 'pi' });
  const sent: { content: string; details: unknown; options: unknown }[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: () => {},
    sendMessage: (message: { content: string; details?: unknown }, options?: unknown) => sent.push({ content: message.content, details: message.details, options }),
  };
  const fire = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  // The extension runs on the child's machine: its daemon is that machine's, named by the environment at session_start.
  const keys = ['BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'BELLWETHER_CHILD', 'BELLWETHER_PARENT', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH'] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BELLWETHER_HOME: space.childHome, BELLWETHER_DAEMON_SOCKET: path.join(space.childHome, 'daemon.sock'), BELLWETHER_CHILD: CHILD_ID, BELLWETHER_PARENT: PARENT_ID, HERDR_PANE_ID: PANE, HERDR_SOCKET_PATH: space.far.socketPath });
  const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => SESSION, getCwd: () => path.dirname(space.childHome), getEntries: () => [] } };
  try {
    const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
    bellwether(pi);
    await fire('session_start', {}, ctx);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => fire('session_shutdown', {}, ctx));
  await until('the far pi session to connect to its own daemon', async () => (await daemonSessions(path.join(space.childHome, 'daemon.sock')).catch(() => undefined))?.sessions.some((entry) => entry.childId === CHILD_ID));
  await relayUp(space);

  const reply = await space.parent.tool('agent_send', { child: NAME, text: 'Stop: the plan changed.' });
  const id = /Delivered to first-mate's session as message (m-[0-9a-f]{8}), through its Bellwether pi extension/.exec(reply)?.[1];
  assert.ok(id, reply);
  const message = await until('the steered message', () => sent.find((entry) => (entry.details as { message?: string } | undefined)?.message === id));
  assert.deepEqual(message.options, { triggerTurn: true, deliverAs: 'steer' }, 'the same mid-turn rule as a child on this machine');
  assert.deepEqual(typed(space.far), [], 'nothing typed into the far pane of a pi child whose extension took the message');
  assert.equal(messages()[0]?.via, 'pi-message');

  await fire('message_end', { message: { role: 'custom', customType: 'bellwether-message', details: { message: id } } }, ctx);
  await until('the read on the parent record', () => messages().find((entry) => entry.id === id && entry.readAt));
});

test('a far session that reconnects before reading takes the message again from its own machine, marked as a replay', async (t) => {
  const space = await room(t);
  const farSocket = path.join(space.childHome, 'daemon.sock');
  const hello = { harness: 'claude-code' as const, session: SESSION, cwd: '/far/work', host: 'child-box', paneId: PANE, depth: 1, herdrSocket: space.far.socketPath, childId: CHILD_ID, reportsTo: PARENT_ID, accepts: ['message'] };
  const first = await inHome(space.childHome, () => DaemonClient.connect(hello, { socketPath: farSocket, home: space.childHome }));
  first.onMessage((message) => first.messageAck(message.id, 'queued', { via: 'claude-channel' }));
  await relayUp(space);
  const reply = await space.parent.tool('agent_send', { child: NAME, text: 'Keep this one.' });
  const id = /message (m-[0-9a-f]{8})/.exec(reply)?.[1];
  assert.match(reply, /Delivered to first-mate's session/);
  await first.close();

  const again: { id: string; replay: boolean; text: string }[] = [];
  const second = await DaemonClient.connect(hello, { socketPath: farSocket, home: space.childHome, spawn: false });
  t.after(() => second.close());
  second.onMessage((message, replay) => {
    again.push({ id: message.id, replay, text: message.text });
    second.messageAck(message.id, 'read', { via: 'claude-channel' });
  });
  assert.deepEqual(await until('the replay', () => again[0]), { id, replay: true, text: 'Keep this one.' });
  await until('the read on the parent record', () => messages().find((entry) => entry.id === id && entry.readAt));
  assert.deepEqual(typed(space.far), []);
});

/** A daemon on the child's machine from before relay-message: it serves the relay and answers anything newer with unknown_type. */
async function olderDaemon(socketPath: string): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as { type: string };
        if (request.type === 'relay-subscribe') {
          socket.write(`${JSON.stringify({ type: 'relay-hello', protocol: 4, pid: process.pid, waiting: 0, version: '0.1.6', build: '1b5d5ca' })}\n`);
          socket.write(`${JSON.stringify({ type: 'relay-drained', sent: 0 })}\n`);
        } else {
          socket.write(`${JSON.stringify({ type: 'error', code: 'unknown_type', message: `unknown request type ${JSON.stringify(request.type)}` })}\n`);
        }
      }
    });
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
}

test('a far daemon from before relay-message degrades to keystrokes, and the reason names the release that brings it', async (t) => {
  const space = await room(t, { farDaemon: olderDaemon });
  await relayUp(space);
  const reply = await space.parent.tool('agent_send', { child: NAME, text: 'Carry on.' });
  assert.match(reply, /^Prompted first-mate: herdr typed message m-[0-9a-f]{8} into its pane, because machine child-box runs bellwether 0\.1\.6 build 1b5d5ca, which does not serve relay-message: that takes the relay-message request, which came with bellwether 0\.1\.7\. Update @elecnix\/bellwether on machine child-box\.$/);
  assert.deepEqual(typed(space.far), ['Carry on.']);
  const [message] = messages();
  assert.equal(message?.path, 'keystrokes');
  assert.match(message?.reason ?? '', /does not serve relay-message/);
  assert.notEqual(space.links.state('child-box')?.status, 'reconnecting', 'an unknown request does not end the relay');
});
