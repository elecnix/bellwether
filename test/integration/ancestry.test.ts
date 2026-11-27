// `bellwether ancestry` as another program runs it: the command in a process
// of its own, against a daemon on this case's home, with no daemon at all, and
// against a daemon from before the request. The tree is written with the
// registry's own functions, and a root session says hello so the daemon knows
// it runs and watches its children.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import type { AncestryAnswer } from '../../src/core/ancestry.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { isolate } from '../fixtures/isolated.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const T0 = '2026-11-01T10:00:00.000Z';

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function ask(agent: string): Promise<AncestryAnswer> {
  const result = await run(['ancestry', '--json', agent]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as AncestryAnswer;
}

/** A service that holds nothing: the cases cover only what the daemon owns. */
const quiet: ServiceFactory = (): ParentService => ({
  tool: async (name) => {
    throw new Error(`no tool ${name}`);
  },
  markRead: () => {},
  onEvents: () => {},
  pending: () => [],
  watchPane: () => () => {},
  stop: () => {},
});

function child(id: string, kind: string, session: string, extra: Partial<ChildRecord> = {}): ChildRecord {
  return { id, name: `name-${id}`, kind, harness: kind === 'claude' ? 'claude-code' : kind, paneId: `w1:${id}`, host: 'local', startedAt: T0, lastStatus: 'idle', statusChangedAt: T0, lastBusyAt: T0, depth: 1, session: { kind: kind === 'pi' ? 'path' : 'id', value: session }, ...extra };
}

/** root (claude) → mid (pi) → leaf (claude, exited). */
function writeTree(leaf: Partial<ChildRecord> = {}): void {
  saveParent({ ...emptyParent('claude-code', 'claude-root-session', '/work', { host: 'local' }), children: [child('mid0000000000001', 'pi', '/s/2026-11-01T10-00-00-000Z_pi-mid-session.jsonl')] });
  saveParent({ ...emptyParent('pi', 'pi-mid-session', '/work', { host: 'local', depth: 1, childId: 'mid0000000000001' }), children: [child('leaf000000000001', 'claude', 'claude-leaf-session', { depth: 2, exitedAt: '2026-11-01T12:00:00.000Z', ...leaf })] });
}

test('the daemon answers: the leaf exited, its parent is watched, and the root is connected', async (t) => {
  const space = isolate(t, 'bellwether-ancestry-');
  writeTree();
  const socketPath = path.join(space.home, 'daemon.sock');
  const daemon = await startDaemon({ socketPath, home: space.home, factory: quiet });
  t.after(() => daemon.close());
  const root = await DaemonClient.connect({ harness: 'claude-code', session: 'claude-root-session', cwd: '/work', host: 'local', depth: 0, herdrSocket: '/tmp/none.sock' }, { home: space.home, socketPath, spawn: false });
  t.after(() => root.close());

  const answer = await ask('claude:claude-leaf-session');
  assert.equal(answer.source, 'daemon');
  assert.equal(answer.stale, false);
  assert.equal(answer.status, 'known');
  assert.deepEqual([answer.agent, ...answer.chain].map((level) => [level?.agent, level?.alive, level?.evidence]), [
    ['claude:claude-leaf-session', false, 'exited'],
    ['pi:pi-mid-session', true, 'watched'],
    ['claude:claude-root-session', true, 'connected'],
  ]);
  assert.equal(answer.nearestAlive, 0);
  assert.equal(answer.top, 'root');

  const unknown = await ask('claude:never-seen');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.agent, null);

  const text = await run(['ancestry', 'claude:claude-leaf-session']);
  assert.match(text.stdout, /^alive {2}pi:pi-mid-session \(name-mid0000000000001\) on local: alive, watched/m);
});

test('with no daemon, the command reads the registry and says the answer is stale', async (t) => {
  const space = isolate(t, 'bellwether-ancestry-');
  writeTree();
  const answer = await ask('claude:claude-leaf-session');
  assert.equal(answer.stale, true);
  assert.equal(answer.source, 'registry');
  assert.match(answer.staleReason ?? '', /no daemon answers on .*daemon\.sock/);
  assert.equal(answer.agent?.evidence, 'exited');
  assert.deepEqual(answer.chain.map((level) => [level.alive, level.evidence]), [[null, 'stale'], [null, 'stale']]);
  assert.equal(fs.existsSync(path.join(space.home, 'daemon.lock')), false, 'the query started no daemon');
});

test('a daemon from before the request gets a stale answer that names the release it needs', async (t) => {
  const space = isolate(t, 'bellwether-ancestry-');
  writeTree();
  const socketPath = path.join(space.home, 'daemon.sock');
  const server = net.createServer((client) => client.on('data', () => client.end(`${JSON.stringify({ type: 'error', code: 'unknown_type', message: 'unknown request type "ancestry"' })}\n`)));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const answer = await ask('claude:claude-leaf-session');
  assert.equal(answer.stale, true);
  assert.match(answer.staleReason ?? '', /predates the ancestry request, which needs Bellwether 0\.1\.6/);
  assert.equal(answer.chain.length, 2);
});
