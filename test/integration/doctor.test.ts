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
import { MOVE_CHECK_BUDGET_MS } from '../../src/core/move-endpoint.ts';
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

/** A directory of fake commands for PATH: herdr lists one saved machine, and ssh never connects. */
function fakeBin(root: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const machines = JSON.stringify([{ id: 'm1', label: 'far', target: 'far.example', session: 'default', enabled: true }]);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nprintf '%s\\n' '${machines}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  return bin;
}

test(`doctor answers within the move check's bound of ${MOVE_CHECK_BUDGET_MS} ms, against a slow herdr and a machine whose SSH never connects`, async (t) => {
  const space = isolate(t, 'bellwether-doctor-');
  const herdr = await startFakeHerdr({ delayMs: 300 });
  t.after(() => herdr.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin(space.root)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_SOCKET_PATH: herdr.socketPath };
  const result = await run(['doctor'], env);
  assert.ok(result.elapsedMs < MOVE_CHECK_BUDGET_MS + STARTUP_ALLOWANCE_MS, `doctor took ${result.elapsedMs} ms:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok {4}herdr api: 0 panes/);
  assert.match(result.stdout, /move machine far: no child can move there or from there until this is fixed: no answer within 4 s, the bound doctor sets on the move check/);
  assert.match(result.stdout, /versions: this install is /);
  // herdr was asked for the pane list once, not once per session or child.
  assert.equal(herdr.requests.filter((request) => request.method === 'pane.list').length, 1);
});

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
