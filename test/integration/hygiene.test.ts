// Tier 2: the daemon prunes the state of sessions that ended, from its idle
// tick. Each simulated session says hello, which writes its parent record as
// the herdr service does, then says bye. The daemon's clock moves past each
// period, and the records of ended sessions go while the live ones stay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { readLastPrune } from '../../src/core/hygiene.ts';
import { Outbox } from '../../src/core/outbox.ts';
import { parentsDir, promptPath, registryPath } from '../../src/core/paths.ts';
import { emptyParent, parentId, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import type { ChildRecord } from '../../src/core/types.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A service that writes the parent record on hello, as the herdr service does, and nothing else. */
const recordingFactory: ServiceFactory = (parent, id) => {
  if (!readParent(id)) saveParent(emptyParent(parent.harness, parent.session, parent.cwd, { host: parent.host, depth: parent.depth }));
  const service: ParentService = {
    tool: async () => 'ok',
    markRead: () => {},
    onEvents: () => {},
    pending: () => [],
    watchPane: () => () => {},
    stop: () => {},
  };
  return service;
};

function hello(session: string): { harness: 'pi'; session: string; cwd: string; host: string; depth: number; herdrSocket: string } {
  return { harness: 'pi', session, cwd: '/tmp', host: 'machine', depth: 0, herdrSocket: '/tmp/herdr.sock' };
}

function child(id: string, exited: boolean): ChildRecord {
  const at = new Date().toISOString();
  return { id, name: id, kind: 'pi', harness: 'pi', paneId: `w1:${id}`, host: 'local', startedAt: at, lastStatus: 'idle', statusChangedAt: at, depth: 1, lastBusyAt: at, ...(exited ? { exitedAt: at } : {}) };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function records(): string[] {
  try {
    return fs.readdirSync(parentsDir()).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

test('after twenty sessions end, the daemon prunes their records, and the live ones stay untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-hygiene-'));
  const previousHome = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = root;
  let clock = Date.now();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory: recordingFactory, idleCheckMs: 10, idleMs: 60 * DAY, pruneEveryMs: 1, pruneDelayMs: 0, now: () => clock });
  try {
    // Twenty sessions come and go. Five of them spawned a child that exited.
    const ended: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const session = `ended-${index}`;
      const client = await DaemonClient.connect(hello(session), { home: root, spawn: false });
      if (index < 5) {
        upsertChild(client.parentId, child(`fake-exited-${index}`, true));
        fs.mkdirSync(path.dirname(promptPath(`fake-exited-${index}`)), { recursive: true });
        fs.writeFileSync(promptPath(`fake-exited-${index}`), 'brief');
      }
      ended.push(client.parentId);
      await client.close();
    }
    // One session stays connected, one ended with a child that still runs, and one ended with an unread event.
    const connected = await DaemonClient.connect(hello('connected'), { home: root, spawn: false });
    const running = await DaemonClient.connect(hello('running'), { home: root, spawn: false });
    upsertChild(running.parentId, child('fake-running', false));
    fs.writeFileSync(promptPath('fake-running'), 'brief');
    await running.close();
    const unreadId = parentId('pi', 'unread');
    const unread = await DaemonClient.connect(hello('unread'), { home: root, spawn: false });
    upsertChild(unreadId, child('fake-unread', true));
    const box = Outbox.load(unreadId);
    box.offer({ childId: 'fake-unread', name: 'fake-unread', kind: 'pi', paneId: 'w1:p1', event: 'exited', text: 'exited', at: new Date().toISOString() });
    box.save(unreadId);
    await unread.close();
    const before = fs.readFileSync(registryPath(running.parentId), 'utf8');
    assert.equal(records().length, 23);

    // Two hours on, the fifteen sessions that never had a child are gone.
    clock += 2 * HOUR;
    await until(() => records().length === 8);
    for (const id of ended.slice(5)) assert.equal(fs.existsSync(registryPath(id)), false, id);
    for (const id of ended.slice(0, 5)) assert.equal(fs.existsSync(registryPath(id)), true, id);

    // Eight days on, the five with exited children follow, with their briefs.
    clock += 8 * DAY;
    await until(() => records().length === 3);
    assert.deepEqual(records(), [connected.parentId, running.parentId, unreadId].map((id) => `${id}.json`).sort());
    for (let index = 0; index < 5; index += 1) assert.equal(fs.existsSync(promptPath(`fake-exited-${index}`)), false);
    assert.equal(fs.existsSync(promptPath('fake-running')), true);
    assert.equal(fs.readFileSync(registryPath(running.parentId), 'utf8'), before, 'the live record is untouched');
    assert.equal(Outbox.load(unreadId).pending().length, 1);
    await until(() => readLastPrune()?.at === new Date(clock).toISOString());
    await connected.close();
  } finally {
    await daemon.close();
    if (previousHome === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a daemon that just started waits for its sessions to say hello before it prunes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-hygiene-'));
  const previousHome = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = root;
  // A session from before a hand-over: its record is old, and it never had a child.
  const returning = emptyParent('pi', 'returning', '/tmp');
  saveParent(returning);
  const old = new Date(Date.now() - 3 * HOUR).toISOString();
  fs.writeFileSync(registryPath(returning.id), `${JSON.stringify({ ...returning, updatedAt: old }, null, 2)}\n`);
  const gone = emptyParent('pi', 'gone', '/tmp');
  saveParent(gone);
  fs.writeFileSync(registryPath(gone.id), `${JSON.stringify({ ...gone, updatedAt: old }, null, 2)}\n`);
  let clock = Date.now();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory: recordingFactory, idleCheckMs: 10, idleMs: 60 * DAY, pruneEveryMs: 1, pruneDelayMs: 60_000, now: () => clock });
  try {
    clock += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(records().length, 2, 'nothing goes inside the first minute');
    const client = await DaemonClient.connect(hello('returning'), { home: root, spawn: false });
    clock += 61_000;
    await until(() => records().length === 1);
    assert.deepEqual(records(), [`${returning.id}.json`]);
    await client.close();
  } finally {
    await daemon.close();
    if (previousHome === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
