// Tier 2: an upgrade with no restart. Two installs share one home: an older
// release, copied from these sources with a lower version and protocol, and
// this one. Each runs its daemon as a real process from its own copy. The
// cases show the newer install handing the daemon over while a session of the
// older one stays connected and keeps working, one daemon owning the children
// throughout, a drain that answers its calls in flight, a hand-over that a
// crash on either side does not block, and doctor's verdict at each step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DaemonClient, daemonSessions, ensureDaemon, handOverDaemon } from '../../src/daemon/client.ts';
import { isAlive, readLock } from '../../src/daemon/lock.ts';
import { DAEMON_PROTOCOL } from '../../src/daemon/protocol.ts';
import { startDaemon, type ParentService } from '../../src/daemon/server.ts';
import { describeUpgrade, gatherUpgrade } from '../../src/daemon/upgrade-status.ts';
import { emptyParent, listParents, saveParent } from '../../src/core/registry.ts';
import { PI_EXTENSION_ENV, piExtensionEntry, standDown } from '../../src/core/pi-extension.ts';
import { BELLWETHER_VERSION } from '../../src/core/version.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { makeInstall } from '../fixtures/installs.ts';

const OLD_VERSION = '0.0.9';

interface Space {
  root: string;
  home: string;
  socket: string;
  herdr: string;
  /** Close this client before the daemons stop, so it does not reconnect and start another. */
  track<T extends { close(): Promise<void> }>(client: T): T;
}

/**
 * A scratch machine under /tmp, whose home this process's registry also
 * uses, so the case can seed and read the records the daemons keep.
 */
function space(t: { after: (fn: () => Promise<void>) => void }): Space {
  const root = fs.mkdtempSync('/tmp/bw-ho-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const clients: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await stopDaemonsUnder(root, home);
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // No herdr answers here: the tools these cases call read only the registry.
  const track = <T extends { close(): Promise<void> }>(client: T): T => {
    clients.push(client);
    return client;
  };
  return { root, home, socket: path.join(home, 'daemon.sock'), herdr: path.join(root, 'no-herdr.sock'), track };
}

function parent(session: string, herdr: string) {
  return { harness: 'pi' as const, session, cwd: '/tmp', host: 'machine', depth: 0, herdrSocket: herdr };
}

function child(id: string, name: string): ChildRecord {
  const at = new Date().toISOString();
  return { id, name, kind: 'pi', harness: 'pi', paneId: 'w1:p9', host: 'local', startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 } as ChildRecord;
}

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

test('a newer install hands the daemon over while an older session stays connected, and one daemon owns the children throughout', async (t) => {
  const machine = space(t);
  const old = makeInstall(machine.root, 'old-install', OLD_VERSION, DAEMON_PROTOCOL - 1);
  saveParent(emptyParent('pi', 'old-session', '/tmp', { host: 'machine', depth: 0, children: [child('c0ffee0000000001', 'long-job')] }));

  // A session of the older release starts that release's daemon.
  const oldModule = await old.client();
  const oldSession = machine.track(await oldModule.DaemonClient.connect(parent('old-session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  const before = readLock(machine.home);
  assert.deepEqual([before?.version, before?.protocol, before?.entry], [OLD_VERSION, DAEMON_PROTOCOL - 1, fs.realpathSync(old.entry)]);
  assert.match(await oldSession.tool('agent_list', {}), /long-job/);
  const oldDaemonPid = before?.pid ?? 0;

  // Doctor on the newer install sees an older daemon, and says the next session hands it over.
  const midway = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.equal(midway.state, 'in-progress');
  assert.match(midway.lines.join('\n'), new RegExp(`the running daemon, pid \\d+, is ${OLD_VERSION.replaceAll('.', '\\.')} on protocol ${DAEMON_PROTOCOL - 1}, .*A session started from this install hands it over`));

  // A session of this release starts: it hands the daemon over, with no restart of the older session.
  const newSession = machine.track(await DaemonClient.connect(parent('new-session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  const after = readLock(machine.home);
  assert.deepEqual([after?.version, after?.protocol], [BELLWETHER_VERSION, DAEMON_PROTOCOL]);
  assert.notEqual(after?.pid, oldDaemonPid);
  await until(() => (isAlive(oldDaemonPid) ? undefined : true), 'the old daemon to exit');

  // The older session reconnects to the new daemon on its own, and its tools keep working.
  const listing = await until(async () => {
    const text = await oldSession.tool('agent_list', {}).catch(() => undefined);
    return text && oldSession.pid === after?.pid ? text : undefined;
  }, 'the older session to reach the new daemon');
  assert.match(listing, /long-job/);

  // One daemon runs, and the child sits in exactly one parent record, which that daemon owns. An
  // older client that raced to start its own daemon sees the lock held and its process exits.
  await until(() => (daemonsUnder(machine.root).length === 1 ? true : undefined), 'a single daemon process');
  assert.deepEqual(daemonsUnder(machine.root).map((daemon) => daemon.pid), [after?.pid]);
  const holders = listParents().filter((record) => record.children.some((entry) => entry.id === 'c0ffee0000000001'));
  assert.deepEqual(holders.map((record) => record.session), ['old-session']);

  // The daemon lists both sessions with the code each runs.
  const listed = await daemonSessions(machine.socket);
  const byClient = Object.fromEntries(listed.sessions.map((session) => [session.session, session]));
  assert.deepEqual([byClient['old-session']?.client, byClient['old-session']?.protocol, byClient['old-session']?.liveChildren], [OLD_VERSION, DAEMON_PROTOCOL - 1, 1]);
  assert.deepEqual([byClient['new-session']?.client, byClient['new-session']?.protocol], [BELLWETHER_VERSION, DAEMON_PROTOCOL]);

  // Doctor: the older session is served by the daemon, so the upgrade is finished, and the session is named with what it would lose by ending.
  const coexisting = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.equal(coexisting.state, 'finished', coexisting.lines.join('\n'));
  assert.deepEqual(coexisting.leftovers, []);
  assert.equal(coexisting.olderSessions.length, 1);
  assert.match(coexisting.lines.join('\n'), /Ending it leaves 1 live child without their parent until the session resumes/);

  // The older session ends on its own: the machine has converged, with nothing stale behind.
  await oldSession.close();
  await until(async () => ((await daemonSessions(machine.socket)).sessions.length === 1 ? true : undefined), 'the older session to leave');
  const converged = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.equal(converged.state, 'finished', converged.lines.join('\n'));
  assert.deepEqual(converged.leftovers, []);
  assert.deepEqual(fs.readdirSync(machine.home).filter((name) => name.endsWith('.sock') || name === 'daemon.starting'), ['daemon.sock']);
});

test('an older session meeting a newer daemon uses it, and never replaces it', async (t) => {
  const machine = space(t);
  const old = makeInstall(machine.root, 'old-install', OLD_VERSION, DAEMON_PROTOCOL - 1);
  const newSession = machine.track(await DaemonClient.connect(parent('new-session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  const daemonPid = readLock(machine.home)?.pid;

  const oldModule = await old.client();
  const oldSession = machine.track(await oldModule.DaemonClient.connect(parent('old-session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  assert.equal(oldSession.pid, daemonPid);
  assert.match(await oldSession.tool('agent_list', {}), /No children yet/);
  assert.equal(readLock(machine.home)?.pid, daemonPid);
  assert.deepEqual(daemonsUnder(machine.root).map((daemon) => daemon.pid), [daemonPid]);
});

test('a draining daemon answers its calls in flight, takes no new connection, and then exits', async (t) => {
  const machine = space(t);
  let finish: (text: string) => void = () => {};
  const slow = new Promise<string>((resolve) => (finish = resolve));
  const service: ParentService = {
    tool: async (name) => (name === 'slow' ? slow : 'quick'),
    markRead: () => {},
    onEvents: () => {},
    pending: () => [],
    watchPane: () => () => {},
    stop: () => {},
  };
  const daemon = await startDaemon({ socketPath: machine.socket, home: machine.home, factory: () => service });
  t.after(() => daemon.close());
  const session = machine.track(await DaemonClient.connect(parent('session', machine.herdr), { home: machine.home, socketPath: machine.socket, spawn: false }));
  const inFlight = session.tool('slow', {});
  await delay(50);

  // A hand-over starts: the drain stops new connections at once, so the next daemon is not kept waiting on the socket.
  const net = await import('node:net');
  await new Promise<void>((resolve) => {
    const drain = net.createConnection(machine.socket);
    drain.resume();
    drain.once('connect', () => drain.end('{"type":"drain"}\n'));
    drain.once('close', () => resolve());
  });
  await until(() => (daemon.draining ? true : undefined), 'the drain to start');
  await assert.rejects(new Promise((resolve, reject) => net.createConnection(machine.socket).once('connect', resolve).once('error', reject)));
  assert.equal(daemon.closed, false, 'the daemon waits for the call in flight');

  finish('the spawn finished');
  assert.equal(await inFlight, 'the spawn finished');
  await daemon.whenClosed();
  assert.equal(readLock(machine.home), undefined, 'the lock is released for the next daemon');
});

test('a hand-over goes ahead after a crash on either side', async (t) => {
  const machine = space(t);
  // A client died holding the marker, and a daemon died holding the lock and its socket file.
  const dead = 2 ** 22 + 12_345;
  assert.equal(isAlive(dead), false);
  fs.writeFileSync(path.join(machine.home, 'daemon.starting'), `${JSON.stringify({ pid: dead, at: Date.now() })}\n`);
  fs.writeFileSync(path.join(machine.home, 'daemon.lock'), `${JSON.stringify({ pid: dead, startedAt: 0, protocol: DAEMON_PROTOCOL - 1, socket: machine.socket })}\n`);
  fs.writeFileSync(machine.socket, '');
  const leftover = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.equal(leftover.leftovers.length, 3, leftover.lines.join('\n'));

  const session = machine.track(await DaemonClient.connect(parent('session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  assert.equal(readLock(machine.home)?.version, BELLWETHER_VERSION);

  // A second hand-over, asked for by hand, finds nothing to do but wait for its own daemon to restart.
  await handOverDaemon(machine.home, machine.socket);
  const replaced = readLock(machine.home);
  assert.equal(replaced?.version, BELLWETHER_VERSION);
  await until(async () => (session.pid === replaced?.pid && (await session.tool('agent_list', {}).catch(() => undefined)) ? true : undefined), 'the session to reach the replacement');
  const healed = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.deepEqual(healed.leftovers, []);
  assert.equal(healed.state, 'finished', healed.lines.join('\n'));
});

test('a child an older daemon starts runs that daemon\'s adapter and keeps it, until relay-bridge from the newer install hands it over', async (t) => {
  const machine = space(t);
  const old = makeInstall(machine.root, 'old-install', OLD_VERSION, DAEMON_PROTOCOL - 1);
  const oldModule = await old.client();
  machine.track(await oldModule.DaemonClient.connect(parent('old-parent', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  const oldDaemonPid = readLock(machine.home)?.pid;
  assert.equal(readLock(machine.home)?.version, OLD_VERSION);

  // That daemon starts a pi child with -e naming the extension of the install the daemon runs from,
  // whatever newer copy pi's settings hold. The newer copy sees the variable and the -e, and stands down.
  const oldPi = (await import(pathToFileURL(path.join(old.root, 'src', 'core', 'pi-extension.ts')).href)) as typeof import('../../src/core/pi-extension.ts');
  const childExtension = oldPi.piExtensionEntry();
  assert.ok(childExtension.startsWith(old.root), childExtension);
  assert.equal(standDown(piExtensionEntry(), { [PI_EXTENSION_ENV]: childExtension }, ['pi', '-e', childExtension]), true);

  // So the child's client is the older install's, and it keeps the daemon: no child of that daemon hands it over.
  const childSession = machine.track(await oldModule.DaemonClient.connect(parent('child-session', machine.herdr), { home: machine.home, socketPath: machine.socket }));
  assert.equal(childSession.pid, oldDaemonPid);
  assert.equal(readLock(machine.home)?.pid, oldDaemonPid);

  // Doctor on the newer install says what the upgrade waits for, and what hands it over now.
  const waiting = describeUpgrade(await gatherUpgrade(machine.home, machine.socket));
  assert.equal(waiting.state, 'in-progress');
  assert.match(waiting.lines.join('\n'), /upgrade: in progress, because the daemon runs an older release\. A child that daemon starts runs the daemon's own adapter and never hands it over\. Run bellwether relay-bridge < \/dev\/null from this install to hand it over now; it ends no session\./);

  // What `bellwether relay-bridge` runs first, from the newer install: the hand-over, with the child still connected.
  await ensureDaemon(machine.home, machine.socket);
  const after = readLock(machine.home);
  assert.equal(after?.version, BELLWETHER_VERSION);
  assert.notEqual(after?.pid, oldDaemonPid);
  await until(async () => (childSession.pid === after?.pid && (await childSession.tool('agent_list', {}).catch(() => undefined)) ? true : undefined), 'the child to reach the new daemon');
});
