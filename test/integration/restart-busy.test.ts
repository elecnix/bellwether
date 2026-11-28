// Tier 2: a self-restart for a session that is never idle (issue #188). The
// restart waits for the caller's turn to end, and a busy session takes one
// message after another, so the wait is bounded: it either runs between two
// turns or gives up within its bound, naming what held it. While it waits, the
// daemon holds the session's own Bellwether events, which are what kept it
// busy, and a second call says what the restart waits for.
import { messageRead, messageSending } from '../../src/core/delivery.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { bellwetherHome } from '../../src/core/paths.ts';
import { emptyParent, listParents, readParent, saveParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import { acceptLocalReport } from '../../src/core/report.ts';
import { restartWaitLines, type RestartHooks } from '../../src/core/restart.ts';
import { hostName } from '../../src/core/spawn.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Rig {
  fake: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

async function herdr(t: test.TestContext): Promise<Rig> {
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

const LEAD_SESSION = { agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value: 'busy-lead' };

function child(extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date().toISOString();
  return {
    id: 'child-worker',
    name: 'worker',
    kind: 'claude',
    harness: 'claude-code',
    paneId: 'w1:p3',
    tabId: 'w1:t3',
    workspaceId: 'w1',
    host: LOCAL_HOST,
    origin: 'spawn',
    cwd: '/work/repo',
    startedAt: at,
    lastStatus: 'working',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'id', value: 'sess-1' },
    depth: 1,
    ...extra,
  };
}

function setStatus(rig: Rig, paneId: string, status: 'idle' | 'working'): void {
  const pane = rig.world.panes.get(paneId);
  if (pane) pane.agent_status = status;
  rig.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: paneId, agent_status: status } });
}

function restartLog(): Record<string, unknown>[] {
  const file = path.join(bellwetherHome(), 'restart.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function context(id: string, rig: Rig, deferTimeoutMs: number): { tool: (args: Record<string, unknown>, caller: { paneId?: string; childId?: string }) => Promise<string>; jobs: Map<string, Promise<void>> } {
  const jobs = new Map<string, Promise<void>>();
  const hooks: RestartHooks = {
    signal: new AbortController().signal,
    defer: (key, job) => {
      if (jobs.has(key)) return;
      const running = job();
      jobs.set(key, running);
      void running.finally(() => jobs.delete(key));
    },
    deferTimeoutMs,
    startupTimeoutMs: 3_000,
    redrawMs: 10,
  };
  const ctx: ToolContext = { client: rig.client, clientFor: async () => rig.client, parentId: id, watcher: new Watcher({ client: rig.client, parentId: id, onEntries: () => {} }), restart: hooks };
  return { tool: (args, caller) => runBellwetherTool(ctx, 'agent_restart', args, caller), jobs };
}

test('a session that never ends a turn gives up its restart within the bound, naming the live turn and its working child', async (t) => {
  isolate(t, 'bellwether-restart-busy-');
  const rig = await herdr(t);
  const id = saveParent(emptyParent('claude-code', 'busy-lead', '/work', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p1' })).id;
  upsertChild(id, child());
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: LEAD_SESSION });
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'working', agent_session: { ...LEAD_SESSION, value: 'sess-1' } });
  const { tool, jobs } = context(id, rig, 600);

  const first = await tool({}, { paneId: 'w1:p1' });
  assert.match(first, /If the turn has not ended within 0\.6 s, the daemon reads the pane from herdr once: idle restarts it, and anything else gives up and says what held it/);
  await until('the status herdr reports for the pane', () => readParent(id)?.restartWait?.status);

  // A second call is a diagnosis, not a wall.
  const second = await tool({}, { paneId: 'w1:p1' });
  assert.match(second, /^This session has a restart pending since \S+\. It waits for pane w1:p1 to end its turn, and herdr reports it working since \S+\./);
  assert.match(second, /1 of its children is working: worker\./);
  assert.match(second, /At \S+ it reads the pane from herdr once more: idle restarts it, and anything else gives up and says why\./);
  const pending = restartWaitLines(listParents());
  assert.match(pending[0] ?? '', /^info +restart: session .* has a restart pending since .*waits for pane w1:p1/);

  await jobs.get(`parent:${id}`);
  const record = readParent(id);
  assert.equal(record?.restartRequestedAt, undefined, 'the request is over');
  assert.equal(record?.restartWait, undefined);
  assert.match(record?.restartStalled?.reason ?? '', /pane w1:p1 did not end a turn within 0\.6 s: herdr reported it working since \S+, so the turn was live the whole time/);
  assert.match(record?.restartStalled?.reason ?? '', /1 of its children was working \(worker\)/);
  assert.match(record?.restartStalled?.reason ?? '', /Nothing was closed\./);
  assert.equal(rig.fake.requests.filter((request) => request.method === 'pane.close' || request.method === 'tab.create').length, 0, 'nothing was closed or opened');
  assert.equal(restartLog().at(-1)?.['outcome'], 'timeout');
  assert.match(restartWaitLines(listParents())[0] ?? '', /^warn +restart: session .* gave up the restart it requested at \S+ on pane w1:p1, at \S+: pane w1:p1 did not end a turn/);

  // The session can ask again, and the new request starts a fresh wait.
  assert.match(await tool({}, { paneId: 'w1:p1' }), /^Restart requested\./);
  assert.equal(readParent(id)?.restartStalled, undefined);
  await jobs.get(`parent:${id}`);
});

test('a child that receives messages through its wait gives up by name, counting the messages that kept it busy', async (t) => {
  isolate(t, 'bellwether-restart-busy-');
  const rig = await herdr(t);
  const id = saveParent(emptyParent('claude-code', 'outer', '/work', { workspaceId: 'w1', host: hostName() })).id;
  upsertChild(id, child());
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'working', agent_session: { ...LEAD_SESSION, value: 'sess-1' } });
  const { tool, jobs } = context(id, rig, 600);
  const caller = { childId: 'child-worker', paneId: 'w1:p3' };

  await tool({}, caller);
  // A parent's message reaches the child at the end of each turn, so herdr never reports it idle.
  for (const n of [1, 2]) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Each one entered the session's conversation, as its adapter's read receipt says.
    updateChild(id, 'child-worker', (entry) => {
      const at = new Date().toISOString();
      messageSending(entry, { id: `m-${n}`, at, text: `next task ${n}`, from: 'your parent' });
      messageRead(entry, `m-${n}`, at);
    });
  }
  assert.match(await tool({}, caller), /2 messages reached the session since the request, each a turn of its own\./);

  await jobs.get('child:child-worker');
  const record = readParent(id)?.children[0];
  assert.equal(record?.restartRequestedAt, undefined);
  assert.equal(record?.paneId, 'w1:p3', 'the child keeps its pane');
  assert.match(record?.restartStalled?.reason ?? '', /did not end a turn within 0\.6 s/);
  assert.match(record?.restartStalled?.reason ?? '', /2 messages reached the session during the wait/);
});

test('a session whose own events start every turn restarts between two turns, because the daemon holds those events while it waits', async (t) => {
  const { home } = isolate(t, 'bellwether-restart-busy-');
  const rig = await herdr(t);
  const id = saveParent(emptyParent('claude-code', 'busy-lead', '/work', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p1' })).id;
  upsertChild(id, child());
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: LEAD_SESSION });
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'working', agent_session: { ...LEAD_SESSION, value: 'sess-1' } });

  const daemon = await startDaemon({ socketPath: path.join(home, 'daemon.sock'), home, idleMs: 300_000 });
  const session = await DaemonClient.connect({ harness: 'claude-code', session: 'busy-lead', cwd: '/work', host: hostName(), depth: 0, paneId: 'w1:p1', herdrSocket: rig.fake.socketPath }, { socketPath: daemon.socketPath, home, spawn: false });
  t.after(async () => {
    clearInterval(reports);
    clearInterval(turns);
    await session.close();
    await daemon.close();
  });

  // The session takes a turn on every event it receives. A turn that took one
  // goes straight into the next without herdr reporting idle, as a session fed
  // a message at the end of every turn does.
  const received: { at: number; entries: OutboxEntry[] }[] = [];
  let tookMessage = false;
  session.onEvents((entries) => {
    received.push({ at: Date.now(), entries });
    tookMessage = true;
    session.receipts(entries.map((entry) => entry.receipt));
  });
  let n = 0;
  const reports = setInterval(() => {
    const parent = readParent(id);
    const worker = parent?.children[0];
    if (parent && worker) acceptLocalReport(parent, worker, { status: 'progress', text: `step ${(n += 1)}` });
  }, 1_000);
  await until('the first event', () => (received.length ? true : undefined), 8_000);

  // The moment herdr is asked to close the old pane, which ends the wait.
  let closedAt = 0;
  const answer = rig.world.answer.bind(rig.world);
  rig.world.answer = (request) => {
    if (request.method === 'pane.close' && request.params['pane_id'] === 'w1:p1' && !closedAt) closedAt = Date.now();
    return answer(request);
  };
  const reply = await session.tool('agent_restart', {});
  assert.match(reply, /^Restart requested\./);
  assert.match(reply, /Until then Bellwether holds the events bound for this session/);
  const requestedAt = Date.now();
  tookMessage = false;
  const turns = setInterval(() => {
    if (tookMessage) tookMessage = false;
    else if (rig.world.panes.get('w1:p1')?.agent_status === 'working') setStatus(rig, 'w1:p1', 'idle');
  }, 6_000);

  const record = await until('the restart to run', () => {
    const current = readParent(id);
    return current?.paneId && current.paneId !== 'w1:p1' && current.restartedAt ? current : undefined;
  }, 20_000);
  assert.ok(closedAt, 'the old pane closed');
  assert.equal(record.restartRequestedAt, undefined);
  assert.equal(record.restartStalled, undefined);
  const during = received.filter((entry) => entry.at > requestedAt && entry.at < closedAt);
  assert.deepEqual(during, [], 'no event reached the session while its restart waited');
  assert.equal(restartLog().at(-1)?.['outcome'], 'restarted');
});
