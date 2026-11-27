// Tier 2: routes against the fake herdr socket. A child on a route starts
// behind the route's launcher, typed at the prompt of the pane its spawn
// created, and a bare child starts with herdr's agent.start. The cases cover
// the exact launch for a route, a route with a tier and a bare start, the
// refusals before any tab opens, a restart and a resume that change route in
// both directions on the same session, the record's route and key file path
// with the key never written anywhere, and a routed and a bare child side by
// side, both reporting. Every route, tier and variable name is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { bellwetherHome, claudeSettingsPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { hostName } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import type { RestartHooks } from '../../src/core/restart.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest, harnessStarts } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const KEY_VALUE = 'example-tenant-key-value';

const ROUTES = {
  routes: {
    'example-router': {
      launcher: ['example-router', '--yes'],
      tiers: ['example-deep', 'example-fast'],
      defaultTier: 'example-deep',
      key: { env: 'EXAMPLE_ROUTER_KEY' },
      description: 'Its requests go through the example router.',
    },
  },
};

interface Rig {
  fake: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
  root: string;
  keyFile: string;
  tool: (name: string, args: Record<string, unknown>, caller?: { paneId?: string; childId?: string }) => Promise<string>;
  parentId: string;
}

async function rig(t: test.TestContext, name: string): Promise<Rig> {
  const { root } = isolate(t, 'bellwether-routes-');
  // The preload points BELLWETHER_ROUTES into its own root; each case writes its own file.
  const before = process.env['BELLWETHER_ROUTES'];
  const routesFile = path.join(root, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify(ROUTES));
  process.env['BELLWETHER_ROUTES'] = routesFile;
  t.after(() => {
    if (before === undefined) delete process.env['BELLWETHER_ROUTES'];
    else process.env['BELLWETHER_ROUTES'] = before;
  });
  const keyFile = path.join(root, 'tenant.key');
  fs.writeFileSync(keyFile, `${KEY_VALUE}\n`, { mode: 0o600 });

  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parentId = saveParent(emptyParent('claude-code', name, '/work', { workspaceId: 'w1', host: hostName() })).id;
  const watcher = new Watcher({ client, parentId, onEntries: () => {} });
  const jobs = new Map<string, Promise<void>>();
  const hooks: RestartHooks = {
    defer: (key, job) => {
      if (!jobs.has(key)) jobs.set(key, job());
    },
    waitTimeoutMs: 300,
    deferTimeoutMs: 2_000,
    startupTimeoutMs: 3_000,
    redrawMs: 10,
  };
  const ctx: ToolContext = { client, clientFor: async () => client, parentId, watcher, restart: hooks };
  return { fake, world, client, root, keyFile, parentId, tool: (tool, args, caller) => runBellwetherTool(ctx, tool, args, caller) };
}

function calls(fake: FakeHerdr, method: string): RecordedRequest[] {
  return fake.requests.filter((request) => request.method === method);
}

function child(rig: Rig, name: string): ChildRecord {
  const found = readParent(rig.parentId)?.children.find((entry) => entry.name === name);
  assert.ok(found, `${name} is on the record`);
  return found;
}

function pane(rig: Rig, paneId: string): FakePane {
  const found = rig.world.panes.get(paneId);
  assert.ok(found, `pane ${paneId} exists`);
  return found;
}

/** Everything Bellwether wrote under its home, as one string. */
function homeContents(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(bellwetherHome());
  return out.join('\n');
}

/** A bare claude child that ran on session sess-1, and its live pane. */
function liveBare(rig: Rig, extra: Partial<ChildRecord> = {}): void {
  const at = new Date(Date.now() - 60_000).toISOString();
  upsertChild(rig.parentId, { id: 'child-worker', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p3', tabId: 'w1:t3', workspaceId: 'w1', host: LOCAL_HOST, origin: 'spawn', cwd: '/work/repo', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, session: { kind: 'id', value: 'sess-1' }, depth: 1, ...extra });
  rig.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-1' } });
}

test('via a route starts the launcher in front of claude, on the default tier, and records the route', async (t) => {
  const r = await rig(t, 'routes-spawn');
  const text = await r.tool('agent_spawn', { kind: 'claude', name: 'routed', cwd: '/work/repo', prompt: 'Do the thing.\nThen report.', via: 'example-router' });
  assert.match(text, /routed started as a claude agent in pane w1:p\d+, tab w1:t\d+, on route example-router:example-deep\./);
  const record = child(r, 'routed');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-deep' });

  const started = pane(r, record.paneId);
  assert.deepEqual(started.assignments, []);
  assert.deepEqual(started.launcher, ['example-router', '--yes', '--model', 'example-deep']);
  assert.equal(started.agent, 'claude');
  const brief = path.join(bellwetherHome(), 'prompts', `${record.id}.md`);
  const mcp = path.join(bellwetherHome(), 'mcp', `${record.id}.json`);
  assert.deepEqual(started.args, [`--mcp-config=${mcp}`, `--settings=${claudeSettingsPath(record.id)}`, '--dangerously-load-development-channels=server:bellwether', `@${brief}`]);
  assert.equal(harnessStarts(r.fake).length, 0, 'herdr never started a bare claude');
  assert.deepEqual(calls(r.fake, 'agent.rename').map((request) => request.params), [{ target: record.paneId, name: 'routed' }]);
  // The startup dialog was answered, as for a bare claude child.
  assert.equal(started.agent_status, 'idle');
  assert.equal(started.name, 'routed');
});

test('via a route with a tier passes that tier, and a bare spawn types the harness behind `command`, with no launcher', async (t) => {
  const r = await rig(t, 'routes-tier');
  await r.tool('agent_spawn', { kind: 'claude', name: 'fast', cwd: '/work/repo', via: 'example-router', model: 'example-fast' });
  const fast = child(r, 'fast');
  assert.deepEqual(fast.route, { name: 'example-router', tier: 'example-fast' });
  assert.deepEqual(pane(r, fast.paneId).launcher, ['example-router', '--yes', '--model', 'example-fast']);
  assert.ok(!pane(r, fast.paneId).args?.includes('--model'), 'the harness gets no model of its own on a route');

  await r.tool('agent_spawn', { kind: 'claude', name: 'plain', cwd: '/work/repo', model: 'haiku' });
  const plain = child(r, 'plain');
  assert.equal(plain.route, undefined);
  const starts = harnessStarts(r.fake);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.via, 'typed', 'a bare claude is typed behind `command`, so a shell function named claude cannot change it');
  assert.equal(starts[0]?.kind, 'claude');
  assert.deepEqual((starts[0]?.args as string[]).slice(0, 2), ['--model', 'haiku']);
  assert.equal(pane(r, plain.paneId).launcher, undefined);
});

test('a bare child starts behind `command`, so a shell function named after its harness cannot change its arguments (issue #133)', async (t) => {
  const r = await rig(t, 'routes-shell-function');
  // The operator's startup files wrap claude to add development channels of their own.
  r.world.shellFunctions.set('claude', ['--dangerously-load-development-channels', 'server:example-one', 'server:example-two']);
  r.world.shellFunctions.set('pi', ['--provider', 'example-provider']);

  await r.tool('agent_spawn', { kind: 'claude', name: 'plain', cwd: '/work/repo', prompt: 'Do the thing.' });
  const record = child(r, 'plain');
  const started = pane(r, record.paneId);
  assert.match(started.typed ?? '', /^command claude /, 'the launch line names claude behind `command`');
  const brief = path.join(bellwetherHome(), 'prompts', `${record.id}.md`);
  const mcp = path.join(bellwetherHome(), 'mcp', `${record.id}.json`);
  assert.deepEqual(started.args, [`--mcp-config=${mcp}`, `--settings=${claudeSettingsPath(record.id)}`, '--dangerously-load-development-channels=server:bellwether', `@${brief}`], 'the child got exactly the arguments Bellwether chose');
  assert.equal(started.agent_status, 'idle', 'the channel question was answered');
  assert.equal(started.name, 'plain', 'the agent is named after its detection');

  await r.tool('agent_spawn', { kind: 'pi', name: 'pi-plain', cwd: '/work/repo', model: 'example-model', provider: 'example-host' });
  const pi = pane(r, child(r, 'pi-plain').paneId);
  assert.match(pi.typed ?? '', /^command pi /);
  assert.ok(!pi.args?.includes('example-provider'), `the pi function ran: ${JSON.stringify(pi.args)}`);
});

test('each mismatch is refused by name before any tab opens', async (t) => {
  const r = await rig(t, 'routes-refusals');
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'a', model: 'example-fast' }), {
    message: 'a was not started: model example-fast is a tier of route example-router, not a model claude knows. Add via example-router.',
  });
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'b', via: 'example-router', model: 'haiku' }), /b was not started: model haiku is not a tier of route example-router, which takes example-deep, example-fast\. Drop model to run on its default tier example-deep, or drop via to run haiku bare\./);
  const missing = path.join(r.root, 'no-such.key');
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'c', via: 'example-router', key_file: missing }), {
    message: `c was not started: key_file ${missing} does not exist. Pass the path of a file that holds the key, or drop key_file.`,
  });
  const empty = path.join(r.root, 'empty.key');
  fs.writeFileSync(empty, '');
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'd', via: 'example-router', key_file: empty }), /d was not started: key_file .* is empty\./);
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'e', via: 'example-other' }), /via example-other names no route in .*routes\.json\. Routes defined there: example-router\./);
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'f', key_file: r.keyFile }), /key_file needs via/);
  // The first thing someone meets after installing: no routes file at all.
  fs.rmSync(process.env['BELLWETHER_ROUTES'] as string);
  await assert.rejects(r.tool('agent_spawn', { kind: 'claude', name: 'g', via: 'example-router' }), /g was not started: via example-router names a route, and the routes file .*routes\.json does not exist\. Create it with a route named example-router/);
  assert.equal(calls(r.fake, 'tab.create').length, 0, 'no tab opened');
  assert.deepEqual(readParent(r.parentId)?.children, [], 'no record left behind');
});

test('the record carries the route and the key file path, and the key itself appears nowhere', async (t) => {
  const r = await rig(t, 'routes-key');
  await r.tool('agent_spawn', { kind: 'claude', name: 'tenant', cwd: '/work/repo', via: 'example-router', key_file: r.keyFile });
  const record = child(r, 'tenant');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-deep', keyFile: r.keyFile });
  const started = pane(r, record.paneId);
  assert.deepEqual(started.assignments, [`EXAMPLE_ROUTER_KEY=$(cat ${r.keyFile})`]);
  assert.doesNotMatch(started.typed ?? '', new RegExp(KEY_VALUE));
  assert.doesNotMatch(JSON.stringify(r.fake.requests), new RegExp(KEY_VALUE), 'no herdr request carries the key');
  assert.doesNotMatch(homeContents(), new RegExp(KEY_VALUE), 'nothing Bellwether wrote holds the key');
  const listed = await r.tool('agent_list', {});
  assert.match(listed, /^name\tkind\troute\tstate/);
  assert.match(listed, /^tenant\tclaude\texample-router:example-deep \(key file\)\t/m);
});

test('a restart moves a bare child onto a route and back off it, keeping its session id both ways', async (t) => {
  const r = await rig(t, 'routes-restart');
  liveBare(r);

  const onto = await r.tool('agent_restart', { target: 'worker', via: 'example-router', model: 'example-fast' });
  assert.match(onto, /It moved from route bare to example-router:example-fast, on the same session\./);
  assert.match(onto, /The session id matches\./);
  let record = child(r, 'worker');
  assert.equal(record.id, 'child-worker');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-fast' });
  assert.equal(record.session?.value, 'sess-1');
  let started = pane(r, record.paneId);
  assert.deepEqual(started.launcher, ['example-router', '--yes', '--model', 'example-fast']);
  assert.deepEqual(started.args?.slice(-2), ['--resume', 'sess-1']);
  assert.equal(started.agent_session?.value, 'sess-1');
  assert.equal(harnessStarts(r.fake).length, 0);

  // Without via, a restart keeps the route it runs on.
  await r.tool('agent_restart', { target: 'worker' });
  record = child(r, 'worker');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-fast' });
  assert.deepEqual(pane(r, record.paneId).launcher, ['example-router', '--yes', '--model', 'example-fast']);

  const off = await r.tool('agent_restart', { target: 'worker', via: 'none' });
  assert.match(off, /It moved from route example-router:example-fast to bare, on the same session\./);
  record = child(r, 'worker');
  assert.equal(record.route, undefined);
  assert.equal(record.session?.value, 'sess-1');
  started = pane(r, record.paneId);
  assert.equal(started.launcher, undefined, 'a bare restart types no launcher');
  const bare = harnessStarts(r.fake);
  assert.equal(bare.length, 1);
  const args = bare[0]?.args as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.equal(started.agent_session?.value, 'sess-1');
});

test('a self restart onto a route is kept on the record until the daemon acts', async (t) => {
  const r = await rig(t, 'routes-self');
  liveBare(r);
  const reply = await r.tool('agent_restart', { via: 'example-router' }, { childId: 'child-worker', paneId: 'w1:p3' });
  assert.match(reply, /Restart requested for worker/);
  assert.match(reply, /example-router --yes --model example-deep claude --resume sess-1/);
  assert.match(reply, /It moved from route bare to example-router:example-deep/);
  assert.deepEqual(child(r, 'worker').restartRoute, { via: 'example-router' });
});

test('a resume of a retired child changes route in both directions on the same session', async (t) => {
  const r = await rig(t, 'routes-resume');
  liveBare(r);
  r.world.panes.delete('w1:p3');

  const onto = await r.tool('agent_spawn', { resume: 'worker', prompt: 'Carry on.', via: 'example-router', key_file: r.keyFile });
  assert.match(onto, /worker resumed session sess-1 in pane w1:p\d+, as the same child child-worker, on route example-router:example-deep \(key file\)\./);
  let record = child(r, 'worker');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-deep', keyFile: r.keyFile });
  let started = pane(r, record.paneId);
  assert.deepEqual(started.launcher, ['example-router', '--yes', '--model', 'example-deep']);
  assert.ok(started.args?.includes('--resume') && started.args.includes('sess-1'));

  // A resume that names a different route for a live child would only message it, so it is refused.
  await assert.rejects(r.tool('agent_spawn', { resume: 'worker', prompt: 'x', via: 'none' }), /worker is alive in pane .* on route example-router:example-deep \(key file\), so a resume would only message it and could not move it to bare\. Call agent_restart/);

  r.world.panes.delete(record.paneId);
  const off = await r.tool('agent_spawn', { resume: 'worker', prompt: 'Carry on bare.', via: 'none' });
  assert.match(off, /on route bare\./);
  record = child(r, 'worker');
  assert.equal(record.route, undefined);
  started = pane(r, record.paneId);
  assert.equal(started.launcher, undefined);
  assert.equal(started.agent_session?.value, 'sess-1');
});

test('a resume that names no route keeps the one the child ran on, with its key file', async (t) => {
  const r = await rig(t, 'routes-keep');
  liveBare(r, { route: { name: 'example-router', tier: 'example-fast', keyFile: r.keyFile } });
  r.world.panes.delete('w1:p3');
  await r.tool('agent_spawn', { resume: 'worker', prompt: 'Carry on.' });
  const record = child(r, 'worker');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-fast', keyFile: r.keyFile });
  assert.deepEqual(pane(r, record.paneId).assignments, [`EXAMPLE_ROUTER_KEY=$(cat ${r.keyFile})`]);
});

test('a routed child and a bare child run side by side, and both report', async (t) => {
  const r = await rig(t, 'routes-both');
  await r.tool('agent_spawn', { kind: 'claude', name: 'routed', cwd: '/work/a', via: 'example-router' });
  await r.tool('agent_spawn', { kind: 'claude', name: 'plain', cwd: '/work/b' });
  const routed = child(r, 'routed');
  const plain = child(r, 'plain');
  assert.equal(await r.tool('parent_report', { status: 'done', text: 'routed finished' }, { childId: routed.id, paneId: routed.paneId }), 'Reported done to the parent, as routed.');
  assert.equal(await r.tool('parent_report', { status: 'done', text: 'plain finished' }, { childId: plain.id, paneId: plain.paneId }), 'Reported done to the parent, as plain.');
  const listed = await r.tool('agent_list', {});
  assert.match(listed, /^routed\tclaude\texample-router:example-deep\t/m);
  assert.match(listed, /^plain\tclaude\tbare\t/m);
});

test('a pi child on a route runs behind the launcher with its extension, and inherits no provider and model pair', async (t) => {
  const r = await rig(t, 'routes-pi');
  const caller = { model: { provider: 'openrouter', id: 'example-parent-model' } };
  const ctxTool = (args: Record<string, unknown>): Promise<string> => runBellwetherTool({ client: r.client, clientFor: async () => r.client, parentId: r.parentId, watcher: new Watcher({ client: r.client, parentId: r.parentId, onEntries: () => {} }) }, 'agent_spawn', args, caller);
  await ctxTool({ kind: 'pi', name: 'pirouted', cwd: '/work/repo', prompt: 'Do it.', via: 'example-router', model: 'example-fast' });
  const record = child(r, 'pirouted');
  assert.deepEqual(record.route, { name: 'example-router', tier: 'example-fast' });
  assert.equal(record.model, undefined, 'the tier picks the model, not the parent pair');
  const started = pane(r, record.paneId);
  assert.deepEqual(started.launcher, ['example-router', '--yes', '--model', 'example-fast']);
  assert.equal(started.agent, 'pi');
  assert.equal(started.args?.[0], '-e');
  assert.ok(!started.args?.includes('--provider') && !started.args?.includes('--model'));
  await assert.rejects(ctxTool({ kind: 'pi', name: 'pihalf', via: 'example-router', provider: 'openrouter' }), /provider applies to a bare pi start, and on route example-router the tier picks the model\. Drop provider, or pass via none\./);
});
