// Tier 2: an adopted session reports to the parent that adopted it (issue
// #142). A session Bellwether did not start can still hold a Bellwether
// adapter: a pi extension from pi's settings, or a Claude Code server from a
// plugin or a user-level entry. That adapter said hello with its pane and no
// child id, so the daemon offered it no parent_report. Once a parent adopts
// the pane, the daemon offers the tool over the connection the adapter
// already holds, and routes the report by the pane. A session with no
// adapter has nothing to offer it to, and the adoption says so.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import type { ChildMessage, OutboxEntry } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const channelServer = path.join(here, '..', '..', 'bin', 'bellwether-mcp.js');

const CLAUDE_PANE = 'w1:p7';
const CLAUDE_SESSION = '3f1c2a9e-0000-4000-8000-00000000c1a0';
const PI_PANE = 'w1:p8';
const PI_SESSION = '01a2b3c4-0000-7000-8000-0000000000p1';
const BARE_PANE = 'w1:p9';

interface Room {
  root: string;
  home: string;
  socketPath: string;
  fake: FakeHerdr;
  parentId: string;
  parent: DaemonClient;
  events: OutboxEntry[];
}

/** A daemon on a fake herdr with three hand-started agents, and a parent session that has adopted none of them yet. */
async function room(t: test.TestContext): Promise<Room> {
  const { root, home } = isolate(t, 'bellwether-adopted-');
  const world = fakeWorld('w1');
  world.add({ pane_id: CLAUDE_PANE, agent: 'claude', agent_status: 'idle', name: 'hand-claude', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: CLAUDE_SESSION } });
  world.add({ pane_id: PI_PANE, agent: 'pi', agent_status: 'idle', name: 'hand-pi', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: `/sessions/--work--/2026-11-27T00-00-00-000Z_${PI_SESSION}.jsonl` } });
  world.add({ pane_id: BARE_PANE, agent: 'claude', agent_status: 'idle', name: 'bare-claude', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'no-adapter-session' } });
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  process.env['HERDR_SOCKET_PATH'] = fake.socketPath;
  const socketPath = path.join(home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home, pruneEveryMs: false });
  const session = `parent-${path.basename(root)}`;
  const parentId = saveParent(emptyParent('claude-code', session, root, { paneId: 'w1:p0', workspaceId: 'w1' })).id;
  const parent = await DaemonClient.connect({ harness: 'claude-code', session, cwd: root, host: os.hostname(), paneId: 'w1:p0', depth: 0, herdrSocket: fake.socketPath }, { socketPath, home, spawn: false });
  const events: OutboxEntry[] = [];
  parent.onEvents((entries) => events.push(...entries));
  t.after(async () => {
    await parent.close();
    await daemon.close();
    await fake.stop();
  });
  return { root, home, socketPath, fake, parentId, parent, events };
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The Claude Code server a plugin or a user-level entry loads in a session Bellwether did not start: no --child, no BELLWETHER_PARENT. */
async function handStartedClaude(t: test.TestContext, space: Room, session: string): Promise<{ client: Client; changed: string[] }> {
  const changed: string[] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    changed.push(notification.method);
  };
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: space.root,
    BELLWETHER_HOME: space.home,
    BELLWETHER_DAEMON_SOCKET: space.socketPath,
    CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] as string,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PROJECT_DIR: space.root,
    HERDR_SOCKET_PATH: space.fake.socketPath,
    HERDR_PANE_ID: CLAUDE_PANE,
  };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [channelServer], env, stderr: 'pipe' }));
  t.after(() => client.close());
  return { client, changed };
}

interface HandPi {
  tools: Map<string, PiTool>;
  sent: { content: string; details: unknown; options: unknown }[];
  fire: (event: string, payload: unknown) => Promise<void>;
  ctx: unknown;
}

interface PiTool {
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
}

/** The pi extension that pi's own settings load in a session Bellwether did not start: no BELLWETHER_CHILD, no BELLWETHER_PARENT. */
async function handStartedPi(t: test.TestContext, space: Room): Promise<HandPi> {
  const tools = new Map<string, PiTool>();
  const sent: HandPi['sent'] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: PiTool & { name: string }) => tools.set(tool.name, tool),
    sendMessage: (message: { content: string; details?: unknown }, options?: unknown) => sent.push({ content: message.content, details: message.details, options }),
  };
  const saved = { pane: process.env['HERDR_PANE_ID'], home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['HERDR_PANE_ID'] = PI_PANE;
  process.env['BELLWETHER_HOME'] = space.home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = space.socketPath;
  t.after(() => {
    process.env['HERDR_PANE_ID'] = saved.pane;
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
  });
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  bellwether(pi);
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => PI_SESSION, getCwd: () => space.root, getEntries: () => [] } };
  const fire = async (event: string, payload: unknown): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  await fire('session_start', {});
  t.after(() => fire('session_shutdown', {}));
  return { tools, sent, fire, ctx };
}

/** What herdr typed into a pane: every agent.prompt it took for it. */
function typed(fake: FakeHerdr, paneId: string): string[] {
  return fake.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === paneId).map((request) => String(request.params['text']));
}

function messagesOf(space: Room, name: string): ChildMessage[] {
  return readParent(space.parentId)?.children.find((child) => child.name === name)?.messages ?? [];
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

test('an adopted Claude Code session whose Bellwether server is already connected gains parent_report, and its report reaches the adopter', async (t) => {
  const space = await room(t);
  const { client, changed } = await handStartedClaude(t, space, CLAUDE_SESSION);
  assert.ok(!(await toolNames(client)).includes('parent_report'), 'before the adoption, the session reports to nobody');

  const reply = await space.parent.tool('agent_adopt', { target: CLAUDE_PANE, name: 'first-mate' });
  assert.match(reply, /Its session holds a Bellwether server or extension, connected to this machine's daemon, which now offers it parent_report: a report from it reaches this session\./, reply);
  assert.doesNotMatch(reply, /cannot call parent_report/);

  await until('the server to hear the tool list changed', () => changed.includes('notifications/tools/list_changed'));
  assert.ok((await toolNames(client)).includes('parent_report'), 'Claude Code asks again, and the list has parent_report');

  const result = (await client.callTool({ name: 'parent_report', arguments: { status: 'done', text: 'Rebased and pushed.' } })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0]?.text ?? '', /Reported done to .*, as first-mate\./);
  const report = await until('the report event at the adopter', () => space.events.find((entry) => entry.event === 'report'));
  assert.equal(report.paneId, CLAUDE_PANE);
  assert.match(report.text, /first-mate \(w1:p7\) reported done:\nRebased and pushed\./);
});

/**
 * The Claude Code server as an interactive Claude Code starts it with the
 * Bellwether channel: under a process whose command line carries the channel
 * flag, and before a resume chooses the session, so CLAUDE_CODE_SESSION_ID
 * names the fresh one. The wrapper stands in for Claude Code, so it is the
 * server's parent process, and its pid names its sessions file.
 */
async function channelClaude(t: test.TestContext, space: Room, startedAs: string): Promise<{ client: Client; changed: string[]; notes: { method: string; params: unknown }[]; sessionsFile: string }> {
  const changed: string[] = [];
  const notes: { method: string; params: unknown }[] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification: { method: string; params?: unknown }): Promise<void> => {
    changed.push(notification.method);
    notes.push({ method: notification.method, params: notification.params });
  };
  const config = process.env['CLAUDE_CONFIG_DIR'] as string;
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: space.root,
    BELLWETHER_HOME: space.home,
    BELLWETHER_DAEMON_SOCKET: space.socketPath,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_SESSION_ID: startedAs,
    CLAUDE_PROJECT_DIR: space.root,
    HERDR_SOCKET_PATH: space.fake.socketPath,
    HERDR_PANE_ID: CLAUDE_PANE,
    BW_CHANNEL: channelServer,
  };
  const wrapper = "const c=require('node:child_process').spawn(process.execPath,[process.env.BW_CHANNEL],{stdio:'inherit'});c.on('exit',(code)=>process.exit(code??0));process.on('SIGTERM',()=>c.kill('SIGTERM'));";
  const launcher = path.join(space.root, 'claude-launcher.cjs');
  fs.writeFileSync(launcher, wrapper);
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher, '--dangerously-load-development-channels', 'plugin:bellwether@elecnix-plugins'], env, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const sessionsFile = path.join(config, 'sessions', `${transport.pid}.json`);
  t.after(() => fs.rmSync(sessionsFile, { force: true }));
  return { client, changed, notes, sessionsFile };
}

test('a Claude Code session that started with the Bellwether channel and resumed the adopted session gains parent_report and takes a message in its session, with nothing typed (issue #184)', async (t) => {
  const space = await room(t);
  const { client, changed, notes, sessionsFile } = await channelClaude(t, space, 'fresh-at-start-0002');
  await space.parent.tool('agent_adopt', { target: CLAUDE_PANE, name: 'first-mate' });
  assert.ok(!(await toolNames(client)).includes('parent_report'), 'the server still names the session Claude Code started under, which is not the adopted one');

  // The person picks the adopted session in the resume picker, and Claude Code rewrites its sessions file.
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(sessionsFile, JSON.stringify({ pid: 1, sessionId: CLAUDE_SESSION, kind: 'interactive' }));
  await until('the server to hear the tool list changed', () => changed.includes('notifications/tools/list_changed'));
  await until('parent_report in the tool list', async () => (await toolNames(client)).includes('parent_report'));

  const reply = await space.parent.tool('agent_send', { child: 'first-mate', text: 'Stop after this commit.' });
  assert.match(reply, /^Delivered to first-mate's session as message m-[0-9a-f]{8}, through its Bellwether channel; nothing was typed into its pane\./, reply);
  const note = await until('the message as a channel notification', () => notes.find((entry) => entry.method === 'notifications/claude/channel' && JSON.stringify(entry.params).includes('Stop after this commit.')));
  assert.match(JSON.stringify(note.params), /parent-message/);
  assert.deepEqual(typed(space.fake, CLAUDE_PANE), []);
  assert.deepEqual(messagesOf(space, 'first-mate').map((message) => [message.path, message.via]), [['session', 'claude-channel']]);
});

test('an adopted pi session registers parent_report from the extension it already loaded, and its report reaches the adopter', async (t) => {
  const space = await room(t);
  const pi = await handStartedPi(t, space);
  assert.ok(pi.tools.has('agent_spawn') && !pi.tools.has('parent_report'));

  const reply = await space.parent.tool('agent_adopt', { target: PI_PANE });
  assert.match(reply, /now offers it parent_report/, reply);
  const report = await until('pi to register parent_report', () => pi.tools.get('parent_report'));
  const result = await report.execute('call-1', { status: 'progress', text: 'Halfway through the migration.' }, undefined, undefined, pi.ctx);
  assert.match(result.content[0]?.text ?? '', /Reported progress to .*, as hand-pi\./);
  const event = await until('the report event at the adopter', () => space.events.find((entry) => entry.event === 'report'));
  assert.equal(event.paneId, PI_PANE);
});

test('a session in an adopted pane whose harness session differs from the adopted one is offered nothing, because herdr reused the pane', async (t) => {
  const space = await room(t);
  const { client } = await handStartedClaude(t, space, 'some-later-session');
  const reply = await space.parent.tool('agent_adopt', { target: CLAUDE_PANE });
  assert.match(reply, /holds no Bellwether server or extension connected to this machine's daemon/, reply);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!(await toolNames(client)).includes('parent_report'));
});

test('adopting a session with no Bellwether adapter says what the parent gets: its status, and messages by keystroke, never a report', async (t) => {
  const space = await room(t);
  const reply = await space.parent.tool('agent_adopt', { target: BARE_PANE });
  assert.match(reply, /Its session holds no Bellwether server or extension connected to this machine's daemon, so it cannot call parent_report\. Its status changes still start your turns, and agent_send types into its pane\. A session gets parent_report only from a Bellwether server or extension it loaded at its start: a plugin, a user-level server or pi's package\./, reply);
});

test('an adopted session whose adapter predates the tool push is told apart, and gains parent_report at its next hello', async (t) => {
  const space = await room(t);
  // A 0.1.6 adapter: it says hello with its pane and accepts no tool list.
  const hello = { harness: 'claude-code' as const, session: CLAUDE_SESSION, cwd: space.root, host: os.hostname(), paneId: CLAUDE_PANE, depth: 0, herdrSocket: space.fake.socketPath };
  const older = await DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false });
  const reply = await space.parent.tool('agent_adopt', { target: CLAUDE_PANE });
  assert.match(reply, /from a release before 0\.1\.7, which takes no new tool list while it runs\. It gains parent_report the next time it connects to the daemon/, reply);
  assert.ok(!older.tools().some((tool) => tool.name === 'parent_report'), 'nothing was pushed to an adapter that did not ask');
  await older.close();
  const again = await DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false });
  t.after(() => again.close());
  assert.ok(again.tools().some((tool) => tool.name === 'parent_report'), 'the hello of its next connection carries parent_report');
});

// Issue #168: the adoption gave a session parent_report and its reports
// arrived, while a message to it was typed into its pane with a reason that
// blamed an extension that was running. The daemon found a session to message
// by the child id in its hello, and a session Bellwether did not start has none.

test('a message to an adopted pi session enters the session through the extension it already loaded, nothing is typed, and message_end marks it read', async (t) => {
  const space = await room(t);
  const pi = await handStartedPi(t, space);
  const adopted = await space.parent.tool('agent_adopt', { target: PI_PANE });
  assert.match(adopted, /now offers it parent_report: a report from it reaches this session, and a message from agent_send enters its session\./, adopted);

  const reply = await space.parent.tool('agent_send', { child: 'hand-pi', text: 'Rebase onto main before you push.' });
  const id = /^Delivered to hand-pi's session as message (m-[0-9a-f]{8}), through its Bellwether pi extension; nothing was typed into its pane\./.exec(reply)?.[1];
  assert.ok(id, reply);
  const message = await until('the steered message', () => pi.sent.find((entry) => (entry.details as { message?: string } | undefined)?.message === id));
  assert.deepEqual(message.options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(message.content, /Rebase onto main before you push\.$/);
  assert.deepEqual(typed(space.fake, PI_PANE), [], 'nothing typed into the pane of an adopted session whose extension took the message');
  assert.equal(messagesOf(space, 'hand-pi')[0]?.path, 'session');

  await pi.fire('message_end', { message: { role: 'custom', customType: 'bellwether-message', details: { message: id } } });
  await until('the read on the record', () => messagesOf(space, 'hand-pi').find((entry) => entry.id === id && entry.readAt));
});

test('an adopted pi session whose extension predates messages to adopted sessions keeps the keystrokes, and both replies name that case', async (t) => {
  const space = await room(t);
  // A 0.1.7 pi extension: it takes a new tool list, and messages only in a child Bellwether started.
  const older = await DaemonClient.connect({ harness: 'pi', session: PI_SESSION, cwd: space.root, host: os.hostname(), paneId: PI_PANE, depth: 0, herdrSocket: space.fake.socketPath, accepts: ['tools'] }, { socketPath: space.socketPath, home: space.home, spawn: false });
  t.after(() => older.close());
  const adopted = await space.parent.tool('agent_adopt', { target: PI_PANE });
  assert.match(adopted, /now offers it parent_report: a report from it reaches this session\. Its Bellwether extension predates 0\.1\.8 and takes no message in a session Bellwether did not start, so agent_send types into its pane until pi starts again with 0\.1\.8 or later\./, adopted);

  const reply = await space.parent.tool('agent_send', { child: 'hand-pi', text: 'Are you there?' });
  assert.match(reply, /^Prompted hand-pi: herdr typed message m-[0-9a-f]{8} into its pane, because hand-pi is an adopted session whose Bellwether extension predates 0\.1\.8 and takes no message in a session Bellwether did not start\./, reply);
  assert.doesNotMatch(reply, /has not started its Bellwether extension yet/);
  assert.deepEqual(typed(space.fake, PI_PANE), ['Are you there?']);
  assert.equal(messagesOf(space, 'hand-pi')[0]?.path, 'keystrokes');
});

test('an adopted Claude Code session whose Bellwether server is a tool server, not a channel, keeps the keystrokes, and both replies say why', async (t) => {
  const space = await room(t);
  await handStartedClaude(t, space, CLAUDE_SESSION);
  const adopted = await space.parent.tool('agent_adopt', { target: CLAUDE_PANE, name: 'first-mate' });
  assert.match(adopted, /a report from it reaches this session\. Claude Code puts a server's message in a session only when the session started with that server as a channel, and no channel flag on this session's command line names Bellwether, or its server predates 0\.1\.9, so agent_send types into its pane\./, adopted);

  const reply = await space.parent.tool('agent_send', { child: 'first-mate', text: 'Stop after this commit.' });
  assert.match(reply, /^Prompted first-mate: herdr typed message m-[0-9a-f]{8} into its pane, because first-mate is an adopted session whose Bellwether server takes no messages: Claude Code puts a server's message in a session only when the session started with that server as a channel, and no channel flag on this session's command line names Bellwether, or its server predates 0\.1\.9\./, reply);
  assert.deepEqual(typed(space.fake, CLAUDE_PANE), ['Stop after this commit.']);
});

test('a message to an adopted session with no Bellwether adapter is typed, and the reason says the session has none', async (t) => {
  const space = await room(t);
  await space.parent.tool('agent_adopt', { target: BARE_PANE });
  const reply = await space.parent.tool('agent_send', { child: 'bare-claude', text: 'Status?' });
  assert.match(reply, /^Prompted bare-claude: herdr typed message m-[0-9a-f]{8} into its pane, because bare-claude is an adopted session with no Bellwether server or extension connected to this machine's daemon, so nothing in it can take a message\./, reply);
  assert.deepEqual(typed(space.fake, BARE_PANE), ['Status?']);
});
