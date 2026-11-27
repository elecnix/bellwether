// Tier 3: a hand-over against a real herdr server of the lab's own. A session
// of an older release watches a child in a real pane through that release's
// daemon. A session of this release hands the daemon over. The pane then
// closes, and the older session still hears about it, from the new daemon's
// herdr subscription: the child was neither lost nor watched twice. The homes,
// sockets and herdr server all sit under the test's own root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, listParents, saveParent } from '../../src/core/registry.ts';
import { BELLWETHER_VERSION } from '../../src/core/version.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { isAlive, readLock } from '../../src/daemon/lock.ts';
import { DAEMON_PROTOCOL } from '../../src/daemon/protocol.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { makeInstall } from '../fixtures/installs.ts';
import { hasHerdr, startLab } from './herdr-lab.ts';

const skip = (await hasHerdr()) ? false : 'herdr is not on PATH';

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

test('an older session keeps hearing from its child in a real pane across a hand-over', { skip, timeout: 120_000 }, async (t) => {
  const lab = await startLab();
  const root = fs.mkdtempSync('/tmp/bw-hol-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  // Sessions close before the daemons stop, or a session would reconnect and start another daemon.
  const clients: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await stopDaemonsUnder(root, home);
    await lab.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const socket = path.join(home, 'daemon.sock');
  const herdr = new HerdrClient({ socketPath: lab.socketPath });
  // A fresh lab has no workspace until one is created.
  const created = (await herdr.request('workspace.create', { cwd: root, label: 'handover-lab', focus: false })) as { workspace?: { workspace_id?: string } };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId, 'the lab created a workspace');
  const { paneId, tabId } = await herdr.tabCreate({ workspaceId, cwd: root, label: 'child' });
  assert.ok(paneId, 'the lab opened a pane for the child');
  const at = new Date().toISOString();
  const childRecord = { id: 'c0ffee00000000aa', name: 'lab-child', kind: 'pi', harness: 'pi', paneId, ...(tabId ? { tabId } : {}), host: 'local', workspaceId, startedAt: at, lastStatus: 'unknown', statusChangedAt: at, lastBusyAt: at, depth: 1 } as ChildRecord;
  saveParent(emptyParent('pi', 'old-session', root, { host: 'machine', depth: 0, children: [childRecord] }));
  const hello = (session: string) => ({ harness: 'pi' as const, session, cwd: root, host: 'machine', depth: 0, herdrSocket: lab.socketPath });

  const old = makeInstall(root, 'old-install', '0.0.9', DAEMON_PROTOCOL - 1);
  const oldModule = await old.client();
  const oldSession = await oldModule.DaemonClient.connect(hello('old-session'), { home, socketPath: socket });
  clients.push(oldSession);
  const heard: OutboxEntry[] = [];
  oldSession.onEvents((entries) => heard.push(...entries));
  const oldPid = readLock(home)?.pid ?? 0;
  assert.equal(readLock(home)?.version, '0.0.9');

  const newSession = await DaemonClient.connect(hello('new-session'), { home, socketPath: socket });
  clients.push(newSession);
  const newPid = readLock(home)?.pid;
  assert.equal(readLock(home)?.version, BELLWETHER_VERSION);
  await until(() => (isAlive(oldPid) ? undefined : true), 'the old daemon to exit');
  await until(async () => (oldSession.pid === newPid && (await oldSession.tool('agent_list', {}).catch(() => undefined)) ? true : undefined), 'the older session to reach the new daemon');
  await until(() => (daemonsUnder(root).length === 1 ? true : undefined), 'a single daemon process');

  // The pane closes: only the new daemon watches it now, and the older session hears it once.
  await delay(500);
  await herdr.paneClose(paneId);
  const exited = await until(() => heard.find((entry) => entry.childId === childRecord.id && entry.event === 'exited'), 'the exit event in the older session');
  assert.equal(exited.name, 'lab-child');
  const records = listParents().flatMap((record) => record.children.filter((entry) => entry.id === childRecord.id));
  assert.equal(records.length, 1, 'the child sits in one parent record');
  assert.ok(records[0]?.exitedAt, 'the new daemon recorded the exit');
});
