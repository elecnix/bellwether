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

async function room(t: test.TestContext, options: { sessionWaitMs?: number; briefTurnWaitMs?: number; briefDeadline?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): Promise<Room> {
  const { root, home } = isolate(t, 'bellwether-brief-');
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  process.env['HERDR_SOCKET_PATH'] = fake.socketPath;
  const socketPath = path.join(home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home, pruneEveryMs: false, messageAckMs: 2_000, sessionWaitMs: options.sessionWaitMs ?? 5_000, ...(options.briefTurnWaitMs ? { briefTurnWaitMs: options.briefTurnWaitMs } : {}), ...(options.briefDeadline ? { briefDeadline: options.briefDeadline } : {}) });
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

/** What the model behind a bare session does with each push: begin a turn, have its adapter send the read receipt, after a delay each, or nothing. */
type Model = (push: number) => { turnAfterMs?: number; readAfterMs?: number } | undefined;

/** A model that takes the message as soon as its adapter queues it, as a harness at its prompt does: the read receipt and the turn come at once. */
const prompt: Model = () => ({ turnAfterMs: 0, readAfterMs: 0 });

/** Tell herdr's subscribers that the harness in a pane began a turn, and ended it a moment later, as herdr's integration reports both. */
function beginTurn(space: Room, paneId: string): void {
  const report = (status: 'working' | 'idle'): void => {
    const pane = space.world.panes.get(paneId);
    if (!pane) return;
    pane.agent_status = status;
    space.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: paneId, agent_status: status } });
  };
  report('working');
  setTimeout(() => report('idle'), 200).unref();
}

/** A child's session as a bare daemon client, which records each push and acknowledges it, and whose model then does what `model` says. */
async function bareSession(t: test.TestContext, space: Room, child: ChildRecord, harness: ParentHello['harness'], via: string, pushes: { id: string; text: string; replay: boolean; at: number }[], model: Model = prompt): Promise<DaemonClient> {
  const hello: ParentHello = { harness, session: `session-${child.id}-${pushes.length}`, cwd: space.root, host: os.hostname(), paneId: child.paneId, depth: 1, herdrSocket: space.fake.socketPath, childId: child.id, reportsTo: space.parentId, accepts: ['message'] };
  const client = await DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false });
  const timers: NodeJS.Timeout[] = [];
  client.onMessage((message: InboxMessage, replay: boolean) => {
    pushes.push({ id: message.id, text: message.text, replay, at: Date.now() });
    client.messageAck(message.id, 'queued', { via });
    const does = model(pushes.length);
    if (does?.readAfterMs !== undefined) timers.push(setTimeout(() => client.messageAck(message.id, 'read', { via }), does.readAfterMs));
    if (does?.turnAfterMs !== undefined) timers.push(setTimeout(() => beginTurn(space, child.paneId), does.turnAfterMs));
  });
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    return client.close();
  });
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
      // Claude Code queues the channel message into its transcript and begins
      // a turn on it, and herdr reports the turn. The channel server reads the
      // transcript line as the model's read receipt.
      if (notification.method === 'notifications/claude/channel') {
        fs.appendFileSync(transcript, `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: (notification as (typeof notifications)[number]).params.content, commandMode: 'prompt', origin: { kind: 'channel', server: 'bellwether' } } })}\n`);
        beginTurn(space, pane.pane_id);
      }
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
  const id = /writer's Bellwether channel received its brief as message (m-[0-9a-f]{8}), and its model read it and began a turn on it \d+(\.\d)? s later; nothing was typed into its pane\./.exec(reply)?.[1];
  assert.ok(id, reply);
  const child = childNamed(space, 'writer');
  assert.ok(child);
  const note = await until('the channel notification', () => notifications.find((entry) => entry.method === 'notifications/claude/channel'));
  assert.ok(note.params.content.endsWith(BRIEF), `the session got the brief itself: ${note.params.content}`);
  assert.equal(dialogShown, false, 'the brief went in only after the startup dialog was answered');
  // The guard that fails if the brief turned back into a keystroke or an @ path.
  assert.deepEqual(prompted(space.fake, child.paneId), [], 'nothing typed into the pane of a child whose channel took its brief');
  assert.ok(!(space.world.panes.get(child.paneId)?.args ?? []).some((arg) => arg.startsWith('@')), 'the launch line carries no @ path');
  assert.deepEqual(child.briefs?.[0]?.delivery && { path: child.briefs[0].delivery.path, via: child.briefs[0].delivery.via, message: child.briefs[0].delivery.message, takenBy: child.briefs[0].delivery.takenBy }, { path: 'session', via: 'claude-channel', message: id, takenBy: 'turn' });
  const message = child.messages?.find((entry) => entry.id === id);
  assert.equal(message?.brief, 1);
  assert.equal(message?.path, 'session');
  // The prompt file stays as the record a parent can read again.
  assert.equal(fs.readFileSync(child.briefs?.[0]?.file ?? '', 'utf8'), BRIEF);
});

test("agent_list says how each child's newest brief arrived, and names the record path where the delivery sits (issue #189)", async (t) => {
  const space = await room(t, { sessionWaitMs: 300 });
  await space.parent.tool('agent_spawn', { kind: FAKE_KIND, name: 'plain', prompt: BRIEF });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'pi', 'pi-message', pushes);
  };
  await space.parent.tool('agent_spawn', { kind: 'pi', name: 'listener', prompt: BRIEF });
  const plain = childNamed(space, 'plain');
  const listener = childNamed(space, 'listener');
  assert.ok(plain && listener);
  const list = await space.parent.tool('agent_list', {});
  assert.match(list, /Each child's newest brief and how it arrived \(on the record, children\[\]\.briefs\[\]\.delivery\):/);
  assert.ok(list.includes(`plain: brief 1 at ${plain.briefs?.[0]?.at}, typed into its pane as message ${plain.briefs?.[0]?.delivery?.message}, because fake-agent is a test harness with no inbound path; Bellwether cannot tell when its model read it. The brief stays at ${plain.briefs?.[0]?.file}.`), list);
  const taken = listener.briefs?.[0]?.delivery;
  assert.equal(taken?.takenBy, 'turn');
  assert.ok(list.includes(`listener: brief 1 at ${listener.briefs?.[0]?.at}, into its session through its Bellwether pi extension as message ${taken?.message}; its model read it and began a turn on it at ${taken?.takenAt}.`), list);
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
  const space = await room(t, { sessionWaitMs: 300 });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  // The first start's session never connects, so herdr types its brief, and
  // nothing proves the model read it.
  const spawned = await space.parent.tool('agent_spawn', { kind: 'pi', name: 'planner', prompt: BRIEF });
  assert.match(spawned, /herdr typed planner's brief into its pane as message m-[0-9a-f]{8}/);
  const child = childNamed(space, 'planner');
  assert.ok(child);

  // The harness exits with no report and no finished turn, and herdr forgets the pane.
  space.world.panes.delete(child.paneId);
  updateChild(space.parentId, child.id, (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  space.world.onStart = (pane) => {
    const resumed = childInPane(space, pane);
    if (resumed) void bareSession(t, space, resumed, 'pi', 'pi-message', pushes);
  };
  const reply = await space.parent.tool('agent_spawn', { resume: 'planner', prompt: 'Continue.' });
  assert.match(reply, /planner resumed session/);
  assert.match(reply, /planner's Bellwether pi extension received its brief as message m-[0-9a-f]{8}, and its model read it and began a turn on it/);
  // The resumed session reconnects, and takes one message: the new brief, which carries the unread one.
  assert.equal(pushes.length, 1, `one push, not a replay and a brief: ${JSON.stringify(pushes)}`);
  assert.equal(pushes[0]?.replay, false);
  assert.ok(pushes[0]?.text.includes(BRIEF) && pushes[0].text.includes('Continue.'), pushes[0]?.text);
  const resumed = childNamed(space, 'planner');
  assert.notEqual(resumed?.paneId, child.paneId);
  assert.deepEqual(prompted(space.fake, resumed?.paneId ?? ''), [], 'nothing typed into the resumed pane');
  assert.equal(resumed?.briefs?.at(-1)?.delivery?.path, 'session');
  assert.match(resumed?.messages?.find((message) => message.brief === 1)?.undelivered ?? '', /brief 2 carries it/);
});

test('a restart of a child whose brief its model read delivers nothing again, and types nothing', async (t) => {
  const space = await room(t);
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
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

// Issue #176: the adapter's acknowledgement proves the transport, not the
// reader. A Claude Code or pi adapter is connected before the model behind it
// takes a turn, so a spawn waits for a fact only the model produces.

test('an adapter that acknowledges at once while its model reads the brief ten seconds later: the spawn waits for the read, and the record tells the receipt from the read', async (t) => {
  const space = await room(t);
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, () => ({ turnAfterMs: 10_000, readAfterMs: 10_000 }));
  };
  const reply = await space.parent.tool('agent_spawn', { kind: 'claude', name: 'slow', prompt: BRIEF });
  const answered = Date.now();
  assert.equal(pushes.length, 1, 'one push: the read came before the wait ran out, so nothing went again');
  const received = pushes[0]!.at;
  assert.ok(answered - received >= 9_500, `the spawn answered ${answered - received} ms after the receipt, not at it`);
  assert.match(reply, /slow's Bellwether channel received its brief as message m-[0-9a-f]{8}, and its model read it and began a turn on it (9|10|11)(\.\d)? s later; nothing was typed into its pane\./);
  const delivery = childNamed(space, 'slow')?.briefs?.[0]?.delivery;
  assert.equal(delivery?.path, 'session');
  assert.equal(delivery?.via, 'claude-channel');
  assert.equal(delivery?.takenBy, 'turn');
  assert.ok(delivery?.receivedAt && delivery.takenAt, JSON.stringify(delivery));
  assert.ok(Date.parse(delivery.takenAt) - Date.parse(delivery.receivedAt) >= 9_500, `the record keeps the receipt and the read apart: ${JSON.stringify(delivery)}`);
  assert.deepEqual(prompted(space.fake, childNamed(space, 'slow')?.paneId ?? ''), [], 'nothing typed');
});

// Issue #246: a read receipt says the message entered the session, so it
// alone does not settle the brief as taken (issue #176), but it does mean a
// second copy would enter that session twice. A copy with a read never goes
// again, whatever herdr reported.
test('a read receipt arrives and herdr never reports a turn: the brief is not taken, and it does not go again (issue #246)', async (t) => {
  const space = await room(t, { briefTurnWaitMs: 500 });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    // The adapter acknowledges and reports a read; herdr never reports a turn,
    // as for a turn shorter than one herdr status cycle.
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, () => ({ readAfterMs: 0 }));
  };
  const reply = await space.parent.tool('agent_spawn', { kind: 'claude', name: 'unturned', prompt: BRIEF }).catch((error: Error) => error.message);
  assert.equal(pushes.length, 1, `a copy whose read was recorded went again: ${JSON.stringify(pushes)}`);
  const child = childNamed(space, 'unturned');
  const delivery = child?.briefs?.[0]?.delivery;
  assert.equal(delivery?.takenBy, undefined, `the brief settled as taken on a read with no turn: ${JSON.stringify(delivery)}`);
  assert.equal(delivery?.takenAt, undefined);
  assert.equal(delivery?.readAt, child?.messages?.find((message) => message.id === pushes[0]!.id)?.readAt, 'the delivery keeps the read the record holds');
  assert.equal(delivery?.resentFrom, undefined);
  assert.match(reply, new RegExp(`unturned's Bellwether channel received its brief as message ${pushes[0]!.id}, and its model read it [0-9.]+ s later, but herdr reported no turn on it within 0\\.5 s; Bellwether did not send it again, because a second copy would enter its session twice; nothing was typed into its pane\\.`));
  assert.deepEqual(space.fake.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing typed');
});

/** A deadline a case fires by hand, so a read can land just before it, or just after it, without a race against a real timer. */
function heldDeadlines(): { deadline: (ms: number, signal: AbortSignal) => Promise<void>; pending: (() => void)[] } {
  const pending: (() => void)[] = [];
  return {
    pending,
    deadline: (_ms, signal) =>
      new Promise<void>((resolve) => {
        const fire = (): void => resolve();
        pending.push(fire);
        signal.addEventListener('abort', () => pending.splice(pending.indexOf(fire) >>> 0, 1), { once: true });
      }),
  };
}

// Issue #246: the crossing it came from. The first copy's read reached the
// daemon 1.4 s after the push, herdr never reported a turn, and the resend
// fired at the end of the window all the same. Here the read lands just
// before the window ends, and the window ends only after the record has it.
test('a read receipt that lands just before the resend is due, with no turn from herdr, leaves one copy in the session (issue #246)', async (t) => {
  const held = heldDeadlines();
  // A daemon without the injected deadline falls back on this real one, so the case fails there by resending.
  const space = await room(t, { briefTurnWaitMs: 1_500, briefDeadline: held.deadline });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  let session: DaemonClient | undefined;
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, () => undefined).then((client) => (session = client));
  };
  const spawned = space.parent.tool('agent_spawn', { kind: 'claude', name: 'brisk', prompt: BRIEF });
  spawned.catch(() => {});
  const first = await until('the first copy', () => pushes[0]);
  // A daemon that ignores the held deadline opens no window here; its real one ends at 1.5 s, after this read.
  await until('the window for the first copy', () => held.pending.length === 1 || undefined, 1_000).catch(() => undefined);
  session!.messageAck(first.id, 'read', { via: 'claude-channel' });
  await until('the read on the record', () => childNamed(space, 'brisk')?.messages?.find((message) => message.id === first.id)?.readAt);
  // The resend is due now, with the read already on the record.
  held.pending.shift()?.();
  const reply = await spawned.catch((error: Error) => error.message);
  assert.deepEqual(pushes.map((push) => push.id), [first.id], 'the read landed before the resend was due, so one copy entered the session');
  const delivery = childNamed(space, 'brisk')?.briefs?.[0]?.delivery;
  assert.equal(delivery?.message, first.id);
  assert.equal(delivery?.resentFrom, undefined);
  assert.equal(delivery?.takenBy, undefined, 'no turn, so not taken');
  assert.ok(delivery?.readAt, JSON.stringify(delivery));
  assert.match(reply, /but herdr reported no turn on it within 1\.5 s; Bellwether did not send it again/);
});

// Issue #246: a read that lands after the resend went out. On this machine the
// last check of the record and the push run in one turn of the event loop, so
// the read can only land on the far side of the push, as one on its way back
// over the relay does. The session then holds two copies, the brief does not
// go a third time, and the record says which copy was read.
test('a read on the first copy that lands while the second copy waits settles the brief on that read, sends no third copy, and the record says the session holds both (issue #246)', async (t) => {
  const held = heldDeadlines();
  const space = await room(t, { briefTurnWaitMs: 1_500, briefDeadline: held.deadline });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  let session: DaemonClient | undefined;
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, () => undefined).then((client) => (session = client));
  };
  const spawned = space.parent.tool('agent_spawn', { kind: 'claude', name: 'late', prompt: BRIEF });
  spawned.catch(() => {});
  const first = await until('the first copy', () => pushes[0]);
  // A daemon that ignores the held deadline resends on its real one, at 1.5 s.
  await until('the window for the first copy', () => held.pending.length === 1 || pushes.length > 1 || undefined);
  held.pending.shift()?.();
  const second = await until('the second copy', () => pushes[1]);
  await until('the window for the second copy', () => held.pending.length === 1 || undefined, 500).catch(() => undefined);
  session!.messageAck(first.id, 'read', { via: 'claude-channel' });
  await until('the read on the record', () => childNamed(space, 'late')?.messages?.find((message) => message.id === first.id)?.readAt, 1_000).catch(() => undefined);
  held.pending.shift()?.();
  const reply = await spawned.catch((error: Error) => error.message);
  assert.equal(pushes.length, 2, 'no third copy');
  const child = childNamed(space, 'late');
  const delivery = child?.briefs?.[0]?.delivery;
  assert.equal(delivery?.message, second.id);
  assert.equal(delivery?.resentFrom, first.id);
  assert.equal(delivery?.readFrom, first.id, `the delivery names the copy that was read: ${JSON.stringify(delivery)}`);
  const firstMessage = child?.messages?.find((message) => message.id === first.id);
  assert.ok(firstMessage?.readAt);
  assert.equal(firstMessage?.undelivered, undefined, 'a message the model read is not also marked undelivered');
  assert.match(reply, new RegExp(`the read receipt for message ${first.id} arrived after message ${second.id} went out, so its session holds both copies`));
});

test('a model that does not take the first copy gets the brief once more, and the reply says so', async (t) => {
  const space = await room(t, { briefTurnWaitMs: 1_000 });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    // The first copy reaches the adapter during the startup window and never the model; the model reads the second.
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, (n) => (n === 2 ? { turnAfterMs: 0, readAfterMs: 0 } : undefined));
  };
  const reply = await space.parent.tool('agent_spawn', { kind: 'claude', name: 'deaf', prompt: BRIEF });
  assert.equal(pushes.length, 2, `the brief went twice: ${JSON.stringify(pushes)}`);
  assert.equal(pushes[1]?.text, pushes[0]?.text, 'the second copy is the same brief');
  const [first, second] = pushes;
  assert.match(reply, new RegExp(`deaf's model did not read its brief and begin a turn on it within 1 s of its Bellwether channel receiving its brief as message ${first!.id}, so Bellwether sent the brief once more as message ${second!.id}, and its model read it and began a turn on it`));
  const child = childNamed(space, 'deaf');
  assert.equal(child?.briefs?.[0]?.delivery?.message, second!.id);
  assert.equal(child?.briefs?.[0]?.delivery?.resentFrom, first!.id);
  assert.match(child?.messages?.find((message) => message.id === first!.id)?.undelivered ?? '', new RegExp(`its model did not read it and begin a turn on it within 1 s \\(Bellwether saw neither a read receipt nor a turn\\), so brief 1 went again as message ${second!.id}`));
  assert.deepEqual(prompted(space.fake, child?.paneId ?? ''), [], 'nothing typed');
});

test('a model that takes neither copy fails the spawn by name, and leaves no record that claims delivery', async (t) => {
  const space = await room(t, { briefTurnWaitMs: 500 });
  const pushes: { id: string; text: string; replay: boolean; at: number }[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (child) void bareSession(t, space, child, 'claude-code', 'claude-channel', pushes, () => undefined);
  };
  await assert.rejects(space.parent.tool('agent_spawn', { kind: 'claude', name: 'mute', prompt: BRIEF }), (error: Error) => {
    assert.match(error.message, /BriefNotTaken: mute's Bellwether channel received its brief twice, as messages m-[0-9a-f]{8} and m-[0-9a-f]{8}, but its model did not read and begin a turn on either within 0\.5 s of each, so the spawn failed and its pane is closed\./);
    return true;
  });
  assert.equal(pushes.length, 2, 'one resend, not more');
  assert.equal(childNamed(space, 'mute'), undefined, 'the failed spawn left no record, so nothing says the brief arrived');
  assert.deepEqual(space.fake.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing typed');
});

// Issue #211, item 1 (Delivery.tla TakenMeansTurn): herdr's "working" names no
// message, so a status that arrives while the brief is in flight, for any
// other reason, must not stand in for the model taking it.
test('TakenMeansTurn: a stray herdr "working" while the brief is sending, with no turn and no read, must not record the brief as taken', async (t) => {
  const space = await room(t, { briefTurnWaitMs: 1_000 });
  const clients: DaemonClient[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
  });
  const pushes: string[] = [];
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (!child) return;
    const hello: ParentHello = { harness: 'pi', session: `session-${child.id}`, cwd: space.root, host: os.hostname(), paneId: child.paneId, depth: 1, herdrSocket: space.fake.socketPath, childId: child.id, reportsTo: space.parentId, accepts: ['message'] };
    void DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false }).then((client) => {
      clients.push(client);
      client.onMessage((message) => {
        pushes.push(message.id);
        // The adapter queues the brief, and never reports a read.
        client.messageAck(message.id, 'queued', { via: 'pi-message' });
        // herdr reports the pane working for a reason that is not the brief
        // (a startup redraw, a hook), while the brief is still sending.
        space.world.panes.get(child.paneId)!.agent_status = 'working';
        space.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });
      });
    });
  };

  const outcome = await space.parent.tool('agent_spawn', { kind: 'pi', name: 'stray', prompt: 'Rebase the branch on main.' }).catch((error: Error) => error.message);
  const child = childNamed(space, 'stray');
  const delivery = child?.briefs?.[0]?.delivery;
  assert.deepEqual(prompted(space.fake, child?.paneId ?? ''), [], 'nothing typed');
  assert.ok(pushes.length >= 1, 'the adapter received the brief');
  // Invariant: taken => modelTurn. The model took no turn and read nothing.
  assert.equal(delivery?.takenBy, undefined, `brief recorded as taken with no model turn: ${JSON.stringify(delivery)}`);
  assert.equal(delivery?.takenAt, undefined, `brief recorded as taken with no model turn: ${JSON.stringify(delivery)}`);
  assert.match(outcome, /BriefNotTaken: stray's Bellwether pi extension received its brief twice/, 'the resend and the failure stay');
});

// Issue #211, item 2: a brief pushed to a session that never answers may still
// enter it, so it is neither typed nor sent again.
test('a brief whose session never answers is neither typed nor sent twice, and the spawn fails by name', async (t) => {
  const space = await room(t, { briefTurnWaitMs: 500 });
  const pushes: string[] = [];
  const clients: DaemonClient[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
  });
  space.world.onStart = (pane) => {
    const child = childInPane(space, pane);
    if (!child) return;
    const hello: ParentHello = { harness: 'claude-code', session: `session-${child.id}`, cwd: space.root, host: os.hostname(), paneId: child.paneId, depth: 1, herdrSocket: space.fake.socketPath, childId: child.id, reportsTo: space.parentId, accepts: ['message'] };
    void DaemonClient.connect(hello, { socketPath: space.socketPath, home: space.home, spawn: false }).then((client) => {
      clients.push(client);
      client.onMessage((message) => pushes.push(message.id));
    });
  };
  await assert.rejects(space.parent.tool('agent_spawn', { kind: 'claude', name: 'silent', prompt: BRIEF }), (error: Error) => {
    assert.match(error.message, /BriefNotTaken: silent's session was pushed its brief as message m-[0-9a-f]{8}, but its session had not answered within 2 s, and its model did not read it and begin a turn on it within 0\.5 s more\. A second copy could enter its session twice, so none went/);
    return true;
  });
  assert.equal(pushes.length, 1, 'one copy, never a second');
  assert.deepEqual(space.fake.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing typed');
  assert.equal(childNamed(space, 'silent'), undefined, 'the failed spawn left no record');
});
