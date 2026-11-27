// Tier 2: a Cline child against the fake herdr socket and a fixture Cline
// store. The default launch is refused for Cline's shared background hub
// before anything is written. With -y in args the child starts in Cline's
// unattended mode with its own MCP settings, named in CLINE_MCP_SETTINGS_PATH,
// and the agent_spawn reply lists what that mode costs. agent_read answers an
// adopted cline child from Cline's store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clineDbPath } from '../../src/core/harnesses/cline.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { mcpConfigPath, promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { addClineSession, clineStore } from '../fixtures/cline-db.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
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

async function room(t: test.TestContext): Promise<Room> {
  const { root, home } = isolate(t, 'bellwether-cline-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('claude-code', `cline-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, home, cwd };
}

function context(space: Room): ToolContext {
  return { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
}

function nothingWritten(space: Room): void {
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'agent.start'), false);
  const prompts = path.join(space.home, 'prompts');
  assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
}

test('the default launch is refused for the shared hub, before the record, the brief or the tab', async (t) => {
  const space = await room(t);
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'cline', name: 'worker', prompt: 'report back', cwd: space.cwd }), (error: Error) => {
    assert.match(error.message, /^worker was not started: Cline runs each terminal session inside one shared background hub/);
    assert.match(error.message, /a second child's reports would be credited to the first/);
    assert.match(error.message, /the hub a child starts outlives the child/);
    assert.match(error.message, /the operator's own Cline sessions would load the child's server/);
    assert.match(error.message, /https:\/\/github\.com\/cline\/cline\/issues\/15881/);
    return true;
  });
  nothingWritten(space);
});

test('a child on another machine is refused, because the store is read where it runs', async (t) => {
  const space = await room(t);
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'cline', name: 'far', prompt: 'x', cwd: space.cwd, args: ['-y'], host: 'example-host' }), /far was not started: a cline child runs on this machine only for now/);
  nothingWritten(space);
});

test('with -y the child starts in unattended mode with its own MCP settings, and the reply lists the costs', async (t) => {
  const space = await room(t);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'cline', name: 'worker', prompt: 'report back', cwd: space.cwd, model: 'example-model', args: ['-y'] }, {});
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'worker');
  assert.ok(child, 'the spawn wrote no record');

  const start = space.fake.requests.find((request) => request.method === 'agent.start');
  assert.equal(start?.params['kind'], 'cline');
  assert.deepEqual(start?.params['args'], ['--model', 'example-model', '-i', `Your task is in ${promptPath(child.id)}. Read it, then do what it says.`, '-y']);
  assert.equal(fs.readFileSync(promptPath(child.id), 'utf8'), 'report back');

  // The tab names the child's own settings file, whose one server carries the child id.
  const create = space.fake.requests.find((request) => request.method === 'tab.create' || request.method === 'workspace.create');
  const env = (create?.params['env'] ?? {}) as Record<string, string>;
  assert.equal(env['CLINE_MCP_SETTINGS_PATH'], mcpConfigPath(child.id));
  assert.equal(fs.statSync(mcpConfigPath(child.id)).mode & 0o777, 0o600);
  const settings = JSON.parse(fs.readFileSync(mcpConfigPath(child.id), 'utf8')) as { mcpServers: Record<string, { transport: { type: string; args: string[]; env: Record<string, string> } }> };
  const servers = Object.values(settings.mcpServers);
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.transport.type, 'stdio');
  assert.deepEqual(servers[0]?.transport.args.slice(-2), ['--child', child.id]);

  // The costs print at the moment the opt-in is used.
  assert.match(reply, /worker started as a cline agent/);
  assert.match(reply, /Cline runs this child with -y/);
  assert.match(reply, /agent_send reaches it/);
  assert.match(reply, /benchmark mode/);
  assert.doesNotMatch(reply, /credited to the first/);
});

test("agent_read answers an adopted cline child from Cline's store, by its directory", async (t) => {
  const space = await room(t);
  const db = clineDbPath();
  const store = clineStore(db);
  addClineSession(store, db, { id: 'example-session', cwd: space.cwd, prompt: 'by hand', startedAt: '2026-11-27T11:00:00.000Z', replies: ['the adopted child answered'] });
  store.close();
  const now = new Date().toISOString();
  upsertChild(space.parentId, { id: 'c-adopted', name: 'adopted', kind: 'cline', harness: 'cline', paneId: 'w1:p9', host: 'local', origin: 'adopt', cwd: space.cwd, startedAt: now, lastStatus: 'idle', statusChangedAt: now, lastBusyAt: now, depth: 1 });
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'adopted' }, {}), 'the adopted child answered');
});
