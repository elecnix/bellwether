// `bellwether doctor` and `bellwether --version` as a person runs them: the
// command in a process of its own, on a home, herdr and PATH this case owns.
// herdr answers each request after a fixed delay, a saved machine's SSH never
// connects, and a daemon speaks a protocol this install does not.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MOVE_CHECK_BUDGET_MS } from '../../src/core/move-endpoint.ts';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from '../../src/core/version.ts';
import { DAEMON_ENTRY, originOf, readLock } from '../../src/daemon/lock.ts';
import { acquired } from '../../src/core/authority.ts';
import { firstRun } from '../../src/core/incarnation.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, saveRelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';
import { isolate } from '../fixtures/isolated.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
/** What starting node and loading the sources costs, beyond the move check's bound. */
const STARTUP_ALLOWANCE_MS = 3_000;

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

/** A directory of fake commands for PATH: herdr lists one saved machine, or none, ssh never connects unless a case gives its own, and pi when a case gives one. */
function fakeBin(root: string, options: { machines?: object[]; pi?: string; ssh?: string } = {}): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const machines = JSON.stringify(options.machines ?? [{ id: 'm1', label: 'far', target: 'far.example', session: 'default', enabled: true }]);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nprintf '%s\\n' '${machines}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), options.ssh ?? '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  if (options.pi) fs.writeFileSync(path.join(bin, 'pi'), options.pi, { mode: 0o755 });
  return bin;
}

/** pi on a machine with no provider: it prints its version, and a sentence where the model table would be, and exits 0. */
const PI_WITHOUT_MODELS = `#!/bin/sh
case "$1" in
  --version) echo 0.99.0 ;;
  --list-models) echo 'No models available. Use /login to log into a provider via OAuth or API key.' ;;
esac
`;

test('doctor says a machine whose pi has no provider offers no pair, rather than counting pi\'s sentence as one', async (t) => {
  const space = isolate(t, 'bellwether-doctor-no-models-');
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root, { machines: [], pi: PI_WITHOUT_MODELS })}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const result = await run(['doctor'], env);
  const line = result.stdout.split('\n').find((entry) => entry.includes('move this machine')) ?? '';
  assert.match(line, /pi 0\.99\.0, pi offers no pair: pi --list-models lists no provider and model,/, result.stdout);
  assert.doesNotMatch(result.stdout, /1 pi models?/);
});

test(`doctor answers within the move check's bound of ${MOVE_CHECK_BUDGET_MS} ms, against a slow herdr and a machine whose SSH never connects`, async (t) => {
  const space = isolate(t, 'bellwether-doctor-');
  const herdr = await startFakeHerdr({ delayMs: 300 });
  t.after(() => herdr.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const result = await run(['doctor'], env);
  assert.ok(result.elapsedMs < MOVE_CHECK_BUDGET_MS + STARTUP_ALLOWANCE_MS, `doctor took ${result.elapsedMs} ms:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok {4}herdr api: 0 panes/);
  // A machine that does not answer in time is unknown, not broken (issue #166).
  assert.match(result.stdout, /move machine far: unknown, because it did not answer within 6 s, the bound doctor sets on each call of the move check \(.*timed out.*\)\. That alone shows no fault there, so doctor cannot tell whether a child can move there or from there\./);
  assert.doesNotMatch(result.stdout, /until this is fixed/);
  assert.match(result.stdout, /versions: this install is /);
  // herdr was asked for the pane list once, not once per session or child.
  assert.equal(herdr.requests.filter((request) => request.method === 'pane.list').length, 1);
});

/** ssh to a machine that answers as the one in issue #166 did by hand: bellwether help in 0.6 s, then move-probe in 3.4 s. */
const SSH_SLOW_BUT_WORKING = `#!/bin/sh
for last; do :; done
case "$last" in
  *move-probe*)
    cat > /dev/null
    sleep 3.4
    printf '%s\\n' '${JSON.stringify({ ok: true, result: { hostname: 'far-host', bellwether: '0.1.8', dirs: {}, harnesses: { 'claude-code': { path: '/opt/claude', version: '2.1.332' }, pi: { path: '/opt/pi', version: '0.99.0' } }, piModels: [{ provider: 'example-hosted', model: 'example-m1' }], piModelsFile: '/opt/models.json' } })}'
    ;;
  *help*)
    sleep 0.6
    echo 'Usage: bellwether <daemon|move|doctor>'
    echo '  move-probe|move-export|move-import|move-discard|move-commit'
    ;;
esac
`;

test('doctor reports a machine that answers its two move calls in 0.6 s and 3.4 s, rather than calling it unable to move children', async (t) => {
  const space = isolate(t, 'bellwether-doctor-slow-');
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root, { ssh: SSH_SLOW_BUT_WORKING })}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const result = await run(['doctor'], env);
  // The fake ssh carries no herdr bridge, so herdr on that machine reads as unknown, never as missing.
  assert.match(result.stdout, /info {2}move machine far \(far-host\): claude 2\.1\.332, pi 0\.99\.0, 1 pi model, herdr integrations unknown \(.+\), bellwether 0\.1\.8/, result.stdout);
  assert.doesNotMatch(result.stdout, /move machine far: /);
});

/** herdr's answer to integration.list, with pi listed in a state or left out, as herdr 0.9.5 lists it. */
function integrations(pi: string | undefined): { result: unknown } {
  const claude = { target: 'claude', label: 'claude', command: 'claude', available: true, state: 'current' };
  return { result: { type: 'integration_list', integrations: pi === undefined ? [claude] : [{ target: 'pi', label: 'pi', command: 'pi', available: true, state: pi }, claude] } };
}

for (const [pi, expected] of [
  [undefined, 'herdr pi integration missing (run `herdr integration install pi` on this machine)'],
  ['current', 'herdr pi integration present'],
] as const) {
  test(`doctor reports this machine's herdr pi integration as ${pi === undefined ? 'missing when herdr does not list it' : 'present when herdr lists it'}`, async (t) => {
    const space = isolate(t, 'bellwether-doctor-integration-');
    const herdr = await startFakeHerdr({ respond: (request) => (request.method === 'integration.list' ? integrations(pi) : undefined) });
    t.after(() => herdr.stop());
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root, { machines: [], pi: PI_WITHOUT_MODELS })}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
    const result = await run(['doctor'], env);
    const line = result.stdout.split('\n').find((entry) => entry.includes('move this machine')) ?? '';
    assert.ok(line.includes('herdr claude integration present'), result.stdout);
    assert.ok(line.includes(expected), result.stdout);
    assert.ok(herdr.requests.some((request) => request.method === 'integration.list'), 'doctor asked herdr');
  });
}

test('--version prints the version and the commit, without asking a daemon that speaks another protocol', async (t) => {
  const space = isolate(t, 'bellwether-version-');
  fs.mkdirSync(space.home, { recursive: true });
  // A daemon from a later protocol: its lock says so, and it refuses whatever a client says.
  let connections = 0;
  const socket = path.join(space.home, 'daemon.sock');
  const server = net.createServer((client) => {
    connections += 1;
    client.end(`${JSON.stringify({ type: 'error', id: '', code: 'protocol', message: 'this daemon speaks protocol 99 only' })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  fs.writeFileSync(path.join(space.home, 'daemon.lock'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), protocol: 99, version: '9.0.0', socket })}\n`);
  for (const flag of ['--version', 'version']) {
    const result = await run([flag], { ...process.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+\S* \((commit [0-9a-f]{12}|build unknown)/);
    assert.equal(result.stderr, '');
  }
  assert.equal(connections, 0, 'the version came from the build, not from the daemon');
});

test('drain --socket describes the lock beside that socket, not the one in BELLWETHER_HOME, and names the lock it read', async (t) => {
  const space = isolate(t, 'bellwether-drain-');
  fs.mkdirSync(space.home, { recursive: true });
  // The home holds the lock of an older daemon, which is not the one being drained.
  fs.writeFileSync(path.join(space.home, 'daemon.lock'), `${JSON.stringify({ pid: 1, startedAt: 1, protocol: 3, socket: path.join(space.home, 'daemon.sock') })}\n`);
  const other = path.join(space.root, 'x');
  fs.mkdirSync(other);
  const socket = path.join(other, 'daemon.sock');
  const lock = path.join(other, 'daemon.lock');
  fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), protocol: 4, version: '0.1.5', socket })}\n`);
  // A daemon on that socket: it answers the drain, lets go of its lock and stops listening.
  const server = net.createServer((client) => {
    client.on('data', () => {
      client.end(`${JSON.stringify({ type: 'drained', id: '' })}\n`);
      fs.rmSync(lock, { force: true });
      server.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve())));
  const result = await run(['drain', '--socket', socket], { ...process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`drained the daemon 0\\.1\\.5 on protocol 4 \\(pid ${process.pid}\\), as its lock ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} records`));
  assert.doesNotMatch(result.stdout, /before 0\.1\.5|unknown/);
});

test('bellwether daemon in the foreground writes its entry point, version and build into its lock, and doctor names that install', async (t) => {
  const space = isolate(t, 'bellwether-foreground-');
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const socket = path.join(space.home, 'daemon.sock');
  const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<void>((resolve) => daemon.on('close', () => resolve()));
  t.after(async () => {
    daemon.kill('SIGTERM');
    await exited;
  });
  const deadline = Date.now() + 10_000;
  while (!stderr.includes('listening on') && Date.now() < deadline) await delay(20);
  assert.match(stderr, /listening on/, stderr);
  const lock = readLock(space.home);
  assert.ok(lock, 'the daemon wrote its lock');
  assert.equal(lock.pid, daemon.pid);
  assert.equal(lock.socket, socket);
  assert.equal(lock.version, BELLWETHER_VERSION);
  assert.equal(lock.build, BELLWETHER_BUILD_ID);
  assert.equal(lock.entry, DAEMON_ENTRY);
  assert.equal(lock.origin, originOf(DAEMON_ENTRY));
  assert.equal(lock.foreground, true);
  const result = await run(['doctor'], env);
  const versions = result.stdout.split('\n').find((line) => line.includes('versions:')) ?? '';
  assert.match(versions, new RegExp(`started by hand with bellwether daemon on ${escape(socket)}, from this install's entry point, ${escape(DAEMON_ENTRY)}`), result.stdout);
  assert.doesNotMatch(versions, /names no entry point|predates/);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('doctor prints the authority it uses for each live child, and fails on a pane whose two sources disagree, naming both (issue #279)', async (t) => {
  const space = isolate(t, 'bellwether-doctor-authority-');
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const at = '2026-11-28T08:00:00.000Z';
  const child = (id: string, name: string, extra: Partial<ChildRecord>): ChildRecord => ({
    id,
    name,
    kind: 'claude',
    harness: 'claude-code',
    ...firstRun({ paneId: 'w1:p2', host: LOCAL_HOST, cwd: '/work', status: 'idle' }),
    startedAt: at,
    statusChangedAt: at,
    lastBusyAt: at,
    depth: 1,
    ...extra,
  });
  const parent = emptyParent('claude-code', 'S-doctor', '/work');
  parent.children.push(
    child('c-built', 'builder', { ...acquired('spawn'), ...firstRun({ paneId: 'w1:p3', host: LOCAL_HOST, cwd: '/work', status: 'idle' }) }),
    child('c-hand', 'hand-started', { ...acquired('adopt'), ...firstRun({ paneId: 'w1:p2', host: LOCAL_HOST, cwd: '/work', session: { kind: 'id', value: 'S-pane' }, status: 'idle' }) }),
  );
  saveParent(parent);
  // A parent on another machine claims the same pane on the same session: two sources, one pane.
  saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'c-far', name: 'far-held', kind: 'claude', parentId: 'pi-far-parent', registeredAt: at, paneId: 'w1:p2', adopted: true, session: 'S-pane' });

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root, { machines: [] })}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const result = await run(['doctor'], env);
  assert.match(result.stdout, new RegExp(`ok {4}authority: builder \\(child c-built\\) on this machine is started, held by parent ${parent.id}; evidence: the registry of parent ${parent.id} on this machine, which started it in pane w1:p3\\.`), result.stdout);
  assert.match(result.stdout, new RegExp(`ok {4}authority: hand-started \\(child c-hand\\) on this machine is adopted, held by parent ${parent.id}; evidence: the registry of parent ${parent.id} on this machine, which adopted pane w1:p2\\.`), result.stdout);
  assert.match(result.stdout, new RegExp(`fail  authority: Pane w1:p2 on this machine is held by two sources of authority that disagree: the registry of parent ${parent.id} on this machine, as child c-hand \\(hand-started\\) on session S-pane, and the adoption claim of parent pi-far-parent on another machine, as child c-far \\(far-held\\) on session S-pane\\. Bellwether does not pick one\\.`), result.stdout);
  assert.notEqual(result.status, 0, 'a conflict between two sources of authority fails doctor');
});
