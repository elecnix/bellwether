// Tier 2: an omp child. omp loads the Bellwether pi extension with -e, reads
// its brief from an @file argument, and is watched by herdr only through the
// omp integration, which reports the child's session file. The spawn asks
// herdr for that integration before it writes anything. Facts about omp
// come from its 19.2.1 sources; see src/core/harnesses/omp.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { harnessFor } from '../../src/core/harnesses/index.ts';
import { OMP_SKIP_SETUP, ompSessionModel } from '../../src/core/harnesses/omp.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { PI_EXTENSION_ENV, piExtensionEntry } from '../../src/core/pi-extension.ts';
import { promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { resumeArgs } from '../../src/core/resume.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { FEATURES } from '../../src/daemon/features.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import type { RecordedRequest } from '../fixtures/fake-herdr.ts';
import { startFakeHerdr, type FakeHerdr, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  home: string;
  cwd: string;
}

type IntegrationState = 'current' | 'outdated' | 'not_installed' | 'absent' | 'unknown-method';

/** herdr's answer to integration.list, with the omp integration in the state a case needs. */
function integrations(state: IntegrationState): (request: RecordedRequest) => { result: unknown } | { error: { code: string; message: string } } | undefined {
  return (request) => {
    if (request.method !== 'integration.list') return undefined;
    if (state === 'unknown-method') return { error: { code: 'unknown_method', message: 'unknown method integration.list' } };
    const pi = { target: 'pi', label: 'pi', command: 'pi', available: true, state: 'current' };
    const omp = { target: 'omp', label: 'omp', command: 'omp', available: true, state };
    return { result: { type: 'integration_list', integrations: state === 'absent' ? [pi] : [pi, omp] } };
  };
}

async function room(t: test.TestContext, state: IntegrationState = 'current'): Promise<Room> {
  const { root: scratch, home } = isolate(t, 'bellwether-omp-launch-');
  const cwd = path.join(scratch, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const answer = integrations(state);
  const fake = await startFakeHerdr({ respond: (request) => answer(request) ?? world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('pi', `omp-launch-${path.basename(scratch)}`, scratch, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, home, cwd };
}

function startArgs(fake: FakeHerdr): string[] {
  const start = harnessStarts(fake)[0];
  assert.ok(start, 'herdr was never asked to start the agent');
  return start.args as string[];
}

function tabEnv(fake: FakeHerdr): Record<string, string> {
  const create = fake.requests.find((request) => request.method === 'tab.create');
  assert.ok(create, 'herdr was never asked for a tab');
  return create.params['env'] as Record<string, string>;
}

function record(parentId: string, childId: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((child) => child.id === childId);
}

/** Nothing was written and herdr opened nothing. */
function assertNothingStarted(space: Room): void {
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || harnessStart(request) !== undefined), false, 'herdr was asked for a tab');
  const prompts = path.join(space.home, 'prompts');
  assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
}

/**
 * An omp session file as omp 19.2.1 writes it: a header, a model_change whose
 * model is provider/id, and messages in the form pi uses.
 */
function ompSession(dir: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-11-27T10-00-00-000Z_0f3c2a1b-example.jsonl');
  const lines = [
    { type: 'session', id: '0f3c2a1b-example', cwd: dir },
    { type: 'model_change', id: 'e1', model: 'example-provider/example-model', role: 'default' },
    { type: 'message', id: 'e2', message: { role: 'user', content: [{ type: 'text', text: 'report back' }] } },
    { type: 'message', id: 'e3', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

function context(space: Room): ToolContext {
  return { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
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

test('an omp spawn loads the pi extension with -e, points omp at the brief with @, and skips its setup wizard', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'omp-drill', prompt: 'report back', cwd: space.cwd, model: 'example-provider/example-model' });
  const extension = piExtensionEntry();
  assert.deepEqual(startArgs(space.fake), ['--model', 'example-provider/example-model', '-e', extension, `@${promptPath(child.id)}`]);
  const start = harnessStarts(space.fake)[0];
  assert.equal(start?.kind, 'omp', 'herdr starts the kind its omp integration reports');
  assert.equal(fs.readFileSync(promptPath(child.id), 'utf8'), 'report back');
  const env = tabEnv(space.fake);
  assert.equal(env[PI_EXTENSION_ENV], extension, 'a second copy of the extension stands down');
  assert.equal(env[OMP_SKIP_SETUP], '1');
  assert.equal(env['BELLWETHER_HARNESS'], 'omp');
  assert.ok(env['BELLWETHER_CHILD'], 'the extension finds its child id in the tab');
  const saved = record(space.parentId, child.id);
  assert.equal(saved?.kind, 'omp');
  assert.equal(saved?.harness, 'omp');
  // herdr asked first, before the record and the tab.
  const order = space.fake.requests.map((request) => request.method);
  assert.ok(order.indexOf('integration.list') < order.indexOf('tab.create'));
});

test('an omp spawn accepts an outdated herdr integration, which still reports the session', async (t) => {
  const space = await room(t, 'outdated');
  await spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'omp-drill', prompt: 'report back', cwd: space.cwd });
  assert.ok(space.fake.requests.some((request) => harnessStart(request) !== undefined));
});

for (const state of ['not_installed', 'absent', 'unknown-method'] as const) {
  test(`an omp spawn is refused before anything is written when herdr's omp integration is ${state}`, async (t) => {
    const space = await room(t, state);
    await assert.rejects(
      spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'unwatched', prompt: 'report back', cwd: space.cwd }),
      (error: Error) => error.message.startsWith('unwatched was not started: herdr on this machine') && (state === 'unknown-method' ? /did not list its integrations/.test(error.message) : error.message.includes('herdr integration install omp')),
    );
    assertNothingStarted(space);
  });
}

test('an omp spawn on another machine that this session cannot register there is refused before anything is written', async (t) => {
  const space = await room(t);
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'far', prompt: 'report back', host: 'example-host' }),
    /far was not started on machine example-host: this session cannot register children there, so Bellwether cannot name the omp extension it would load\./,
  );
  assertNothingStarted(space);
});

test('an omp spawn whose pi extension cannot be found fails, and leaves no tab, record or brief', async (t) => {
  const space = await room(t);
  const missing = path.join(space.home, 'gone', 'extension.js');
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'no-tools', prompt: 'report back' }, undefined, { piExtension: () => missing }),
    (error: Error) => error.message.includes(missing) && /omp child/.test(error.message),
  );
  assertNothingStarted(space);
});

test('an omp spawn refuses a provider, because omp takes the model alone', async (t) => {
  const space = await room(t);
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'paired', prompt: 'report back', provider: 'example-provider', model: 'example-model' }),
    /paired was not started: provider applies to a pi child/,
  );
  assertNothingStarted(space);
});

test('an omp child records the session file herdr reports, its model, and agent_read reads its last answer', async (t) => {
  const space = await room(t);
  const file = ompSession(path.join(space.home, '.omp', 'agent', 'sessions', 'work'), 'omp child: reported through the pi extension');
  space.world.onStart = (pane) => {
    // herdr's omp integration reports the session once omp starts its first turn.
    delete pane.agent_session;
  };
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'omp', name: 'omp-drill', prompt: 'report back', cwd: space.cwd });

  const watcher = new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {}, tickMs: 60_000 });
  t.after(() => watcher.stop());
  watcher.start();
  await until('the watcher subscription', () => (space.fake.requests.some((request) => request.method === 'events.subscribe') ? true : undefined));
  const pane = space.world.panes.get(child.paneId)!;
  pane.agent_status = 'working';
  pane.agent_session = { agent: 'omp', kind: 'path', source: 'herdr:omp', value: file };
  space.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });

  assert.deepEqual(await until('the session on the record', () => record(space.parentId, child.id)?.session), { kind: 'path', value: file });
  assert.equal(await until('the transcript on the record', () => record(space.parentId, child.id)?.transcript), file);
  assert.deepEqual(await until('the model on the record', () => record(space.parentId, child.id)?.model), { provider: 'example-provider', id: 'example-model', source: 'session' });
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'omp-drill' }), 'omp child: reported through the pi extension');
});

test('agent_read for an exited omp child reads the session file on its record', async (t) => {
  const space = await room(t);
  const file = ompSession(path.join(space.home, '.omp', 'agent', 'sessions', 'work'), 'omp finished');
  const at = new Date(Date.now() - 60_000).toISOString();
  upsertChild(space.parentId, { id: 'child-omp', name: 'omp-done', kind: 'omp', harness: 'omp', paneId: 'w1:p9', host: LOCAL_HOST, cwd: space.cwd, startedAt: at, lastStatus: 'unknown', statusChangedAt: at, lastBusyAt: at, session: { kind: 'path', value: file }, depth: 1, exitedAt: at });
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'omp-done' }), 'omp finished');
});

test('an omp session resumes with --session and its file, and an older daemon is refused the kind by name', () => {
  assert.deepEqual(resumeArgs('omp', { kind: 'path', value: '/tmp/s.jsonl' }), ['--session', '/tmp/s.jsonl']);
  assert.deepEqual(harnessFor('omp')?.resume?.fromTranscript?.('/tmp/s.jsonl'), { value: '/tmp/s.jsonl', kind: 'path' });
  const feature = FEATURES.find((entry) => entry.name === 'agent_spawn.kind=omp');
  assert.deepEqual(feature, { name: 'agent_spawn.kind=omp', kind: 'argument', protocol: 4, version: '0.1.5', summary: 'A spawn starts a child that runs omp.' });
  assert.equal(harnessFor('omp')?.movable, false);
});

test("omp's model_change names provider/id in one field, and a session without one names no model", (t) => {
  const { home } = isolate(t, 'bellwether-omp-model-');
  const file = ompSession(path.join(home, 'sessions'), 'x');
  assert.deepEqual(ompSessionModel(file), { provider: 'example-provider', id: 'example-model' });
  const bare = path.join(home, 'bare.jsonl');
  fs.writeFileSync(bare, `${JSON.stringify({ type: 'model_change', model: 'example-model' })}\n`);
  assert.equal(ompSessionModel(bare), undefined);
  assert.equal(ompSessionModel(path.join(home, 'missing.jsonl')), undefined);
});
