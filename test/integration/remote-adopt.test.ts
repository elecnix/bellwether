// Tier 2: adopting an agent on another machine (issue #118). Two machines are
// two Bellwether homes in one temporary root, joined by the fake ssh, as in
// remote-report.test.ts. The child's machine has a herdr of its own, a fake
// one, which the parent's watcher reads as it reads a remote child it
// spawned. The parent's relay links ask the daemon on the child's machine,
// through `bellwether relay-bridge`, to record the adoption, and that daemon
// decides who already watches the pane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, readRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const PARENT_ID = 'claude-code-the-parent';
const PANE = 'w1:p5';
const SESSION = 'sess-far-0001';
const LIMITS = { idleMs: 40, blockedMs: 20, stuckMs: 60_000 };

/** The agent in pane w1:p5 on child-box, plus an empty pane w1:p4 and a watched one w1:p6. */
class FarPane {
  status = 'idle';
  seq = 3;
  stateSeq = 1;
  fake!: FakeHerdr;
  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.info() } };
    if (request.method === 'agent.list') return { result: { type: 'agent_list', agents: [this.info(), this.info('w1:p6', 'watched', 'sess-other')] } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [this.info()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [this.bare(PANE), this.bare('w1:p4'), this.bare('w1:p6')] } };
    if (request.method === 'pane.read') return { result: { type: 'pane_read', read: { pane_id: PANE, source: request.params['source'], format: 'text', text: 'far screen' } } };
    return undefined;
  };
  private bare(paneId: string): Record<string, unknown> {
    return { pane_id: paneId, workspace_id: 'w1', tab_id: `w1:t${paneId.slice(4)}`, terminal_id: `term-${paneId}`, agent_status: 'unknown' };
  }
  private info(paneId = PANE, name = 'first-mate', session = SESSION): Record<string, unknown> {
    return { pane_id: paneId, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: `term-${paneId}`, agent: 'claude', name, agent_status: paneId === PANE ? this.status : 'idle', agent_session: { value: session }, completion_seq: this.seq, state_change_seq: this.stateSeq, cwd: '/far/work' };
  }
  /** herdr's status event on the child's machine. */
  set(status: string, endsTurn = false): void {
    if (endsTurn) this.seq += 1;
    this.status = status;
    this.stateSeq += 1;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent_status: status, completion_seq: this.seq, state_change_seq: this.stateSeq } });
  }
}

interface World {
  root: string;
  parentHome: string;
  childHome: string;
  ssh: FakeSsh;
  far: FakeHerdr;
  pane: FarPane;
  links: RelayLinks;
  watcher: Watcher;
  ctx: ToolContext;
  /** While true, the parent cannot reach the herdr on child-box, as when the SSH link is down. */
  setDown(down: boolean): void;
  /** Move the watcher's clock forward, as a long outage would. */
  advance(ms: number): void;
  published: OutboxEntry[];
  logs: string[];
}

function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

const profiles: MachineProfile[] = [{ id: 'child-box', label: 'child-box', target: 'child-box', session: 'default', enabled: true }];
const resolve = async (label: string): Promise<MachineProfile> => pickMachine(profiles, label);

async function world(t: test.TestContext, options: { farDaemon?: (socketPath: string) => Promise<() => Promise<void>> } = {}): Promise<World> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-adopt-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const stopFar = options.farDaemon ? await options.farDaemon(path.join(childHome, 'daemon.sock')) : undefined;

  const pane = new FarPane();
  const far = await startFakeHerdr({ respond: pane.respond });
  pane.fake = far;
  const near = await startFakeHerdr();
  let down = false;
  // The herdr bridge to child-box: a connection that fails while the link is down.
  const farClient = new HerdrClient({
    label: 'machine:child-box',
    dial: (onReady) => {
      const socket = net.createConnection(down ? path.join(root, 'no-such-herdr.sock') : far.socketPath);
      socket.on('connect', onReady);
      return socket;
    },
  });
  const nearClient = new HerdrClient({ socketPath: near.socketPath });
  const clientFor = async (host: string): Promise<HerdrClient> => {
    if (host === 'local') return nearClient;
    await resolve(host);
    return farClient;
  };

  const logs: string[] = [];
  const links = new RelayLinks({ resolve, initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, heartbeatMs: 1_000, log: (line) => logs.push(line) });
  links.start(() => ({ refused: 'this case carries no reports' }));
  saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  const published: OutboxEntry[] = [];
  let skew = 0;
  const watcher = new Watcher({
    now: () => Date.now() + skew,
    client: nearClient,
    clientFor,
    parentId: PARENT_ID,
    limits: LIMITS,
    tickMs: 15,
    screenPollMs: 0,
    relayState: (host) => links.state(host),
    log: (line) => logs.push(`watcher: ${line}`),
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  const ctx: ToolContext = { client: nearClient, clientFor, parentId: PARENT_ID, watcher, remote: remoteOps(resolve, {}, links), relayState: (host) => links.state(host) };

  t.after(async () => {
    watcher.stop();
    links.stop();
    await ssh.drop();
    await stopFar?.();
    await stopDaemonsUnder(root, childHome);
    await far.stop();
    await near.stop();
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    parentHome,
    childHome,
    ssh,
    far,
    pane,
    links,
    watcher,
    ctx,
    published,
    logs,
    advance(ms) {
      skew += ms;
    },
    setDown(value) {
      down = value;
      if (value) far.hangUp();
    },
  };
}

async function until(what: string, check: () => boolean, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(20);
  }
}

function child(w: World): ChildRecord | undefined {
  return readParent(PARENT_ID)?.children.find((entry) => entry.paneId === PANE);
}

/** Whether the watcher subscribed to the pane's status on child-box. */
function subscribed(w: World): boolean {
  return w.far.requests.some((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(PANE));
}

function subscriptions(w: World): number {
  return w.far.requests.filter((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(PANE)).length;
}

/** agent_adopt, followed by the sync the daemon runs after every call, which keeps the relay open for the new child. */
async function adopt(w: World, args: Record<string, unknown> = { target: `child-box:${PANE}` }): Promise<string> {
  try {
    return await runBellwetherTool(w.ctx, 'agent_adopt', args);
  } finally {
    w.links.sync();
  }
}

function listRow(text: string): string {
  return text.split('\n').find((line) => line.includes(PANE)) ?? '';
}

test('a pane on another machine is adopted, its record names that machine and its session, and its status changes reach the parent', async (t) => {
  const w = await world(t);
  const text = await adopt(w);
  assert.match(text, /Adopted first-mate, a claude agent on machine child-box in pane w1:p5, as child \S+\. Bellwether watches it from now on\. Its harness session is sess-far-0001\./);
  assert.match(text, /cannot call parent_report/);

  const record = child(w);
  assert.ok(record, 'the parent holds the child');
  assert.equal(record.host, 'child-box');
  assert.equal(record.paneId, PANE);
  assert.equal(record.origin, 'adopt');
  assert.deepEqual(record.session, { kind: 'id', value: SESSION }, 'the session id comes from the far herdr');
  assert.equal(record.transcript, undefined, "a remote child's transcript stays on its own machine");

  // The child's machine records the adoption, so it can say who watches the pane.
  const claim = inHome(w.childHome, () => readRelayRecord(record.id));
  assert.equal(claim?.adopted, true);
  assert.equal(claim?.paneId, PANE);
  assert.equal(claim?.parentId, PARENT_ID);
  assert.equal(claim?.session, SESSION);
  assert.deepEqual(w.ssh.remoteCalls().map((call) => call.argv[0]), ['relay-bridge'], 'the claim went over the relay connection, not a command of its own');

  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event from child-box', () => w.published.some((entry) => entry.childId === record.id && entry.event === 'idle'), 5_000, () => w.published);

  // Adopting it again is the same child, and the far machine agrees.
  assert.match(await adopt(w, { target: PANE, machine: 'child-box' }), /already a child of this session/);
});

test('an unknown machine, an empty pane and a pane another parent watches there are each refused by name', async (t) => {
  const w = await world(t);
  await assert.rejects(adopt(w, { target: 'nowhere:w1:p5' }), /Cannot adopt w1:p5 on machine nowhere: herdr has no saved machine nowhere\. Saved machines: child-box\./);
  await assert.rejects(adopt(w, { target: 'w1:p4', machine: 'child-box' }), /Pane w1:p4 on machine child-box holds no agent herdr recognizes/);
  await assert.rejects(adopt(w, { target: 'w1:p5', machine: 'elsewhere' }), /herdr has no saved machine elsewhere/);
  await assert.rejects(adopt(w, { target: 'child-box:w1:p5', machine: 'other-box' }), /names machine other-box, but its target child-box:w1:p5 names machine child-box/);

  // A parent on the child's machine itself watches w1:p6: only that machine's registry knows it.
  inHome(w.childHome, () => {
    saveParent(emptyParent('pi', 'far-parent', '/far', { paneId: 'w1:p2' }));
    const at = new Date().toISOString();
    upsertChild('pi-far-parent', { id: 'far-kid', name: 'watched', kind: 'claude', harness: 'claude-code', paneId: 'w1:p6', host: 'local', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 });
  });
  await assert.rejects(adopt(w, { target: 'child-box:w1:p6' }), /Pane w1:p6 on machine child-box cannot be adopted: pane w1:p6 is already a child of pi-far-parent, a parent on that machine, as watched\.$/);

  // A parent on a third machine adopted w1:p5 there earlier: its claim sits in that machine's relay records.
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'third-kid', name: 'their-mate', kind: 'claude', parentId: 'claude-code-third-parent', registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: SESSION }));
  await assert.rejects(adopt(w), /Pane w1:p5 on machine child-box cannot be adopted: pane w1:p5 is already a child of claude-code-third-parent, a parent on another machine, as their-mate\.$/);
  assert.equal(readParent(PARENT_ID)?.children.length, 0, 'no refusal left a child record behind');

  // A claim on the same pane id for another session is stale: herdr reused the id after that agent ended.
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'third-kid', name: 'their-mate', kind: 'claude', parentId: 'claude-code-third-parent', registeredAt: new Date().toISOString(), paneId: PANE, adopted: true, session: 'sess-ended' }));
  assert.match(await adopt(w), /Adopted first-mate/);
  assert.equal(inHome(w.childHome, () => readRelayRecord('third-kid')), undefined, 'the stale claim is gone');
});

test('a dropped link shows the child unreachable, not exited, and the reconnect restores it without a second adoption', async (t) => {
  const w = await world(t);
  // A stuck threshold of one minute, which the outage below runs far past.
  await adopt(w, { target: `child-box:${PANE}`, stuck_minutes: 1 });
  const id = child(w)!.id;
  await until('the watcher to subscribe on child-box', () => subscribed(w));
  w.pane.set('working');
  await until('the record to say working', () => child(w)?.lastStatus === 'working');
  const before = subscriptions(w);

  w.setDown(true);
  await until('the watcher to count child-box unreachable', () => w.watcher.unreachable('child-box') !== undefined, 5_000, () => w.logs.slice(-5));
  const listed = listRow(await runBellwetherTool(w.ctx, 'agent_list', {}));
  assert.match(listed, /\tunreachable since \S+ \(last seen working\)\t/, listed);
  assert.doesNotMatch(listed, /exited/);
  // Six minutes pass on the watcher's clock: past the stuck threshold and the five-minute inactivity period.
  w.advance(6 * 60_000);
  // The parent hears it through the inactivity notice, which says the child is unreachable rather than gone.
  await until('the inactivity notice', () => w.published.some((entry) => entry.childId === id && entry.event === 'inactive'), 5_000, () => w.published);
  assert.match(w.published.find((entry) => entry.event === 'inactive')?.text ?? '', /Bellwether cannot reach herdr on machine child-box since \S+ \(.+\), so that status is the last one it saw: the child is unreachable, not exited/);
  await delay(300);
  assert.equal(child(w)?.exitedAt, undefined, 'a dropped link is not an exit');
  assert.ok(!w.published.some((entry) => entry.event === 'exited' || entry.event === 'stuck'), `a quiet link is neither an exit nor a stall: ${JSON.stringify(w.published)}`);

  w.setDown(false);
  await until('the watcher to reach child-box again', () => w.watcher.unreachable('child-box') === undefined && subscriptions(w) > before, 20_000, () => w.logs.slice(-5));
  assert.doesNotMatch(listRow(await runBellwetherTool(w.ctx, 'agent_list', {})), /unreachable/);
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event after the reconnect', () => w.published.some((entry) => entry.childId === id && entry.event === 'idle'), 5_000, () => w.published);
  assert.equal(readParent(PARENT_ID)?.children.length, 1, 'the same child, not a second adoption');
  assert.equal(child(w)?.id, id);
});

test('a restart of the daemon on the child machine is not the child exiting', async (t) => {
  const w = await world(t);
  await adopt(w);
  const id = child(w)!.id;
  await until('the relay to hold child-box open for the child', () => w.links.state('child-box')?.status === 'connected' && (w.links.state('child-box')?.children ?? []).includes(id));
  await until('the watcher to subscribe on child-box', () => subscribed(w));

  await stopDaemonsUnder(w.root, w.childHome);
  await until('the relay to notice the far daemon went', () => w.links.state('child-box')?.status === 'reconnecting', 10_000);
  await until('the relay to reconnect to a new far daemon', () => w.links.state('child-box')?.status === 'connected', 20_000, () => w.links.state('child-box'));
  assert.equal(child(w)?.exitedAt, undefined);
  assert.ok(!w.published.some((entry) => entry.event === 'exited'), JSON.stringify(w.published));

  // The new daemon there still knows who watches the pane, from the claim on disk.
  assert.match(await adopt(w), /already a child of this session/);
  w.pane.set('working');
  w.pane.set('idle', true);
  await until('the idle event after the far restart', () => w.published.some((entry) => entry.childId === id && entry.event === 'idle'), 5_000, () => w.published);
});

/**
 * A daemon from 0.1.5 on the child's machine: it serves the relay, and answers
 * a request it does not know the way 0.1.5's parser does.
 */
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
          socket.write(`${JSON.stringify({ type: 'relay-hello', protocol: 4, pid: process.pid, waiting: 0, version: '0.1.5', build: '97d8f82' })}\n`);
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

test('a machine whose Bellwether predates the request is refused with the version that brings it, and the relay stays up', async (t) => {
  const w = await world(t, { farDaemon: olderDaemon });
  await assert.rejects(adopt(w), /Pane w1:p5 on machine child-box cannot be adopted: machine child-box runs bellwether 0\.1\.5 build 97d8f82, which cannot adopt a pane for a parent on another machine: that takes the relay-adopt request, which came with bellwether 0\.1\.6\. Update @elecnix\/bellwether on machine child-box\.$/);
  assert.equal(readParent(PARENT_ID)?.children.length, 0);
  assert.notEqual(w.links.state('child-box')?.status, 'reconnecting', 'an unknown request does not end the relay');
});
