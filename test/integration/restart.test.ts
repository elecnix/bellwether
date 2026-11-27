// Tier 2: agent_restart against the fake herdr socket. A restart keeps the
// session: a child comes back in a new tab under the same child id, a caller
// restarting itself is deferred until its turn ends, and a parent session or a
// live agent gets a new pane on the same session with the old one left alone.
// The daemon refuses a target with no session to name, one on another machine,
// a pane Bellwether did not start when closing one is involved, and a mid-turn
// pane that never settles. Each case runs in its own root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { bellwetherHome, parentId as registryId } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { hostName } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry, ParentRecord } from '../../src/core/types.ts';
import type { RestartHooks } from '../../src/core/restart.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon, type Daemon } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
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

function parent(session: string, extra: Partial<ParentRecord> = {}): string {
  return saveParent(emptyParent('claude-code', session, '/work', { workspaceId: 'w1', host: hostName(), ...extra })).id;
}

const SESSION_1 = { agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value: 'sess-1' };

function worker(extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
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
    lastStatus: 'idle',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'id', value: 'sess-1' },
    depth: 1,
    ...extra,
  };
}

/** Put the worker's pane in the world, with the status herdr would report. */
function liveWorker(world: FakeWorld, status: 'idle' | 'working' | 'blocked' | 'done' = 'idle'): void {
  world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: status, agent_session: SESSION_1 });
}

interface Ctx {
  tool: (name: string, args: Record<string, unknown>, caller?: { paneId?: string; childId?: string }) => Promise<string>;
  jobs: Map<string, Promise<void>>;
  watcher: Watcher;
}

function context(id: string, rig: Rig): Ctx {
  const watcher = new Watcher({ client: rig.client, parentId: id, onEntries: () => {} });
  const jobs = new Map<string, Promise<void>>();
  const hooks: RestartHooks = {
    defer: (key, job) => {
      if (!jobs.has(key)) {
        const running = job();
        jobs.set(key, running);
        void running.finally(() => jobs.delete(key));
      }
    },
    waitTimeoutMs: 300,
    deferTimeoutMs: 2_000,
    startupTimeoutMs: 3_000,
    redrawMs: 10,
  };
  const ctx: ToolContext = {
    client: rig.client,
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return rig.client;
      throw new Error(`herdr has no saved machine ${host}`);
    },
    parentId: id,
    watcher,
    restart: hooks,
  };
  return { tool: (name, args, caller) => runBellwetherTool(ctx, name, args, caller), jobs, watcher };
}

function calls(fake: FakeHerdr, method: string): RecordedRequest[] {
  return fake.requests.filter((request) => request.method === method);
}

function lastStart(fake: FakeHerdr): RecordedRequest {
  return calls(fake, 'agent.start').at(-1) as RecordedRequest;
}

function children(id: string): ChildRecord[] {
  return readParent(id)?.children ?? [];
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

function restartLog(): Record<string, unknown>[] {
  const file = path.join(bellwetherHome(), 'restart.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function setStatus(rig: Rig, paneId: string, status: 'idle' | 'working' | 'blocked' | 'done'): void {
  const pane = rig.world.panes.get(paneId);
  if (pane) pane.agent_status = status;
  rig.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: paneId, agent_status: status } });
}

test('a child restart closes its tab and starts it on the same session under the same child id', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-idle');
  upsertChild(id, worker());
  liveWorker(rig.world);

  const text = await context(id, rig).tool('agent_restart', { target: 'worker' });
  assert.match(text, /Restarted worker \(child child-worker\)/);
  const child = children(id)[0];
  assert.ok(child);
  assert.equal(children(id).length, 1, 'no second child record');
  assert.notEqual(child.paneId, 'w1:p3');
  assert.match(text, new RegExp(`started claude in pane ${child.paneId.replace(':', '\\:')}`));
  assert.match(text, /--resume sess-1/);
  assert.match(text, /The session id matches\./);

  assert.deepEqual(calls(rig.fake, 'tab.close').map((request) => request.params['tab_id']), ['w1:t3']);
  const created = calls(rig.fake, 'tab.create')[0]?.params;
  assert.equal(created?.['label'], 'worker', 'same tab label');
  assert.equal(created?.['cwd'], '/work/repo', 'same working directory');
  const env = created?.['env'] as Record<string, string>;
  assert.equal(env['BELLWETHER_CHILD'], 'child-worker', 'same child id');
  assert.equal(env['BELLWETHER_PARENT'], id, 'same parent');
  const args = lastStart(rig.fake).params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.equal(rig.world.panes.get(child.paneId)?.agent_session?.value, 'sess-1');
  assert.equal(rig.world.panes.has('w1:p3'), false, 'the old pane is gone');

  assert.ok(child.restartedAt, 'the record carries the restart');
  assert.equal(child.restartRequestedAt, undefined);
  const log = restartLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]?.['outcome'], 'restarted');
  assert.equal(log[0]?.['child'], 'child-worker');
  assert.equal(log[0]?.['oldPane'], 'w1:p3');
  assert.equal(log[0]?.['newPane'], child.paneId);
  assert.equal(log[0]?.['sessionMatched'], true);
});

test('a mid-turn child is waited on, and the reply reports the wait', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-working');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');

  const run = context(id, rig).tool('agent_restart', { target: 'worker', wait_seconds: 30 });
  await rig.fake.waitFor('events.subscribe');
  await new Promise((resolve) => setTimeout(resolve, 50));
  setStatus(rig, 'w1:p3', 'idle');
  const text = await run;
  assert.match(text, /Restarted worker/);
  assert.match(text, /waited \d+ ms for the turn to end/);
  assert.equal(calls(rig.fake, 'tab.close').length, 1);
  assert.equal(calls(rig.fake, 'agent.start').length, 1);
});

test('a child still working when the wait runs out is refused and left alone', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-busy');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'worker' }), /worker is still working after the 0\.3 s wait; agent_restart never restarts a pane mid-turn/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0, 'nothing was closed');
  assert.equal(calls(rig.fake, 'agent.start').length, 0);
  assert.equal(children(id)[0]?.paneId, 'w1:p3', 'the record still points at the live pane');
  assert.equal(restartLog().length, 0);
});

test('a child restarting itself defers to the end of its turn and then restarts in place', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-self-child');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');
  const { tool, jobs } = context(id, rig);
  const caller = { childId: 'child-worker', paneId: 'w1:p3' };

  const text = await tool('agent_restart', {}, caller);
  assert.match(text, /Restart requested for worker \(child child-worker\)/);
  assert.match(text, /Once this turn ends/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0, 'the caller is not killed mid-call');
  assert.ok(children(id)[0]?.restartRequestedAt, 'the deferral is on the record');
  assert.ok(jobs.has('child:child-worker'), 'the deferred act was armed');
  assert.equal(children(id)[0]?.paneId, 'w1:p3');

  // The turn ends: herdr reports idle, and only then does the daemon act.
  await rig.fake.waitFor('events.subscribe');
  setStatus(rig, 'w1:p3', 'idle');
  const newPane = await until('the new pane', () => {
    const pane = children(id)[0]?.paneId;
    return pane && pane !== 'w1:p3' ? pane : undefined;
  });
  await jobs.get('child:child-worker');

  assert.deepEqual(calls(rig.fake, 'tab.close').map((request) => request.params['tab_id']), ['w1:t3']);
  const args = lastStart(rig.fake).params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  const child = children(id)[0];
  assert.equal(child?.paneId, newPane);
  assert.equal(child?.id, 'child-worker');
  assert.equal(child?.restartRequestedAt, undefined);
  assert.ok(child?.restartedAt);
  assert.equal(rig.world.panes.get(newPane)?.agent_session?.value, 'sess-1');
  assert.equal(restartLog().at(-1)?.['sessionMatched'], true);
});

test('a session restarting itself gets a new pane on the same session after its turn, with the old pane left alone', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('parent-session', { paneId: 'w1:p1' });
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'parent-session' } });
  const { tool, jobs } = context(id, rig);

  const text = await tool('agent_restart', {}, { paneId: 'w1:p1' });
  assert.match(text, /Restart requested/);
  assert.match(text, /Once this turn ends/);
  assert.equal(rig.world.panes.size, 1, 'no new pane yet');
  assert.ok(readParent(id)?.restartRequestedAt, 'the deferral is on the parent record');
  assert.ok(jobs.has(`parent:${id}`));

  await rig.fake.waitFor('events.subscribe');
  setStatus(rig, 'w1:p1', 'idle');
  await jobs.get(`parent:${id}`);

  const record = readParent(id);
  const newPane = record?.paneId ?? '';
  assert.ok(newPane && newPane !== 'w1:p1', 'the record points at the new pane');
  assert.equal(rig.world.panes.has('w1:p1'), true, 'the old pane is left alone');
  assert.equal(record?.restartRequestedAt, undefined);
  assert.ok(record?.restartedAt);

  const started = lastStart(rig.fake);
  assert.equal(started.params['pane_id'], newPane);
  const args = started.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'parent-session'], 'the harness command carries the same session');
  assert.equal(rig.world.panes.get(newPane)?.agent_session?.value, 'parent-session');
  const env = calls(rig.fake, 'tab.create')[0]?.params['env'] as Record<string, string>;
  assert.equal(env['BELLWETHER_CHILD'], undefined, 'a top-level session keeps no child environment');
  assert.equal(env['BELLWETHER_PARENT'], undefined);
  const log = restartLog().at(-1);
  assert.equal(log?.['target'], 'parent');
  assert.equal(log?.['oldPane'], 'w1:p1');
  assert.equal(log?.['newPane'], newPane);
  assert.equal(log?.['sessionMatched'], true);
});

test('a target with no recorded session is refused, naming the record', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-no-session');
  upsertChild(id, worker({ session: undefined }));
  liveWorker(rig.world);

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'child-worker' }), /worker \(child child-worker, pane w1:p3\) has no recorded session, so agent_restart cannot reopen it/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
  assert.equal(calls(rig.fake, 'agent.start').length, 0);
});

test('a second restart during one is refused by the lock', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-lock');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');
  const { tool } = context(id, rig);

  const first = tool('agent_restart', { target: 'worker', wait_seconds: 45 });
  await rig.fake.waitFor('events.subscribe');
  await assert.rejects(tool('agent_restart', { target: 'worker' }), /worker \(child child-worker\) is already being restarted by another call \(process \d+, restart of worker/);
  setStatus(rig, 'w1:p3', 'idle');
  const text = await first;
  assert.match(text, /Restarted worker/);
  assert.equal(calls(rig.fake, 'agent.start').length, 1, 'one restart happened between the two calls');
  assert.equal(calls(rig.fake, 'tab.close').length, 1);
});

test('an adopted child, and a child on another machine, are refused', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const adoptedId = parent('restart-adopted');
  upsertChild(adoptedId, worker({ origin: 'adopt' }));
  liveWorker(rig.world);
  await assert.rejects(context(adoptedId, rig).tool('agent_restart', { target: 'worker' }), /worker \(child child-worker\) was adopted, not started by Bellwether, so agent_restart will not close pane w1:p3/);

  const remoteId = parent('restart-remote');
  upsertChild(remoteId, worker({ host: 'hawthorne' }));
  await assert.rejects(context(remoteId, rig).tool('agent_restart', { target: 'worker' }), /worker runs on machine hawthorne, and this daemon only restarts agents on its own machine/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
});

test('a live agent no registry holds restarts in a new pane on the same session, with the old pane left alone', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-stray');
  rig.world.add({ pane_id: 'w1:p9', tab_id: 'w1:t9', agent: 'pi', name: 'stray', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: '/sessions/2026-11-27_stray.jsonl' }, cwd: '/work/stray' });
  rig.world.add({ pane_id: 'w1:p30' });

  const text = await context(id, rig).tool('agent_restart', { target: 'stray' });
  assert.match(text, /Restarted stray/);
  assert.match(text, /The old pane w1:p9 is left alone/);
  const started = lastStart(rig.fake);
  const args = started.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', '/sessions/2026-11-27_stray.jsonl']);
  assert.notEqual(started.params['pane_id'], 'w1:p9');
  assert.equal(rig.world.panes.has('w1:p9'), true, 'the old pane is left alone');
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
  assert.equal(restartLog().at(-1)?.['sessionMatched'], true);

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'w1:p30' }), /Pane w1:p30 holds no agent herdr recognizes, so there is nothing to restart/);
});

test('a parent session named by its session id restarts in a new pane whose command carries that session', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  saveParent(emptyParent('claude-code', 'ops-session', '/work/ops', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p7' }));
  rig.world.add({ pane_id: 'w1:p7', tab_id: 'w1:t7', agent: 'claude', name: 'ops', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'ops-session' }, cwd: '/work/ops' });
  const callerId = parent('restart-caller');

  const text = await context(callerId, rig).tool('agent_restart', { target: 'ops-session' });
  assert.match(text, /Restarted ops/);
  assert.match(text, /--resume ops-session/);
  assert.match(text, /The old pane w1:p7 is left alone/);
  const started = lastStart(rig.fake);
  const args = started.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'ops-session']);
  const newPane = String(started.params['pane_id']);
  assert.equal(rig.world.panes.get(newPane)?.agent_session?.value, 'ops-session');
  assert.equal(readParent(registryId('claude-code', 'ops-session'))?.paneId, newPane, 'the parent record points at the new pane');
  assert.equal(calls(rig.fake, 'tab.create')[0]?.params['cwd'], '/work/ops', 'same working directory');
});

test('a pi session restarts with its session file passed to --session', async (t) => {
  const { root } = isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const sessions = path.join(root, '.pi', 'agent', 'sessions', 'work');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, '2026-11-27T00-00-00_pi-sess.jsonl');
  fs.writeFileSync(file, '{}\n');
  saveParent(emptyParent('pi', 'pi-sess', '/work', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p8' }));
  rig.world.add({ pane_id: 'w1:p8', tab_id: 'w1:t8', agent: 'pi', name: 'scribe', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'id', source: 'herdr:pi', value: 'pi-sess' } });
  const callerId = parent('restart-pi-caller');

  const text = await context(callerId, rig).tool('agent_restart', { target: 'pi-sess' });
  assert.match(text, /Restarted scribe/);
  const args = lastStart(rig.fake).params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', file]);
});

test('a claude session whose record holds a process marker instead of a session id is refused', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  saveParent(emptyParent('claude-code', 'pid-4242', '/work', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p2' }));
  await assert.rejects(context(parent('restart-pid'), rig).tool('agent_restart', { target: 'pid-4242' }), /session claude-code-pid-4242 holds pid-4242, a process marker, so there is no session to resume/);
  assert.equal(calls(rig.fake, 'tab.create').length, 0);
});

test('a daemon that starts with a pending restart re-arms it', async (t) => {
  const { home } = isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('rearm');
  upsertChild(id, worker({ lastStatus: 'working', restartRequestedAt: new Date().toISOString() }));
  liveWorker(rig.world, 'working');

  const daemon: Daemon = await startDaemon({ socketPath: path.join(home, 'daemon.sock'), home, idleMs: 300_000 });
  const client = await DaemonClient.connect({ harness: 'claude-code', session: 'rearm', cwd: '/work', host: hostName(), depth: 0, herdrSocket: rig.fake.socketPath }, { socketPath: daemon.socketPath, home, spawn: false });
  t.after(async () => {
    await client.close();
    await daemon.close();
  });

  await until('the restart subscription', () => (calls(rig.fake, 'events.subscribe').length >= 2 ? true : undefined));
  setStatus(rig, 'w1:p3', 'idle');
  await until('the restart to finish', () => {
    const child = children(id)[0];
    return child && child.paneId !== 'w1:p3' && child.restartedAt && child.restartRequestedAt === undefined ? child : undefined;
  });
  assert.ok(restartLog().some((line) => line['child'] === 'child-worker' && line['outcome'] === 'restarted'));
});

test('a restart publishes no exited event for the old pane', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-quiet');
  const now = new Date().toISOString();
  upsertChild(id, worker({ startedAt: now, statusChangedAt: now, lastBusyAt: now }));
  liveWorker(rig.world);
  const { tool, watcher } = context(id, rig);
  const entries: OutboxEntry[] = [];
  watcher.stop();
  const watching = new Watcher({ client: rig.client, parentId: id, onEntries: (fresh) => entries.push(...fresh), tickMs: 60_000, screenPollMs: 0 });
  watching.start();
  t.after(() => watching.stop());
  await rig.fake.waitFor('events.subscribe');

  await tool('agent_restart', { target: 'worker' });
  // herdr sends tab_closed for the old tab; with the restart on the record it names no child.
  rig.fake.send({ event: 'tab_closed', data: { tab_id: 'w1:t3' } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(entries, [], 'the parent hears nothing about the swap');
});

test('an unknown target says what to call next', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-unknown');
  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'nonesuch' }), /No child, parent session or live agent matches "nonesuch"\. Call agent_list for this session's children/);
});
