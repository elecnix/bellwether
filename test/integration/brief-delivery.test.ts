// Tier 2: a start hands its child the brief as a message (issue #162). A
// daemon runs in process against the fake herdr world, and a parent session
// calls agent_spawn through it. When the world starts a harness in a pane, a
// case connects that child's session the way its adapter would: the real
// Claude Code channel server as a process, or a bare daemon client where a
// case counts each push. herdr records every agent.prompt, so a case knows
// whether the brief was typed, and the child record says which path carried it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// Registered before the daemon's modules load, so the daemon serves its kind.
import { FAKE_KIND } from '../fixtures/fake-harness.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import type { InboxMessage, ParentHello } from '../../src/daemon/protocol.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { prompted, startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const channelServer = path.join(here, '..', '..', 'bin', 'bellwether-mcp.js');

const BRIEF = 'Rebase the branch on main.\nThen run the tests, and call parent_report with the result.';

interface Room {
  root: string;
  home: string;
  socketPath: string;
  world: FakeWorld;
  fake: FakeHerdr;
  parentId: string;
  parent: DaemonClient;
}

async function room(t: test.TestContext, options: { sessionWaitMs?: number } = {}): Promise<Room> {
  const { root, home } = isolate(t, 'bellwether-brief-');
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  process.env['HERDR_SOCKET_PATH'] = fake.socketPath;
  const socketPath = path.join(home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home, pruneEveryMs: false, messageAckMs: 2_000, sessionWaitMs: options.sessionWaitMs ?? 5_000 });
  const session = `parent-${path.basename(root)}`;
  const parentId = saveParent(emptyParent('claude-code', session, root, { paneId: 'w1:p0', workspaceId: 'w1' })).id;
  const parent = await DaemonClient.connect({ harness: 'claude-code', session, cwd: root, host: os.hostname(), paneId: 'w1:p0', depth: 0, herdrSocket: fake.socketPath }, { socketPath, home, spawn: false });
  t.after(async () => {
    await parent.close();
    await daemon.close();
    await fake.stop();
  });
  return { root, home, socketPath, world, fake, parentId, parent };
}

function childNamed(space: Room, name: string): ChildRecord | undefined {
  return readParent(space.parentId)?.children.find((child) => child.name === name);
}

/** The child record a pane belongs to, which the spawn wrote before it started the harness. */
function childInPane(space: Room, pane: FakePane): ChildRecord | undefined {
  return readParent(space.parentId)?.children.find((child) => child.paneId === pane.pane_id);
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

/** A child's session as a bare daemon client, which records each push and acknowledges it. */
async function bareSession(t: test.TestContext, space: Room, child: ChildRecord, harness: ParentHello['harness'], via: string, pushes: { id: string; text: string; replay: boolean }[]): Promise<DaemonClient> {
  const hello: ParentHello = { harness, session: `session-${child.id}-${pushes.length}`, cwd: space.root, host: os.hostname(), paneId: child.paneId, depth: 1, herdrSocket: space.fake.socketPath, childId: child.id, reportsTo: space.parentId, accepts: ['message'] };
  const client = await DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false });
  client.onMessage((message: InboxMessage, replay: boolean) => {
    pushes.push({ id: message.id, text: message.text, replay });
    client.messageAck(message.id, 'queued', { via });
  });
  t.after(() => client.close());
  return client;
}

test('a Claude Code child takes its brief through its channel after the startup dialog, never sees a keystroke, and its record says session', async (t) => {
  const space = await room(t);
  const config = path.join(space.root, '.claude');
  const cwd = path.join(space.root, 'worktree');
  fs.mkdirSync(cwd, { recursive: true });
  const notifications: { method: string; params: { content: string; meta?: Record<string, string> } }[] = [];
  let dialogShown: boolean | undefined;
  // Claude Code starts its MCP servers as it starts, so the channel server
  // connects while the development-channel question is still on screen.
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (!child) return;
    const session = String(pane.agent_session?.value);
    const transcript = path.join(config, 'projects', claudeProjectDir(cwd), `${session}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
    client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
      // The brief must not reach a session that still waits on its startup question.
      dialogShown ??= pane.agent_status === 'blocked';
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
      HERDR_PANE_ID: pane.pane_id,
      BELLWETHER_PARENT: space.parentId,
      BELLWETHER_DEPTH: '1',
      ...(process.env['NODE_COMPILE_CACHE'] ? { NODE_COMPILE_CACHE: process.env['NODE_COMPILE_CACHE'] } : {}),
    };
    void client.connect(new StdioClientTransport({ command: process.execPath, args: [channelServer, '--child', child.id], env, stderr: 'pipe' }));
    t.after(() => client.close());
  };

  const reply = await space.parent.tool('agent_spawn', { kind: 'claude', name: 'writer', cwd, prompt: BRIEF });
  const id = /writer's session took its brief as message (m-[0-9a-f]{8}), through its Bellwether channel; nothing was typed into its pane\./.exec(reply)?.[1];
  assert.ok(id, reply);
  const child = childNamed(space, 'writer');
  assert.ok(child);
  const note = await until('the channel notification', () => notifications.find((entry) => entry.method === 'notifications/claude/channel'));
  assert.ok(note.params.content.endsWith(BRIEF), `the session got the brief itself: ${note.params.content}`);
  assert.equal(dialogShown, false, 'the brief went in only after the startup dialog was answered');
  // The guard that fails if the brief turned back into a keystroke or an @ path.
  assert.deepEqual(prompted(space.fake, child.paneId), [], 'nothing typed into the pane of a child whose channel took its brief');
  assert.ok(!(space.world.panes.get(child.paneId)?.args ?? []).some((arg) => arg.startsWith('@')), 'the launch line carries no @ path');
  assert.deepEqual(child.briefs?.[0]?.delivery && { path: child.briefs[0].delivery.path, via: child.briefs[0].delivery.via, message: child.briefs[0].delivery.message }, { path: 'session', via: 'claude-channel', message: id });
  const message = child.messages?.find((entry) => entry.id === id);
  assert.equal(message?.brief, 1);
  assert.equal(message?.path, 'session');
  // The prompt file stays as the record a parent can read again.
  assert.equal(fs.readFileSync(child.briefs?.[0]?.file ?? '', 'utf8'), BRIEF);
});

test('a child with no adapter gets its brief typed, and the record says so with the reason', async (t) => {
  const space = await room(t);
  const reply = await space.parent.tool('agent_spawn', { kind: FAKE_KIND, name: 'plain', prompt: BRIEF });
  assert.match(reply, /herdr typed plain's brief into its pane as message m-[0-9a-f]{8}, because fake-agent is a test harness with no inbound path\. Bellwether cannot tell when its model read it\./);
  const child = childNamed(space, 'plain');
  assert.ok(child);
  assert.deepEqual(prompted(space.fake, child.paneId), [BRIEF], 'the person watching the pane sees the brief itself');
  assert.equal(child.briefs?.[0]?.delivery?.path, 'keystrokes');
  assert.equal(child.briefs?.[0]?.delivery?.reason, 'fake-agent is a test harness with no inbound path');
});

test("a child whose session never connects gets its brief typed after the bound, and the reason names the wait", async (t) => {
  const space = await room(t, { sessionWaitMs: 300 });
  const reply = await space.parent.tool('agent_spawn', { kind: 'pi', name: 'quiet', prompt: BRIEF });
  assert.match(reply, /herdr typed quiet's brief into its pane .*because no session of quiet that takes messages connected to this machine's Bellwether daemon within 0\.3 s of the start/);
  const child = childNamed(space, 'quiet');
  assert.ok(child);
  assert.deepEqual(prompted(space.fake, child.paneId), [BRIEF]);
  assert.equal(child.briefs?.[0]?.delivery?.path, 'keystrokes');
  assert.equal(child.messages?.length, 1, 'one record for the brief, on the path that carried it');
});

test('a harness that prints an error and exits before it acknowledges fails the spawn, quoting its line, and leaves nothing that looks delivered', async (t) => {
  const space = await room(t);
  // pi takes its brief as a message, so it starts at its prompt. Here it then
  // prints a fatal error and exits, and herdr releases the agent.
  space.world.onStart = (pane) => {
    setTimeout(() => {
      pane.screen = `${pane.screen ?? ''}\n Error: No API key found for example-provider.\n$ `;
      pane.agent = undefined;
      space.world.emit({ event: 'pane_agent_detected', data: { pane_id: pane.pane_id, released: true } });
    }, 400);
  };
  const began = Date.now();
  await assert.rejects(space.parent.tool('agent_spawn', { kind: 'pi', name: 'keyless', prompt: BRIEF }), /pi in pane w1:\S+ exited before its session took the brief, and printed: Error: No API key found for example-provider\./);
  assert.ok(Date.now() - began < 4_000, 'the exit ends the wait, rather than the bound');
  assert.equal(childNamed(space, 'keyless'), undefined, 'the failed spawn left no record, so nothing says the brief arrived');
  assert.deepEqual(space.fake.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing was typed at the shell the harness left');
});

test('a resume hands its brief to the session once, and an unread brief it carries is not offered again', async (t) => {
  const space = await room(t);
  const pushes: { id: string; text: string; replay: boolean }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'pi', 'pi-message', pushes);
  };
  const spawned = await space.parent.tool('agent_spawn', { kind: 'pi', name: 'planner', prompt: BRIEF });
  assert.match(spawned, /planner's session took its brief as message m-[0-9a-f]{8}, through its Bellwether pi extension/);
  assert.equal(pushes.length, 1);
  const child = childNamed(space, 'planner');
  assert.ok(child);

  // The harness exits before its model reads the brief, and herdr forgets the pane.
  space.world.panes.delete(child.paneId);
  updateChild(space.parentId, child.id, (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  pushes.length = 0;
  const reply = await space.parent.tool('agent_spawn', { resume: 'planner', prompt: 'Continue.' });
  assert.match(reply, /planner resumed session/);
  assert.match(reply, /planner's session took its brief as message m-[0-9a-f]{8}/);
  // The resumed session reconnects, and takes one message: the new brief, which carries the unread one.
  assert.equal(pushes.length, 1, `one push, not a replay and a brief: ${JSON.stringify(pushes)}`);
  assert.equal(pushes[0]?.replay, false);
  assert.ok(pushes[0]?.text.includes(BRIEF) && pushes[0].text.includes('Continue.'), pushes[0]?.text);
  const resumed = childNamed(space, 'planner');
  assert.deepEqual(prompted(space.fake, resumed?.paneId ?? ''), [], 'nothing typed into the resumed pane');
  assert.equal(resumed?.briefs?.at(-1)?.delivery?.path, 'session');
  assert.match(resumed?.messages?.find((message) => message.brief === 1)?.undelivered ?? '', /brief 2 carries it/);
});

test('a restart of a child whose brief its model read delivers nothing again, and types nothing', async (t) => {
  const space = await room(t);
  const pushes: { id: string; text: string; replay: boolean }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes);
  };
  await space.parent.tool('agent_spawn', { kind: 'claude', name: 'writer', prompt: BRIEF });
  const child = childNamed(space, 'writer');
  assert.ok(child);
  assert.equal(pushes.length, 1);
  // The model read it, as the adapter reports from the transcript.
  updateChild(space.parentId, child.id, (entry) => {
    const message = entry.messages?.find((candidate) => candidate.brief === 1);
    if (message) {
      message.readAt = new Date().toISOString();
      delete message.text;
    }
  });
  pushes.length = 0;
  const reply = await space.parent.tool('agent_restart', { target: 'writer' });
  assert.match(reply, /writer/);
  await until('the restarted pane', () => childNamed(space, 'writer')?.paneId !== child.paneId && childNamed(space, 'writer')?.paneId);
  // Give the new session time to connect and be offered anything it missed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(pushes, [], 'the restarted session is not offered the brief its model already read');
  assert.deepEqual(space.fake.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing typed into either pane');
});
