// Tier 2: an OpenCode v2 child against the fake herdr socket and a fixture
// OpenCode store. The launch line is asserted as arguments, the session the
// spawn minted is looked up in the store, a store that never shows it fails
// the spawn by its path, and agent_read answers from the store. herdr reports
// no session for OpenCode, so the fake world plays OpenCode's part by writing
// the session row when the agent starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { openCodeBriefLine, type OpenCodeProbe } from '../../src/core/opencode.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild, type SpawnHooks } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';
import { addSession, openCodeStore } from '../fixtures/opencode-db.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  cwd: string;
  db: string;
}

const V2: OpenCodeProbe = { version: '2.4.2', binary: '/opt/opencode/bin/opencode' };

async function room(t: test.TestContext, parentDepth = 0): Promise<Room> {
  const { root } = isolate(t, 'bellwether-opencode-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const db = path.join(root, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  openCodeStore(db).close();
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parent = emptyParent('claude-code', `opencode-${path.basename(root)}`, root, { workspaceId: 'w1' });
  parent.depth = parentDepth;
  const parentId = saveParent(parent).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, cwd, db };
}

/** OpenCode's part: when the agent starts, record the session it was told to create, with its prompt. */
function opencodeWrites(space: Room, reply?: string[]): void {
  space.world.onStart = (pane: FakePane) => {
    const args = pane.args ?? [];
    const id = args[args.indexOf('--session') + 1] as string;
    const prompt = args[args.indexOf('--prompt') + 1] as string;
    // herdr reports no session for OpenCode.
    delete pane.agent_session;
    const store = new DatabaseSync(space.db);
    addSession(store, { id, directory: space.cwd, prompt, ...(reply ? { reply, busyAt: 1, idleAt: 2, outcome: 'succeeded' as const } : {}) });
    store.close();
  };
}

function hooks(space: Room, extra: Partial<NonNullable<SpawnHooks['openCode']>> = {}): SpawnHooks {
  return { openCode: { probe: async () => V2, db: space.db, waitMs: 400, intervalMs: 20, ...extra } };
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

test('an opencode spawn starts OpenCode 2 standalone on a session id it minted, with the brief in the working directory', async (t) => {
  const space = await room(t);
  opencodeWrites(space);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'opencode', name: 'oc', prompt: 'line one\nline two', cwd: space.cwd, model: 'example/fake-model' }, undefined, hooks(space));

  const brief = path.join(space.cwd, '.bellwether', `brief-${child.id}.md`);
  const session = child.session?.value ?? '';
  assert.match(session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  const start = startRequest(space.fake);
  assert.equal(start.kind, 'opencode');
  assert.deepEqual(start.args, ['--standalone', '--session', session, '--prompt', openCodeBriefLine(brief)]);
  assert.equal(fs.readFileSync(brief, 'utf8'), 'line one\nline two');
  assert.equal(fs.statSync(brief).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(space.cwd, '.bellwether', '.gitignore'), 'utf8'), '*\n');

  // The tab hands the child's private server its own configuration and the store this daemon reads.
  const env = tabEnv(space.fake);
  assert.equal(env['OPENCODE_CONFIG'], mcpConfigPath(child.id));
  assert.equal(env['OPENCODE_DB'], space.db);
  assert.equal(env['BELLWETHER_CHILD'], child.id);
  assert.equal(env['BELLWETHER_HARNESS'], 'opencode');
  const config = JSON.parse(fs.readFileSync(mcpConfigPath(child.id), 'utf8')) as { model?: string; mcp: { servers: Record<string, { type: string; command: string[]; environment: Record<string, string> }> } };
  assert.equal(config.model, 'example/fake-model');
  assert.equal(config.mcp.servers['bellwether']?.type, 'local');
  assert.deepEqual(config.mcp.servers['bellwether']?.command.slice(-2), ['--child', child.id]);
  assert.equal(config.mcp.servers['bellwether']?.environment['BELLWETHER_PARENT'], space.parentId);

  const saved = record(space.parentId, child.id);
  assert.equal(saved?.harness, 'opencode');
  assert.deepEqual(saved?.session, { kind: 'id', value: session });
  assert.equal(saved?.store, space.db);
});

test('a spawn whose session never reaches the store fails naming the store, and keeps the brief for inspection', async (t) => {
  const space = await room(t);
  // OpenCode starts, but never records the session.
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'opencode', name: 'mute', prompt: 'do it', cwd: space.cwd }, undefined, hooks(space)),
    (error: Error) => error.message.includes(space.db) && /within 400 ms/.test(error.message) && /\.bellwether\/brief-/.test(error.message),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.ok(space.fake.requests.some((request) => request.method === 'tab.close'), 'the tab was not closed');
  const briefs = fs.readdirSync(path.join(space.cwd, '.bellwether')).filter((name) => name.startsWith('brief-'));
  assert.equal(briefs.length, 1, 'the brief was not kept for inspection');
});

test('an OpenCode that is not version 2 is refused before any tab, naming the version found and the one needed', async (t) => {
  const space = await room(t);
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'opencode', name: 'old', prompt: 'x', cwd: space.cwd }, undefined, hooks(space, { probe: async () => ({ version: '1.19.6', binary: '/usr/bin/opencode' }) })),
    (error: Error) => error.message.includes('OpenCode 1.19.6') && error.message.includes('/usr/bin/opencode') && error.message.includes('needs OpenCode 2'),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create'), false);
});

test('an opencode spawn without a working directory, with a bare model, or on another machine is refused before any tab', async (t) => {
  const space = await room(t);
  const parent = readParent(space.parentId)!;
  await assert.rejects(spawnChild(space.client, parent, { kind: 'opencode', name: 'nowhere', prompt: 'x' }, undefined, hooks(space)), /needs cwd/);
  await assert.rejects(spawnChild(space.client, parent, { kind: 'opencode', name: 'bare', prompt: 'x', cwd: space.cwd, model: 'example-tier' }, undefined, hooks(space)), /provider\/model/);
  await assert.rejects(spawnChild(space.client, parent, { kind: 'opencode', name: 'away', prompt: 'x', cwd: space.cwd, host: 'hawthorne' }, undefined, hooks(space)), /this machine only/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'workspace.create'), false);
});

test('agent_read answers from the OpenCode store', async (t) => {
  const space = await room(t);
  opencodeWrites(space, ['The fix is in.', 'Tests pass.']);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'opencode', name: 'reader', prompt: 'do it', cwd: space.cwd }, undefined, hooks(space));
  const ctx: ToolContext = { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
  const text = await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {});
  assert.equal(text, 'The fix is in.\nTests pass.');
  assert.equal(space.fake.requests.some((request) => request.method === 'pane.read'), false, 'agent_read read the screen instead of the store');
});

test('depth and workspace options hold for an opencode child', async (t) => {
  const space = await room(t, 1);
  opencodeWrites(space);
  const parent = readParent(space.parentId)!;
  // At the spawner's ceiling, the spawn is refused before anything exists.
  await assert.rejects(spawnChild(space.client, parent, { kind: 'opencode', name: 'deep', prompt: 'x', cwd: space.cwd, spawnerCeiling: 1 }, undefined, hooks(space)), /deep/);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'workspace.create'), false);
  const { child } = await spawnChild(space.client, parent, { kind: 'opencode', name: 'roomy', prompt: 'x', cwd: space.cwd, workspace: 'new', maxDepth: 3 }, undefined, hooks(space));
  const saved = record(space.parentId, child.id);
  assert.equal(saved?.depth, 2);
  assert.equal(saved?.maxDepth, 3);
  assert.equal(saved?.ownsWorkspace, true);
  const env = tabEnv(space.fake);
  assert.equal(env['BELLWETHER_DEPTH'], '2');
  assert.equal(env['BELLWETHER_MAX_DEPTH'], '3');
  assert.equal(startRequest(space.fake).args[0], '--standalone');
});

test('on a route that runs opencode, the launcher carries the tier and OpenCode gets its own arguments behind it', async (t) => {
  const space = await room(t);
  opencodeWrites(space);
  const before = process.env['BELLWETHER_ROUTES'];
  const routesFile = path.join(path.dirname(space.cwd), 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ routes: { 'example-router': { launcher: ['example-router', '--yes'], tiers: ['example-deep'], defaultTier: 'example-deep', harnesses: ['opencode'] } } }));
  process.env['BELLWETHER_ROUTES'] = routesFile;
  t.after(() => {
    if (before === undefined) delete process.env['BELLWETHER_ROUTES'];
    else process.env['BELLWETHER_ROUTES'] = before;
  });
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'opencode', name: 'routed', prompt: 'x', cwd: space.cwd, via: 'example-router' }, undefined, hooks(space));
  const pane = space.world.panes.get(child.paneId);
  assert.deepEqual(pane?.launcher, ['example-router', '--yes', '--model', 'example-deep']);
  const brief = path.join(space.cwd, '.bellwether', `brief-${child.id}.md`);
  assert.deepEqual(pane?.args, ['--standalone', '--session', child.session?.value, '--prompt', openCodeBriefLine(brief)]);
  assert.equal(space.fake.requests.some((request) => request.method === 'agent.start'), false, 'herdr started a bare opencode');
  // The tier picks the model on a route, so the child's configuration names none.
  const config = JSON.parse(fs.readFileSync(mcpConfigPath(child.id), 'utf8')) as { model?: string };
  assert.equal(config.model, undefined);
  assert.deepEqual(child.route, { name: 'example-router', tier: 'example-deep' });
});
