// Tier 1: routes. A route is a launcher wrapper from this machine's routes
// file. These cases cover the arguments a routed child starts with, each
// refusal by its message, the key file kept by path, and the doctor line read
// from the route's own config. Every name here is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeRoutes, launchLine, readRoutes, resolveRoute, routeExplanation, routeLabel, routeLaunch, routesPath, type RoutesFile } from '../../src/core/routes.ts';

const ROUTER = {
  launcher: ['example-router', '--yes'],
  tiers: ['example-deep', 'example-fast'],
  defaultTier: 'example-deep',
  key: { env: 'EXAMPLE_ROUTER_KEY' },
  description: 'Its requests go through the example router, which picks the provider.',
};

function routes(extra: Record<string, unknown> = {}): RoutesFile {
  return { file: '/config/bellwether/routes.json', routes: { 'example-router': ROUTER, ...extra } as RoutesFile['routes'] };
}

function keyFile(t: test.TestContext, contents = 'example-key-value\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tenant.key');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

test('the routes file is BELLWETHER_ROUTES when set, and ~/.config/bellwether/routes.json otherwise', () => {
  assert.equal(routesPath({ BELLWETHER_ROUTES: '/tmp/r.json' }), '/tmp/r.json');
  assert.equal(routesPath({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/bellwether/routes.json');
  assert.equal(routesPath({}), path.join(os.homedir(), '.config', 'bellwether', 'routes.json'));
});

test('a missing routes file defines no routes, and a broken one is refused by its path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readRoutes(path.join(dir, 'absent.json')), { file: path.join(dir, 'absent.json'), missing: true, routes: {} });
  const file = path.join(dir, 'routes.json');
  fs.writeFileSync(file, '{"routes":{"example-router":{"launcher":[]}}}');
  assert.throws(() => readRoutes(file), new RegExp(`${file} cannot be used: route example-router needs launcher`));
  fs.writeFileSync(file, '{"routes":{"none":{"launcher":["x"]}}}');
  assert.throws(() => readRoutes(file), /"none" is reserved/);
  fs.writeFileSync(file, JSON.stringify({ routes: { 'example-router': { ...ROUTER, defaultTier: 'example-other' } } }));
  assert.throws(() => readRoutes(file), /defaultTier example-other, which is not one of its tiers/);
  fs.writeFileSync(file, JSON.stringify({ routes: { 'example-router': ROUTER } }));
  assert.deepEqual(readRoutes(file).routes['example-router'], ROUTER);
});

test('via a route starts the launcher, then the default tier, then the harness and its own arguments', () => {
  const resolved = resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router' }, routes());
  assert.deepEqual(resolved, { route: { name: 'example-router', tier: 'example-deep' } });
  const launch = routeLaunch(ROUTER, resolved.route!, 'claude', ['--mcp-config=/m.json', '@/brief.md']);
  assert.deepEqual(launch.argv, ['example-router', '--yes', '--model', 'example-deep', 'claude', '--mcp-config=/m.json', '@/brief.md']);
  assert.deepEqual(launch.envFromFile, {});
});

test('via a route with a tier passes that tier, and the harness gets no model of its own', () => {
  const resolved = resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', model: 'example-fast' }, routes());
  assert.deepEqual(resolved, { route: { name: 'example-router', tier: 'example-fast' } });
  assert.equal((resolved as { harnessModel?: string }).harnessModel, undefined);
  assert.deepEqual(routeLaunch(ROUTER, resolved.route!, 'claude', ['--resume', 'sess-1']).argv, ['example-router', '--yes', '--model', 'example-fast', 'claude', '--resume', 'sess-1']);
});

test('a route places the tier where its tierArgs say, and pi runs behind it the same way', () => {
  const config = { launcher: ['example-wrap'], tierArgs: ['--tier={tier}'] };
  const resolved = resolveRoute({ name: 'worker', kind: 'pi', via: 'example-wrap', model: 'example-any' }, routes({ 'example-wrap': config }));
  assert.deepEqual(routeLaunch(config, resolved.route!, 'pi', ['--session', '/s.jsonl']).argv, ['example-wrap', '--tier=example-any', 'pi', '--session', '/s.jsonl']);
});

test('bare, the harness gets the model, and no launcher', () => {
  assert.deepEqual(resolveRoute({ name: 'worker', kind: 'claude', model: 'haiku' }, routes()), { harnessModel: 'haiku' });
  assert.deepEqual(resolveRoute({ name: 'worker', kind: 'claude', via: 'none', model: 'haiku' }, routes()), { harnessModel: 'haiku' });
  assert.deepEqual(resolveRoute({ name: 'worker', kind: 'claude' }, routes()), {});
});

test('a tier passed without via is refused, and the refusal names the route to add', () => {
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', model: 'example-fast' }, routes()), {
    message: 'worker was not started: model example-fast is a tier of route example-router, not a model claude knows. Add via example-router.',
  });
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'none', model: 'example-fast' }, routes()), /via none starts claude bare, which does not know that tier\. Pass via example-router, or drop via none\./);
});

test('via a route with a model that is not one of its tiers is refused, and says to drop model or via', () => {
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', model: 'haiku' }, routes()), {
    message: 'worker was not started: model haiku is not a tier of route example-router, which takes example-deep, example-fast. Drop model to run on its default tier example-deep, or drop via to run haiku bare.',
  });
});

test('a key file that does not exist, or is empty, is refused by its path', (t) => {
  const missing = path.join(os.tmpdir(), 'bw-no-such-key', 'tenant.key');
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', keyFile: missing }, routes()), {
    message: `worker was not started: key_file ${missing} does not exist. Pass the path of a file that holds the key, or drop key_file.`,
  });
  const empty = keyFile(t, '');
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', keyFile: empty }, routes()), {
    message: `worker was not started: key_file ${empty} is empty. Put the key in it, or drop key_file.`,
  });
});

test('a key file needs via, and a route that declares a key', (t) => {
  const file = keyFile(t);
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', keyFile: file }, routes()), /key_file needs via, a route whose launcher takes a key/);
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-plain', keyFile: file }, routes({ 'example-plain': { launcher: ['example-plain'] } })), /route example-plain declares no key, so it cannot take key_file/);
});

test('an unknown route names the routes the file does define', () => {
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-other' }, routes()), {
    message: 'worker was not started: via example-other names no route in /config/bellwether/routes.json. Routes defined there: example-router. Pass one of them, add example-other to that file, or pass via none for a bare start.',
  });
});

test('a route asked for with no routes file, or with a file that defines none, says which and what to do', () => {
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router' }, { file: '/r.json', missing: true, routes: {} }), {
    message: 'worker was not started: via example-router names a route, and the routes file /r.json does not exist. Create it with a route named example-router (docs/routes.md gives the fields), or pass via none for a bare start.',
  });
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router' }, { file: '/r.json', routes: {} }), {
    message: 'worker was not started: via example-router names a route, and the routes file /r.json defines none. Add a route named example-router there, or pass via none for a bare start.',
  });
  assert.deepEqual(describeRoutes(() => ({ file: '/r.json', missing: true, routes: {} }), []), ['info  routes: /r.json does not exist, so every child starts bare']);
});

test('a route is refused for a harness it does not run, and for another machine', () => {
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'cline', via: 'example-router' }, routes()), /route example-router runs claude, pi, codex, not cline/);
  assert.throws(() => resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', host: 'example-box' }, routes()), /describes this machine's launcher, and worker would run on machine example-box/);
});

test('a key reaches the launcher from its file when the line runs, and the line never holds the key', (t) => {
  const file = keyFile(t, 'example-secret-value');
  const resolved = resolveRoute({ name: 'worker', kind: 'claude', via: 'example-router', keyFile: file }, routes());
  assert.deepEqual(resolved.route, { name: 'example-router', tier: 'example-deep', keyFile: file });
  const launch = routeLaunch(ROUTER, resolved.route!, 'claude', ['@/brief.md']);
  assert.deepEqual(launch.envFromFile, { EXAMPLE_ROUTER_KEY: file });
  const line = launchLine(launch);
  assert.equal(line, `EXAMPLE_ROUTER_KEY="$(cat ${file})" example-router --yes --model example-deep claude @/brief.md`);
  assert.doesNotMatch(line, /example-secret-value/);
  assert.doesNotMatch(JSON.stringify(resolved), /example-secret-value/);
});

test('a route whose key is a flag passes the file path with it', (t) => {
  const file = keyFile(t);
  const config = { launcher: ['example-wrap'], key: { flag: '--key-file' } };
  const resolved = resolveRoute({ name: 'worker', kind: 'claude', via: 'example-wrap', keyFile: file }, routes({ 'example-wrap': config }));
  assert.deepEqual(routeLaunch(config, resolved.route!, 'claude', []).argv, ['example-wrap', '--key-file', file, 'claude']);
});

test('a route adds its own arguments for a harness right after the harness name', () => {
  const config = { launcher: ['example-wrap'], harnessArgs: { claude: ['--example-flag=one'] } };
  const resolved = resolveRoute({ name: 'worker', kind: 'claude', via: 'example-wrap' }, routes({ 'example-wrap': config }));
  assert.deepEqual(routeLaunch(config, resolved.route!, 'claude', ['@/b.md']).argv, ['example-wrap', 'claude', '--example-flag=one', '@/b.md']);
  assert.deepEqual(routeLaunch(config, resolved.route!, 'pi', ['@/b.md']).argv, ['example-wrap', 'pi', '@/b.md']);
});

test('the launch line quotes each word for the shell', () => {
  assert.equal(launchLine({ envFromFile: { EXAMPLE_KEY: "/a b/it's" }, argv: ['example-router', '@"/x y.md"'] }), `EXAMPLE_KEY="$(cat '/a b/it'\\''s')" example-router '@"/x y.md"'`);
});

test('agent_list shows the route in one short column', () => {
  assert.equal(routeLabel(undefined), 'bare');
  assert.equal(routeLabel({ name: 'example-router', tier: 'example-fast' }), 'example-router:example-fast');
  assert.equal(routeLabel({ name: 'example-router', tier: 'example-fast', keyFile: '/k' }), 'example-router:example-fast (key file)');
});

test('doctor explains each route from its own config, and names the children on it', () => {
  assert.equal(
    routeExplanation('example-router', ROUTER),
    'a child on route example-router runs under `example-router --yes`, on tier example-deep unless the spawn names one of example-deep, example-fast, and a key file reaches it as EXAMPLE_ROUTER_KEY, where a bare child runs the harness directly. Its requests go through the example router, which picks the provider.',
  );
  const lines = describeRoutes(() => routes(), [{ name: 'a' }, { name: 'b', route: { name: 'example-router' } }, { name: 'c', route: { name: 'example-gone' } }]);
  assert.equal(lines[0], 'ok    routes: /config/bellwether/routes.json defines example-router');
  assert.match(lines[1] ?? '', /^info {2}route example-router \(b\): a child on route example-router runs under/);
  assert.match(lines[2] ?? '', /^fail {2}route example-gone \(c\): route example-gone is not defined in this machine's routes file/);
  assert.deepEqual(describeRoutes(() => ({ file: '/r.json', routes: {} }), []), ['info  routes: /r.json defines none, so every child starts bare']);
  assert.match(describeRoutes(() => { throw new Error('broken'); }, [])[0] ?? '', /^fail {2}routes: broken/);
});
