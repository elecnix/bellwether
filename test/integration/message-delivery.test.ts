// Tier 2: a parent's message reaches a child's session, not its keyboard. A
// daemon runs in process against the fake herdr, a parent session is a daemon
// client, and each child is the adapter that would run inside it: the real
// Claude Code channel server as a process of its own, the real pi extension
// against a fake pi, or a bare daemon client where a case needs a session
// that misbehaves. herdr records every agent.prompt, so a case knows whether
// anything was typed into a pane, and the child record says which path the
// message took.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildMessage, ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { DaemonClient, daemonSessions } from '../../src/daemon/client.ts';
import type { InboxMessage, ParentHello } from '../../src/daemon/protocol.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const channelServer = path.join(here, '..', '..', 'bin', 'bellwether-mcp.js');

interface Room {
  root: string;
  home: string;
  socketPath: string;
  world: FakeWorld;
  fake: FakeHerdr;
  parentId: string;
  parent: DaemonClient;
  events: OutboxEntry[];
}

interface Kid {
  id: string;
  name: string;
  kind: string;
  harness: string;
  pane: string;
  status?: 'idle' | 'working' | 'blocked';
}

function record(kid: Kid): ChildRecord {
  const at = new Date().toISOString();
  return { id: kid.id, name: kid.name, kind: kid.kind, harness: kid.harness, paneId: kid.pane, host: LOCAL_HOST, origin: 'spawn', startedAt: at, lastStatus: kid.status ?? 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 };
}

/** A daemon, a fake herdr with each child's pane, and a parent session whose registry lists the children. */
async function room(t: test.TestContext, kids: Kid[], options: { messageAckMs?: number } = {}): Promise<Room> {
  const { messageAckMs } = options;
  const { root, home } = isolate(t, 'bellwether-message-');
  const world = fakeWorld('w1');
  for (const kid of kids) world.add({ pane_id: kid.pane, agent: kid.kind, agent_status: kid.status ?? 'idle', name: kid.name });
  // herdr refuses a prompt to an agent on a dialog, as the live server does.
  const fake = await startFakeHerdr({
    respond: (request) => (request.method === 'agent.prompt' && world.panes.get(String(request.params['target']))?.agent_status === 'blocked' ? { error: { code: 'agent_blocked', message: 'the agent is waiting on a dialog' } } : world.respond(request)),
  });
  world.emit = (frame) => fake.send(frame);
  process.env['HERDR_SOCKET_PATH'] = fake.socketPath;
  const socketPath = path.join(home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home, pruneEveryMs: false, ...(messageAckMs === undefined ? {} : { messageAckMs }) });
  const session = `parent-${path.basename(root)}`;
  const parentId = saveParent(emptyParent('claude-code', session, root, { paneId: 'w1:p0', workspaceId: 'w1' })).id;
  for (const kid of kids) upsertChild(parentId, record(kid));
  const parent = await DaemonClient.connect({ harness: 'claude-code', session, cwd: root, host: os.hostname(), paneId: 'w1:p0', depth: 0, herdrSocket: fake.socketPath }, { socketPath, home, spawn: false });
  const events: OutboxEntry[] = [];
  parent.onEvents((entries) => events.push(...entries));
  t.after(async () => {
    await parent.close();
    await daemon.close();
    await fake.stop();
  });
  return { root, home, socketPath, world, fake, parentId, parent, events };
}

/** What herdr was asked to type into one pane. */
function typed(fake: FakeHerdr, paneId: string): string[] {
  return fake.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === paneId).map((request) => String(request.params['text']));
}

function messagesOf(space: Room, childId: string): ChildMessage[] {
  return readParent(space.parentId)?.children.find((child) => child.id === childId)?.messages ?? [];
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until the daemon lists a session for this child id. */
async function connected(space: Room, childId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const sessions = await daemonSessions(space.socketPath);
    if (sessions.sessions.some((entry) => entry.childId === childId)) return;
    if (Date.now() > deadline) throw new Error(`no session for ${childId} connected`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A child session as a bare daemon client, for a case whose adapter must misbehave. */
async function bareChild(t: test.TestContext, space: Room, kid: Kid, take: (message: InboxMessage, replay: boolean, client: DaemonClient) => void): Promise<DaemonClient> {
  const hello: ParentHello = { harness: 'claude-code', session: `session-${kid.id}`, cwd: space.root, host: os.hostname(), paneId: kid.pane, depth: 1, herdrSocket: space.fake.socketPath, childId: kid.id, reportsTo: space.parentId, accepts: ['message'] };
  const client = await DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false });
  client.onMessage((message, replay) => take(message, replay, client));
  t.after(() => client.close());
  return client;
}

const WRITER: Kid = { id: 'child-writer', name: 'writer', kind: 'claude', harness: 'claude-code', pane: 'w1:p1' };
const CODER: Kid = { id: 'child-coder', name: 'coder', kind: 'codex', harness: 'codex', pane: 'w1:p2' };
const PIKID: Kid = { id: 'child-pi', name: 'planner', kind: 'pi', harness: 'pi', pane: 'w1:p3' };

test('a Claude Code child gets the message through its channel, nothing is typed, and the record says so until its model reads it', async (t) => {
  const space = await room(t, [WRITER]);
  const session = '0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5';
  const cwd = path.join(space.root, 'worktree');
  const config = path.join(space.root, '.claude');
  const transcript = path.join(config, 'projects', claudeProjectDir(cwd), `${session}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const notifications: { method: string; params: { content: string; meta?: Record<string, string> } }[] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    notifications.push(notification as (typeof notifications)[number]);
  };
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: space.root,
    BELLWETHER_HOME: space.home,
    BELLWETHER_DAEMON_SOCKET: space.socketPath,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PROJECT_DIR: cwd,
    HERDR_SOCKET_PATH: space.fake.socketPath,
    HERDR_PANE_ID: WRITER.pane,
    BELLWETHER_PARENT: space.parentId,
    BELLWETHER_DEPTH: '1',
  };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [channelServer, '--child', WRITER.id], env, stderr: 'pipe' }));
  t.after(() => client.close());
  await connected(space, WRITER.id);

  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Rebase on main before you push.' });
  const id = /Delivered to writer's session as message (m-[0-9a-f]{8}), through its Bellwether channel; nothing was typed into its pane\./.exec(reply)?.[1];
  assert.ok(id, reply);
  const note = await until('the channel notification', () => notifications.find((entry) => entry.method === 'notifications/claude/channel'));
  assert.match(note.params.content, new RegExp(`^\\[bellwether\\] Message ${id} from your parent, claude-code session parent-.*:\\nRebase on main before you push\\.$`, 's'));
  assert.equal(note.params.meta?.['message_id'], id);
  // The test that fails if the session path silently turned back into typing.
  assert.deepEqual(typed(space.fake, WRITER.pane), [], 'nothing typed into the pane of a child whose channel took the message');
  const [sent] = messagesOf(space, WRITER.id);
  assert.equal(sent?.path, 'session');
  assert.equal(sent?.via, 'claude-channel');
  assert.equal(sent?.readAt, undefined, 'queued in Claude Code is not read by the model');
  assert.match(await space.parent.tool('agent_list', {}), new RegExp(`writer: message ${id} at .*, into its session through Bellwether channel; not read yet\\.`));

  // Claude Code records the channel message reaching the model as an attachment line.
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: note.params.content, commandMode: 'prompt', origin: { kind: 'channel', server: 'bellwether' } } })}\n`);
  const read = await until('the read on the record', () => messagesOf(space, WRITER.id).find((message) => message.id === id && message.readAt));
  assert.equal(read.text, undefined, 'the text leaves the record once it is read');
  assert.match(await space.parent.tool('agent_list', {}), new RegExp(`writer: message ${id} at .*, into its session through Bellwether channel; read at `));
});

test('a pi child gets the message as a steered pi message, and message_end marks it read', async (t) => {
  const space = await room(t, [PIKID]);
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
  const saved = { child: process.env['BELLWETHER_CHILD'], pane: process.env['HERDR_PANE_ID'], parent: process.env['BELLWETHER_PARENT'] };
  process.env['BELLWETHER_CHILD'] = PIKID.id;
  process.env['HERDR_PANE_ID'] = PIKID.pane;
  process.env['BELLWETHER_PARENT'] = space.parentId;
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  bellwether(pi);
  const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => `pi-${path.basename(space.root)}`, getCwd: () => space.root, getEntries: () => [] } };
  await fire('session_start', {}, ctx);
  for (const [name, value] of Object.entries(saved)) {
    const key = { child: 'BELLWETHER_CHILD', pane: 'HERDR_PANE_ID', parent: 'BELLWETHER_PARENT' }[name] as string;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => fire('session_shutdown', {}, ctx));
  await connected(space, PIKID.id);

  const reply = await space.parent.tool('agent_send', { child: 'planner', text: 'Stop: the plan changed.' });
  const id = /Delivered to planner's session as message (m-[0-9a-f]{8}), through its Bellwether pi extension/.exec(reply)?.[1];
  assert.ok(id, reply);
  const message = await until('the steered message', () => sent.find((entry) => (entry.details as { message?: string } | undefined)?.message === id));
  assert.deepEqual(message.options, { triggerTurn: true, deliverAs: 'steer' }, 'a busy pi takes it after the tool calls in flight, as typing would');
  assert.match(message.content, /Stop: the plan changed\.$/);
  assert.deepEqual(typed(space.fake, PIKID.pane), []);
  assert.equal(messagesOf(space, PIKID.id)[0]?.via, 'pi-message');

  await fire('message_end', { message: { role: 'custom', customType: 'bellwether-message', details: { message: id } } }, ctx);
  await until('the read on the record', () => messagesOf(space, PIKID.id).find((entry) => entry.id === id && entry.readAt));
});

test('a codex child, with no channel, still gets the message typed into its pane, and the record names the path and why', async (t) => {
  const space = await room(t, [CODER]);
  const reply = await space.parent.tool('agent_send', { child: 'coder', text: 'Run the tests again.' });
  const id = /^Prompted coder: herdr typed message (m-[0-9a-f]{8}) into its pane, because Codex loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session\.$/.exec(reply)?.[1];
  assert.ok(id, reply);
  assert.deepEqual(typed(space.fake, CODER.pane), ['Run the tests again.'], 'the old path carried it, with the text unchanged');
  const [message] = messagesOf(space, CODER.id);
  assert.equal(message?.path, 'keystrokes');
  assert.match(message?.reason ?? '', /Codex loads Bellwether as an ordinary MCP server/);
  assert.match(await space.parent.tool('agent_list', {}), new RegExp(`coder: message ${id} at .*, typed into its pane, because Codex .*; typed; Bellwether cannot tell when the model read it\\.`));
});

test('a Claude Code child whose session is not connected gets the message typed, and the reply says why', async (t) => {
  const space = await room(t, [WRITER]);
  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Are you there?' });
  assert.match(reply, /^Prompted writer: herdr typed message m-[0-9a-f]{8} into its pane, because no session of writer that takes messages is connected to this machine's Bellwether daemon/);
  assert.deepEqual(typed(space.fake, WRITER.pane), ['Are you there?']);
  assert.equal(messagesOf(space, WRITER.id)[0]?.path, 'keystrokes');
});

test('a session that does not answer within the bound is not waited on forever, and nothing is typed, because it may still take the message', async (t) => {
  const space = await room(t, [WRITER], { messageAckMs: 300 });
  const pushed: string[] = [];
  await bareChild(t, space, WRITER, (message) => pushed.push(message.id));
  const began = Date.now();
  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Hello?' });
  assert.ok(Date.now() - began < 3_000, 'the reply comes at the bound, not later');
  assert.match(reply, /^Pushed to writer's session as message m-[0-9a-f]{8}, but its session had not answered within 0\.3 s, so nothing was typed into its pane/);
  assert.equal(pushed.length, 1, 'the session was offered the message');
  assert.deepEqual(typed(space.fake, WRITER.pane), [], 'no typed copy beside the one the session holds');
  const [message] = messagesOf(space, WRITER.id);
  assert.equal(message?.id, pushed[0], 'one record per message');
  assert.equal(message?.path, 'session');
});

// Issue #211, item 2 (Delivery.tla EntersOnce): a message enters exactly one
// session, once (inSession + typed <= 1).
test('EntersOnce: an adapter that queues the message after the ack bound must not leave the child with a session copy and a typed copy', async (t) => {
  const ACK_MS = 300;
  const LATE_MS = 600;
  const space = await room(t, [WRITER], { messageAckMs: ACK_MS });
  const inSession: string[] = [];
  const timers: NodeJS.Timeout[] = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  await bareChild(t, space, WRITER, (message, _replay, client) => {
    // The adapter puts the message in the session and acknowledges, but only
    // after the daemon's bound has run out.
    timers.push(
      setTimeout(() => {
        inSession.push(message.text);
        client.messageAck(message.id, 'queued', { via: 'claude-channel' });
      }, LATE_MS),
    );
  });

  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Run the tests again.' });
  await new Promise((resolve) => setTimeout(resolve, LATE_MS + 300));
  const copies = typed(space.fake, WRITER.pane);
  const record = messagesOf(space, WRITER.id);
  // Invariant: inSession + typed <= 1.
  assert.ok(inSession.length + copies.length <= 1, `the message entered the child ${inSession.length + copies.length} times: session copies ${JSON.stringify(inSession)}, typed copies ${JSON.stringify(copies)}; reply: ${reply}; record: ${JSON.stringify(record.map((m) => ({ id: m.id, path: m.path })))}`);
  assert.equal(inSession.length, 1, 'the session took its copy');
  assert.deepEqual(record.map((m) => ({ path: m.path, via: m.via })), [{ path: 'session', via: 'claude-channel' }], 'the late answer names the adapter on the record');
});

test('a blocked child keeps the old refusal: nothing is pushed to its session, herdr refuses the prompt, and the parent gets the dialog', async (t) => {
  const stuck: Kid = { ...WRITER, status: 'blocked' };
  const space = await room(t, [stuck]);
  space.world.panes.get(stuck.pane)!.screen = 'Allow this command?\n ❯ 1. Yes\n   2. No';
  const pushed: string[] = [];
  await bareChild(t, space, stuck, (message, _replay, client) => {
    pushed.push(message.id);
    client.messageAck(message.id, 'queued', { via: 'claude-channel' });
  });
  await until('the watcher to read the child blocked', () => readParent(space.parentId)?.children[0]?.lastStatus === 'blocked');
  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Carry on.' });
  assert.match(reply, /^herdr refused the prompt because writer is blocked\. The dialog:\nAllow this command\?/);
  assert.match(reply, /Reply with agent_send keys/);
  assert.deepEqual(pushed, [], 'a message must not wait unseen behind a dialog');
  assert.deepEqual(typed(space.fake, stuck.pane), ['Carry on.'], 'herdr was asked, and refused');
  const [message] = messagesOf(space, stuck.id);
  assert.equal(message?.path, 'keystrokes');
  assert.match(message?.reason ?? '', /blocked on a dialog/);
  assert.match(message?.undelivered ?? '', /herdr refused the prompt/);
});

test('a session that reconnects before reading takes the message again, marked as a replay', async (t) => {
  const space = await room(t, [WRITER]);
  const first: string[] = [];
  const before = await bareChild(t, space, WRITER, (message, _replay, client) => {
    first.push(message.id);
    client.messageAck(message.id, 'queued', { via: 'claude-channel' });
  });
  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Keep this one.' });
  assert.match(reply, /Delivered to writer's session/);
  await before.close();
  const again: { id: string; replay: boolean; text: string }[] = [];
  await bareChild(t, space, WRITER, (message, replay, client) => {
    again.push({ id: message.id, replay, text: message.text });
    client.messageAck(message.id, 'read', { via: 'claude-channel' });
  });
  const replayed = await until('the replay', () => again[0]);
  assert.deepEqual(replayed, { id: first[0], replay: true, text: 'Keep this one.' });
  await until('the read on the record', () => messagesOf(space, WRITER.id)[0]?.readAt);
});

test('a child that exits before reading a session message is reported: the exit event names the message, and the record marks it undelivered', async (t) => {
  const space = await room(t, [WRITER]);
  await bareChild(t, space, WRITER, (message, _replay, client) => client.messageAck(message.id, 'queued', { via: 'claude-channel' }));
  const reply = await space.parent.tool('agent_send', { child: 'writer', text: 'Please also update the changelog.' });
  const id = /message (m-[0-9a-f]{8})/.exec(reply)?.[1];
  assert.ok(id, reply);
  space.world.panes.delete(WRITER.pane);
  space.fake.send({ event: 'pane_exited', data: { pane_id: WRITER.pane } });
  const exit = await until('the exit event', () => space.events.find((entry) => entry.event === 'exited'));
  assert.match(exit.text, new RegExp(`It never read message ${id} \\(sent at .*: "Please also update the changelog\\."\\), which is undelivered`));
  const [message] = messagesOf(space, WRITER.id);
  assert.equal(message?.undelivered, 'the child exited before its model received it');
  assert.equal(message?.text, undefined);
});
