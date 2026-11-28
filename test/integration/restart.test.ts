// Tier 2: agent_restart against the fake herdr socket. A restart keeps the
// session and leaves no pane behind: a child comes back in a new tab under the
// same child id, a parent session's pane closes before the same session starts
// in a new one, and a caller restarting itself is deferred until its turn
// ends. The daemon refuses a target with no session to name, one on another
// machine it holds no relay to, a pane no registry holds, a parent pane that now holds another
// session, and a mid-turn pane that never settles. Each case runs in its own root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { bellwetherHome, parentId as registryId } from '../../src/core/paths.ts';
import { PI_EXTENSION_ENV, piExtensionEntry } from '../../src/core/pi-extension.ts';
import { emptyParent, listParents, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { hostName } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry, ParentRecord } from '../../src/core/types.ts';
import { restartFailureLines, type RestartHooks } from '../../src/core/restart.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon, type Daemon } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest, harnessStart, harnessStarts, type HarnessStartRequest } from '../fixtures/fake-herdr.ts';
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
  /** Aborts the service signal, as the daemon does when the session's adapter says bye. */
  service: AbortController;
}

function context(id: string, rig: Rig): Ctx {
  const watcher = new Watcher({ client: rig.client, parentId: id, onEntries: () => {} });
  const jobs = new Map<string, Promise<void>>();
  const service = new AbortController();
  const hooks: RestartHooks = {
    signal: service.signal,
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
  return { tool: (name, args, caller) => runBellwetherTool(ctx, name, args, caller), jobs, watcher, service };
}

/**
 * Stop the caller's service the moment herdr closes its pane or tab, before
 * herdr answers: the adapter in that pane dies and says bye, so the daemon
 * stops its service while the restart is still under way.
 */
function byeOnClose(rig: Rig, service: AbortController, close: { method: 'tab.close' | 'pane.close'; id: string }): void {
  const answer = rig.world.answer.bind(rig.world);
  rig.world.answer = (request) => {
    const id = request.params[close.method === 'tab.close' ? 'tab_id' : 'pane_id'];
    if (request.method === close.method && id === close.id) service.abort();
    return answer(request);
  };
}

function calls(fake: FakeHerdr, method: string): RecordedRequest[] {
  return fake.requests.filter((request) => request.method === method);
}

function lastStart(fake: FakeHerdr): HarnessStartRequest {
  return harnessStarts(fake).at(-1) as HarnessStartRequest;
}

function listParentsBySession(session: string): ParentRecord | undefined {
  return listParents().find((record) => record.session === session);
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
  const args = lastStart(rig.fake).args;
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
  assert.equal(harnessStarts(rig.fake).length, 1);
});

test('a child still working when the wait runs out is refused and left alone', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-busy');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'worker' }), /worker is still working after the 0\.3 s wait; agent_restart never restarts a pane mid-turn/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0, 'nothing was closed');
  assert.equal(harnessStarts(rig.fake).length, 0);
  assert.equal(children(id)[0]?.paneId, 'w1:p3', 'the record still points at the live pane');
  assert.equal(restartLog().length, 0);
});

test('a child restarting itself defers to the end of its turn and then restarts in place, even as its own service stops', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-self-child');
  upsertChild(id, worker({ lastStatus: 'working' }));
  liveWorker(rig.world, 'working');
  const { tool, jobs, service } = context(id, rig);
  byeOnClose(rig, service, { method: 'tab.close', id: 'w1:t3' });
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
  assert.equal(service.signal.aborted, true, 'the caller\'s service stopped when its tab closed');
  const args = lastStart(rig.fake).args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  const child = children(id)[0];
  assert.equal(child?.paneId, newPane);
  assert.equal(child?.id, 'child-worker');
  assert.equal(child?.restartRequestedAt, undefined);
  assert.ok(child?.restartedAt);
  assert.equal(rig.world.panes.get(newPane)?.agent_session?.value, 'sess-1');
  assert.equal(restartLog().at(-1)?.['sessionMatched'], true);
});

test('a session restarting itself closes its own pane after its turn and reopens the same session with its channel', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('parent-session', { paneId: 'w1:p1' });
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'parent-session' } });
  const { tool, jobs, service } = context(id, rig);
  byeOnClose(rig, service, { method: 'pane.close', id: 'w1:p1' });

  const text = await tool('agent_restart', {}, { paneId: 'w1:p1' });
  assert.match(text, /Restart requested\. Once this turn ends, the daemon closes this pane \(w1:p1\)/);
  assert.equal(calls(rig.fake, 'pane.close').length, 0, 'the caller is not killed mid-call');
  assert.equal(rig.world.panes.size, 1, 'no new pane yet');
  assert.ok(readParent(id)?.restartRequestedAt, 'the deferral is on the parent record');
  assert.ok(jobs.has(`parent:${id}`));

  await rig.fake.waitFor('events.subscribe');
  setStatus(rig, 'w1:p1', 'idle');
  await jobs.get(`parent:${id}`);

  assert.deepEqual(calls(rig.fake, 'pane.close').map((request) => request.params['pane_id']), ['w1:p1'], 'the old pane is closed');
  assert.equal(service.signal.aborted, true, 'the caller\'s service stopped when its pane closed');
  assert.equal(rig.world.panes.has('w1:p1'), false);
  const order = rig.fake.requests.map((request) => request.method).filter((method) => method === 'pane.close' || method === 'agent.start');
  assert.deepEqual(order, ['pane.close', 'agent.start'], 'one process holds the session at a time');
  const record = readParent(id);
  const newPane = record?.paneId ?? '';
  assert.ok(newPane && newPane !== 'w1:p1', 'the record points at the new pane');
  assert.equal(record?.restartRequestedAt, undefined);
  assert.ok(record?.restartedAt);
  assert.equal(rig.world.panes.size, 1, 'only the new pane is left');

  const started = lastStart(rig.fake);
  assert.equal(started.paneId, newPane);
  const args = started.args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'parent-session'], 'the harness command carries the same session');
  assert.ok(args.includes('--dangerously-load-development-channels=plugin:bellwether@elecnix-plugins'), `the restarted session loads the Bellwether channel: ${JSON.stringify(args)}`);
  assert.equal(rig.world.panes.get(newPane)?.screen?.includes('Loading development channels'), false, 'the daemon answered the channel question');
  assert.equal(rig.world.panes.get(newPane)?.agent_session?.value, 'parent-session');
  const created = calls(rig.fake, 'tab.create')[0]?.params;
  assert.equal(created?.['label'], 'lead', 'same tab label');
  const env = created?.['env'] as Record<string, string>;
  assert.equal(env['BELLWETHER_CHILD'], undefined, 'a top-level session keeps no child environment');
  assert.equal(env['BELLWETHER_PARENT'], undefined);
  const log = restartLog().at(-1);
  assert.equal(log?.['target'], 'parent');
  assert.equal(log?.['oldPane'], 'w1:p1');
  assert.equal(log?.['newPane'], newPane);
  assert.equal(log?.['sessionMatched'], true);
});

test('a parent pane that now holds another session is refused, and nothing is closed or started', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  saveParent(emptyParent('claude-code', 'ops-session', '/work/ops', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p7' }));
  rig.world.add({ pane_id: 'w1:p7', tab_id: 'w1:t7', agent: 'claude', name: 'other', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'someone-else' } });
  await assert.rejects(context(parent('restart-reused'), rig).tool('agent_restart', { target: 'ops-session' }), /pane w1:p7 now holds session someone-else, not ops-session, so agent_restart closed nothing and started nothing/);
  assert.equal(calls(rig.fake, 'pane.close').length, 0);
  assert.equal(calls(rig.fake, 'tab.create').length, 0);
  assert.equal(rig.world.panes.has('w1:p7'), true);
});

test('a session that is itself a child restarts as that child, under its child id', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const outer = parent('outer');
  upsertChild(outer, worker());
  liveWorker(rig.world);
  const nested = saveParent(emptyParent('claude-code', 'sess-1', '/work/repo', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p3', depth: 1 })).id;

  const text = await context(parent('restart-nested-caller'), rig).tool('agent_restart', { target: nested });
  assert.match(text, /Restarted worker/);
  assert.deepEqual(calls(rig.fake, 'tab.close').map((request) => request.params['tab_id']), ['w1:t3'], 'the tab Bellwether started is closed');
  assert.equal(calls(rig.fake, 'pane.close').length, 0);
  const child = children(outer)[0];
  assert.equal(child?.id, 'child-worker');
  assert.notEqual(child?.paneId, 'w1:p3');
  assert.equal((calls(rig.fake, 'tab.create')[0]?.params['env'] as Record<string, string>)['BELLWETHER_CHILD'], 'child-worker');
  assert.equal(readParent(nested)?.paneId, child?.paneId, 'the session\'s own record follows it');
});

test('a pi child restarts with the extension and the provider and model it was spawned with', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-pi-child');
  const session = '/sessions/2026-11-27T00-00-00_pi-child.jsonl';
  upsertChild(id, worker({ kind: 'pi', harness: 'pi', session: { kind: 'path', value: session }, model: { provider: 'openrouter', id: 'example-cheap', source: 'parent' } }));
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'pi', name: 'worker', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: session } });

  const text = await context(id, rig).tool('agent_restart', { target: 'worker' });
  assert.match(text, /Restarted worker \(child child-worker\): closed pane w1:p3, started pi/);
  const extension = piExtensionEntry();
  const args = lastStart(rig.fake).args;
  assert.deepEqual(args, ['--provider', 'openrouter', '--model', 'example-cheap', '-e', extension, '--session', session], 'the same launch a spawn gives a pi child, on its own session');
  const env = calls(rig.fake, 'tab.create')[0]?.params['env'] as Record<string, string>;
  assert.equal(env[PI_EXTENSION_ENV], extension);
  assert.equal(env['BELLWETHER_CHILD'], 'child-worker');
});

test('a target with no recorded session is refused, naming the record', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-no-session');
  upsertChild(id, worker({ session: undefined }));
  liveWorker(rig.world);

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'child-worker' }), /worker \(child child-worker, pane w1:p3\) has no recorded session, so agent_restart cannot reopen it/);
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
  assert.equal(harnessStarts(rig.fake).length, 0);
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
  assert.equal(harnessStarts(rig.fake).length, 1, 'one restart happened between the two calls');
  assert.equal(calls(rig.fake, 'tab.close').length, 1);
});

test('an adopted child, and a child on another machine with no relay to it, are refused', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const adoptedId = parent('restart-adopted');
  upsertChild(adoptedId, worker({ origin: 'adopt' }));
  liveWorker(rig.world);
  await assert.rejects(context(adoptedId, rig).tool('agent_restart', { target: 'worker' }), /worker \(child child-worker\) was adopted, not started by Bellwether, so agent_restart will not close pane w1:p3/);

  const remoteId = parent('restart-remote');
  upsertChild(remoteId, worker({ host: 'hawthorne' }));
  await assert.rejects(context(remoteId, rig).tool('agent_restart', { target: 'worker' }), /worker runs on machine hawthorne, and it was not restarted: this daemon holds no relay connection to that machine, which a restart there goes through\./);
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
});

test('a live agent no registry holds is refused, and nothing is closed or started', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-stray');
  rig.world.add({ pane_id: 'w1:p9', tab_id: 'w1:t9', agent: 'pi', name: 'stray', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: '/sessions/2026-11-27_stray.jsonl' }, cwd: '/work/stray' });
  rig.world.add({ pane_id: 'w1:p30' });

  for (const target of ['stray', 'w1:p9']) {
    await assert.rejects(context(id, rig).tool('agent_restart', { target }), /stray in pane w1:p9 is not a session any Bellwether registry holds, so agent_restart neither closes that pane nor starts a second copy of its session/);
  }
  assert.equal(calls(rig.fake, 'pane.close').length, 0);
  assert.equal(calls(rig.fake, 'tab.close').length, 0);
  assert.equal(calls(rig.fake, 'tab.create').length, 0);
  assert.equal(rig.world.panes.has('w1:p9'), true);

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'w1:p30' }), /Pane w1:p30 holds no agent herdr recognizes, so there is nothing to restart/);
});

test('a parent session named by its session id restarts in a new pane whose command carries that session', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  saveParent(emptyParent('claude-code', 'ops-session', '/work/ops', { workspaceId: 'w1', host: hostName(), paneId: 'w1:p7' }));
  rig.world.add({ pane_id: 'w1:p7', tab_id: 'w1:t7', agent: 'claude', name: 'ops', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'ops-session' }, cwd: '/work/ops' });
  const callerId = parent('restart-caller');

  const text = await context(callerId, rig).tool('agent_restart', { target: 'ops-session' });
  assert.match(text, /Restarted ops: closed pane w1:p7, started claude in pane w1:p\d+/);
  assert.match(text, /--resume ops-session/);
  assert.deepEqual(calls(rig.fake, 'pane.close').map((request) => request.params['pane_id']), ['w1:p7'], 'the old pane is closed');
  assert.equal(rig.world.panes.has('w1:p7'), false);
  const started = lastStart(rig.fake);
  const args = started.args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'ops-session']);
  const newPane = String(started.paneId);
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
  assert.match(text, /Restarted scribe: closed pane w1:p8/);
  const args = lastStart(rig.fake).args;
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', file]);
  assert.equal(args.some((arg) => arg.includes('development-channels')), false, 'pi loads its extension without a flag');
  assert.equal(rig.world.panes.has('w1:p8'), false, 'the old pane is closed');
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

test('a child alone in a workspace Bellwether made for it restarts in that workspace, which never empties', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await closingHerdr(t, 'w1');
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', agent_status: 'idle' });
  const id = parent('restart-own-workspace');
  // The child's tab is the only one in w5: closing it first would leave herdr no w5.
  upsertChild(id, worker({ paneId: 'w5:p1', tabId: 'w5:t1', workspaceId: 'w5', workspaceLabel: 'big-job', ownsWorkspace: true }));
  rig.world.add({ pane_id: 'w5:p1', tab_id: 'w5:t1', workspace_id: 'w5', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: SESSION_1 });

  const text = await context(id, rig).tool('agent_restart', { target: 'worker' });
  assert.match(text, /Restarted worker \(child child-worker\)/);
  assert.equal(calls(rig.fake, 'workspace.create').length, 0);
  assert.equal(calls(rig.fake, 'tab.create')[0]?.params['workspace_id'], 'w5');
  assert.deepEqual(methodOrder(rig.fake, ['tab.create', 'tab.close', 'start']), ['tab.create', 'tab.close', 'start']);
  const child = children(id)[0];
  assert.equal(child?.workspaceId, 'w5');
  assert.equal(child?.ownsWorkspace, true);
  assert.ok(child?.paneId.startsWith('w5:'));
});

test('a child whose own workspace still holds another tab restarts in that same workspace', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-shared-workspace');
  upsertChild(id, worker({ paneId: 'w5:p1', tabId: 'w5:t1', workspaceId: 'w5', workspaceLabel: 'big-job', ownsWorkspace: true }));
  rig.world.add({ pane_id: 'w5:p1', tab_id: 'w5:t1', workspace_id: 'w5', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: SESSION_1 });
  rig.world.add({ pane_id: 'w5:p2', tab_id: 'w5:t2', workspace_id: 'w5' });

  await context(id, rig).tool('agent_restart', { target: 'worker' });
  assert.equal(calls(rig.fake, 'workspace.create').length, 0);
  assert.equal(calls(rig.fake, 'tab.create')[0]?.params['workspace_id'], 'w5');
  assert.equal(children(id)[0]?.workspaceId, 'w5');
  assert.equal(children(id)[0]?.ownsWorkspace, true);
});

test('a restart with reads widens the read set in the child\'s launch settings, and a resume keeps it', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-reads');
  upsertChild(id, worker());
  liveWorker(rig.world);
  const other = path.join(os.tmpdir(), 'example-other-checkout', 'lint');

  await context(id, rig).tool('agent_restart', { target: 'worker', reads: [other] });
  assert.deepEqual(children(id)[0]?.reads, [other], 'the record keeps the paths');
  const settingsFile = lastStart(rig.fake).args.find((arg) => arg.startsWith('--settings='))?.slice('--settings='.length) ?? '';
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { permissions: { additionalDirectories: string[] }; sandbox: { filesystem: { allowRead: string[] } } };
  assert.deepEqual(settings.permissions.additionalDirectories, [path.resolve(bellwetherHome()), other]);
  assert.deepEqual(settings.sandbox.filesystem.allowRead, [path.resolve(bellwetherHome()), other]);

  // The operator's home is refused before anything closes.
  const before = calls(rig.fake, 'tab.close').length;
  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'worker', reads: [os.homedir()] }), /holds the operator's home/);
  assert.equal(calls(rig.fake, 'tab.close').length, before, 'nothing was closed');
  assert.deepEqual(children(id)[0]?.reads, [other]);
});

// Issue #185: a session alone in its herdr workspace. herdr closes a workspace
// with its last pane, so a restart that closed the old pane first had no
// workspace left to open the new tab in.
async function closingHerdr(t: test.TestContext, workspace: string): Promise<Rig> {
  const world = fakeWorld(workspace, { closeEmptyWorkspaces: true });
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

/** Refuse every harness start in a new pane, as a harness that never comes up. */
function refuseStarts(rig: Rig, except: string[] = []): void {
  const answer = rig.world.answer.bind(rig.world);
  rig.world.answer = (request) => {
    const pane = String(request.params['pane_id'] ?? '');
    if ((request.method === 'agent.start' || (request.method === 'pane.send_input' && Array.isArray(request.params['keys']) && (request.params['keys'] as string[]).includes('Enter'))) && !except.includes(pane)) {
      return { error: { code: 'pane_not_found', message: `herdr pane ${pane} refused the start` } };
    }
    return answer(request);
  };
}

function methodOrder(fake: FakeHerdr, wanted: string[]): string[] {
  return fake.requests.map((request) => harnessStart(request) ? 'start' : request.method).filter((method) => wanted.includes(method));
}

test('a session alone in its workspace restarts itself, and the new tab opens in that workspace before the old pane closes', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await closingHerdr(t, 'w74');
  const id = parent('alone-session', { paneId: 'w74:p1', workspaceId: 'w74' });
  rig.world.add({ pane_id: 'w74:p1', tab_id: 'w74:t1', workspace_id: 'w74', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'alone-session' } });
  const { tool, jobs, service } = context(id, rig);
  byeOnClose(rig, service, { method: 'pane.close', id: 'w74:p1' });

  await tool('agent_restart', {}, { paneId: 'w74:p1' });
  await rig.fake.waitFor('events.subscribe');
  setStatus(rig, 'w74:p1', 'idle');
  await jobs.get(`parent:${id}`);

  assert.deepEqual(methodOrder(rig.fake, ['tab.create', 'workspace.create', 'pane.close', 'start']), ['tab.create', 'pane.close', 'start'], 'the new tab opens first, and the harness starts only once the old pane is closed');
  assert.equal(calls(rig.fake, 'tab.create')[0]?.params['workspace_id'], 'w74');
  const record = readParent(id);
  assert.ok(record?.paneId?.startsWith('w74:'), `the session came back in its workspace: ${record?.paneId}`);
  assert.equal(record?.restartFailed, undefined);
  assert.equal(rig.world.panes.get(record?.paneId ?? '')?.agent_session?.value, 'alone-session');
  assert.equal(restartLog().at(-1)?.['outcome'], 'restarted');
});

test('a restart whose workspace disappears under it opens a new workspace carrying the old label', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await closingHerdr(t, 'w74');
  saveParent(emptyParent('claude-code', 'ops-session', '/work/ops', { workspaceId: 'w74', host: hostName(), paneId: 'w74:p1' }));
  rig.world.add({ pane_id: 'w74:p1', tab_id: 'w74:t1', workspace_id: 'w74', agent: 'claude', name: 'ops', label: 'ops', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'ops-session' } });
  // herdr lists w74 as "ops", then the workspace goes before the tab opens in it.
  const answer = rig.world.answer.bind(rig.world);
  rig.world.answer = (request) => {
    if (request.method === 'workspace.list') return { type: 'workspace_list', workspaces: [{ workspace_id: 'w74', label: 'ops', tab_count: 1 }] };
    if (request.method === 'tab.create' && request.params['workspace_id'] === 'w74') return { error: { code: 'workspace_not_found', message: 'herdr workspace w74 not found' } };
    return answer(request);
  };

  const text = await context(parent('restart-caller'), rig).tool('agent_restart', { target: 'ops-session' });
  assert.match(text, /Restarted ops/);
  assert.equal(calls(rig.fake, 'workspace.create')[0]?.params['label'], 'ops', 'the new workspace carries the old label');
  const record = listParentsBySession('ops-session');
  assert.ok(record?.paneId && !record.paneId.startsWith('w74:'), `the session came back somewhere: ${record?.paneId}`);
  assert.equal(record?.workspaceId, record?.paneId?.split(':')[0]);
  assert.equal(rig.world.panes.get(record?.paneId ?? '')?.agent_session?.value, 'ops-session');
});

test('a child restart that fails to start leaves an event for its parent, a line on its record and a doctor line', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await herdr(t);
  const id = parent('restart-fails');
  const now = new Date().toISOString();
  upsertChild(id, worker({ startedAt: now, statusChangedAt: now, lastBusyAt: now }));
  liveWorker(rig.world);
  refuseStarts(rig);
  const entries: OutboxEntry[] = [];
  const watching = new Watcher({ client: rig.client, parentId: id, onEntries: (fresh) => entries.push(...fresh), tickMs: 50, screenPollMs: 0 });
  watching.start();
  t.after(() => watching.stop());

  await assert.rejects(context(id, rig).tool('agent_restart', { target: 'worker' }), /worker did not come back: .*Its old pane w1:p3 is closed/);
  const child = children(id)[0];
  assert.equal(child?.restartFailed?.oldPane, 'w1:p3');
  assert.match(child?.restartFailed?.error ?? '', /refused the start/);
  assert.match(child?.restartFailed?.reopen ?? '', /agent_spawn and resume sess-1/);

  const event = await until('the parent\'s event', () => entries.find((entry) => entry.childId === 'child-worker' && entry.event === 'exited'));
  assert.equal(event.event, 'exited');
  assert.match(event.text, /worker \(child child-worker\) did not come back from a restart/);
  assert.match(event.text, /last pane w1:p3/);
  assert.equal(children(id)[0]?.restartFailed?.told, true, 'the parent hears of it once');

  const lines = restartFailureLines(listParents());
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^fail +restart: worker \(child child-worker of /);
  assert.match(lines[0] ?? '', /last pane w1:p3/);
  assert.match(lines[0] ?? '', /refused the start/);
});

test('a session restart that fails to start leaves a line on its record and a doctor line naming its last pane', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await closingHerdr(t, 'w74');
  const id = parent('lost-session', { paneId: 'w74:p1', workspaceId: 'w74' });
  rig.world.add({ pane_id: 'w74:p1', tab_id: 'w74:t1', workspace_id: 'w74', agent: 'claude', name: 'lead', label: 'lead', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'lost-session' } });
  refuseStarts(rig);
  const { tool, jobs } = context(id, rig);

  await tool('agent_restart', {}, { paneId: 'w74:p1' });
  await rig.fake.waitFor('events.subscribe');
  setStatus(rig, 'w74:p1', 'idle');
  await jobs.get(`parent:${id}`);

  const failed = readParent(id)?.restartFailed;
  assert.equal(failed?.oldPane, 'w74:p1');
  assert.equal(failed?.workspaceId, 'w74');
  assert.match(failed?.reopen ?? '', /claude .*--resume lost-session/);
  const lines = restartFailureLines(listParents());
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', new RegExp(`^fail +restart: session ${id} \\(claude-code, last pane w74:p1 in workspace w74\\) did not come back`));
  assert.match(lines[0] ?? '', new RegExp(`Bring it back with \x60bellwether resume ${id}\x60, or by hand with \x60claude .*--resume lost-session\x60 in /work\\.`));
  assert.equal(restartLog().at(-1)?.['outcome'], 'failed');
});

test('a child in a workspace Bellwether made for it, whose workspace herdr has already closed, restarts in a new one under the same label', async (t) => {
  isolate(t, 'bellwether-restart-');
  const rig = await closingHerdr(t, 'w1');
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', name: 'lead', agent_status: 'idle' });
  const id = parent('restart-gone-workspace');
  // The child's pane is gone, and herdr closed w5 with it.
  upsertChild(id, worker({ paneId: 'w5:p1', tabId: 'w5:t1', workspaceId: 'w5', workspaceLabel: 'big-job', ownsWorkspace: true }));

  await context(id, rig).tool('agent_restart', { target: 'worker' });
  assert.equal(calls(rig.fake, 'workspace.create')[0]?.params['label'], 'big-job');
  const child = children(id)[0];
  assert.ok(child?.workspaceId && child.workspaceId !== 'w5');
  assert.equal(child.ownsWorkspace, true);
});
