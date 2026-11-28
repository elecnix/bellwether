// Tier 2: a parent frees a child (issue #262). The daemon runs in process
// against the fake herdr, the parent is a daemon client, and each child is a
// bare daemon client that says hello with its child id, the way its own
// Bellwether adapter would. The cases prove the three things a freed child
// stops being: a source of its former parent's events, a holder of briefs in
// that parent's record, and a window onto its former siblings. Then the peer
// exchange itself, which carries the pair's token.
import assert from 'node:assert/strict';
import { acquired } from '../../src/core/authority.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { promptPath, spoolPath } from '../../src/core/paths.ts';
import { peerBookPath, peerDoctorLines, readPeerBook } from '../../src/core/peers.ts';
import { emptyParent, mutateParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import type { InboxMessage, ParentHello } from '../../src/daemon/protocol.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';
import { runEnds } from '../../src/core/incarnation.ts';

interface Kid {
  id: string;
  name: string;
  pane: string;
  /** A brief the child's model has not read yet. */
  unreadBrief?: boolean;
}

// The sibling's id and name share no word with the freed child's, so a leak of either shows in any text.
const WRITER: Kid = { id: 'a1b2c3d4e5f60718', name: 'writer', pane: 'w1:p1' };
const SIBLING: Kid = { id: '9f8e7d6c5b4a3921', name: 'lighthouse', pane: 'w1:p2' };
const READER: Kid = { id: '0badc0de0badc0de', name: 'reader', pane: 'w1:p3', unreadBrief: true };

function record(kid: Kid): ChildRecord {
  const at = new Date(Date.now() - 60_000).toISOString();
  const file = promptPath(kid.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `The brief for ${kid.name}.\n`, { mode: 0o600 });
  const delivery = kid.unreadBrief ? { path: 'session' as const, via: 'claude-channel', receivedAt: at, at } : { path: 'session' as const, via: 'claude-channel', receivedAt: at, readAt: at, takenAt: at, takenBy: 'turn' as const, at };
  return { id: kid.id, name: kid.name, kind: 'claude', harness: 'claude-code', paneId: kid.pane, host: LOCAL_HOST, origin: 'spawn', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, briefs: [{ n: 1, file, at, paneId: kid.pane, delivery }], ...(kid.unreadBrief ? {} : { lastReport: { status: 'progress' as const, text: 'Read the brief.', at: new Date().toISOString(), seq: 1 } }) };
}

/** The parent's service, with the real tools and a watcher whose settle times suit a test. */
function factory(near: HerdrClient): ServiceFactory {
  return (parent, id, deps): ParentService => {
    // Each session has a registry of its own, as the daemon's own service gives it.
    if (!readParent(id)) saveParent(emptyParent(parent.harness, parent.session, parent.cwd, { host: LOCAL_HOST, depth: parent.depth, ...(parent.childId ? { childId: parent.childId } : {}) }));
    let handler: ((entries: OutboxEntry[]) => void) | undefined;
    const watcher = new Watcher({ client: near, parentId: id, onEntries: (entries) => handler?.(entries), tickMs: 50, limits: { idleMs: 150, blockedMs: 150, stuckMs: 600_000, inactiveMs: 600_000 } });
    watcher.start();
    const ctx: ToolContext = { client: near, parentId: id, watcher, ...(deps.inbox ? { inbox: deps.inbox } : {}) };
    return {
      tool: (name, args, caller) => runBellwetherTool(ctx, name, args, caller),
      markRead: (receipts) => receipts.forEach((receipt) => watcher.markRead(receipt)),
      onEvents: (next) => {
        handler = next;
      },
      pending: () => watcher.pendingEntries(),
      watchPane: () => () => {},
      stop: () => watcher.stop(),
    };
  };
}

interface Room {
  root: string;
  home: string;
  socketPath: string;
  world: FakeWorld;
  fake: FakeHerdr;
  parentId: string;
  parent: DaemonClient;
  events: OutboxEntry[];
  kids: Map<string, { client: DaemonClient; messages: InboxMessage[] }>;
}

async function room(t: test.TestContext, kids: Kid[]): Promise<Room> {
  const { root, home } = isolate(t, 'bellwether-free-');
  const world = fakeWorld('w1');
  for (const kid of kids) world.add({ pane_id: kid.pane, agent: 'claude', agent_status: 'idle', name: kid.name });
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  process.env['HERDR_SOCKET_PATH'] = fake.socketPath;
  const near = new HerdrClient({ socketPath: fake.socketPath });
  const socketPath = path.join(home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home, pruneEveryMs: false, messageAckMs: 2_000, factory: factory(near) });
  const session = `parent-${path.basename(root)}`;
  const parentId = saveParent(emptyParent('claude-code', session, root, { paneId: 'w1:p0', workspaceId: 'w1', host: LOCAL_HOST })).id;
  for (const kid of kids) upsertChild(parentId, record(kid));
  const parent = await DaemonClient.connect({ harness: 'claude-code', session, cwd: root, host: os.hostname(), paneId: 'w1:p0', depth: 0, herdrSocket: fake.socketPath }, { socketPath, home, spawn: false });
  const events: OutboxEntry[] = [];
  parent.onEvents((entries) => {
    events.push(...entries);
    parent.receipts(entries.filter((entry) => !entry.read).map((entry) => entry.receipt));
  });
  const connected = new Map<string, { client: DaemonClient; messages: InboxMessage[] }>();
  for (const kid of kids) {
    const hello: ParentHello = { harness: 'claude-code', session: `session-${kid.id}`, cwd: root, host: os.hostname(), paneId: kid.pane, depth: 1, herdrSocket: fake.socketPath, childId: kid.id, reportsTo: parentId, accepts: ['message', 'tools'] };
    const client = await DaemonClient.connect(hello, { socketPath, home, spawn: false });
    const messages: InboxMessage[] = [];
    client.onMessage((message) => {
      messages.push(message);
      client.messageAck(message.id, 'queued', { via: 'claude-channel' });
    });
    connected.set(kid.id, { client, messages });
  }
  t.after(async () => {
    for (const { client } of connected.values()) await client.close();
    await parent.close();
    await daemon.close();
    await fake.stop();
  });
  return { root, home, socketPath, world, fake, parentId, parent, events, kids: connected };
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

function kid(space: Room, id: string): { client: DaemonClient; messages: InboxMessage[] } {
  const found = space.kids.get(id);
  assert.ok(found, `no session for ${id}`);
  return found;
}

function typed(fake: FakeHerdr): string[] {
  return fake.requests.filter((request) => request.method === 'agent.prompt' || request.method === 'pane.send_keys' || request.method === 'pane.send_text').map((request) => JSON.stringify(request.params));
}

test('freeing moves the child out of its parent\'s registry, and both sides keep one peer entry with the same token', async (t) => {
  const space = await room(t, [WRITER, SIBLING]);
  const reply = await space.parent.tool('agent_free', { child: 'writer', reason: 'it owns the docs now' });
  assert.match(reply, new RegExp(`writer is free.*address ${WRITER.id}`, 's'));
  assert.match(reply, /peer_send/);

  const parent = readParent(space.parentId);
  assert.ok(parent);
  assert.deepEqual(parent.children.map((child) => child.id), [SIBLING.id], 'the freed child is no longer a child');
  const freed = parent.freed?.find((entry) => entry.id === WRITER.id);
  assert.ok(freed, 'the registry keeps the history');
  assert.equal(freed.freedBy, space.parentId);
  assert.equal(freed.reason, 'it owns the docs now');
  assert.ok(Date.parse(freed.freedAt) > 0);

  const own = readPeerBook(WRITER.id);
  const held = readPeerBook(space.parentId);
  assert.ok(own?.freed, 'the freed child has a record of its own');
  assert.equal(own.freed.by, space.parentId);
  const toParent = own.peers.find((entry) => entry.address === space.parentId);
  const toChild = held?.peers.find((entry) => entry.address === WRITER.id);
  assert.equal(toParent?.relation, 'former-parent');
  assert.equal(toChild?.relation, 'freed-child');
  assert.match(toParent?.token ?? '', /^[0-9a-f]{64}$/);
  assert.equal(toParent?.token, toChild?.token, 'one token for the pair');
  for (const address of [WRITER.id, space.parentId]) assert.equal(fs.statSync(peerBookPath(address)).mode & 0o777, 0o600);

  // The child hears it, in its session, with its former parent's address.
  const notice = await until('the freeing notice', () => kid(space, WRITER.id).messages.find((message) => /freed/.test(message.text)));
  assert.match(notice.text, new RegExp(`peer_send.*${space.parentId}`, 's'));
  assert.deepEqual(typed(space.fake), [], 'nothing was typed into any pane');
  // The freed child's tools lose the parent's, now that it has none.
  await until('the tool list without parent_report', () => !kid(space, WRITER.id).client.tools().some((tool) => tool.name === 'parent_report'));
  assert.ok(kid(space, WRITER.id).client.tools().some((tool) => tool.name === 'peer_send'));

  const lines = peerDoctorLines();
  assert.ok(lines.some((line) => line.includes(`freed writer (${WRITER.id})`) && line.includes(space.parentId)), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes(`writer (${WRITER.id}) is a freed agent`)), lines.join('\n'));

  await assert.rejects(space.parent.tool('agent_free', { child: 'writer' }), new RegExp(`writer was freed at .*peer_send.*${WRITER.id}`, 's'));
});

test('a freed child\'s events no longer wake its former parent, and its parent_report has nowhere to go', async (t) => {
  const space = await room(t, [WRITER, SIBLING]);
  await space.parent.tool('agent_free', { child: 'writer' });
  space.events.length = 0;

  for (const pane of [WRITER.pane, SIBLING.pane]) space.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: pane, agent_status: 'working', state_change_seq: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pane of [WRITER.pane, SIBLING.pane]) space.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: pane, agent_status: 'idle', state_change_seq: 3 } });
  // The sibling's turn still wakes the parent, which proves the watcher ran.
  await until('the sibling\'s idle event', () => space.events.find((entry) => entry.childId === SIBLING.id && entry.event === 'idle'));
  space.world.emit({ event: 'pane_exited', data: { pane_id: WRITER.pane, exit_code: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(space.events.filter((entry) => entry.childId === WRITER.id), [], 'no event about the freed child reached the parent');

  await assert.rejects(kid(space, WRITER.id).client.tool('parent_report', { status: 'done', text: 'finished' }), /freed .*peer_send/s);
  const spool = fs.existsSync(spoolPath(space.parentId)) ? fs.readFileSync(spoolPath(space.parentId), 'utf8') : '';
  assert.doesNotMatch(spool, new RegExp(WRITER.id), 'no report reached the former parent\'s spool');
  await assert.rejects(kid(space, WRITER.id).client.tool('request_retirement', {}), /freed/);
});

test('a freed child\'s briefs leave its former parent\'s record, and a brief still unread refuses the freeing', async (t) => {
  const space = await room(t, [WRITER, SIBLING, READER]);
  const before = JSON.stringify(readParent(space.parentId)?.children);
  await assert.rejects(space.parent.tool('agent_free', { child: 'reader' }), /reader has not read its brief/);
  assert.equal(JSON.stringify(readParent(space.parentId)?.children), before, 'a refused freeing changes nothing');
  assert.equal(readPeerBook(READER.id), undefined);

  await space.parent.tool('agent_free', { child: 'writer' });
  const parent = readParent(space.parentId);
  const history = JSON.stringify(parent?.freed);
  assert.doesNotMatch(history, /briefs|prompts/, 'the freed entry holds no brief');
  assert.ok(!parent?.children.some((child) => child.id === WRITER.id));
  assert.equal(readPeerBook(WRITER.id)?.freed?.briefs?.[0]?.file, promptPath(WRITER.id), 'the brief goes with the child');
  assert.doesNotMatch(await space.parent.tool('agent_list', {}), /writer/);
  await assert.rejects(space.parent.tool('agent_spawn', { resume: 'writer', prompt: 'One more thing.' }), new RegExp(`writer was freed at .*peer_send.*${WRITER.id}`, 's'));
  await assert.rejects(space.parent.tool('agent_send', { child: 'writer', text: 'Hello?' }), new RegExp(`writer was freed at .*peer_send.*${WRITER.id}`, 's'));
  await assert.rejects(space.parent.tool('agent_stop', { child: WRITER.id }), /freed/);
});

test('a freed child cannot learn its former siblings, and nobody can list another agent\'s peers', async (t) => {
  const space = await room(t, [WRITER, SIBLING]);
  await space.parent.tool('agent_free', { child: 'writer' });
  const writer = kid(space, WRITER.id).client;

  assert.equal(await writer.tool('agent_list', {}), 'No children yet. Start one with agent_spawn.');
  for (const to of [SIBLING.id, SIBLING.name]) {
    const refusal = await writer.tool('peer_send', { to, text: 'hi' }).then(
      () => assert.fail('a freed child reached an address it was never given'),
      (error: Error) => error.message,
    );
    assert.match(refusal, new RegExp(`You hold no address "${to}"`));
    assert.match(refusal, new RegExp(`your contacts: .*\\(${space.parentId}\\)`), 'it names the caller\'s own contacts');
    const leaked = refusal.replace(`"${to}"`, '');
    assert.doesNotMatch(leaked, new RegExp(`${SIBLING.id}|${SIBLING.name}`), 'it never names a sibling');
  }
  // The sibling holds no address either, and learns nothing of the parent's peers.
  const sibling = kid(space, SIBLING.id).client;
  const other = await sibling.tool('peer_send', { to: WRITER.id, text: 'hi' }).then(
    () => assert.fail('a sibling reached the freed child'),
    (error: Error) => error.message,
  );
  assert.match(other, /You hold no peer addresses/);
  assert.doesNotMatch(other.replace(`"${WRITER.id}"`, ''), new RegExp(`${space.parentId}|writer`));
  assert.equal(kid(space, WRITER.id).messages.filter((message) => message.text === 'hi').length, 0);
});

test('peers message each other through their sessions, and a token that does not match the target\'s record stops the message', async (t) => {
  const space = await room(t, [WRITER, SIBLING]);
  await space.parent.tool('agent_free', { child: 'writer' });

  const sent = await space.parent.tool('peer_send', { to: WRITER.id, text: 'Ping from your former parent.' });
  assert.match(sent, /writer's session took it/);
  const got = await until('the peer message', () => kid(space, WRITER.id).messages.find((message) => message.text.includes('Ping from your former parent.')));
  assert.match(got.from, /your peer/);

  const back = await kid(space, WRITER.id).client.tool('peer_send', { to: space.parentId, text: 'Pong, from the docs.' });
  assert.match(back, /Sent to/);
  const event = await until('the peer event', () => space.events.find((entry) => entry.event === 'peer-message'));
  assert.equal(event.childId, WRITER.id);
  assert.match(event.text, /Pong, from the docs\./);
  assert.match(event.text, new RegExp(`peer_send to ${WRITER.id}`));
  assert.deepEqual(typed(space.fake), [], 'nothing was typed into any pane');

  // The daemon that holds the target's record checks the token, so a sender whose copy differs is refused.
  const book = JSON.parse(fs.readFileSync(peerBookPath(space.parentId), 'utf8')) as { peers: { address: string; token: string }[] };
  for (const entry of book.peers) if (entry.address === WRITER.id) entry.token = '0'.repeat(64);
  fs.writeFileSync(peerBookPath(space.parentId), JSON.stringify(book));
  const count = kid(space, WRITER.id).messages.length;
  await assert.rejects(space.parent.tool('peer_send', { to: WRITER.id, text: 'Forged.' }), /token/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(kid(space, WRITER.id).messages.length, count, 'the forged message never reached the session');
});

test('freeing refuses an adopted child and a child that has exited', async (t) => {
  const space = await room(t, [WRITER, SIBLING]);
  mutateParent(space.parentId, (parent) => {
    const writer = parent.children.find((child) => child.id === WRITER.id);
    const sibling = parent.children.find((child) => child.id === SIBLING.id);
    if (writer) Object.assign(writer, acquired('adopt'));
    if (sibling) runEnds(sibling, { at: new Date().toISOString() });
  });
  await assert.rejects(space.parent.tool('agent_free', { child: 'writer' }), /adopted/);
  await assert.rejects(space.parent.tool('agent_free', { child: 'lighthouse' }), /exited/);
  assert.equal(readPeerBook(WRITER.id), undefined);
  assert.equal(readPeerBook(SIBLING.id), undefined);
});
