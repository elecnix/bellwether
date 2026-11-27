// Tier 2: a Cline child against the fake herdr socket and a fixture Cline
// store. Each spawned child runs in Cline's sandbox mode with a data
// directory of its own, so its session runs in its own process and no hub is
// shared: its MCP settings, named in CLINE_MCP_SETTINGS_PATH, stay with it,
// and its session is found in its own sessions.db. With -y in args the child
// also runs in Cline's benchmark mode, and the agent_spawn reply lists what
// that mode costs. agent_read answers an adopted cline child from the
// operator's own Cline store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clineDbPath } from '../../src/core/harnesses/cline.ts';
import { clineDataDir } from '../../src/core/paths.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { mcpConfigPath, promptPath, spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { SpoolReport } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { addClineSession, clineStore } from '../fixtures/cline-db.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
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

/** The variables the newest tab carried: the child herdr is starting now. */
function lastTabEnv(space: Room): Record<string, string> {
  const creates = space.fake.requests.filter((request) => request.method === 'tab.create' || request.method === 'workspace.create');
  return (creates.at(-1)?.params['env'] ?? {}) as Record<string, string>;
}

/**
 * Cline's part: when the agent starts, record the session it picked, with
 * the prompt it was given, in the store its tab points it at. In sandbox mode
 * Cline puts its store under CLINE_SANDBOX_DATA_DIR.
 */
function clineWrites(space: Room, id = 'example-cline-session', reply = 'the child answered'): void {
  space.world.onStart = (pane: FakePane) => {
    const args = pane.args ?? [];
    // herdr reports no session for Cline.
    delete pane.agent_session;
    const dataDir = lastTabEnv(space)['CLINE_SANDBOX_DATA_DIR'];
    assert.ok(dataDir, 'the tab names no sandbox data directory');
    const db = path.join(dataDir, 'db', 'sessions.db');
    const store = clineStore(db);
    addClineSession(store, db, { id: `${id}-${pane.pane_id}`, cwd: space.cwd, prompt: args[args.indexOf('-i') + 1] as string, startedAt: new Date().toISOString(), replies: [`${reply} in ${pane.pane_id}`] });
    store.close();
  };
}

/** The child id the one Bellwether server in a Cline child's MCP settings carries. */
function serverChildId(file: string): string | undefined {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { transport: { args: string[] } }> };
  const servers = Object.values(settings.mcpServers);
  assert.equal(servers.length, 1);
  const args = servers[0]?.transport.args ?? [];
  return args[args.indexOf('--child') + 1];
}

function spool(parentId: string): SpoolReport[] {
  const file = spoolPath(parentId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpoolReport);
}

function nothingWritten(space: Room): void {
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'agent.start'), false);
  const prompts = path.join(space.home, 'prompts');
  assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
}

test('the default launch starts the child in a sandbox of its own, off the hub and out of benchmark mode', async (t) => {
  const space = await room(t);
  clineWrites(space);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'cline', name: 'worker', prompt: 'report back', cwd: space.cwd, model: 'example-model' }, {});
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'worker');
  assert.ok(child, 'the spawn wrote no record');

  // The launch line: the model, the TUI and the brief, and no -y.
  const start = space.fake.requests.find((request) => request.method === 'agent.start');
  assert.equal(start?.params['kind'], 'cline');
  assert.deepEqual(start?.params['args'], ['--model', 'example-model', '-i', `Your task is in ${promptPath(child.id)}. Read it, then do what it says.`]);

  // Sandbox mode keeps the session in the child's own process, with its own data directory.
  const env = lastTabEnv(space);
  const dataDir = clineDataDir(child.id);
  assert.equal(env['CLINE_SANDBOX'], '1');
  assert.equal(env['CLINE_SANDBOX_DATA_DIR'], dataDir);
  assert.equal(env['CLINE_MCP_SETTINGS_PATH'], mcpConfigPath(child.id));
  assert.equal(serverChildId(mcpConfigPath(child.id)), child.id);
  // The child signs in with the operator's provider settings, through a link to their directory.
  assert.equal(fs.readlinkSync(path.join(dataDir, 'settings')), path.join(process.env['CLINE_DIR']!, 'data', 'settings'));
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);

  // Its session is found in its own store, and agent_read answers from it.
  assert.equal(child.store, path.join(dataDir, 'db', 'sessions.db'));
  assert.deepEqual(child.session, { kind: 'id', value: `example-cline-session-${child.paneId}` });
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'worker' }, {}), `the child answered in ${child.paneId}`);

  // The reply says where the child runs, and prints no benchmark costs.
  assert.match(reply, /worker started as a cline agent/);
  assert.match(reply, /Cline's sandbox mode/);
  assert.ok(reply.includes(dataDir), `the reply does not name ${dataDir}`);
  assert.doesNotMatch(reply, /benchmark|-y/);
});

test('two default children run in two sandboxes, and each report lands under its own child id', async (t) => {
  const space = await room(t);
  clineWrites(space);
  await runBellwetherTool(context(space), 'agent_spawn', { kind: 'cline', name: 'first', prompt: 'one', cwd: space.cwd }, {});
  const firstEnv = lastTabEnv(space);
  await runBellwetherTool(context(space), 'agent_spawn', { kind: 'cline', name: 'second', prompt: 'two', cwd: space.cwd }, {});
  const secondEnv = lastTabEnv(space);
  const children = readParent(space.parentId)?.children ?? [];
  const first = children.find((entry) => entry.name === 'first');
  const second = children.find((entry) => entry.name === 'second');
  assert.ok(first && second, 'both spawns should have written a record');

  // Nothing is shared: two data directories, two stores, two MCP settings files, two sessions.
  assert.notEqual(firstEnv['CLINE_SANDBOX_DATA_DIR'], secondEnv['CLINE_SANDBOX_DATA_DIR']);
  assert.notEqual(first.store, second.store);
  assert.notEqual(first.session?.value, second.session?.value);
  assert.equal(serverChildId(firstEnv['CLINE_MCP_SETTINGS_PATH']!), first.id);
  assert.equal(serverChildId(secondEnv['CLINE_MCP_SETTINGS_PATH']!), second.id);

  // Each child's own server calls parent_report with the id its settings carry; the daemon records each under its own child.
  for (const [entry, env] of [[second, secondEnv], [first, firstEnv]] as const) {
    const childId = serverChildId(env['CLINE_MCP_SETTINGS_PATH']!);
    await runBellwetherTool(context(space), 'parent_report', { status: 'done', text: `${entry.name} finished` }, { childId, paneId: entry.paneId });
  }
  const reports = spool(space.parentId);
  assert.deepEqual(
    reports.map((report) => [report.childId, report.childName, report.text]),
    [
      [second.id, 'second', 'second finished'],
      [first.id, 'first', 'first finished'],
    ],
  );
});

test("a provider settings file Cline's sandbox cannot reach is refused before the record", async (t) => {
  const space = await room(t);
  const saved = process.env['CLINE_PROVIDER_SETTINGS_PATH'];
  process.env['CLINE_PROVIDER_SETTINGS_PATH'] = path.join(space.cwd, 'example-providers.json');
  t.after(() => {
    if (saved === undefined) delete process.env['CLINE_PROVIDER_SETTINGS_PATH'];
    else process.env['CLINE_PROVIDER_SETTINGS_PATH'] = saved;
  });
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'cline', name: 'worker', prompt: 'x', cwd: space.cwd }), (error: Error) => {
    assert.match(error.message, /^worker was not started: CLINE_PROVIDER_SETTINGS_PATH names .*example-providers\.json/);
    assert.match(error.message, /providers\.json/);
    return true;
  });
  nothingWritten(space);
});

test('a child on another machine is refused, because the store is read where it runs', async (t) => {
  const space = await room(t);
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'cline', name: 'far', prompt: 'x', cwd: space.cwd, args: ['-y'], host: 'example-host' }), /far was not started: a cline child runs on this machine only for now/);
  nothingWritten(space);
});

test('with -y the child also runs in benchmark mode, and the reply lists the costs', async (t) => {
  const space = await room(t);
  clineWrites(space);
  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'cline', name: 'worker', prompt: 'report back', cwd: space.cwd, model: 'example-model', args: ['-y'] }, {});
  const child = readParent(space.parentId)?.children.find((entry) => entry.name === 'worker');
  assert.ok(child, 'the spawn wrote no record');
  assert.equal(child.store, path.join(clineDataDir(child.id), 'db', 'sessions.db'));
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'worker' }, {}), `the child answered in ${child.paneId}`);

  const start = space.fake.requests.find((request) => request.method === 'agent.start');
  assert.deepEqual(start?.params['args'], ['--model', 'example-model', '-i', `Your task is in ${promptPath(child.id)}. Read it, then do what it says.`, '-y']);
  assert.equal(fs.readFileSync(promptPath(child.id), 'utf8'), 'report back');
  const env = lastTabEnv(space);
  assert.equal(env['CLINE_SANDBOX_DATA_DIR'], clineDataDir(child.id));
  assert.equal(env['CLINE_MCP_SETTINGS_PATH'], mcpConfigPath(child.id));
  assert.equal(fs.statSync(mcpConfigPath(child.id)).mode & 0o777, 0o600);
  assert.equal(serverChildId(mcpConfigPath(child.id)), child.id);

  // The costs print at the moment the opt-in is used.
  assert.match(reply, /worker started as a cline agent/);
  assert.match(reply, /Cline runs this child with -y/);
  assert.match(reply, /benchmark mode: a different system prompt, six built-in tools/);
  assert.match(reply, /no skills and no sub-agents or teams/);
  assert.match(reply, /DANGEROUS: use only in sandboxed environments/);
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

test('a spawn whose session never shows in the store fails, naming the store, and closes the pane', async (t) => {
  const space = await room(t);
  const db = path.join(space.cwd, '..', 'fixture-cline', 'db', 'sessions.db');
  await assert.rejects(
    spawnChild(space.client, readParent(space.parentId)!, { kind: 'cline', name: 'silent', prompt: 'report back', cwd: space.cwd }, undefined, { harness: { store: db, waitMs: 200, intervalMs: 20 } }),
    (error: Error) => error.message.startsWith('silent was not started: Cline never recorded a session') && error.message.includes(db),
  );
  assert.deepEqual(readParent(space.parentId)?.children, []);
});
