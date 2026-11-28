// Tier 1: no test can reach the live Bellwether. The preload in
// test/fixtures/isolation.ts gives each test process its own home and daemon
// socket and refuses the live ones; these cases fail when the preload is
// missing from a test script, or when a default resolves to the live daemon.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { bellwetherHome } from '../../src/core/paths.ts';
import { defaultDaemonSocket } from '../../src/daemon/client.ts';
import { boundsConcurrency, LIVE_HOME, LIVE_SOCKET, LiveBellwetherError } from '../fixtures/isolation.ts';

test('every test script loads the isolation preload', () => {
  assert.ok((globalThis as { __bellwetherIsolation?: string }).__bellwetherIsolation, 'run the tests with --import ./test/fixtures/isolation.ts');
  const scripts = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['test:unit', 'test:integration', 'test:lab']) {
    assert.match(scripts[name] ?? '', /--import[= ]\.\/test\/fixtures\/isolation\.ts/, `${name} does not load the isolation preload`);
  }
});

test('every script that runs node --test names its concurrency', () => {
  const scripts = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const [name, script] of Object.entries(scripts)) {
    for (const command of script.split('&&').filter((part) => /\bnode --test\b/.test(part))) {
      assert.match(command, /--test-concurrency=\S+/, `${name} runs node --test without --test-concurrency, so Node starts one test file per core but one`);
    }
  }
});

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

/** Runs one probe file the way a person would type node --test, with the given flags. */
async function directRun(flags: string[]): Promise<{ code: number; output: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-concurrency-'));
  try {
    const file = path.join(dir, 'probe.test.mjs');
    fs.writeFileSync(file, "import test from 'node:test';\ntest('probe', () => {});\n");
    const env: NodeJS.ProcessEnv = { ...process.env };
    // This file runs as a child of the unit runner, and a runner that inherits
    // NODE_TEST_CONTEXT reports to that runner instead of running its files.
    delete env['NODE_TEST_CONTEXT'];
    try {
      const { stdout, stderr } = await run(process.execPath, ['--test', ...flags, '--import', './test/fixtures/isolation.ts', '--disable-warning=ExperimentalWarning', file], { cwd: root, env });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a direct node --test without --test-concurrency fails every file and says why', async () => {
  const bare = await directRun([]);
  assert.notEqual(bare.code, 0, bare.output);
  assert.match(bare.output, /UnboundedTestRun/);
  assert.match(bare.output, /--test-concurrency/);
  assert.match(bare.output, /npm run test:integration/);
  const named = await directRun(['--test-concurrency=1']);
  assert.equal(named.code, 0, named.output);
  const spaced = await directRun(['--test-concurrency', '2']);
  assert.equal(spaced.code, 0, spaced.output);
});

test('a command line bounds its concurrency only with a positive number', () => {
  assert.equal(boundsConcurrency(['node', '--test', '--test-concurrency=4', 'a.test.ts']), true);
  assert.equal(boundsConcurrency(['node', '--test', '--test-concurrency', '4', 'a.test.ts']), true);
  assert.equal(boundsConcurrency(['node', '--test', 'a.test.ts']), false);
  assert.equal(boundsConcurrency(['node', '--test', '--test-concurrency=0', 'a.test.ts']), false);
});

test('a process a test file starts inherits the runner context and still loads the preload', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  const { stdout } = await run(process.execPath, ['--import', './test/fixtures/isolation.ts', '--disable-warning=ExperimentalWarning', '-e', 'console.log("started")'], { cwd: root, env });
  assert.equal(stdout.trim(), 'started');
});

const isolationFlag = ['--test-isolation', '--experimental-test-isolation'].find((flag) => process.allowedNodeEnvironmentFlags.has(flag));

test('a run in one process needs no concurrency', { skip: isolationFlag ? false : `Node ${process.version} cannot run test files in one process` }, async () => {
  const inline = await directRun([`${isolationFlag}=none`]);
  assert.equal(inline.code, 0, inline.output);
});

test('the default home and daemon socket sit under a temporary root, never the live ones', () => {
  const home = path.resolve(bellwetherHome());
  assert.ok(home.startsWith(path.resolve(os.tmpdir())), `the default home is ${home}`);
  assert.notEqual(home, LIVE_HOME);
  const socket = path.resolve(defaultDaemonSocket(home));
  assert.ok(socket.startsWith(path.resolve(os.tmpdir())), `the default daemon socket is ${socket}`);
  assert.notEqual(socket, LIVE_SOCKET);
});

test('a connection to the live daemon socket is refused before it leaves the process', () => {
  assert.throws(() => net.createConnection(LIVE_SOCKET), LiveBellwetherError);
  assert.throws(() => net.connect({ path: LIVE_SOCKET }), LiveBellwetherError);
  const server = net.createServer();
  assert.throws(() => server.listen(LIVE_SOCKET), LiveBellwetherError);
});
