// Tier 2: a report from a child on another machine. Two machines are two
// Bellwether homes in one temporary root, joined by a fake ssh on PATH that
// runs each remote command against the home assigned to its target.
//
// The parent dials out. Its daemon runs in this process and holds one SSH
// connection to the child's machine, which runs `bellwether relay-bridge`
// there; the bridge starts that machine's daemon when none runs, as it would
// in use. The child's machine never runs ssh, which the fake ssh proves by
// recording every target it was asked for.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { relayChildPath, relayOutboxDir, spoolPath } from '../../src/core/paths.ts';
import { PI_EXTENSION_ENV, piExtensionEntry } from '../../src/core/pi-extension.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, saveForward, saveRelayRecord, type RelayRecord } from '../../src/core/relay-records.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from '../../src/core/version.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord, SpoolReport } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient, postReport } from '../../src/daemon/client.ts';
import { DAEMON_PROTOCOL, MAX_DAEMON_FRAME_BYTES, formatReply, formatRequest } from '../../src/daemon/protocol.ts';
import { RelayOutbox } from '../../src/daemon/relay.ts';
import { RelayLinks } from '../../src/daemon/relay-links.ts';
import { startDaemon, type Daemon, type ParentService } from '../../src/daemon/server.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdrOptions } from '../fixtures/fake-herdr.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');
const PARENT_ID = 'claude-code-the-parent';

interface World {
  root: string;
  /** The parent's machine: this process. */
  parentHome: string;
  /** The child's machine, reached as `child-box`. */
  childHome: string;
  ssh: FakeSsh;
  logs: string[];
  /** Run at the end of the case, newest first, so a client closes before its daemon. */
  closers: (() => Promise<void> | void)[];
}

/** Run `fn` with this process's Bellwether home pointed at `home`. */
function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

function world(t: test.TestContext, here: 'parent' | 'child' = 'parent'): World {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-relay-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const parentHome = path.join(root, 'parent', '.bellwether');
  const childHome = path.join(root, 'child', '.bellwether');
  for (const home of [childHome, parentHome]) fs.mkdirSync(home, { recursive: true });
  // `parent-box` is reachable too, so a hop toward it would succeed and be seen, not fail unseen.
  const ssh = installFakeSsh(t, root, {
    'child-box': { home: childHome, userHome: path.dirname(childHome) },
    'parent-box': { home: parentHome, userHome: path.dirname(parentHome) },
  });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  const local = here === 'parent' ? parentHome : childHome;
  process.env['BELLWETHER_HOME'] = local;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(local, 'daemon.sock');
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await ssh.drop();
    await stopDaemonsUnder(root, childHome);
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, parentHome, childHome, ssh, logs: [], closers };
}

function childRecord(id: string, host: string): ChildRecord {
  const at = new Date().toISOString();
  return { id, name: `child-${id}`, kind: 'claude', harness: 'claude-code', paneId: 'w1:p5', host, startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 };
}

/** The parent's machine holds the parent and a record of the child on `child-box`. */
function parentHolds(w: World, childId: string, extra: Partial<ChildRecord> = {}): void {
  inHome(w.parentHome, () => {
    if (!readParent(PARENT_ID)) saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
    upsertChild(PARENT_ID, { ...childRecord(childId, 'child-box'), ...extra });
  });
}

function relayRecord(childId: string): RelayRecord {
  return { schema: RELAY_SCHEMA, childId, name: `child-${childId}`, kind: 'claude', parentId: PARENT_ID, registeredAt: new Date().toISOString() };
}

/** The child's machine holds the relay record a spawn's `relay-register` writes there. */
function childHolds(w: World, childId: string): void {
  inHome(w.childHome, () => saveRelayRecord(relayRecord(childId)));
}

function spoolOf(home: string, parentId: string): SpoolReport[] {
  const file = inHome(home, () => spoolPath(parentId));
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpoolReport);
}

function waitingOn(home: string) {
  return inHome(home, () => listForwards());
}

/** A session service that must never be reached: the relay answers first, or the test says so. */
function stubService(): ParentService {
  return {
    tool: async (name) => `the session service ran ${name}`,
    markRead: () => {},
    onEvents: () => {},
    pending: () => [],
    watchPane: () => () => {},
    stop: () => {},
  };
}

const machines = async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true });

function links(w: World, options: Partial<ConstructorParameters<typeof RelayLinks>[0]> = {}): RelayLinks {
  return new RelayLinks({ resolve: machines, initialDelayMs: 50, maxDelayMs: 200, readTimeoutMs: 10_000, log: (line) => w.logs.push(line), ...options });
}

/** The parent's daemon, in this process, which dials out to every host its children run on. */
async function parentDaemon(w: World, relayLinks = links(w)): Promise<{ daemon: Daemon; links: RelayLinks }> {
  const daemon = await startDaemon({ socketPath: path.join(w.parentHome, 'daemon.sock'), home: w.parentHome, factory: () => stubService(), links: relayLinks, log: (line) => w.logs.push(line) });
  w.closers.push(() => daemon.close());
  return { daemon, links: relayLinks };
}

/** The child's daemon, in this process, for a case that runs on the child's machine. */
async function childDaemon(w: World): Promise<Daemon> {
  const outbox = new RelayOutbox({ ackWaitMs: 200, log: (line) => w.logs.push(line) });
  // No machine resolver at all: this daemon holds no remote child, and must never dial anything.
  const noLinks = links(w, { resolve: async (label) => { throw new Error(`the child's daemon tried to resolve ${label}`); } });
  const daemon = await startDaemon({ socketPath: path.join(w.childHome, 'daemon.sock'), home: w.childHome, factory: () => stubService(), relayOutbox: outbox, links: noLinks, log: (line) => w.logs.push(line) });
  w.closers.push(() => daemon.close());
  return daemon;
}

/** The child's own Bellwether server, as the spawn's MCP config starts it. */
async function childClient(w: World, childId: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(
    { harness: 'claude-code', session: `session-${childId}`, cwd: '/work', host: 'child-box', depth: 1, herdrSocket: path.join(w.root, 'no-herdr.sock'), childId, paneId: 'w1:p5' },
    { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock'), spawn: false },
  );
  w.closers.push(() => client.close());
  return client;
}

/** The child reports from its own machine, through that machine's daemon, as `parent_report` does. */
function childReports(w: World, childId: string, status: string, text: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, BELLWETHER_HOME: w.childHome, BELLWETHER_DAEMON_SOCKET: path.join(w.childHome, 'daemon.sock') };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'report', '--child', childId, '--status', status, '--text', text], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0, stdout, stderr });
    });
  });
}

/** `bellwether doctor` on the parent's machine, with herdr pointed at nothing. */
function doctor(w: World): Promise<string> {
  const env = { ...process.env, BELLWETHER_HOME: w.parentHome, BELLWETHER_DAEMON_SOCKET: path.join(w.parentHome, 'daemon.sock'), HERDR_SOCKET_PATH: path.join(w.root, 'no-herdr.sock') };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'doctor'], { env, encoding: 'utf8' }, (_error, stdout) => resolve(stdout));
  });
}

/** Wait for `check`. A timeout names what it waited for, and `state` says what it saw instead. */
async function until(check: () => boolean, what: string, timeoutMs = 20_000, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${state ? `; last seen: ${JSON.stringify(state())}` : ''}`);
    await delay(25);
  }
}

function connected(relayLinks: RelayLinks, host = 'child-box'): boolean {
  return relayLinks.state(host)?.status === 'connected';
}

test('a report written on the child while the parent is connected is delivered once, and the child never dials out', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-live');
  childHolds(w, 'c-live');
  const { links: relayLinks } = await parentDaemon(w);
  await until(() => connected(relayLinks), 'the parent to connect to child-box');

  const body = `--not-a-flag it's "done"\nsecond line $HOME \`id\``;
  const posted = await childReports(w, 'c-live', 'done', body);
  assert.equal(posted.code, 0, posted.stderr);
  assert.match(posted.stdout, /Reported done to the parent on another machine, as child-c-live/);

  const landed = spoolOf(w.parentHome, PARENT_ID);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]?.text, body);
  assert.equal(landed[0]?.childId, 'c-live');
  assert.equal(landed[0]?.childName, 'child-c-live', "the name comes from the parent machine's record");
  assert.match(landed[0]?.receipt ?? '', /^rp-[0-9a-f]{16}$/);
  assert.deepEqual(waitingOn(w.childHome), [], 'the child acknowledged it and cleared its outbox');

  assert.deepEqual([...new Set(w.ssh.targets())], ['child-box'], 'every ssh call went from the parent to the child');
  assert.deepEqual(w.ssh.remoteCalls().map((call) => [call.target, call.argv[0]]), [['child-box', 'relay-bridge']], 'one bridge, nothing run on the parent');
  assert.equal(w.ssh.calls().length, 1, 'one connection carried it');
  assert.ok(w.logs.some((line) => line.includes('connected to machine child-box')), w.logs.join('\n'));
});

test('a report written while the connection is down is delivered once on reconnect, and doctor says so', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-down');
  childHolds(w, 'c-down');
  const { links: relayLinks } = await parentDaemon(w);
  await until(() => connected(relayLinks), 'the first connection');
  const first = await doctor(w);
  assert.match(first, /ok\s+relay child-box: connected/);
  // The child's machine names its build in the relay hello, and doctor prints it, not only the version number.
  assert.equal(relayLinks.state('child-box')?.farBuild, BELLWETHER_BUILD_ID);
  assert.ok(first.includes(`running ${BELLWETHER_VERSION} build ${BELLWETHER_BUILD_ID}`), first);

  w.ssh.plan(Array.from({ length: 10_000 }, () => 'refuse' as const));
  assert.equal(await w.ssh.drop(), 1, 'the one open connection was cut');
  await until(() => relayLinks.state('child-box')?.status === 'reconnecting', 'the link to say reconnecting');
  await until(() => /refused/.test(relayLinks.state('child-box')?.lastError ?? ''), 'a refused reconnect');
  const down = await doctor(w);
  assert.match(down, /fail\s+relay child-box: reconnecting/);
  assert.match(down, /Connection refused/);

  const posted = await childReports(w, 'c-down', 'progress', 'written while nobody listened');
  assert.equal(posted.code, 0, posted.stderr);
  assert.match(posted.stdout, /saved as rp-[0-9a-f]{16}/);
  assert.match(posted.stdout, /collects it when it connects/);
  assert.equal(waitingOn(w.childHome).length, 1, 'the report waits on the child machine');
  assert.deepEqual(spoolOf(w.parentHome, PARENT_ID), []);

  w.ssh.plan([]);
  const seen = () => ({ link: relayLinks.state('child-box'), waiting: waitingOn(w.childHome).length });
  await until(() => spoolOf(w.parentHome, PARENT_ID).length === 1, 'the report to arrive after the reconnect', 20_000, seen);
  await until(() => connected(relayLinks), 'the link to say connected');
  await until(() => waitingOn(w.childHome).length === 0, 'the child outbox to empty');
  assert.equal(spoolOf(w.parentHome, PARENT_ID)[0]?.text, 'written while nobody listened');
  const up = await doctor(w);
  assert.match(up, /ok\s+relay child-box: connected/);
  assert.match(up, /last drain/);
  assert.ok(relayLinks.state('child-box')?.lastDrainAt, 'the drain is on the state');
  assert.ok(w.logs.some((line) => /lost machine child-box/.test(line)), w.logs.join('\n'));
  assert.ok(!w.ssh.targets().includes('parent-box'), 'the child never dialled the parent');
  await delay(200);
  assert.equal(spoolOf(w.parentHome, PARENT_ID).length, 1, 'no second copy arrived later');
});

test('a report the parent accepted but never acknowledged arrives again on reconnect and is accepted once', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-dup');
  childHolds(w, 'c-dup');
  // The parent wrote it, and the connection died before the acknowledgement reached the child.
  const receipt = 'rp-0123456789abcdef';
  const at = new Date().toISOString();
  inHome(w.childHome, () => saveForward({ receipt, childId: 'c-dup', parentId: PARENT_ID, status: 'done', text: 'once only', at }));
  inHome(w.parentHome, () => fs.mkdirSync(path.dirname(spoolPath(PARENT_ID)), { recursive: true }));
  fs.appendFileSync(inHome(w.parentHome, () => spoolPath(PARENT_ID)), `${JSON.stringify({ parentId: PARENT_ID, childId: 'c-dup', childName: 'child-c-dup', paneId: 'w1:p5', status: 'done', text: 'once only', receipt, at, seq: 1 })}\n`);

  const { links: relayLinks } = await parentDaemon(w);
  await until(() => waitingOn(w.childHome).length === 0, 'the child to hear the acknowledgement');
  assert.ok(connected(relayLinks));
  assert.deepEqual(spoolOf(w.parentHome, PARENT_ID).map((entry) => entry.receipt), [receipt], 'one copy');
  assert.ok(w.logs.some((line) => line.includes(`${receipt}`) && line.includes('already accepted')), w.logs.join('\n'));
});

test('the receiving daemon accepts a duplicate receipt once from bellwether report', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-dup2');
  const env = { ...process.env, BELLWETHER_HOME: w.parentHome, BELLWETHER_DAEMON_SOCKET: path.join(w.parentHome, 'daemon.sock') };
  const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'report', '--parent', PARENT_ID, '--child', 'c-dup2', '--receipt', 'rp-0123456789abcdef', '--status', 'done', '--text', 'once only'], { env, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Reported done/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already received/);
  assert.deepEqual(spoolOf(w.parentHome, PARENT_ID).map((entry) => [entry.receipt, entry.text]), [['rp-0123456789abcdef', 'once only']]);
  await stopDaemonsUnder(w.root, w.parentHome);
});

test("the child's daemon keeps a report for a remote parent on disk and runs no ssh at all", async (t) => {
  const w = world(t, 'child');
  saveRelayRecord(relayRecord('c-quiet'));
  await childDaemon(w);
  const client = await childClient(w, 'c-quiet');
  const text = await client.tool('parent_report', { status: 'done', text: 'kept here' });
  assert.match(text, /saved as rp-[0-9a-f]{16}/);
  assert.match(text, /Do not report it again/);
  await delay(300);
  assert.deepEqual(w.ssh.calls(), [], 'the child machine ran no ssh');
  const [entry, ...more] = listForwards();
  assert.equal(more.length, 0);
  assert.equal(entry?.text, 'kept here');
  assert.equal(entry?.parentId, PARENT_ID);
  assert.equal(readRelayRecord('c-quiet')?.unforwarded, 1, 'the relay record counts it');
  assert.equal(fs.statSync(path.join(relayOutboxDir(), `${entry?.receipt}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(relayOutboxDir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(relayChildPath('c-quiet')).mode & 0o777, 0o600);
});

test('a report too long for one relay line is refused on the child machine, and nothing is kept', async (t) => {
  const w = world(t, 'child');
  saveRelayRecord(relayRecord('c-big'));
  await childDaemon(w);
  // Quotes double in JSON, so this text fits the child's own request but not one relay line.
  const text = '"'.repeat(2_500_000);
  const outbox = new RelayOutbox({ ackWaitMs: 50 });
  await assert.rejects(outbox.report(relayRecord('c-big'), 'done', text), (error: Error) => {
    assert.match(error.message, /too long to cross to the parent's machine/);
    assert.match(error.message, /Nothing was saved/);
    return true;
  });
  assert.deepEqual(listForwards(), [], 'nothing waits that would cut every connection it is sent on');
  const fits = await outbox.report(relayRecord('c-big'), 'done', 'x'.repeat(1_000_000));
  assert.match(fits, /saved as/);
});

/** How many times the parent's daemon has dialled the child's machine. */
function dials(w: World): number {
  return w.ssh.targets().filter((target) => target === 'child-box').length;
}

test('a report that fits the child\'s request but escapes past one relay line does not make the parent reconnect in a loop', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-edge');
  childHolds(w, 'c-edge');
  const { links: relayLinks } = await parentDaemon(w);
  await until(() => connected(relayLinks), 'the connection');

  // Quotes double when JSON encodes them. Pick the most that still fit the request the child's
  // daemon reads, so the same text, with the receipt, parent and time added, overflows one relay line.
  const request = (text: string) => formatRequest({ type: 'report', id: 'r1', protocol: DAEMON_PROTOCOL, report: { childId: 'c-edge', status: 'done', text } }).length;
  const overhead = request('');
  const text = '"'.repeat(Math.floor((MAX_DAEMON_FRAME_BYTES - overhead) / 2));
  assert.ok(request(text) <= MAX_DAEMON_FRAME_BYTES, 'the child\'s daemon accepts the request');
  const relayLine = formatReply({ type: 'relay-report', report: { receipt: 'rp-0123456789abcdef', childId: 'c-edge', parentId: PARENT_ID, status: 'done', text, at: new Date().toISOString() } }).length;
  assert.ok(relayLine > MAX_DAEMON_FRAME_BYTES, `the relay line is ${relayLine}, over ${MAX_DAEMON_FRAME_BYTES}`);

  const outcome = postReport({ childId: 'c-edge', status: 'done', text }, { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock'), spawn: false }).then(
    (posted): { posted?: string; refused?: string } => ({ posted: posted.text }),
    (error: Error): { posted?: string; refused?: string } => ({ refused: error.message }),
  );
  // Long enough for several reconnects at a 50 to 200 ms backoff.
  await delay(2_000);
  assert.equal(dials(w), 1, `the parent dialled the child's machine ${dials(w)} times: the connection was cut and the same report came back`);
  assert.ok(connected(relayLinks), 'the one connection is still up');
  assert.ok(!w.logs.some((line) => /lost machine child-box/.test(line)), w.logs.filter((line) => /lost/.test(line)).join('\n'));

  const result = await outcome;
  assert.match(result.refused ?? '', /too long to cross to the parent's machine/, JSON.stringify(result).slice(0, 300));
  assert.deepEqual(waitingOn(w.childHome), [], 'nothing was kept to be sent again');
  assert.deepEqual(spoolOf(w.parentHome, PARENT_ID), []);
});

test('an over-long report already waiting on the child machine is set aside as refused, not sent on every reconnect', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-old');
  childHolds(w, 'c-old');
  // As an older Bellwether, or anything that wrote the outbox without the size check, would leave it.
  const receipt = 'rp-00000000000000aa';
  inHome(w.childHome, () => saveForward({ receipt, childId: 'c-old', parentId: PARENT_ID, status: 'done', text: '"'.repeat(2_500_000), at: new Date().toISOString() }));
  inHome(w.childHome, () => saveForward({ receipt: 'rp-00000000000000bb', childId: 'c-old', parentId: PARENT_ID, status: 'progress', text: 'the one after it', at: new Date(Date.now() + 1).toISOString() }));

  const { links: relayLinks } = await parentDaemon(w);
  await delay(2_500);
  // Under load the first connection can still be `connecting`, on attempt 0
  // with one dial, when the delay ends: 3 of 12 runs with every core busy,
  // after the fake ssh plan fix. So the case waits for it. The dial count is
  // checked after the next report arrives, so a redial in that time still
  // fails the case.
  await until(() => connected(relayLinks), 'the connection to the child machine');
  await until(() => spoolOf(w.parentHome, PARENT_ID).length === 1, 'the report after it to arrive');
  assert.equal(dials(w), 1, `the parent dialled the child's machine ${dials(w)} times: the over-long report cut each connection and came back on the next`);
  assert.equal(spoolOf(w.parentHome, PARENT_ID)[0]?.text, 'the one after it', 'the report behind it is not held up');
  const kept = waitingOn(w.childHome).find((entry) => entry.receipt === receipt) ?? inHome(w.childHome, () => listForwards()).find((entry) => entry.receipt === receipt);
  assert.match(kept?.refused ?? '', /too long to cross/, 'it stays on disk, marked refused');
});

test('a far end that answers with something other than the relay protocol says which machine to update', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-stale');
  // What 0.1.4 does with a command it does not know: print its usage and exit 1.
  const stale = path.join(w.root, 'stale-ssh');
  fs.writeFileSync(stale, '#!/bin/sh\necho "Usage: bellwether <daemon|drain|spawn|watch|list|read|send|stop|report|parents|doctor|version>"\nexit 1\n', { mode: 0o755 });
  const { links: relayLinks } = await parentDaemon(w, links(w, { ssh: stale }));
  await until(() => relayLinks.state('child-box')?.status === 'reconnecting', 'the link to fail');
  assert.match(relayLinks.state('child-box')?.lastError ?? '', /does not speak the relay protocol.*Update @elecnix\/bellwether on machine child-box/);
});

/**
 * Whether a process group still has a process that runs. A zombie does not
 * count: the frozen fake ssh cannot reap the shell it started, as sshd would.
 */
function groupAlive(group: number): boolean {
  const listing = execFileSync('ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8' });
  return listing.split('\n').some((line) => {
    const [pgid, stat] = line.trim().split(/\s+/);
    return Number(pgid) === group && !stat?.startsWith('Z');
  });
}

test('a bridge whose parent goes silent without closing the connection exits within three heartbeats, and an idle healthy one stays', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-beat');
  childHolds(w, 'c-beat');
  const heartbeatMs = 200;
  const { links: relayLinks } = await parentDaemon(w, links(w, { heartbeatMs }));
  await until(() => connected(relayLinks), 'the connection');

  // Idle but healthy: no report, no read, only the heartbeat, for well past the silence limit.
  await delay(heartbeatMs * 8);
  assert.ok(connected(relayLinks), 'the idle connection is still up');
  assert.equal(dials(w), 1, 'the heartbeat kept the idle bridge alive, so the parent never had to redial');

  // Now the link dies the way a network does: nothing more arrives, and nothing closes.
  const [group, ...others] = await w.ssh.freeze();
  assert.equal(others.length, 0, 'one connection was open');
  assert.ok(group && groupAlive(group), 'the bridge was running when the link froze');
  const frozeAt = Date.now();
  const bound = heartbeatMs * 3 + 2_000;
  await until(() => !groupAlive(group as number), `the bridge to exit within ${bound} ms of the parent going silent`, bound);
  const took = Date.now() - frozeAt;
  assert.ok(took >= heartbeatMs * 2, `the bridge waited out the silence (${took} ms) rather than exiting at once`);
});

test('a far end that fails before it answers the relay names its error line and the machine to update', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-crash');
  // What 0.1.4 prints for relay-bridge: a Node stack trace on stderr, with the error well above its last lines.
  const crashing = path.join(w.root, 'crashing-ssh');
  fs.writeFileSync(crashing, [
    '#!/bin/sh',
    "echo 'file:///x/dist/daemon/client.js:225' >&2",
    "echo '            throw new Error(`${reply.code}: ${reply.message}`);' >&2",
    "echo 'Error: invalid_hello: the parent needs a session, cwd, host and herdr socket' >&2",
    "echo '    at DaemonClient.handshake (file:///x/dist/daemon/client.js:225:19)' >&2",
    "echo '    at async main (file:///x/dist/cli.js:235:20)' >&2",
    "echo '    at async file:///x/dist/cli.js:381:20' >&2",
    "echo '' >&2",
    "echo 'Node.js v22.22.1' >&2",
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  const { links: relayLinks } = await parentDaemon(w, links(w, { ssh: crashing }));
  await until(() => relayLinks.state('child-box')?.status === 'reconnecting', 'the link to fail');
  const error = relayLinks.state('child-box')?.lastError ?? '';
  assert.match(error, /Error: invalid_hello: the parent needs a session, cwd, host and herdr socket/);
  assert.match(error, /relay-bridge came with Bellwether 0\.1\.5, and the bellwether that ssh runs on child-box is older/);
  assert.doesNotMatch(error, /at async/, 'stack frames are not the message');
  assert.doesNotMatch(error, /Node\.js v/);
});

test('a report for a child this machine holds is served here and never spooled for a remote parent', async (t) => {
  const w = world(t, 'child');
  await childDaemon(w);
  // This machine holds the parent, and a stale relay record names the same child.
  saveParent(emptyParent('claude-code', 'the-parent', '/work'));
  upsertChild(PARENT_ID, childRecord('c-local', 'local'));
  saveRelayRecord(relayRecord('c-local'));
  const client = await childClient(w, 'c-local');
  assert.equal(await client.tool('parent_report', { status: 'done', text: 'served here' }), 'the session service ran parent_report');
  assert.deepEqual(w.ssh.calls(), []);
  assert.deepEqual(listForwards(), []);
});

test('a relay child whose pane id matches a local child is still kept for its remote parent, by its child id', async (t) => {
  const w = world(t, 'child');
  saveRelayRecord(relayRecord('c-shared'));
  saveParent(emptyParent('pi', 'local-parent', '/work'));
  upsertChild('pi-local-parent', childRecord('c-other', 'local'));
  await childDaemon(w);
  const client = await childClient(w, 'c-shared');
  assert.match(await client.tool('parent_report', { status: 'done', text: 'mine' }), /saved as/);
  assert.equal(spoolOf(w.childHome, 'pi-local-parent').length, 0, 'the local child got nothing');
  assert.equal(listForwards()[0]?.childId, 'c-shared');
});

test('agent_read for a remote child reads through the open connection, and says plainly when the host is unreachable', async (t) => {
  const w = world(t);
  const session = '7f3c2a10-aaaa-bbbb-cccc-000000000001';
  const cwd = '/work/far';
  const transcriptDir = path.join(path.dirname(w.childHome), '.claude', 'projects', claudeProjectDir(cwd));
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${session}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the remote answer' }] } })}\n`);
  parentHolds(w, 'c-read', { cwd, session: { kind: 'id', value: session }, lastReport: { status: 'done', text: 'the reported answer', at: new Date().toISOString(), seq: 1 } });
  childHolds(w, 'c-read');

  const { links: relayLinks } = await parentDaemon(w);
  await until(() => connected(relayLinks), 'the connection');
  const hops = w.ssh.calls().length;
  const client = new HerdrClient({ socketPath: path.join(w.root, 'no-herdr.sock') });
  const remote = remoteOps(machines, {}, relayLinks);
  const ctx = { client, clientFor: async () => client, parentId: PARENT_ID, watcher: new Watcher({ client, parentId: PARENT_ID, onEntries: () => {} }), remote };

  assert.equal((await runBellwetherTool(ctx, 'agent_read', { child: 'c-read' })).trim(), 'the remote answer');
  assert.equal(w.ssh.calls().length, hops, 'no new ssh hop: the read went over the open connection');
  assert.ok(!w.ssh.remoteCalls().some((call) => call.argv[0] !== 'relay-bridge'), 'nothing but the bridge ran on the child machine');

  w.ssh.plan(Array.from({ length: 10_000 }, () => 'refuse' as const));
  await w.ssh.drop();
  await until(() => relayLinks.state('child-box')?.status === 'reconnecting', 'the link to drop');
  const fallback = await runBellwetherTool(ctx, 'agent_read', { child: 'c-read' });
  assert.match(fallback, /machine child-box is unreachable/);
  assert.match(fallback, /reconnecting/);
  assert.match(fallback, /the reported answer/);
});

test('an unreachable host shows in agent_list, and the inactivity notice says the parent is not hearing from it', async (t) => {
  const w = world(t);
  w.ssh.plan(Array.from({ length: 10_000 }, () => 'refuse' as const));
  const quiet = new Date(Date.now() - 10 * 60_000).toISOString();
  parentHolds(w, 'c-far', { lastStatus: 'idle', statusChangedAt: quiet, lastBusyAt: quiet, lastActivityAt: quiet, inactiveMs: 60_000 } as Partial<ChildRecord>);
  const { links: relayLinks } = await parentDaemon(w);
  await until(() => /refused/.test(relayLinks.state('child-box')?.lastError ?? ''), 'a refused connection');

  const client = new HerdrClient({ socketPath: path.join(w.root, 'no-herdr.sock') });
  const entries: string[] = [];
  const watcher = new Watcher({ client, clientFor: async () => client, parentId: PARENT_ID, onEntries: (list) => entries.push(...list.map((entry) => `${entry.event}: ${entry.text}`)), tickMs: 20, relayState: (host) => relayLinks.state(host) });
  const ctx = { client, clientFor: async () => client, parentId: PARENT_ID, watcher, remote: remoteOps(machines, {}, relayLinks), relayState: (host: string) => relayLinks.state(host) };
  const listing = await runBellwetherTool(ctx, 'agent_list', {});
  assert.match(listing, /child-box \(not heard from: reconnecting/);

  watcher.start();
  t.after(() => watcher.stop());
  await until(() => entries.some((entry) => entry.startsWith('inactive:')), 'the inactivity notice');
  const notice = entries.find((entry) => entry.startsWith('inactive:')) ?? '';
  assert.match(notice, /Bellwether is not hearing from machine child-box/);
  assert.match(notice, /Connection refused/);
});

test("a spawn on another machine registers the child there and starts it with that machine's MCP config", async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('claude-code', 'spawner', '/work', { workspaceId: 'w1' }));
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
  herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  t.after(() => herdr?.stop());
  const ops = remoteOps(machines);
  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'far-away', host: 'child-box', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry) => ops.register(parent, entry) });

  const [remote] = w.ssh.remoteCalls();
  assert.equal(remote?.target, 'child-box');
  assert.deepEqual(remote?.argv, ['relay-register', '--child', child.id, '--name', 'far-away', '--kind', 'claude', '--parent', parent.id], 'no parent address: the child never dials back');
  const record = inHome(w.childHome, () => readRelayRecord(child.id));
  assert.equal(record?.parentId, parent.id);
  assert.equal((record as unknown as Record<string, unknown>)['parentHost'], undefined);
  const start = herdr.requests.find((request) => request.method === 'agent.start');
  const args = (start?.params['args'] as string[]) ?? [];
  const mcp = args.find((arg) => arg.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? '';
  assert.ok(mcp.startsWith(path.join(w.childHome, 'mcp')), `the config is the remote machine's: ${mcp}`);
  assert.ok(!fs.existsSync(path.join(w.parentHome, 'mcp')), 'none was written on the parent machine');
  assert.equal(readParent(parent.id)?.children[0]?.host, 'child-box');
});

test('a Claude Code spawn on another machine whose registration fails is refused, because no server there would carry its child id', async (t) => {
  const w = world(t);
  w.ssh.plan(['refuse']);
  const parent = saveParent(emptyParent('pi', 'spawner-fail', '/work'));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(machines);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'unregistered', host: 'child-box', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry) => ops.register(parent, entry) }),
    /unregistered was not started on machine child-box: Bellwether could not register it there: .*255.*no Bellwether server that carries its child id.*parent_report would reach no parent/s,
  );
  assert.equal(readParent(parent.id)?.children.length, 0, 'the record goes with the refusal');
  assert.equal(herdr.requests.some((request) => request.method === 'tab.create'), false, 'no tab opens for a child that could not report');
});

test('a pi spawn on another machine starts with the extension that machine resolves', async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('pi', 'pi-spawner', '/work', { workspaceId: 'w1' }));
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const ops = remoteOps(machines);
  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'pi', name: 'far-pi', host: 'child-box', prompt: 'report back' }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) });
  assert.deepEqual(w.ssh.remoteCalls()[0]?.argv.slice(0, 6), ['relay-register', '--child', child.id, '--name', 'far-pi', '--kind']);
  // The fake machine runs this checkout's CLI, so its package resolves the same file.
  assert.deepEqual(startArgs(herdr).slice(0, 2), ['-e', piExtensionEntry()]);
  const create = herdr.requests.find((request) => request.method === 'tab.create');
  assert.equal((create?.params['env'] as Record<string, string>)[PI_EXTENSION_ENV], piExtensionEntry());
});

test('a pi spawn on another machine whose registration fails starts nothing, since no extension path is known', async (t) => {
  const w = world(t);
  w.ssh.plan(['refuse']);
  const parent = saveParent(emptyParent('pi', 'pi-spawner-fail', '/work'));
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const ops = remoteOps(machines);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'pi', name: 'unregistered', host: 'child-box' }, undefined, { registerRemote: (entry) => ops.register(parent, entry) }),
    /child-box.*pi extension.*255/s,
  );
  assert.deepEqual(readParent(parent.id)?.children, []);
  assert.equal(herdr.requests.some((request) => request.method === 'tab.create'), false);
});

/** A fake herdr whose new pane goes idle after the start, so a Claude Code spawn gets past its dialog wait. */
async function idleHerdr(t: test.TestContext, respond?: FakeHerdrOptions['respond']): Promise<Awaited<ReturnType<typeof startFakeHerdr>>> {
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
  herdr = await startFakeHerdr({
    respond: (request) => {
      const answer = respond?.(request);
      if (answer) return answer;
      if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  t.after(() => herdr?.stop());
  return herdr;
}

function startArgs(herdr: Awaited<ReturnType<typeof startFakeHerdr>>): string[] {
  return (herdr.requests.find((request) => request.method === 'agent.start')?.params['args'] as string[]) ?? [];
}

test('a spawn on another machine copies the brief there over ssh, and points the child at that copy', async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('claude-code', 'brief-sender', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(machines);
  const brief = 'Line one of the task.\nLine two, with a \'quote\' and $HOME left alone.\n';
  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'briefed', host: 'child-box', prompt: brief, startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) });

  const remoteBrief = path.join(w.childHome, 'prompts', `${child.id}.md`);
  assert.equal(fs.readFileSync(remoteBrief, 'utf8'), brief, 'the brief arrived whole on the child\'s machine');
  assert.equal(fs.statSync(remoteBrief).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(w.parentHome, 'prompts', `${child.id}.md`)), 'no brief was left on the parent\'s machine');
  assert.ok(startArgs(herdr).includes(`@${remoteBrief}`), `the child is pointed at the copy that exists where it runs: ${startArgs(herdr).join(' ')}`);
  // The brief never rode on a command line, on either machine.
  for (const argv of w.ssh.calls()) assert.ok(!argv.join(' ').includes('Line one of the task'));
  for (const call of w.ssh.remoteCalls()) assert.ok(!call.argv.join(' ').includes('Line one of the task'));
  assert.ok(w.ssh.remoteCalls()[0]?.argv.includes('--brief-stdin'));

  // The child's exit takes the copy with it.
  await ops.cleanup(child);
  assert.ok(!fs.existsSync(remoteBrief));
  assert.ok(!fs.existsSync(path.join(w.childHome, 'mcp', `${child.id}.json`)));
  assert.equal(inHome(w.childHome, () => readRelayRecord(child.id)), undefined, 'no report waited, so the relay record went too');
});

test('a spawn on another machine whose brief cannot be copied fails, with no tab and no record', async (t) => {
  const w = world(t);
  w.ssh.plan(['refuse']);
  const parent = saveParent(emptyParent('claude-code', 'brief-lost', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(machines);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'mute', host: 'child-box', prompt: 'do the thing', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) }),
    /mute was not started on machine child-box, because its brief could not be copied there: ssh child-box exited with 255/,
  );
  assert.equal(herdr.requests.filter((request) => request.method === 'tab.create').length, 0, 'no tab was opened');
  assert.equal(herdr.requests.filter((request) => request.method === 'agent.start').length, 0);
  assert.deepEqual(readParent(parent.id)?.children, [], 'the record went with the spawn');
  assert.ok(!fs.existsSync(path.join(w.parentHome, 'prompts')) || fs.readdirSync(path.join(w.parentHome, 'prompts')).length === 0);
});

test('a spawn that fails after its brief was copied removes the copy on the child\'s machine', async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('pi', 'start-fails', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t, (request) => (request.method === 'agent.start' ? { error: { code: 'agent_start_failed', message: 'no such agent kind' } } : undefined));
  const ops = remoteOps(machines);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'pi', name: 'never-ran', host: 'child-box', prompt: 'a task' }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text), cleanupRemote: (entry) => ops.cleanup(entry) }),
    /no such agent kind/,
  );
  const [registered] = w.ssh.remoteCalls();
  const childId = registered?.argv[registered.argv.indexOf('--child') + 1] ?? '';
  assert.ok(childId);
  assert.ok(w.ssh.remoteCalls().some((call) => call.argv[0] === 'relay-cleanup' && call.argv.includes(childId)));
  assert.ok(!fs.existsSync(path.join(w.childHome, 'prompts', `${childId}.md`)), 'the copied brief is gone');
});

/** A git repository on the child's machine, where a child would start. */
function childWorktree(w: World): string {
  const cwd = path.join(w.root, 'child', 'work');
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '--quiet', cwd]);
  return cwd;
}

test("a spawn on another machine writes the brief inside the child's working directory there, where git ignores it", async (t) => {
  const w = world(t);
  const cwd = childWorktree(w);
  const parent = saveParent(emptyParent('claude-code', 'brief-in-cwd', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(machines);
  const brief = 'Do the task.\nThen call parent_report.\n';
  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'in-cwd', host: 'child-box', cwd, prompt: brief, startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) });

  const file = path.join(cwd, '.bellwether', `brief-${child.id}.md`);
  assert.equal(fs.readFileSync(file, 'utf8'), brief, "the brief is inside the directory the child starts in");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(startArgs(herdr).includes(`@${file}`), `the child is pointed at the copy in its working directory: ${startArgs(herdr).join(' ')}`);
  assert.ok(!fs.existsSync(path.join(w.childHome, 'prompts', `${child.id}.md`)), 'none went to a home-level directory, outside the child\'s working directory');
  assert.ok(!fs.existsSync(path.join(w.parentHome, 'prompts', `${child.id}.md`)), "none was left on the parent's machine");
  assert.equal(execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), '', 'the worktree stays clean');
  assert.equal(inHome(w.childHome, () => readRelayRecord(child.id))?.brief, file);

  // The child's exit takes the brief and its directory with it.
  await ops.cleanup(child);
  assert.ok(!fs.existsSync(path.join(cwd, '.bellwether')));
});

test("a spawn on another machine whose working directory is missing there fails before a tab opens, and says why", async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('claude-code', 'brief-no-cwd', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(machines);
  const missing = path.join(w.root, 'child', 'not-there');
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'lost', host: 'child-box', cwd: missing, prompt: 'a task', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) }),
    /its brief could not be copied there: .*the working directory .*not-there does not exist on this machine/s,
  );
  assert.equal(herdr.requests.filter((request) => request.method === 'tab.create').length, 0);
  assert.ok(!fs.existsSync(missing), 'the registration did not create the directory');
});

test("agent_stop of a child on another machine removes its brief, MCP config and relay record there", async (t) => {
  const w = world(t);
  const cwd = childWorktree(w);
  const parent = saveParent(emptyParent('claude-code', 'stopper', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  const ops = remoteOps(machines);
  const { child } = await spawnChild(client, parent, { kind: 'claude', name: 'to-stop', host: 'child-box', cwd, prompt: 'a task', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) });
  const there = {
    brief: path.join(cwd, '.bellwether', `brief-${child.id}.md`),
    mcp: inHome(w.childHome, () => mcpConfigPath(child.id)),
    relay: inHome(w.childHome, () => relayChildPath(child.id)),
  };
  for (const file of Object.values(there)) assert.ok(fs.existsSync(file), `the spawn wrote ${file}`);

  const watcher = new Watcher({ client, parentId: parent.id, onEntries: () => {} });
  const reply = await runBellwetherTool({ client, clientFor: async () => client, parentId: parent.id, watcher, remote: ops }, 'agent_stop', { child: 'to-stop', force: true });
  assert.equal(reply, 'Closed to-stop.');
  for (const [what, file] of Object.entries(there)) assert.ok(!fs.existsSync(file), `the stop removed the ${what} file ${file}`);
});

test('agent_stop says so when it cannot remove the files on the child\'s machine', async (t) => {
  const w = world(t);
  const parent = saveParent(emptyParent('claude-code', 'stopper-cut', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  const ops = remoteOps(machines);
  const { child } = await spawnChild(client, parent, { kind: 'claude', name: 'cut-off', host: 'child-box', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry) => ops.register(parent, entry) });
  w.ssh.plan(['refuse']);
  const watcher = new Watcher({ client, parentId: parent.id, onEntries: () => {} });
  const reply = await runBellwetherTool({ client, clientFor: async () => client, parentId: parent.id, watcher, remote: ops }, 'agent_stop', { child: 'cut-off', force: true });
  assert.match(reply, /^Closed cut-off\. Its brief, MCP config and relay record on machine child-box could not be removed, .*relay-cleanup --child [^ ]+ .*255/s);
  assert.ok(reply.includes(child.id));
});

test('a relay record whose reports still wait outlives relay-cleanup, and goes with the last of them', (t) => {
  const w = world(t, 'child');
  childHolds(w, 'c-gone');
  inHome(w.childHome, () => saveForward({ receipt: 'rp-last', childId: 'c-gone', parentId: PARENT_ID, status: 'done', text: 'finished', at: new Date().toISOString() }));
  const env = { ...process.env, BELLWETHER_HOME: w.childHome, BELLWETHER_DAEMON_SOCKET: path.join(w.childHome, 'daemon.sock') };
  const cleanup = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'relay-cleanup', '--child', 'c-gone'], { env, encoding: 'utf8' });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stdout, /recordKept/);
  assert.ok(inHome(w.childHome, () => readRelayRecord('c-gone'))?.retiredAt, 'kept, and marked retired, while its report waits');
  inHome(w.childHome, () => new RelayOutbox().ack('rp-last'));
  assert.equal(inHome(w.childHome, () => readRelayRecord('c-gone')), undefined, 'gone with its last report');
});
