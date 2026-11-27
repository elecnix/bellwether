// The watcher's side of the inactivity notification, on a fake clock. A stub
// herdr client answers the few calls the watcher makes and reads a screen the
// test controls, so "activity" is a screen change the watcher really observes.
// The registry is the file-backed one pointed at a scratch home. The watcher
// is never started, so no timer runs; the test steps its evaluation directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type { HerdrClient } from '../../src/core/herdr-client.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { OutboxEntry } from '../../src/core/types.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-inactivity-watch-'));
process.env['BELLWETHER_HOME'] = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const MINUTE = 60_000;

/** The herdr calls a spawn and a watcher pass make, answered in memory. */
function stubClient() {
  const stub = {
    /** What the child's pane shows. A test changes it to simulate output. */
    screen: 'quiet',
    tabCreate: async () => ({ tabId: 'tab-1', paneId: 'w1:p1' }),
    agentStart: async () => undefined,
    agentList: async () => [],
    tabClose: async () => undefined,
    subscribe: async () => ({ closed: new Promise<void>(() => {}), close: () => {} }),
    request: async (method: string) => (method === 'pane.list' ? { panes: [] } : {}),
    snapshot: async () => ({}),
    paneRead: async () => stub.screen,
  };
  return stub;
}

function watcherFor(parentId: string, stub: ReturnType<typeof stubClient>, clock: { now: number }): Watcher {
  return new Watcher({
    client: stub as unknown as HerdrClient,
    parentId,
    now: () => clock.now,
    // Any positive value makes every pass read the screen, so output is seen.
    screenPollMs: 1,
    tickMs: 1_000_000,
    onEntries: () => {},
  });
}

/** One classifier pass over the children, as a tick would run it. */
async function evaluate(watcher: Watcher): Promise<void> {
  await (watcher as unknown as { evaluate(): Promise<void> }).evaluate();
}

function inactiveEntries(watcher: Watcher): OutboxEntry[] {
  return watcher.outboxEntries().filter((entry) => entry.event === 'inactive');
}

test('the watcher sends one inactive notice at the default five minutes, and not again across a restart', async () => {
  const parent = saveParent(emptyParent('pi', 'watch-quiet', '/work'));
  const stub = stubClient();
  await spawnChild(stub as unknown as HerdrClient, parent, { kind: 'pi', name: 'quiet-worker' });
  const child = readParent(parent.id)?.children[0];
  assert.ok(child);
  assert.equal(child.inactiveMs, 5 * MINUTE, 'the spawn stored the default');

  // The spawn set the activity time, so the fake clock starts there.
  const base = Date.parse(child.lastBusyAt);
  const clock = { now: base };

  const first = watcherFor(parent.id, stub, clock);
  clock.now = base + 5 * MINUTE - 1_000;
  await evaluate(first);
  assert.equal(inactiveEntries(first).length, 0, 'nothing one second before five minutes');

  clock.now = base + 5 * MINUTE;
  await evaluate(first);
  const [notice] = inactiveEntries(first);
  assert.ok(notice, 'the notice is queued at five minutes');
  assert.match(notice.text, /no activity for 5 min/);
  assert.equal(readParent(parent.id)?.children[0]?.inactiveNotifiedFor, new Date(base).toISOString());

  // Keep evaluating in the same period.
  clock.now = base + 9 * MINUTE;
  await evaluate(first);
  assert.equal(inactiveEntries(first)[0]?.receipt, notice.receipt, 'the same entry, not a second one');

  // A restarted parent loads the outbox and the registry, and must not repeat it.
  const restarted = watcherFor(parent.id, stub, clock);
  // Seven minutes, not ten: a quiet working child reaches the stuck threshold
  // at ten, and that event would replace the notice in the outbox.
  clock.now = base + 7 * MINUTE;
  await evaluate(restarted);
  assert.deepEqual(
    inactiveEntries(restarted).map((entry) => entry.receipt),
    [notice.receipt],
    'a restart keeps the one notice and sends nothing new for the same quiet period',
  );
});

test('a new turn with no status change is persisted as activity', async () => {
  const parent = saveParent(emptyParent('pi', 'watch-turn', '/work'));
  const stub = stubClient();
  await spawnChild(stub as unknown as HerdrClient, parent, { kind: 'pi', name: 'turn-worker' });
  const before = readParent(parent.id)?.children[0];
  assert.ok(before);

  // The pane stays idle, but herdr reports a new completion_seq for it.
  const snapshotStub = stub as unknown as { snapshot: () => Promise<unknown> };
  snapshotStub.snapshot = async () => ({ agents: [{ pane_id: 'w1:p1', agent_status: 'idle', completion_seq: 2 }] });
  const clock = { now: Date.parse(before.lastBusyAt) };
  const watcher = watcherFor(parent.id, stub, clock);
  await (watcher as unknown as { reconcile(children: unknown[], signal: AbortSignal): Promise<void> }).reconcile(
    [before],
    new AbortController().signal,
  );

  const after = readParent(parent.id)?.children[0];
  assert.equal(after?.completionSeq, 2);
  assert.notEqual(after?.lastBusyAt, before.lastBusyAt, 'the new turn moved the persisted activity time');
});

test('output on the child screen restarts the clock, and the next quiet period notifies again', async () => {
  const parent = saveParent(emptyParent('pi', 'watch-active', '/work'));
  const stub = stubClient();
  await spawnChild(stub as unknown as HerdrClient, parent, { kind: 'pi', name: 'chatty-worker' });
  const child = readParent(parent.id)?.children[0];
  assert.ok(child);
  const base = Date.parse(child.lastBusyAt);
  const clock = { now: base };

  const watcher = watcherFor(parent.id, stub, clock);
  clock.now = base + 1 * MINUTE;
  await evaluate(watcher); // reads the baseline screen

  // The child prints something at six minutes; the watcher sees the change.
  clock.now = base + 6 * MINUTE;
  stub.screen = 'output';
  await evaluate(watcher);
  assert.equal(inactiveEntries(watcher).length, 0, 'output at six minutes is activity, so nothing is due');

  // Five minutes after that output, the notice is due.
  clock.now = base + 11 * MINUTE;
  await evaluate(watcher);
  const [notice] = inactiveEntries(watcher);
  assert.ok(notice, 'the second quiet period notifies at its own five minutes');
  assert.match(notice.text, /no activity for 5 min/);
});
