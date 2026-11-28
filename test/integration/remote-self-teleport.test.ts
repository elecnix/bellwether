// Tier 2: a child on another machine teleports itself (issue #226). Its
// request goes to the daemon on the machine it runs on, which holds no
// registry for it, only the relay record a spawn or a move left there. As a
// retirement request does since #239, it travels to the daemon that holds the
// record, the parent's, through that machine's relay outbox. The parent's
// daemon writes it on the child's record and hands it to the parent's service,
// which waits for the child's turn to end and teleports it, as
// self-teleport.test.ts shows for a child on the parent's machine.
//
// Two machines are two Bellwether homes in one temporary root, joined by the
// fake ssh. The parent's daemon runs in this process with a stub service. The
// child's daemon is a real process that the child's own session starts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, saveRelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type ParentService } from '../../src/daemon/server.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');
const PARENT_ID = 'claude-code-the-parent';
/** The directory the child runs in on the machine it moved to. */
const FAR_CWD = '/far/x/feat-x';

interface World {
  root: string;
  parentHome: string;
  childHome: string;
  ssh: FakeSsh;
  logs: string[];
  closers: (() => Promise<void> | void)[];
}

function world(t: test.TestContext): World {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-tport-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { 'child-box': { home: childHome, userHome: path.dirname(childHome) } });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'], herdr: process.env['HERDR_BIN_PATH'] };
  // No herdr answers on the parent's machine, as on CI: a request that names its machine must not need one.
  process.env['HERDR_BIN_PATH'] = path.join(root, 'no-herdr');
  process.env['BELLWETHER_HOME'] = parentHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(parentHome, 'daemon.sock');
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await ssh.drop();
    await stopDaemonsUnder(root, childHome);
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    if (saved.herdr === undefined) delete process.env['HERDR_BIN_PATH'];
    else process.env['HERDR_BIN_PATH'] = saved.herdr;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, parentHome, childHome, ssh, logs: [], closers };
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

/** The parent's record of a child that now runs on `child-box`. */
function parentHolds(childId: string, extra: Partial<ChildRecord> = {}): void {
  const at = new Date().toISOString();
  if (!readParent(PARENT_ID)) saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(PARENT_ID, { id: childId, name: `child-${childId}`, kind: 'claude', harness: 'claude-code', paneId: 'w2:p7', tabId: 'w2:t7', host: 'child-box', cwd: FAR_CWD, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra });
}


/** The relay record that `relay-register` writes on the child's machine, at a spawn there or a move there. */
function childHolds(w: World, childId: string): void {
  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: `child-${childId}`, kind: 'claude', parentId: PARENT_ID, cwd: FAR_CWD, registeredAt: new Date().toISOString() }));
}


/** A parent service that records each teleport the daemon hands it, in place of the wait and the crossing that self-teleport.test.ts covers. */
function stubService(armed: string[]): ParentService {
  return { tool: async (name) => `the session service ran ${name}`, markRead: () => {}, onEvents: () => {}, pending: () => [], watchPane: () => () => {}, stop: () => {}, teleport: (childId) => armed.push(childId) };
}

async function parentDaemon(w: World, armed: string[] = []): Promise<RelayLinks> {
  const links = new RelayLinks({ resolve: async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }), initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, log: (line) => w.logs.push(line) });
  const daemon = await startDaemon({ socketPath: path.join(w.parentHome, 'daemon.sock'), home: w.parentHome, factory: () => stubService(armed), links, log: (line) => w.logs.push(line) });
  w.closers.push(() => daemon.close());
  return links;
}

/** The parent's own session, connected to its daemon, so that daemon runs a service for it. */
async function parentSession(w: World): Promise<DaemonClient> {
  const client = await DaemonClient.connect({ harness: 'claude-code', session: 'the-parent', cwd: '/work', host: os.hostname(), paneId: 'w1:p1', depth: 0, herdrSocket: path.join(w.root, 'no-herdr.sock') }, { home: w.parentHome, socketPath: path.join(w.parentHome, 'daemon.sock'), spawn: false });
  w.closers.push(() => client.close());
  return client;
}

/** The child's own Bellwether server on `child-box`, which starts that machine's daemon when none runs. */
async function childSession(w: World, childId: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(
    { harness: 'claude-code', session: `session-${childId}`, cwd: FAR_CWD, host: 'child-box', depth: 1, herdrSocket: path.join(w.root, 'no-herdr.sock'), childId, paneId: 'w2:p7' },
    { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock') },
  );
  w.closers.push(() => client.close());
  return client;
}

function doctorOn(w: World, home: string): Promise<string> {
  const env = { ...process.env, BELLWETHER_HOME: home, BELLWETHER_DAEMON_SOCKET: path.join(home, 'daemon.sock'), HERDR_SOCKET_PATH: path.join(w.root, 'no-herdr.sock') };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'doctor'], { env, encoding: 'utf8' }, (_error, stdout) => resolve(stdout));
  });
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(25);
  }
}

function childOf(childId: string): ChildRecord | undefined {
  return readParent(PARENT_ID)?.children.find((entry) => entry.id === childId);
}


test("a child on another machine that teleports itself reaches its parent's daemon, which records the request and hands it to the parent's service", async (t) => {
  const w = world(t);
  parentHolds('c-tp', { session: { kind: 'id', value: 'sess-far' } });
  childHolds(w, 'c-tp');
  const armed: string[] = [];
  const links = await parentDaemon(w, armed);
  await parentSession(w);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-tp');
  const answer = await client.tool('agent_teleport', { machine: 'local', cwd: '/work/x', reason: 'it needs more memory' });
  assert.match(answer, /^Not this machine's child/, answer);
  assert.match(answer, new RegExp(`The daemon of parent ${PARENT_ID}, which holds your record, took the request`), answer);
  assert.match(answer, new RegExp(`child-c-tp is teleported to machine ${os.hostname()}, directory /work/x, once this turn ends`), 'the destination reads as a machine the child can name, never "this machine"');
  assert.match(answer, /your next input there is the notice/);

  const child = childOf('c-tp');
  assert.equal(child?.teleportRequest?.machine, 'local');
  assert.equal(child?.teleportRequest?.cwd, '/work/x');
  assert.equal(child?.teleportRequest?.reason, 'it needs more memory');
  assert.equal(child?.teleportRequest?.wait?.paneId, 'w2:p7', "the wait is on the child's pane on its own machine");
  assert.deepEqual(armed, ['c-tp'], "the parent's service starts the wait");
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the child machine to drop its copy once acknowledged');
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-tp'))?.teleportRequest, undefined, 'nothing waits on the child machine');
});

test("with no parent daemon connected, the child is told the request waits, doctor there shows it, and the parent's daemon takes it when it connects", async (t) => {
  const w = world(t);
  parentHolds('c-wait', { session: { kind: 'id', value: 'sess-far' } });
  childHolds(w, 'c-wait');

  const client = await childSession(w, 'c-wait');
  const answer = await client.tool('agent_teleport', { machine: 'local', cwd: '/work/x' });
  assert.match(answer, /That daemon is not connected to this machine now/, answer);
  assert.match(answer, /you keep running here as you are/);
  assert.match(answer, /your next input after that is the notice/);
  const waiting = inHome(w.childHome, () => listForwards());
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0]?.teleport, { machine: 'local', cwd: '/work/x' });
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-wait'))?.teleportRequest?.machine, 'local');
  const doctor = await doctorOn(w, w.childHome);
  assert.match(doctor, /warn {2}teleport: child-c-wait \(child c-wait\) asked at .* to be teleported to machine local\. This machine does not hold its record/, doctor);
  assert.equal(childOf('c-wait')?.teleportRequest, undefined, 'nothing reached the parent yet');

  const links = await parentDaemon(w);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');
  await until(() => childOf('c-wait')?.teleportRequest !== undefined, "the parent's daemon to take the request when it connects", 20_000, () => childOf('c-wait'));
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the child machine to drop its copy');
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-wait'))?.teleportRequest, undefined);
});

test("a teleport the parent's daemon refuses comes back as the answer, writes nothing, and an adopted child is refused on its own machine", async (t) => {
  const w = world(t);
  // The parent's record has no session for it: nothing to resume at the destination.
  parentHolds('c-nosession');
  childHolds(w, 'c-nosession');
  const armed: string[] = [];
  const links = await parentDaemon(w, armed);
  await parentSession(w);
  await until(() => links.state('child-box')?.status === 'connected', 'the parent to connect to child-box');

  const client = await childSession(w, 'c-nosession');
  const answer = await client.tool('agent_teleport', { machine: 'local', cwd: '/work/x' });
  assert.match(answer, /refused to teleport child-c-nosession/, answer);
  assert.match(answer, /has no recorded session/);
  assert.equal(childOf('c-nosession')?.teleportRequest, undefined);
  assert.deepEqual(armed, []);
  await until(() => inHome(w.childHome, () => listForwards()).length === 0, 'the refusal to clear the child machine');

  inHome(w.childHome, () => saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'c-adopted', name: 'child-c-adopted', kind: 'claude', parentId: PARENT_ID, paneId: 'w2:p9', adopted: true, registeredAt: new Date().toISOString() }));
  const adopted = await childSession(w, 'c-adopted');
  assert.match(await adopted.tool('agent_teleport', { machine: 'local' }), /child-c-adopted is an adopted child/);
  assert.deepEqual(inHome(w.childHome, () => listForwards()), [], 'nothing crossed for an adopted child');
});
