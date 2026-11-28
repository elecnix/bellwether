// Tier 2: the five ways a child comes back, each through its real code path
// (issue #277). Each case leaves every field of a previous run on the record,
// then runs the path, and fails on each field that survived it.
//
// A path that starts a new run clears the run's fields and its end's fields.
// A path that finds the run never ended clears only the end's fields, and
// keeps what the run that goes on had already shown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptPane } from '../../src/core/adopt.ts';
import type { CarryDeps } from '../../src/core/carry.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { recoverCrossings } from '../../src/core/recover-crossing.ts';
import { emptyParent, readParent, saveParent, updateChild, upsertChild } from '../../src/core/registry.ts';
import type { RestartHooks } from '../../src/core/restart.ts';
import { hostName } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const SESSION_1 = { agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value: 'sess-1' };

/** Every field a previous run leaves on the record, with a value of its type. */
function previousRun(pane = 'w1:p3'): Partial<ChildRecord> {
  return {
    exitedAt: HOUR_AGO,
    exitCode: 1,
    harnessEnded: 'in-pane',
    tabClosedAt: HOUR_AGO,
    paneEnd: { pane, how: 'closed', at: HOUR_AGO },
    awaitsResume: HOUR_AGO,
    restartFailed: { at: HOUR_AGO, oldPane: pane, session: 'sess-1', error: 'example failure', reopen: 'agent_spawn and resume sess-1' },
    crossingFailed: { at: HOUR_AGO, verb: 'move', from: LOCAL_HOST, to: 'box', stage: 'stopped', error: 'example failure', reopen: 'agent_spawn with resume worker' },
    harnessSeenAt: HOUR_AGO,
    reportPending: true,
    closing: { pane, until: HOUR_AGO },
    restartInDoubt: { host: 'box', requestId: 'rs-example', at: HOUR_AGO, oldPane: pane, error: 'example lost answer', launch: {} },
    startingUntil: HOUR_AGO,
  };
}

/** The fields that record how a run ended. */
const END_FIELDS = ['exitedAt', 'exitCode', 'harnessEnded', 'tabClosedAt', 'paneEnd', 'awaitsResume', 'restartFailed', 'crossingFailed'] as const;
/** The fields a run writes while it lasts. */
const RUN_FIELDS = ['reportPending', 'closing', 'restartInDoubt', 'startingUntil', 'harnessSeenAt'] as const;

/** The fields in `fields` still set on the record, by name. */
function survivors(child: ChildRecord | undefined, fields: readonly string[]): string[] {
  assert.ok(child, 'the child record is gone');
  return fields.filter((field) => (child as unknown as Record<string, unknown>)[field] !== undefined);
}

function worker(extra: Partial<ChildRecord> = {}): ChildRecord {
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
    startedAt: HOUR_AGO,
    lastStatus: 'idle',
    statusChangedAt: HOUR_AGO,
    lastBusyAt: HOUR_AGO,
    session: { kind: 'id', value: 'sess-1' },
    depth: 1,
    ...extra,
  };
}

interface Rig {
  world: FakeWorld;
  client: HerdrClient;
}

async function herdr(t: test.TestContext, workspace = 'w1'): Promise<Rig> {
  const world = fakeWorld(workspace);
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

function parent(session: string): string {
  return saveParent(emptyParent('claude-code', session, '/work', { workspaceId: 'w1', host: hostName() })).id;
}

function context(parentId: string, rig: Rig): ToolContext {
  const restart: RestartHooks = { waitTimeoutMs: 300, deferTimeoutMs: 2_000, startupTimeoutMs: 3_000, redrawMs: 10 };
  return {
    client: rig.client,
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return rig.client;
      throw new Error(`herdr has no saved machine ${host}`);
    },
    parentId,
    watcher: new Watcher({ client: rig.client, parentId, onEntries: () => {} }),
    restart,
  };
}

function child(parentId: string, id = 'child-worker'): ChildRecord | undefined {
  return readParent(parentId)?.children.find((entry) => entry.id === id);
}

test('a resume of an exited child leaves nothing of its previous run', async (t) => {
  isolate(t, 'bellwether-incarnation-');
  const rig = await herdr(t);
  const id = parent('resume');
  upsertChild(id, worker(previousRun()));

  await runBellwetherTool(context(id, rig), 'agent_spawn', { resume: 'worker', prompt: 'Pick up where you stopped.' });
  assert.deepEqual(survivors(child(id), [...END_FIELDS, ...RUN_FIELDS]), []);
});

test('a restart of a live child leaves nothing of its previous run', async (t) => {
  isolate(t, 'bellwether-incarnation-');
  const rig = await herdr(t);
  const id = parent('restart');
  // A live child: the run has not ended, so the end's fields are what an
  // earlier run left behind and the revivals since did not clear. A restart
  // refuses a child whose last restart is in doubt, so that field stays out.
  const { exitedAt: _exitedAt, restartInDoubt: _doubt, ...left } = previousRun();
  upsertChild(id, worker(left));
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: SESSION_1 });

  const text = await runBellwetherTool(context(id, rig), 'agent_restart', { target: 'worker' });
  assert.match(text, /Restarted worker/);
  assert.deepEqual(survivors(child(id), [...END_FIELDS, ...RUN_FIELDS]), []);
});

test('an adopted session back in its pane leaves nothing of its previous run, and herdr has seen its harness', async (t) => {
  isolate(t, 'bellwether-incarnation-');
  const rig = await herdr(t);
  const X = 'w1:p1';
  const S1 = '3f1c2a9e-0000-4000-8000-000000000001';
  rig.world.add({ pane_id: 'w1:p0', agent: 'claude', name: 'parent', agent_session: { ...SESSION_1, value: 'parent-session' } });
  rig.world.add({ pane_id: X, agent: 'claude', name: 'hand-x', agent_status: 'idle', agent_session: { ...SESSION_1, value: S1 } });
  const id = saveParent(emptyParent('claude-code', 'adopter', '/work', { paneId: 'w1:p0', workspaceId: 'w1' })).id;
  const first = (await adoptPane(rig.client, readParent(id)!, { target: X })).child.id;
  updateChild(id, first, (entry) => Object.assign(entry, previousRun(X)));

  const before = Date.now();
  const again = await adoptPane(rig.client, readParent(id)!, { target: X });
  assert.equal(again.child.id, first);
  assert.equal(again.revived, true);
  const record = child(id, first);
  assert.deepEqual(survivors(record, [...END_FIELDS, ...RUN_FIELDS.filter((field) => field !== 'harnessSeenAt')]), []);
  assert.ok(record?.harnessSeenAt && Date.parse(record.harnessSeenAt) >= before - 1_000, `harnessSeenAt is the revival time, not ${record?.harnessSeenAt}`);
});

test('a resume that finds the session alive in its own pane clears the recorded end, and keeps what the run showed', async (t) => {
  isolate(t, 'bellwether-incarnation-');
  const rig = await herdr(t);
  const id = parent('corrected');
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_session: SESSION_1 });
  upsertChild(id, worker(previousRun()));

  const text = await runBellwetherTool(context(id, rig), 'agent_spawn', { resume: 'worker' });
  assert.match(text, /cleared the exit/);
  const record = child(id);
  assert.deepEqual(survivors(record, END_FIELDS), []);
  assert.equal(record?.harnessSeenAt, HOUR_AGO, 'the run goes on, and herdr saw its harness');
  assert.equal(record?.reportPending, true, 'the run goes on, and its turn still owes the report its event');
});

/** Two machines, this one and `box`, each with its own fake herdr, and a crossing a dead daemon left from here to box. */
async function crossing(t: test.TestContext): Promise<{ here: Rig; box: Rig; id: string; deps: CarryDeps }> {
  isolate(t, 'bellwether-incarnation-');
  const here = await herdr(t, 'w1');
  const box = await herdr(t, 'w9');
  const id = parent('crossing');
  const session = { kind: 'id', value: 'sess-1' };
  upsertChild(
    id,
    worker({
      ...previousRun(),
      moving: { from: LOCAL_HOST, to: 'box', since: HOUR_AGO, until: new Date(Date.now() + 3_600_000).toISOString(), verb: 'move', daemon: 'example-dead-daemon', stage: 'started', state: 'live', files: [], source: { cwd: '/work/repo', paneId: 'w1:p3', tabId: 'w1:t3', workspaceId: 'w1', session }, target: { cwd: '/box/repo', session } },
    }),
  );
  const endpoint = { commit: async () => ({}), discard: async () => ({}) };
  const deps = {
    clientFor: async (host: string) => (host === 'box' ? box.client : here.client),
    endpointFor: () => endpoint,
    knownHosts: async () => [LOCAL_HOST, 'box'],
  } as unknown as CarryDeps;
  return { here, box, id, deps };
}

test('a crossing recovered at its destination leaves nothing of the run on the source', async (t) => {
  const { box, id, deps } = await crossing(t);
  box.world.add({ pane_id: 'w9:p4', tab_id: 'w9:t4', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: SESSION_1 });

  const [done] = await recoverCrossings(deps, id);
  assert.equal(done?.outcome, 'finished', done?.detail);
  const record = child(id);
  assert.equal(record?.paneId, 'w9:p4');
  assert.deepEqual(survivors(record, [...END_FIELDS, ...RUN_FIELDS]), []);
});

test('a crossing undone while the source still runs the session clears the recorded end, and keeps what the run showed', async (t) => {
  const { here, id, deps } = await crossing(t);
  here.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: SESSION_1 });

  const [done] = await recoverCrossings(deps, id);
  assert.equal(done?.outcome, 'undone', done?.detail);
  const record = child(id);
  assert.deepEqual(survivors(record, END_FIELDS), []);
  assert.equal(record?.harnessSeenAt, HOUR_AGO, 'the run goes on, and herdr saw its harness');
  assert.equal(record?.reportPending, true, 'the run goes on, and its turn still owes the report its event');
});

test('a resume that fails puts back every field of the run before it', async (t) => {
  isolate(t, 'bellwether-incarnation-');
  const world = fakeWorld('w1');
  // The record already takes the new run when herdr fails to open its tab.
  const fake = await startFakeHerdr({ respond: (request) => (request.method === 'tab.create' ? { error: { code: 'example_failure', message: 'the tab did not open' } } : world.respond(request)) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const rig = { world, client: new HerdrClient({ socketPath: fake.socketPath }) };
  const id = parent('resume-fails');
  const before = worker(previousRun());
  upsertChild(id, before);

  await assert.rejects(runBellwetherTool(context(id, rig), 'agent_spawn', { resume: 'worker', prompt: 'Pick up where you stopped.' }), /the tab did not open/);
  const after = child(id);
  const fields = ['paneId', 'tabId', 'lastStatus', ...END_FIELDS, ...RUN_FIELDS] as const;
  const changed = fields.filter((field) => JSON.stringify(after?.[field]) !== JSON.stringify(before[field]));
  assert.deepEqual(changed, [], 'a failed resume leaves the record naming the run it had, such as a restart or crossing that failed');
});
