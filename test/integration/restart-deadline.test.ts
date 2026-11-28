// Tier 2: every pending self-restart ends by its deadline, whatever it waits
// for (issue #220). Issue #196 bounded the wait for a session that never ends a
// turn. These cases cover the other ways a request stayed pending for hours: a
// pane herdr never reports a change for, an act refused after the wait, and a
// request a daemon re-arms with no pane on its record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { bellwetherHome } from '../../src/core/paths.ts';
import { emptyParent, listParents, mutateParent, readParent, saveParent } from '../../src/core/registry.ts';
import { armPendingRestarts, restartWaitLines, type RestartHooks } from '../../src/core/restart.ts';
import { requestLines, requestsInFlight } from '../../src/core/requests.ts';
import { hostName } from '../../src/core/spawn.ts';
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

const LEAD_SESSION = { agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value: 'quiet-lead' };

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

function hooksFor(deferTimeoutMs: number): { hooks: RestartHooks; jobs: Map<string, Promise<void>> } {
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
  return { hooks, jobs };
}

function context(id: string, rig: Rig, deferTimeoutMs: number): { tool: (args: Record<string, unknown>, caller: { paneId?: string }) => Promise<string>; jobs: Map<string, Promise<void>> } {
  const { hooks, jobs } = hooksFor(deferTimeoutMs);
  const ctx: ToolContext = { client: rig.client, clientFor: async () => rig.client, parentId: id, watcher: new Watcher({ client: rig.client, parentId: id, onEntries: () => {} }), restart: hooks };
  return { tool: (args, caller) => runBellwetherTool(ctx, 'agent_restart', args, caller), jobs };
}

function lead(paneId?: string): string {
  return saveParent(emptyParent('claude-code', 'quiet-lead', '/work', { workspaceId: 'w1', host: hostName(), ...(paneId ? { paneId } : {}) })).id;
}

test('a pane herdr reports idle and never changes restarts at the deadline instead of giving up on a turn that had ended', async (t) => {
  isolate(t, 'bellwether-restart-deadline-');
  const rig = await herdr(t);
  const id = lead('w1:p1');
  // The turn that asked ends without herdr sending a change: the pane reads idle throughout.
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'idle', agent_session: LEAD_SESSION });
  const { tool, jobs } = context(id, rig, 400);

  const reply = await tool({}, { paneId: 'w1:p1' });
  assert.match(reply, /^Restart requested\./);
  assert.match(reply, /If the turn has not ended within 0\.4 s, the daemon reads the pane from herdr once: idle restarts it, and anything else gives up and says what held it\./);
  await jobs.get(`parent:${id}`);

  const record = readParent(id);
  assert.equal(record?.restartStalled, undefined, record?.restartStalled?.reason);
  assert.equal(record?.restartRequestedAt, undefined);
  assert.ok(record?.restartedAt, 'the session restarted');
  assert.notEqual(record?.paneId, 'w1:p1');
  assert.equal(restartLog().at(-1)?.['outcome'], 'restarted');
});

test('a pane herdr reports no status for gives up at the deadline, saying herdr reported none rather than a live turn', async (t) => {
  isolate(t, 'bellwether-restart-deadline-');
  const rig = await herdr(t);
  const id = lead('w1:p1');
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'unknown', agent_session: LEAD_SESSION });
  const { tool, jobs } = context(id, rig, 400);

  assert.match(await tool({}, { paneId: 'w1:p1' }), /^Restart requested\./);
  await jobs.get(`parent:${id}`);

  const record = readParent(id);
  assert.equal(record?.restartRequestedAt, undefined, 'the request is over');
  const reason = record?.restartStalled?.reason ?? '';
  assert.match(reason, /herdr reported no status for pane w1:p1 within 0\.4 s/);
  assert.doesNotMatch(reason, /the turn was live/);
  assert.match(reason, /Nothing was closed\./);
  assert.equal(rig.fake.requests.filter((request) => request.method === 'pane.close' || request.method === 'tab.create').length, 0, 'nothing was closed or opened');
  assert.match(restartWaitLines(listParents()).join('\n'), /^warn +restart: session \S+ gave up the restart it requested at \S+ on pane w1:p1, at \S+: herdr reported no status/m);
});

test('a deferred restart whose act is refused after the turn ends closes the request, records why, and takes a new one', async (t) => {
  isolate(t, 'bellwether-restart-deadline-');
  const rig = await herdr(t);
  const id = lead('w1:p1');
  // The pane now holds another session, so the act refuses to close it.
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: { ...LEAD_SESSION, value: 'someone-else' } });
  const { tool, jobs } = context(id, rig, 5_000);

  assert.match(await tool({}, { paneId: 'w1:p1' }), /^Restart requested\./);
  await until('the wait to take its snapshot', () => readParent(id)?.restartWait?.status);
  const pane = rig.world.panes.get('w1:p1');
  if (pane) pane.agent_status = 'idle';
  rig.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } });
  await jobs.get(`parent:${id}`);

  const record = readParent(id);
  assert.equal(record?.restartRequestedAt, undefined, 'a refused act leaves no request pending');
  assert.equal(record?.restartWait, undefined);
  assert.match(record?.restartStalled?.reason ?? '', /the restart did not run: pane w1:p1 now holds session someone-else/);
  assert.equal(restartLog().at(-1)?.['outcome'], 'refused');
  assert.match(restartWaitLines(listParents()).join('\n'), /^warn +restart: session \S+ gave up the restart it requested at \S+ on pane w1:p1/m);
  // The doctor line never reads as a wait that has no end.
  assert.doesNotMatch(restartWaitLines(listParents()).join('\n'), /has a restart pending/);
  assert.match(await tool({}, { paneId: 'w1:p1' }), /^Restart requested\./, 'the session can ask again');
});

test('a request an older daemon left with no wait on its record is replaced by a new call, not echoed back forever', async (t) => {
  isolate(t, 'bellwether-restart-deadline-');
  const rig = await herdr(t);
  const id = lead('w1:p1');
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: LEAD_SESSION });
  mutateParent(id, (entry) => {
    // A request an older daemon wrote with no wait, which no transition of src/core/requests.ts writes.
    (entry as { restartRequestedAt?: string }).restartRequestedAt = '2026-11-28T02:38:18.961Z';
  });
  // The request has no wait, so its bound is the default one from its own time, long past: doctor fails it.
  const doctor = requestLines(requestsInFlight(listParents())).join('\n');
  assert.match(doctor, /^fail +request: restart of session \S+, requested since 2026-11-28T02:38:18\.961Z, outlived its bound 2026-11-28T02:43:18\.961Z\. Its owner, no daemon waits on it/m);
  const { tool, jobs } = context(id, rig, 300);

  const reply = await tool({}, { paneId: 'w1:p1' });
  assert.match(reply, /^Restart requested\./);
  assert.match(reply, /It replaces the request from 2026-11-28T02:38:18\.961Z, which nothing was waiting on\./);
  assert.ok(readParent(id)?.restartWait, 'the new request has a deadline');
  await jobs.get(`parent:${id}`);
});

test('a pending restart re-armed with no pane on its record gives up at once and says so', async (t) => {
  isolate(t, 'bellwether-restart-deadline-');
  const rig = await herdr(t);
  const id = lead();
  mutateParent(id, (entry) => {
    // A request an older daemon wrote with no wait, which no transition of src/core/requests.ts writes.
    (entry as { restartRequestedAt?: string }).restartRequestedAt = '2026-11-28T02:38:18.961Z';
  });
  const { hooks } = hooksFor(300);

  armPendingRestarts(rig.client, readParent(id)!, hooks);

  const record = readParent(id);
  assert.equal(record?.restartRequestedAt, undefined, 'the request no longer waits');
  assert.match(record?.restartStalled?.reason ?? '', /no pane on its record/);
  assert.match(restartWaitLines(listParents()).join('\n'), /^warn +restart: session \S+ gave up the restart it requested at 2026-11-28T02:38:18\.961Z/m);
});
