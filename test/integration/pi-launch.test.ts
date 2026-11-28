// Tier 2: a pi child starts with the Bellwether extension from the package
// that spawns it, and its record keeps the session file herdr reports. A
// machine whose pi has no Bellwether package must still give the child its
// tools, so the launch names the extension rather than trusting the host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { PI_EXTENSION_ENV, piExtensionEntry } from '../../src/core/pi-extension.ts';
import { claudeSettingsPath, mcpConfigPath, promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const root = path.resolve(import.meta.dirname, '../..');

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  home: string;
  cwd: string;
}

async function room(t: test.TestContext): Promise<Room> {
  const { root: scratch, home } = isolate(t, 'bellwether-pi-launch-');
  const cwd = path.join(scratch, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('pi', `pi-launch-${path.basename(scratch)}`, scratch, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, home, cwd };
}

function startArgs(fake: FakeHerdr): string[] {
  const start = harnessStarts(fake)[0];
  assert.ok(start, 'herdr was never asked to start the agent');
  return start.args as string[];
}

function record(parentId: string, childId: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((child) => child.id === childId);
}

/** Where pi keeps a session started in `cwd`, with one assistant message in it. */
function piSession(cwd: string, text = 'pi finished'): string {
  const dir = path.join(process.env['HOME'] ?? '', '.pi', 'agent', 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-11-27T06-44-31-095Z_01a21bbf-98f5-700c-a91b-71bf073331c3.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: '01a21bbf' })}\n${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`);
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

test('a pi spawn starts the child with -e naming the extension in the running package', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'pi-drill', prompt: 'report back', cwd: space.cwd });
  const extension = piExtensionEntry();
  assert.deepEqual(startArgs(space.fake), ['-e', extension]);
  assert.ok(fs.existsSync(extension), `${extension} is not in the package`);
  // The file the package declares to pi, from the sources rather than dist/.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { pi: { extensions: string[] } };
  const declared = manifest.pi.extensions.map((entry) => path.join(root, entry.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')));
  assert.ok(declared.includes(extension), `${extension} is not the extension package.json declares: ${declared.join(', ')}`);
  // The tab names the same file, so a second copy of the extension stands down.
  const create = space.fake.requests.find((request) => request.method === 'tab.create');
  assert.equal((create?.params['env'] as Record<string, string>)[PI_EXTENSION_ENV], extension);
});

test('a pi spawn whose extension cannot be found fails, and leaves no tab, record or brief', async (t) => {
  const space = await room(t);
  const missing = path.join(space.home, 'gone', 'extension.js');
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'no-tools', prompt: 'report back' }, undefined, { piExtension: () => missing }),
    (error: Error) => error.message.includes(missing) && /pi extension/.test(error.message),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || harnessStart(request) !== undefined), false, 'herdr was asked for a tab');
  const prompts = path.join(space.home, 'prompts');
  assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
});

test('a pi spawn on a host whose pi settings load a Bellwether copy without the guard fails with the fix', async (t) => {
  const space = await room(t);
  // pi exits on a tool registered twice, so this child would die at startup.
  const agentDir = path.join(process.env['HOME'] ?? '', '.pi', 'agent');
  const copy = path.join(agentDir, 'npm', 'node_modules', '@elecnix', 'bellwether');
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: '@elecnix/bellwether', version: '0.1.4' }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:@elecnix/bellwether'] }));
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'doomed', prompt: 'report back' }),
    (error: Error) => error.message.includes(copy) && error.message.includes('pi install npm:@elecnix/bellwether'),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create'), false);
});

test('a Claude child starts with no pi extension and no brief on its launch line', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'claude', name: 'claude-child', prompt: 'report back', startupTimeoutMs: 2_000, redrawMs: 10 });
  assert.deepEqual(startArgs(space.fake), [`--mcp-config=${mcpConfigPath(child.id)}`, `--settings=${claudeSettingsPath(child.id)}`, '--dangerously-load-development-channels=server:bellwether']);
  const create = space.fake.requests.find((request) => request.method === 'tab.create');
  assert.equal((create?.params['env'] as Record<string, string>)[PI_EXTENSION_ENV], undefined);
});

test('a pi child records the session path herdr reports after the spawn, and keeps it after exit', async (t) => {
  const space = await room(t);
  const file = piSession(space.cwd);
  // herdr has not detected pi when the spawn looks, as with a pi that loads many extensions.
  space.world.onStart = (pane) => {
    delete pane.agent_session;
    pane.agent = undefined;
  };
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'pi-drill', prompt: 'report back', cwd: space.cwd });
  assert.equal(record(space.parentId, child.id)?.session, undefined);

  const watcher = new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {}, tickMs: 60_000 });
  t.after(() => watcher.stop());
  const subscriptions = (): number => space.fake.requests.filter((request) => request.method === 'events.subscribe').length;
  watcher.start();
  await until('the watcher subscription', () => (subscriptions() > 0 ? true : undefined));

  // pi starts its first turn, and herdr now knows its session file.
  const pane = space.world.panes.get(child.paneId)!;
  pane.agent = 'pi';
  pane.agent_status = 'working';
  pane.agent_session = { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file };
  space.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });
  const saved = await until('the session on the record', () => record(space.parentId, child.id)?.session);
  assert.deepEqual(saved, { kind: 'path', value: file });
  assert.equal(await until('the transcript on the record', () => record(space.parentId, child.id)?.transcript), file);

  space.world.panes.delete(child.paneId);
  space.fake.send({ event: 'pane_exited', data: { pane_id: child.paneId } });
  const exited = await until('the exit', () => {
    const entry = record(space.parentId, child.id);
    return entry?.exitedAt ? entry : undefined;
  });
  assert.deepEqual(exited.session, { kind: 'path', value: file });
  assert.equal(exited.transcript, file);
});

test('agent_read for a pi child reads its session file', async (t) => {
  const space = await room(t);
  const file = piSession(space.cwd, 'pi child: my tools came from the extension this spawn gave me');
  const at = new Date(Date.now() - 60_000).toISOString();
  // The record as the drill left it: a session path, and no transcript field.
  upsertChild(space.parentId, {
    id: 'child-pi',
    name: 'pi-drill',
    kind: 'pi',
    harness: 'pi',
    paneId: 'w1:p9',
    host: LOCAL_HOST,
    cwd: space.cwd,
    startedAt: at,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'path', value: file },
    depth: 1,
    exitedAt: at,
  });
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'pi-drill' }), 'pi child: my tools came from the extension this spawn gave me');
  assert.equal(record(space.parentId, 'child-pi')?.transcript, file, 'the read records the transcript it found');
});

test('a pi child that names itself keeps both names, and agent_send reaches it by either', async (t) => {
  const space = await room(t);
  // A pi naming extension renames the herdr agent after the start.
  space.world.onStart = (pane) => {
    pane.name = 'gray-trout-97';
  };
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'pi-drill', prompt: 'report back', cwd: space.cwd });
  const saved = record(space.parentId, child.id);
  assert.equal(saved?.name, 'pi-drill', 'the name the parent gave stays the address');
  assert.equal(saved?.agentName, 'gray-trout-97');
  const listing = await runBellwetherTool(context(space), 'agent_list', {});
  assert.match(listing, /pi-drill \(gray-trout-97\)/);

  await runBellwetherTool(context(space), 'agent_send', { child: 'gray-trout-97', text: 'status?' });
  const sent = space.fake.requests.filter((request) => request.method === 'agent.prompt');
  assert.equal(sent.at(-1)?.params['target'], child.paneId);
});

test('a name that two children answer to is refused rather than guessed', async (t) => {
  const space = await room(t);
  const at = new Date().toISOString();
  const base = { kind: 'pi', harness: 'pi' as const, host: LOCAL_HOST, startedAt: at, lastStatus: 'idle' as const, statusChangedAt: at, lastBusyAt: at, depth: 1 };
  upsertChild(space.parentId, { ...base, id: 'child-a', name: 'first', paneId: 'w1:p1', agentName: 'gray-trout-97' });
  upsertChild(space.parentId, { ...base, id: 'child-b', name: 'second', paneId: 'w1:p2', agentName: 'gray-trout-97' });
  await assert.rejects(runBellwetherTool(context(space), 'agent_send', { child: 'gray-trout-97', text: 'status?' }), /first.*second|second.*first/);
  assert.equal(space.fake.requests.some((request) => request.method === 'agent.prompt'), false);
});

// A pi child runs on the provider and model its parent runs on, unless the
// caller names a pair. pi needs both flags, so half a pair is refused.
const PARENT_MODEL = { provider: 'example-cloud', id: 'example-large' };

function modelFlags(args: string[]): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg === '--provider' || arg === '--model') out.push(arg, args[index + 1] ?? '');
  });
  return out;
}

test('a pi child inherits the parent\'s provider and model when the caller names neither', async (t) => {
  const space = await room(t);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'heir', prompt: 'go' }, { model: PARENT_MODEL });
  assert.deepEqual(modelFlags(startArgs(space.fake)), ['--provider', 'example-cloud', '--model', 'example-large']);
  assert.match(reply, /runs on provider account example-cloud, model example-large, the same account and model as this session/);
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'heir');
  assert.deepEqual(child?.model, { provider: 'example-cloud', id: 'example-large', source: 'parent' });
});

test('a model without a provider is refused, naming the parent\'s pair, and nothing starts', async (t) => {
  const space = await room(t);
  await assert.rejects(
    runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'half', prompt: 'go', model: 'deepseek-v4.1-flash' }, { model: PARENT_MODEL }),
    (error: Error) => /provider/.test(error.message) && error.message.includes('example-cloud') && error.message.includes('deepseek-v4.1-flash'),
  );
  await assert.rejects(
    runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'half', prompt: 'go', provider: 'example-hosted' }, { model: PARENT_MODEL }),
    (error: Error) => /model/.test(error.message) && error.message.includes('example-hosted'),
  );
  // Half a pair in the extra arguments counts as the caller's too.
  await assert.rejects(runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'half', prompt: 'go', args: ['--model', 'deepseek-v4.1-flash'] }, { model: PARENT_MODEL }), /provider/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create'), false);
});

test('a caller that names both provider and model wins over the parent\'s pair', async (t) => {
  const space = await room(t);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'chosen', prompt: 'go', provider: 'example-hosted', model: 'deepseek-v4.1-flash' }, { model: PARENT_MODEL });
  assert.deepEqual(modelFlags(startArgs(space.fake)), ['--provider', 'example-hosted', '--model', 'deepseek-v4.1-flash']);
  assert.match(reply, /runs on provider account example-hosted, model deepseek-v4.1-flash, as the spawn named/);
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'chosen');
  assert.deepEqual(child?.model, { provider: 'example-hosted', id: 'deepseek-v4.1-flash', source: 'caller' });
});

test('with the parent\'s pair unknown, a pi child starts on pi\'s default and the reply names what it runs on', async (t) => {
  const space = await room(t);
  const file = piSession(space.cwd);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'model_change', provider: 'example-hosted', modelId: 'deepseek-v4.1-flash' })}\n`);
  space.world.onStart = (pane) => {
    pane.agent_session = { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file };
  };
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'orphan', prompt: 'go', cwd: space.cwd }, {});
  assert.deepEqual(modelFlags(startArgs(space.fake)), [], 'no pair is guessed');
  assert.match(reply, /did not say which provider and model it runs on/);
  assert.match(reply, /runs on provider account example-hosted, model deepseek-v4.1-flash, pi's own default, read from its session file/);
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'orphan');
  assert.deepEqual(child?.model, { provider: 'example-hosted', id: 'deepseek-v4.1-flash', source: 'session' });
});

/** Write pi's user settings in the case's pi agent directory, and return the file. */
function piSettings(settings: Record<string, unknown>): string {
  const dir = process.env['PI_CODING_AGENT_DIR'] ?? '';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings));
  return file;
}

test("with the pair unknown, the spawn passes pi's saved default rather than the first entry of enabledModels, and says so (issue #189)", async (t) => {
  const space = await room(t);
  // The drill's settings: a saved default outside enabledModels, where pi on its own takes the first entry.
  const file = piSettings({ defaultProvider: 'example-cloud', defaultModel: 'example-large', enabledModels: ['example-hosted/deepseek-v4.1-flash', 'example-backup/deepseek-v4.1-flash'] });
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'unseen', prompt: 'go' }, {});
  assert.deepEqual(modelFlags(startArgs(space.fake)), ['--provider', 'example-cloud', '--model', 'example-large']);
  assert.match(reply, /passed pi's saved default, defaultProvider and defaultModel in [^:]+: unseen runs on provider account example-cloud, model example-large\./);
  assert.ok(reply.includes(file), `the reply names where the default is set: ${reply}`);
  assert.match(reply, /Without those flags pi would have started it on example-hosted \/ deepseek-v4\.1-flash, the first entry of enabledModels/);
  assert.doesNotMatch(reply, /unverified/);
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'unseen');
  assert.deepEqual(child?.model && { provider: child.model.provider, id: child.model.id, source: child.model.source }, { provider: 'example-cloud', id: 'example-large', source: 'saved' });
});

test('with the pair unknown and a saved default that pi would take anyway, the spawn passes it and names no other pair', async (t) => {
  const space = await room(t);
  piSettings({ defaultProvider: 'example-cloud', defaultModel: 'example-large', enabledModels: ['example-hosted/deepseek-v4.1-flash', 'example-cloud/example-large'] });
  const inScope = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'scoped', prompt: 'go' }, {});
  assert.deepEqual(modelFlags(startArgs(space.fake)), ['--provider', 'example-cloud', '--model', 'example-large']);
  assert.match(inScope, /scoped runs on provider account example-cloud, model example-large\./);
  assert.doesNotMatch(inScope, /Without those flags/);
  piSettings({ defaultProvider: 'example-cloud', defaultModel: 'example-large' });
  const plain = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'plain', prompt: 'go' }, {});
  assert.match(plain, /passed pi's saved default, defaultProvider and defaultModel in .*: plain runs on provider account example-cloud, model example-large\./);
  assert.doesNotMatch(plain, /Without those flags/);
});

test('with the pair unknown and enabledModels but no saved default, the spawn passes no flag and the reply names the first entry, unverified', async (t) => {
  const space = await room(t);
  piSettings({ enabledModels: ['example-hosted/deepseek-v4.1-flash'] });
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'listed', prompt: 'go' }, {});
  assert.deepEqual(modelFlags(startArgs(space.fake)), []);
  assert.match(reply, /provider account example-hosted, model deepseek-v4\.1-flash: the first entry of enabledModels/);
  assert.match(reply, /unverified until pi writes its session file/);
});

test('with the pair unknown and no pi settings, the reply says pi takes the first model it has a key for', async (t) => {
  const space = await room(t);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'pi', name: 'bare', prompt: 'go' }, {});
  assert.match(reply, /first model it has an API key for/);
  assert.match(reply, /unverified/);
});

test('a Claude child gets no provider and model from a pi parent', async (t) => {
  const space = await room(t);
  await runBellwetherTool(context(space), 'agent_spawn', { kind: 'claude', name: 'claude-kid', prompt: 'go' }, { model: PARENT_MODEL });
  assert.deepEqual(modelFlags(startArgs(space.fake)), []);
});
