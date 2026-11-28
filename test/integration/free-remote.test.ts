// Tier 2: a parent frees a child on another machine (issue #262). Two
// machines are two Bellwether homes in one temporary root, joined by the fake
// ssh, as in remote-message.test.ts. The parent's daemon runs in this process,
// and the child's machine runs its own daemon, which `bellwether relay-bridge`
// starts there. The child's session is a bare daemon client on that machine.
// The cases show the relay link outliving the ownership: the freeing is
// recorded on the child's machine, and the link then carries the pair's
// messages, each with its token, in both directions, and nothing else.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { readPeerBook } from '../../src/core/peers.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, readRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient, daemonSessions } from '../../src/daemon/client.ts';
import type { InboxMessage } from '../../src/daemon/protocol.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { installFakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const PARENT_ID = 'claude-code-the-parent';
const CHILD_ID = 'f00dfacecafe0262';
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

function farHerdr(): (request: RecordedRequest) => { result: unknown } | undefined {
  const info = { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t5', terminal_id: `term-${PANE}`, agent: 'claude', name: NAME, agent_status: 'idle', agent_session: { value: SESSION }, completion_seq: 1, state_change_seq: 1 };
  return (request) => {
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: info } };
    if (request.method === 'agent.list') return { result: { type: 'agent_list', agents: [info] } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [info] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t5', terminal_id: `term-${PANE}`, agent_status: 'idle' }] } };
    return undefined;
  };
}

/** The parent's service: the real tools, the relay links for the far machine, and a watcher whose events reach the session. */
function serviceFactory(clientFor: (host: string) => Promise<HerdrClient>, near: HerdrClient, links: RelayLinks): ServiceFactory {
  return (_parent, id, deps): ParentService => {
    let handler: ((entries: OutboxEntry[]) => void) | undefined;
    const watcher = new Watcher({ client: near, clientFor, parentId: id, onEntries: (entries) => handler?.(entries), tickMs: 50, relayState: (host) => links.state(host) });
    watcher.start();
    const ctx: ToolContext = { client: near, clientFor, parentId: id, watcher, remote: remoteOps(resolve, {}, links), relayState: (host) => links.state(host), ...(deps.inbox ? { inbox: deps.inbox } : {}) };
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
  childHome: string;
  far: FakeHerdr;
  links: RelayLinks;
  parent: DaemonClient;
  events: OutboxEntry[];
}

async function room(t: test.TestContext): Promise<Room> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-free-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');

  const far = await startFakeHerdr({ respond: farHerdr() });
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

  const at = new Date(Date.now() - 60_000).toISOString();
  const record: ChildRecord = { id: CHILD_ID, name: NAME, kind: 'claude', harness: 'claude-code', paneId: PANE, tabId: 'w1:t5', host: 'child-box', origin: 'spawn', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, session: { kind: 'id', value: SESSION }, lastReport: { status: 'progress', text: 'Read the brief.', at: new Date().toISOString(), seq: 1 } };
  saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, record);
  inHome(childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: CHILD_ID, name: NAME, kind: 'claude', parentId: PARENT_ID, registeredAt: at, brief: path.join(childHome, 'prompts', `${CHILD_ID}.md`) }));

  const links = new RelayLinks({ resolve, initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, heartbeatMs: 1_000 });
  const socketPath = path.join(parentHome, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home: parentHome, links, factory: serviceFactory(clientFor, nearClient, links), pruneEveryMs: false });
  const parent = await DaemonClient.connect({ harness: 'claude-code', session: 'the-parent', cwd: '/work', host: 'parent-box', paneId: 'w1:p1', depth: 0, herdrSocket: near.socketPath }, { socketPath, home: parentHome, spawn: false });
  const events: OutboxEntry[] = [];
  parent.onEvents((entries) => {
    events.push(...entries);
    parent.receipts(entries.filter((entry) => !entry.read).map((entry) => entry.receipt));
  });
  t.after(async () => {
    await parent.close();
    await daemon.close();
    await ssh.drop();
    await stopDaemonsUnder(root, childHome);
    await far.stop();
    await near.stop();
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, childHome, far, links, parent, events };
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

/** The child's session on its own machine: a bare client of that machine's daemon, which the relay started. */
async function farSession(t: test.TestContext, space: Room): Promise<{ client: DaemonClient; messages: InboxMessage[] }> {
  space.links.sync();
  await until('the relay to child-box', () => space.links.state('child-box')?.status === 'connected');
  const socketPath = path.join(space.childHome, 'daemon.sock');
  const client = await DaemonClient.connect({ harness: 'claude-code', session: SESSION, cwd: '/work', host: 'child-box', paneId: PANE, depth: 1, herdrSocket: space.far.socketPath, childId: CHILD_ID, reportsTo: PARENT_ID, accepts: ['message', 'tools'] }, { socketPath, home: space.childHome, spawn: false });
  const messages: InboxMessage[] = [];
  client.onMessage((message) => {
    messages.push(message);
    client.messageAck(message.id, 'queued', { via: 'claude-channel' });
  });
  t.after(() => client.close());
  await until('the far session', async () => (await daemonSessions(socketPath)).sessions.some((entry) => entry.childId === CHILD_ID));
  return { client, messages };
}

test('freeing a child on another machine writes its record there, and the relay link then carries only the pair\'s messages', async (t) => {
  const space = await room(t);
  const child = await farSession(t, space);

  const reply = await space.parent.tool('agent_free', { child: NAME, reason: 'it runs the far build now' });
  assert.match(reply, new RegExp(`first-mate is free.*address ${CHILD_ID}`, 's'));
  assert.ok(!readParent(PARENT_ID)?.children.some((entry) => entry.id === CHILD_ID), 'the child left the parent\'s registry');
  const own = inHome(space.childHome, () => readPeerBook(CHILD_ID));
  assert.equal(own?.freed?.by, PARENT_ID, 'the freed child\'s record is on its own machine');
  assert.equal(own?.freed?.briefs?.[0]?.file, path.join(space.childHome, 'prompts', `${CHILD_ID}.md`), 'its brief there goes with it');
  assert.equal(own?.peers[0]?.host, undefined, 'the child\'s machine keeps no address to dial the parent\'s');
  assert.equal(inHome(space.childHome, () => readRelayRecord(CHILD_ID))?.freed?.by, PARENT_ID);
  const held = readPeerBook(PARENT_ID)?.peers.find((entry) => entry.address === CHILD_ID);
  assert.equal(held?.host, 'child-box');
  assert.equal(held?.token, own?.peers[0]?.token, 'one token for the pair, on two machines');
  const notice = await until('the freeing notice on the far machine', () => child.messages.find((message) => /freed/.test(message.text)));
  assert.match(notice.text, new RegExp(`peer_send to ${PARENT_ID}`));
  assert.deepEqual(space.far.requests.filter((request) => request.method === 'agent.prompt'), [], 'nothing was typed into the far pane');

  // The link outlives the ownership: no child remains there, and it stays connected for the pair.
  space.links.sync();
  await delay(300);
  assert.equal(space.links.state('child-box')?.status, 'connected');

  // Former parent to freed child, across the relay, with the token.
  assert.match(await space.parent.tool('peer_send', { to: CHILD_ID, text: 'Is the far build green?' }), /first-mate's session took it/);
  await until('the peer message on the far machine', () => child.messages.find((message) => message.text === 'Is the far build green?'));

  // Freed child to former parent: through its machine's relay outbox, which the parent's daemon collects.
  assert.match(await child.client.tool('peer_send', { to: PARENT_ID, text: 'Green, on the far box.' }), /Sent to/);
  const event = await until('the peer event on the parent', () => space.events.find((entry) => entry.event === 'peer-message'));
  assert.equal(event.childId, CHILD_ID);
  assert.match(event.text, /Green, on the far box\./);

  // Nothing else crosses: a report from the freed child is refused on its own machine.
  await assert.rejects(child.client.tool('parent_report', { status: 'done', text: 'done' }), /freed/);
  await until('the far session\'s tool list without parent_report', () => !child.client.tools().some((tool) => tool.name === 'parent_report'));
  assert.ok(!space.events.some((entry) => entry.childId === CHILD_ID && entry.event !== 'peer-message'), 'no event but the peer\'s message reached the parent');
});

test('the far machine refuses a message for a freed child that carries no token, or the wrong one', async (t) => {
  const space = await room(t);
  const child = await farSession(t, space);
  await space.parent.tool('agent_free', { child: NAME });
  await until('the freeing notice', () => child.messages.find((message) => /freed/.test(message.text)));
  const count = child.messages.length;

  const bare = await space.links.message('child-box', PARENT_ID, CHILD_ID, { id: 'm-00000001', from: 'your parent', text: 'Untokened.', at: new Date().toISOString() });
  assert.equal(bare.delivered, false);
  assert.match(bare.delivered ? '' : bare.reason, /freed .*token/);
  const forged = await space.links.message('child-box', PARENT_ID, CHILD_ID, { id: 'm-00000002', from: 'your parent', text: 'Forged.', at: new Date().toISOString() }, { peer: { from: PARENT_ID, token: 'f'.repeat(64) } });
  assert.equal(forged.delivered, false);
  assert.match(forged.delivered ? '' : forged.reason, /token .*does not match/);
  await delay(200);
  assert.equal(child.messages.length, count, 'neither message reached the session');
});
