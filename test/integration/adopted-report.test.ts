// Tier 2: an adopted session reports to the parent that adopted it (issue
// #142). A session Bellwether did not start can still hold a Bellwether
// adapter: a pi extension from pi's settings, or a Claude Code server from a
// plugin or a user-level entry. That adapter said hello with its pane and no
// child id, so the daemon offered it no parent_report. Once a parent adopts
// the pane, the daemon offers the tool over the connection the adapter
// already holds, and routes the report by the pane. A session with no
// adapter has nothing to offer it to, and the adoption says so.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import type { OutboxEntry } from '../../src/core/types.ts';
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

test('an adopted pi session registers parent_report from the extension it already loaded, and its report reaches the adopter', async (t) => {
  const space = await room(t);
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> }>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool),
    sendMessage: () => {},
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
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  t.after(async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, ctx);
  });
  assert.ok(tools.has('agent_spawn') && !tools.has('parent_report'));

  const reply = await space.parent.tool('agent_adopt', { target: PI_PANE });
  assert.match(reply, /now offers it parent_report/, reply);
  const report = await until('pi to register parent_report', () => tools.get('parent_report'));
  const result = await report.execute('call-1', { status: 'progress', text: 'Halfway through the migration.' }, undefined, undefined, ctx);
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
