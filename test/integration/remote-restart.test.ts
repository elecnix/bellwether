// Tier 2: a parent restarts its child on another machine (issue #190). Two
// machines are two Bellwether homes in one temporary root, joined by the fake
// ssh, as in remote-message.test.ts. The parent's daemon runs in this process.
// The child's machine runs its own daemon, which `bellwether relay-bridge`
// starts there, and herdr on that machine is a fake world that opens tabs,
// closes them and starts the harness typed into a pane. The parent asks for
// the restart over the relay, and the daemon on the child's machine closes
// the old pane, opens a new tab and resumes the same session under the same
// child id. A far daemon that predates the request, a machine with no herdr
// and a session that is not on that machine are each refused by name, and
// none of them changes the parent's record or anything on the far machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { emptyParent, listParents, readParent, saveParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import { restartWaitLines } from '../../src/core/restart.ts';
import { RELAY_SCHEMA, saveRelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { harnessStarts, startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { installFakeSsh } from '../fixtures/fake-ssh.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';
import { answerLost } from '../../src/core/incarnation.ts';

const PARENT_ID = 'claude-code-the-parent';
const CHILD_ID = 'child-far';
const NAME = 'first-mate';
const PANE = 'w1:p3';
const TAB = 'w1:t3';
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

/** A parent daemon in this process whose service runs the real tools, with the far machine reached through the relay links. */
function serviceFactory(clientFor: (host: string) => Promise<HerdrClient>, near: HerdrClient, links: RelayLinks): ServiceFactory {
  return (_parent, id): ParentService => {
    const watcher = new Watcher({ client: near, clientFor, parentId: id, onEntries: () => {}, relayState: (host) => links.state(host) });
    watcher.start();
    const ctx: ToolContext = { client: near, clientFor, parentId: id, watcher, remote: remoteOps(resolve, {}, links), relayState: (host) => links.state(host), restart: { waitTimeoutMs: 2_000, startupTimeoutMs: 5_000, redrawMs: 10 } };
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

interface Room {
  childHome: string;
  far: FakeHerdr;
  world: FakeWorld;
  links: RelayLinks;
  parent: DaemonClient;
  transcript: string;
  ssh: ReturnType<typeof installFakeSsh>;
}

interface RoomOptions {
  /** A daemon on the child's machine that stands in for the real one. */
  farDaemon?: (socketPath: string) => Promise<() => Promise<void>>;
  /** Where the child's machine looks for herdr. Defaults to the fake world's socket. */
  farHerdrSocket?: string;
  /** Leave the child's session off the far machine. */
  noTranscript?: boolean;
}

async function room(t: test.TestContext, options: RoomOptions = {}): Promise<Room> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-rst-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const user = path.dirname(childHome);
  const cwd = path.join(user, 'work');
  const claudeConfig = path.join(user, '.claude');
  fs.mkdirSync(cwd, { recursive: true });

  // herdr on the child's machine, with the child idle in its pane.
  const world = fakeWorld('w1');
  const far = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => far.send(frame);
  world.add({ pane_id: PANE, tab_id: TAB, agent: 'claude', name: NAME, agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: SESSION }, cwd });
  const near = await startFakeHerdr();

  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: user, env: { HERDR_SOCKET_PATH: options.farHerdrSocket ?? far.socketPath, CLAUDE_CONFIG_DIR: claudeConfig } } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const stopFar = options.farDaemon ? await options.farDaemon(path.join(childHome, 'daemon.sock')) : undefined;

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

  // Claude Code on the child's machine has written the session's transcript there.
  const transcript = path.join(claudeConfig, 'projects', claudeProjectDir(cwd), `${SESSION}.jsonl`);
  if (!options.noTranscript) {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Parser ported.' }] } })}\n`);
  }

  const at = new Date(Date.now() - 3_600_000).toISOString();
  const record: ChildRecord = { id: CHILD_ID, name: NAME, kind: 'claude', harness: 'claude-code', paneId: PANE, tabId: TAB, workspaceId: 'w1', host: 'child-box', origin: 'spawn', cwd, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, session: { kind: 'id', value: SESSION } };
  saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, record);
  // What the spawn's relay-register wrote on the child's machine.
  inHome(childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: CHILD_ID, name: NAME, kind: 'claude', parentId: PARENT_ID, cwd, registeredAt: at }));

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
  links.sync();
  await until('the relay to child-box', () => links.state('child-box')?.status === 'connected');
  return { childHome, far, world, links, parent, transcript, ssh };
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

function child(): ChildRecord {
  const record = readParent(PARENT_ID)?.children.find((entry) => entry.id === CHILD_ID);
  assert.ok(record, 'the parent still holds the child');
  return record;
}

/** What a restart must leave as it was on the parent's record: everything but where the child runs, its state there, and when the watcher last saw its harness, which every restart clears. */
function identity(record: ChildRecord): Partial<ChildRecord> {
  const { paneId: _pane, tabId: _tab, workspaceId: _workspace, lastStatus: _status, statusChangedAt: _changed, lastBusyAt: _busy, resumedAt: _resumed, restartedAt: _restarted, toolSource: _tools, decisions: _decisions, harnessSeenAt: _seen, ...rest } = record;
  return rest;
}

function calls(fake: FakeHerdr, method: string): RecordedRequest[] {
  return fake.requests.filter((request) => request.method === method);
}

test("a parent restarts its child on another machine: same child id, a new pane, the same conversation, and the parent's record otherwise unchanged", async (t) => {
  const space = await room(t);
  const before = child();

  const reply = await space.parent.tool('agent_restart', { target: NAME });
  assert.match(reply, /^Restarted first-mate \(child child-far\) on machine child-box: closed pane w1:p3, started claude in pane /, reply);
  assert.match(reply, new RegExp(`--resume ${SESSION}`));
  assert.match(reply, /The session id matches\./);

  const after = child();
  // 1. The same child id: one record, and the new tab carries it.
  assert.equal(readParent(PARENT_ID)?.children.length, 1, 'no second child record');
  const created = calls(space.far, 'tab.create');
  assert.equal(created.length, 1, 'one new tab on the child machine');
  const env = created[0]?.params['env'] as Record<string, string>;
  assert.equal(env['BELLWETHER_CHILD'], CHILD_ID, 'the new tab runs under the same child id');
  assert.equal(env['BELLWETHER_PARENT'], PARENT_ID, 'and answers to the same parent');
  assert.equal(created[0]?.params['cwd'], before.cwd, 'in the same directory');

  // 2. A new pane, and the old one closed on the child's machine.
  assert.notEqual(after.paneId, PANE);
  assert.ok(space.world.panes.has(after.paneId), 'the record names the pane that now runs the child there');
  assert.equal(space.world.panes.has(PANE), false, 'the old pane is gone');
  assert.deepEqual(calls(space.far, 'tab.close').map((request) => request.params['tab_id']), [TAB]);
  assert.match(reply, new RegExp(`in pane ${after.paneId}`));

  // 3. The conversation resumed: the harness started on the same session.
  const [start] = harnessStarts(space.far);
  assert.ok(start, 'the harness started in the new pane');
  assert.deepEqual(start.args.slice(start.args.indexOf('--resume'), start.args.indexOf('--resume') + 2), ['--resume', SESSION]);
  assert.equal(space.world.panes.get(after.paneId)?.agent_session?.value, SESSION);
  assert.equal(after.session?.value, SESSION);

  // 4. The parent's record is otherwise unchanged, and it records the restart.
  assert.deepEqual(identity(after), identity(before));
  assert.equal(after.host, 'child-box');
  assert.ok(after.restartedAt, 'the record carries the restart');
  assert.equal(after.startingUntil, undefined);
  assert.equal(after.exitedAt, undefined);
});

/** A daemon on the child's machine from 0.1.9: it serves the relay and answers anything newer with unknown_type. */
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
          socket.write(`${JSON.stringify({ type: 'relay-hello', protocol: 4, pid: process.pid, waiting: 0, version: '0.1.9', build: '150094f' })}\n`);
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

/** Nothing happened on the child's machine, and the parent's record is as it was. */
function unchanged(space: Room, before: ChildRecord): void {
  assert.deepEqual(child(), before, "the parent's record is exactly as it was");
  assert.equal(calls(space.far, 'tab.create').length, 0, 'no tab opened on the child machine');
  assert.equal(calls(space.far, 'tab.close').length + calls(space.far, 'pane.close').length, 0, 'nothing closed on the child machine');
  assert.deepEqual(harnessStarts(space.far), [], 'no harness started');
  assert.ok(space.world.panes.has(PANE), 'the child still runs in its pane');
}

test('a far daemon that predates the restart request is refused by name, with the release that brings it, and nothing changes', async (t) => {
  const space = await room(t, { farDaemon: olderDaemon });
  const before = child();
  await assert.rejects(space.parent.tool('agent_restart', { target: NAME }), /first-mate runs on machine child-box, and it was not restarted: machine child-box runs bellwether 0\.1\.9 build 150094f, which does not serve relay-restart: that takes the relay-restart request, which came with bellwether 0\.1\.10\. Update @elecnix\/bellwether on machine child-box\./);
  unchanged(space, before);
  assert.notEqual(space.links.state('child-box')?.status, 'reconnecting', 'an unknown request does not end the relay');
});

test('a child machine with no herdr is refused by name, and nothing changes', async (t) => {
  const space = await room(t, { farHerdrSocket: '/tmp/bw-no-herdr-here/herdr.sock' });
  const before = child();
  await assert.rejects(space.parent.tool('agent_restart', { target: NAME }), /first-mate runs on machine child-box, and it was not restarted: no herdr answers on that machine at \/tmp\/bw-no-herdr-here\/herdr\.sock/);
  unchanged(space, before);
});

test('a session that is not on the child machine is refused by name, and nothing changes', async (t) => {
  const space = await room(t, { noTranscript: true });
  const before = child();
  await assert.rejects(space.parent.tool('agent_restart', { target: NAME }), new RegExp(`first-mate runs on machine child-box, and it was not restarted: session ${SESSION} is not on that machine: Claude Code has not written `));
  unchanged(space, before);
});

function parentRestartLog(): Record<string, unknown>[] {
  const file = path.join(process.env['BELLWETHER_HOME'] as string, 'restart.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

// Issue #211, item 4: the relay drops after the far side closed the old tab.
// The far daemon finishes the restart, and its answer is lost with the
// connection. The parent must not claim an outcome it has not seen: its reply
// says it does not know, and it learns the outcome from the far side when the
// connection returns.
test('a restart whose relay drops before the answer says the outcome is unknown, and the parent learns it from the far side on reconnect', async (t) => {
  const space = await room(t);
  let dropped: Promise<number> | undefined;
  const answer = space.world.answer.bind(space.world);
  space.world.answer = (request) => {
    const result = answer(request);
    if (request.method === 'tab.close' && request.params['tab_id'] === TAB && !dropped) dropped = space.ssh.drop();
    return result;
  };

  const outcome = await space.parent.tool('agent_restart', { target: NAME }).then((text) => `ok: ${text}`, (error: Error) => `refused: ${error.message}`);
  await dropped;
  assert.doesNotMatch(outcome, /it was not restarted/, 'the parent did not see the outcome, so it must not assert one');
  assert.match(outcome, /does not know whether/);
  assert.equal(parentRestartLog().at(-1)?.['outcome'], 'unknown');

  const record = await until('the parent to learn the outcome from child-box', () => {
    const now = child();
    return now.restartInDoubt === undefined && now.paneId !== PANE ? now : undefined;
  });
  assert.equal(space.world.panes.get(record.paneId)?.agent_session?.value, SESSION, `the record names ${record.paneId}, where the session runs`);
  assert.equal(record.restartFailed, undefined);
  assert.equal(record.id, CHILD_ID);
  assert.equal(parentRestartLog().at(-1)?.['outcome'], 'restarted');
  assert.equal(parentRestartLog().at(-1)?.['learned'], true);
});

// While the outcome is unknown, a second restart could start a second copy of
// the session there, so it is refused, and doctor says what the record waits for.
test('a child whose restart outcome is unknown is refused a second restart, and doctor names the doubt', async (t) => {
  const space = await room(t);
  const at = new Date().toISOString();
  updateChild(PARENT_ID, CHILD_ID, (entry) => {
    answerLost(entry, { host: 'child-box', requestId: 'rs-example', at, oldPane: PANE, oldTab: TAB, error: 'the connection to machine child-box ended: example', launch: {} });
  });

  await assert.rejects(space.parent.tool('agent_restart', { target: NAME }), /the outcome of the last restart of first-mate on machine child-box is unknown since .*, so a second restart could start the session twice/);
  assert.equal(calls(space.far, 'tab.create').length, 0, 'nothing opened there');
  const lines = restartWaitLines(listParents());
  assert.ok(lines.some((line) => /^warn  restart: first-mate \(child child-far of claude-code-the-parent\) on machine child-box: the answer to its restart at .* was lost with the connection, so the outcome is unknown/.test(line)), JSON.stringify(lines));
});
