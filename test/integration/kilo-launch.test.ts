// Tier 2: a kilo child against the fake herdr socket and a fixture kilo store.
// The launch line is asserted as arguments. herdr reports no session for kilo
// without its own integration, and kilo refuses a session id it did not
// create, so the spawn finds the session in the store by directory, start
// time and brief line. A store that never shows it fails the spawn by its
// path, and agent_read answers from the store. The fake world plays kilo's
// part by writing the session row when the agent starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { kiloBriefLine, type KiloProbe } from '../../src/core/harnesses/kilo-store.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild, type SpawnHooks } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';
import { addKiloSession, kiloStore } from '../fixtures/kilo-db.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  cwd: string;
  db: string;
}

const NATIVE: KiloProbe = { version: '7.8.40', binary: '/opt/kilo/bin/kilo' };

async function room(t: test.TestContext): Promise<Room> {
  const { root } = isolate(t, 'bellwether-kilo-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const db = path.join(root, 'kilo', 'kilo.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  kiloStore(db).close();
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('claude-code', `kilo-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, cwd, db };
}

/** Kilo's part: when the agent starts, record a new session with the prompt it was given, under an id of its own. */
function kiloWrites(space: Room, reply?: string[], id = 'ses_de35ce149ffeExampleKilo01'): void {
  space.world.onStart = (pane: FakePane) => {
    const args = pane.args ?? [];
    const prompt = args[args.indexOf('--prompt') + 1] as string;
    // herdr reports no session for kilo without its integration.
    delete pane.agent_session;
    const store = new DatabaseSync(space.db);
    addKiloSession(store, { id, directory: space.cwd, prompt, ...(reply ? { reply } : {}) });
    store.close();
  };
}

function hooks(space: Room, extra: Partial<NonNullable<SpawnHooks['harness']>> = {}): SpawnHooks {
  return { harness: { probe: async () => NATIVE, store: space.db, waitMs: 400, intervalMs: 20, ...extra } };
}

function startRequest(fake: FakeHerdr): { kind: string; args: string[] } {
  const start = fake.requests.find((request) => request.method === 'agent.start');
  assert.ok(start, 'herdr was never asked to start the agent');
  return { kind: String(start.params['kind']), args: start.params['args'] as string[] };
}

function tabEnv(fake: FakeHerdr): Record<string, string> {
  const create = fake.requests.find((request) => request.method === 'tab.create' || request.method === 'workspace.create');
  return (create?.params['env'] ?? {}) as Record<string, string>;
}

function record(parentId: string, childId: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((child) => child.id === childId);
}

test('a kilo spawn starts kilo on the brief line in the working directory, and records the session its store shows', async (t) => {
  const space = await room(t);
  kiloWrites(space);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'kilo', name: 'kc', prompt: 'line one\nline two', cwd: space.cwd, model: 'example/fake-model' }, undefined, hooks(space));

  const brief = path.join(space.cwd, '.bellwether', `brief-${child.id}.md`);
  const start = startRequest(space.fake);
  assert.equal(start.kind, 'kilo');
  assert.deepEqual(start.args, ['--model', 'example/fake-model', '--prompt', kiloBriefLine(brief)]);
  assert.equal(start.args.includes('--session'), false, 'kilo refuses a session id it did not create');
  assert.equal(fs.readFileSync(brief, 'utf8'), 'line one\nline two');
  assert.equal(fs.statSync(brief).mode & 0o777, 0o600);

  // The tab hands kilo the child's own configuration and the store this daemon reads.
  const env = tabEnv(space.fake);
  assert.equal(env['KILO_CONFIG'], mcpConfigPath(child.id));
  assert.equal(env['KILO_DB'], space.db);
  assert.equal(env['BELLWETHER_CHILD'], child.id);
  assert.equal(env['BELLWETHER_HARNESS'], 'kilo');
  const config = JSON.parse(fs.readFileSync(mcpConfigPath(child.id), 'utf8')) as { mcp: Record<string, { type: string; command: string[]; environment: Record<string, string> }> };
  assert.equal(config.mcp['bellwether']?.type, 'local');
  assert.deepEqual(config.mcp['bellwether']?.command.slice(-2), ['--child', child.id]);
  assert.equal(config.mcp['bellwether']?.environment['BELLWETHER_PARENT'], space.parentId);
  assert.equal(fs.statSync(mcpConfigPath(child.id)).mode & 0o777, 0o600);

  const saved = record(space.parentId, child.id);
  assert.equal(saved?.harness, 'kilo');
  assert.deepEqual(saved?.session, { kind: 'id', value: 'ses_de35ce149ffeExampleKilo01' });
  assert.equal(saved?.store, space.db);
});

test('a spawn whose session never reaches the store fails naming the store, and keeps the brief for inspection', async (t) => {
  const space = await room(t);
  // kilo starts, but never records the session.
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'kilo', name: 'mute', prompt: 'do it', cwd: space.cwd }, undefined, hooks(space)),
    (error: Error) => error.message.includes(space.db) && /within 400 ms/.test(error.message) && /\.bellwether\/brief-/.test(error.message),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.ok(space.fake.requests.some((request) => request.method === 'tab.close'), 'the tab was not closed');
});

test('npm\'s Node launcher, a missing working directory, a bare model and another machine are refused before any tab', async (t) => {
  const space = await room(t);
  const parent = readParent(space.parentId)!;
  const launcher = { probe: async (): Promise<KiloProbe> => ({ version: '7.8.40', binary: '/usr/bin/kilo', launcher: '/usr/lib/node_modules/@kilocode/cli/bin/kilo' }) };
  await assert.rejects(spawnChild(space.client, parent, { kind: 'kilo', name: 'wrapped', prompt: 'x', cwd: space.cwd }, undefined, hooks(space, launcher)), /herdr detects kilo by its process name/);
  await assert.rejects(spawnChild(space.client, parent, { kind: 'kilo', name: 'nowhere', prompt: 'x' }, undefined, hooks(space)), /needs cwd/);
  await assert.rejects(spawnChild(space.client, parent, { kind: 'kilo', name: 'bare', prompt: 'x', cwd: space.cwd, model: 'example-tier' }, undefined, hooks(space)), /provider\/model/);
  await assert.rejects(spawnChild(space.client, parent, { kind: 'kilo', name: 'away', prompt: 'x', cwd: space.cwd, host: 'example-host' }, undefined, hooks(space)), /this machine only/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'workspace.create'), false);
});

test('agent_read answers from the kilo store', async (t) => {
  const space = await room(t);
  kiloWrites(space, ['The fix is in.', 'Tests pass.']);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'kilo', name: 'reader', prompt: 'do it', cwd: space.cwd }, undefined, hooks(space));
  const ctx: ToolContext = { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
  const text = await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {});
  assert.equal(text, 'The fix is in.\nTests pass.');
  assert.equal(space.fake.requests.some((request) => request.method === 'pane.read'), false, 'agent_read read the screen instead of the store');
});

test('on a route that runs kilo, the launcher carries the tier and kilo gets its own arguments behind it', async (t) => {
  const space = await room(t);
  kiloWrites(space);
  const before = process.env['BELLWETHER_ROUTES'];
  const routesFile = path.join(path.dirname(space.cwd), 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ routes: { 'example-router': { launcher: ['example-router', '--yes'], tiers: ['example-deep'], defaultTier: 'example-deep', harnesses: ['kilo'] } } }));
  process.env['BELLWETHER_ROUTES'] = routesFile;
  t.after(() => {
    if (before === undefined) delete process.env['BELLWETHER_ROUTES'];
    else process.env['BELLWETHER_ROUTES'] = before;
  });
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'kilo', name: 'routed', prompt: 'x', cwd: space.cwd, via: 'example-router' }, undefined, hooks(space));
  const pane = space.world.panes.get(child.paneId);
  assert.deepEqual(pane?.launcher, ['example-router', '--yes', '--model', 'example-deep']);
  const brief = path.join(space.cwd, '.bellwether', `brief-${child.id}.md`);
  assert.deepEqual(pane?.args, ['--prompt', kiloBriefLine(brief)]);
  assert.equal(space.fake.requests.some((request) => request.method === 'agent.start'), false, 'herdr started a bare kilo');
  assert.deepEqual(child.route, { name: 'example-router', tier: 'example-deep' });
});
