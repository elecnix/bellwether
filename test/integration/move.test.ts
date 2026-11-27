// Tier 2: agent_move between two fake machines. This process is the parent's
// machine, with its own Bellwether home and harness directories, and `box` is
// a second home in the same temporary root, reached through the fake ssh,
// which runs this checkout's CLI there. Each machine has its own fake herdr
// socket, and fake `claude` and `pi` binaries that answer from that machine's
// harness directory, so each machine can have its own versions and models.
//
// The cases follow a move in both directions, the copy and its verification,
// the resume on the target, and the rollback that starts the child again on
// the source when the target cannot start it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withChildLock } from '../../src/core/child-lock.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { writeMcpConfig } from '../../src/core/mcp-config.ts';
import { moveEndpoints } from '../../src/core/move-endpoint.ts';
import { piSessionDirName } from '../../src/core/move-plan.ts';
import { MoveFailedError, MoveRefusedError, moveChild, moveLogPath, type MoveDeps } from '../../src/core/move.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { readRelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { spawnResume } from '../../src/core/spawn-resume.ts';
import { restartChild } from '../../src/core/restart.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';
import { findBinaries } from '../../src/core/session-state.ts';

interface Machine {
  /** That machine's HOME. */
  user: string;
  /** Its Bellwether home. */
  home: string;
  /** Its Claude Code and pi state roots. */
  claude: string;
  pi: string;
  herdr: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

interface World {
  root: string;
  here: Machine;
  box: Machine;
  ssh: FakeSsh;
  parentId: string;
  deps: MoveDeps;
}

const FAKE_CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ ! -f "$dir/fake-version" ]; then echo "claude: not installed on this machine" >&2; exit 127; fi
echo "$(cat "$dir/fake-version") (Claude Code)"
`;

const FAKE_PI = `#!/bin/sh
dir="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ ! -f "$dir/fake-version" ]; then echo "pi: not installed on this machine" >&2; exit 127; fi
case "$1" in
  --version) cat "$dir/fake-version" ;;
  --list-models) printf 'provider  model  context\\n'; cat "$dir/fake-models" 2>/dev/null ;;
esac
`;

/** Run `fn` with this process's Bellwether home pointed at another machine's. */
function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

async function machine(t: test.TestContext, root: string, name: string, workspace: string, respond?: (world: FakeWorld, request: RecordedRequest) => ReturnType<FakeWorld['respond']>): Promise<Machine> {
  const user = path.join(root, name);
  const home = path.join(user, '.bellwether');
  fs.mkdirSync(home, { recursive: true });
  const world = fakeWorld(workspace);
  const herdr = await startFakeHerdr({ respond: (request) => respond?.(world, request) ?? world.respond(request) });
  world.emit = (frame) => herdr.send(frame);
  t.after(() => herdr.stop());
  return { user, home, claude: path.join(user, '.claude'), pi: path.join(user, '.pi', 'agent'), herdr, world, client: new HerdrClient({ socketPath: herdr.socketPath }) };
}

async function world(t: test.TestContext, respond: { here?: Parameters<typeof machine>[4]; box?: Parameters<typeof machine>[4] } = {}): Promise<World> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-move-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const here = await machine(t, root, 'here', 'w1', respond.here);
  const box = await machine(t, root, 'box', 'w9', respond.box);
  const ssh = installFakeSsh(t, root, { box: { home: box.home, userHome: box.user } });
  const bin = path.join(root, 'harness-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pi'), FAKE_PI, { mode: 0o755 });
  // node alone, not the directory it was installed in: npm puts a global
  // claude or pi beside node, and that real harness would answer the probe.
  const nodeBin = path.join(root, 'node-bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const keys = ['HOME', 'BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PATH', 'BELLWETHER_HARNESS_DIRS'] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env['BELLWETHER_HOME'] = here.home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(here.home, 'daemon.sock');
  process.env['CLAUDE_CONFIG_DIR'] = here.claude;
  process.env['PI_CODING_AGENT_DIR'] = here.pi;
  delete process.env['PI_CODING_AGENT_SESSION_DIR'];
  // Only the fake harnesses, the fake ssh and node: a real claude or pi on this
  // machine would answer for both fake machines, which share one filesystem.
  process.env['HOME'] = here.user;
  process.env['PATH'] = [bin, ssh.dir, nodeBin, '/usr/bin', '/bin'].join(path.delimiter);
  // The probe also tries the usual install places, such as Homebrew's, which PATH does not reach. Ask it for none.
  process.env['BELLWETHER_HARNESS_DIRS'] = '';
  // Each case decides which harness each machine has, so the only claude and pi the probe can find are the fakes.
  for (const name of ['claude', 'pi']) {
    const found = findBinaries(name);
    assert.deepEqual(found, [path.join(bin, name)], `a ${name} outside the test's own fakes is reachable, so a case that needs it missing cannot pass: ${found.join(', ')}`);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const parentId = saveParent(emptyParent('claude-code', 'mover', '/work', { workspaceId: 'w1' })).id;
  const resolve = async (label: string) => {
    if (label !== 'box') throw new Error(`herdr has no saved machine ${label}`);
    return { id: label, label, target: label, session: 'default', enabled: true };
  };
  const remote = remoteOps(resolve);
  const deps: MoveDeps = {
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return here.client;
      if (host === 'box') return box.client;
      throw new Error(`herdr has no saved machine ${host}`);
    },
    endpointFor: moveEndpoints(resolve),
    knownHosts: async () => [LOCAL_HOST, 'box'],
    registerRemote: (child, brief) => remote.register({ id: parentId }, child, brief),
    cleanupRemote: (child) => remote.cleanup(child),
    startupTimeoutMs: 5_000,
    redrawMs: 20,
  };
  return { root, here, box, ssh, parentId, deps };
}

function harness(m: Machine, versions: { claude?: string; pi?: string; models?: string[] }): void {
  if (versions.claude) {
    fs.mkdirSync(m.claude, { recursive: true });
    fs.writeFileSync(path.join(m.claude, 'fake-version'), versions.claude);
  }
  if (versions.pi) {
    fs.mkdirSync(m.pi, { recursive: true });
    fs.writeFileSync(path.join(m.pi, 'fake-version'), versions.pi);
    fs.writeFileSync(path.join(m.pi, 'fake-models'), (versions.models ?? []).map((pair) => `${pair.replace('/', '  ')}  1.0M\n`).join(''));
  }
}

function dir(...parts: string[]): string {
  const full = path.join(...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function child(extra: Partial<ChildRecord>): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'child-worker', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p3', tabId: 'w1:t3', host: LOCAL_HOST, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra };
}

function record(w: World): ChildRecord | undefined {
  return readParent(w.parentId)?.children.find((entry) => entry.id === 'child-worker');
}

function startArgs(m: Machine): string[][] {
  return harnessStarts(m.herdr).map((request) => request.args);
}

function moveLog(): Record<string, unknown>[] {
  if (!fs.existsSync(moveLogPath())) return [];
  return fs.readFileSync(moveLogPath(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const TRANSCRIPT = ['{"type":"user","version":"2.1.300","message":{"role":"user","content":"start"}}', '{"type":"assistant","version":"2.1.300","message":{"role":"assistant","content":"working on it"}}', ''].join('\n');

/** A Claude Code child on this machine, idle in pane w1:p3, with a transcript and a tool result beside it. */
function claudeHere(w: World, cwd: string): { file: string; side: string } {
  const project = path.join(w.here.claude, 'projects', claudeProjectDir(fs.realpathSync(cwd)));
  const file = path.join(project, 'sess-1.jsonl');
  fs.mkdirSync(path.join(project, 'sess-1', 'tool-results'), { recursive: true });
  fs.writeFileSync(file, TRANSCRIPT);
  const side = path.join(project, 'sess-1', 'tool-results', 'out.txt');
  fs.writeFileSync(side, 'a long tool result\n');
  w.here.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-1' } });
  upsertChild(w.parentId, child({ cwd, session: { kind: 'id', value: 'sess-1' }, transcript: file }));
  return { file, side };
}

test('a Claude Code child moves to the other machine under the same id, resumes its session there, and the parent hears no exit', async (t) => {
  const w = await world(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'Source', 'bell.wether', 'main');
  const source = claudeHere(w, hereCwd);
  writeMcpConfig('child-worker');

  // The watcher holds a subscription to the old pane, and herdr reports its close as it would.
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, onEntries: () => {} });
  watcher.start();
  t.after(() => watcher.stop());
  await w.here.herdr.waitFor('events.subscribe');
  const close = w.here.world.answer.bind(w.here.world);
  w.here.world.answer = (request) => {
    if (request.method === 'tab.close') setTimeout(() => w.here.herdr.send({ event: 'pane_closed', data: { pane_id: 'w1:p3' } }), 5);
    return close(request);
  };

  // No machine named: with two known, the other one is the target.
  const result = await moveChild(w.deps, w.parentId, { child: 'worker', cwd: boxCwd, reason: 'closer to the data' });
  await delay(100);

  assert.equal(result.from, LOCAL_HOST);
  assert.equal(result.to, 'box');
  const moved = record(w);
  assert.equal(moved?.id, 'child-worker');
  assert.equal(moved?.name, 'worker');
  assert.equal(moved?.host, 'box');
  assert.equal(moved?.cwd, boxCwd);
  assert.match(moved?.paneId ?? '', /^w9:/);
  assert.equal(moved?.exitedAt, undefined);
  assert.equal(moved?.moving, undefined);
  assert.equal(moved?.movedFrom?.host, LOCAL_HOST);
  assert.equal(moved?.transcript, undefined, 'the old machine\'s transcript path means nothing on the new one');

  // The session sits where Claude Code looks from the new working directory, byte for byte.
  const copied = path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl');
  assert.equal(result.sessionFile, copied);
  assert.equal(fs.readFileSync(copied, 'utf8'), TRANSCRIPT);
  assert.equal(fs.readFileSync(path.join(path.dirname(copied), 'sess-1', 'tool-results', 'out.txt'), 'utf8'), 'a long tool result\n');
  assert.ok(fs.existsSync(source.file), 'the source keeps its session');

  // The child resumed on the target, with an MCP config that machine wrote.
  const [args] = startArgs(w.box);
  assert.deepEqual(args?.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.ok(args?.some((arg) => arg.startsWith(`--mcp-config=${w.box.home}`)), args?.join(' '));
  // A move resumes the session, so it hands the child no brief to read.
  assert.ok(!args?.some((arg) => arg.startsWith('@')), args?.join(' '));
  assert.ok(inHome(w.box.home, () => readRelayRecord('child-worker')), 'the target holds the relay record its reports wait on');
  assert.equal(fs.existsSync(mcpConfigPath('child-worker')), false, 'the config on the machine it left is gone');
  assert.equal(w.here.world.panes.has('w1:p3'), false, 'the source tab is closed');

  // The close of the old pane was the move's own, so no exit reached the parent.
  assert.deepEqual(watcher.outboxEntries().filter((entry) => entry.event === 'exited'), []);
  const [line] = moveLog();
  assert.equal(line?.['outcome'], 'moved');
  assert.equal(line?.['from'], LOCAL_HOST);
  assert.equal(line?.['to'], 'box');
  assert.equal(line?.['reason'], 'closer to the data');
});

test('a resume that fails on the target rolls back: the child runs again where it started, from its own session', async (t) => {
  const w = await world(t, { box: (_world, request) => (harnessStart(request) !== undefined ? { error: { code: 'agent_start_failed', message: 'claude would not start' } } : undefined) });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'Source', 'repo');
  claudeHere(w, hereCwd);
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, onEntries: () => {} });
  watcher.start();
  t.after(() => watcher.stop());
  await w.here.herdr.waitFor('events.subscribe');
  const close = w.here.world.answer.bind(w.here.world);
  w.here.world.answer = (request) => {
    if (request.method === 'tab.close') setTimeout(() => w.here.herdr.send({ event: 'pane_closed', data: { pane_id: 'w1:p3' } }), 5);
    return close(request);
  };

  const failure = await moveChild(w.deps, w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof MoveFailedError, String(failure));
  assert.match(failure.message, /claude would not start/);
  assert.match(failure.message, /rolled it back: worker runs again on this machine in pane w1:p\d+/);

  const back = record(w);
  assert.equal(back?.host, LOCAL_HOST);
  assert.equal(back?.cwd, hereCwd);
  assert.equal(back?.exitedAt, undefined);
  assert.equal(back?.moving, undefined);
  assert.notEqual(back?.paneId, 'w1:p3');
  assert.ok(w.here.world.panes.get(back?.paneId ?? '')?.agent, 'the child runs in a new pane on the source');
  const [args] = startArgs(w.here);
  assert.deepEqual(args?.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.equal(fs.existsSync(path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl')), false, 'the copy on the target is removed');
  assert.equal(moveLog()[0]?.['outcome'], 'rolled-back');
  assert.equal(back?.id, 'child-worker');
  assert.ok(!args?.some((arg) => arg.startsWith('@')), 'the rollback resumes too, with no brief');
  await delay(100);
  assert.deepEqual(watcher.outboxEntries().filter((entry) => entry.event === 'exited'), [], 'the parent hears no exit for a child that came back');
});

test('a pi child moves the other way, from the other machine to this one, into a different directory', async (t) => {
  const w = await world(t);
  harness(w.here, { pi: '1.6.1', models: ['example-hosted/deepseek-v4.1-flash'] });
  harness(w.box, { pi: '1.6.1' });
  const boxCwd = dir(w.box.user, 'work', 'repo');
  const hereCwd = dir(w.here.user, 'Source', 'repo', 'main');
  const name = '2026-11-16T01-38-19-939Z_01a1e201.jsonl';
  const boxFile = path.join(dir(w.box.pi, 'sessions', piSessionDirName(boxCwd)), name);
  const body = [JSON.stringify({ type: 'session', version: 3, id: '01a1e201', cwd: boxCwd }), '{"type":"model_change","provider":"example-hosted","modelId":"deepseek-v4.1-flash"}', '{"type":"message","message":{"role":"assistant","content":"done so far"}}', ''].join('\n');
  fs.writeFileSync(boxFile, body);
  w.box.world.add({ pane_id: 'w9:p4', tab_id: 'w9:t4', agent: 'pi', name: 'worker', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: boxFile } });
  upsertChild(w.parentId, child({ kind: 'pi', harness: 'pi', host: 'box', paneId: 'w9:p4', tabId: 'w9:t4', cwd: boxCwd, session: { kind: 'path', value: boxFile } }));

  const result = await moveChild(w.deps, w.parentId, { child: 'worker', machine: 'local', cwd: hereCwd });

  const local = path.join(w.here.pi, 'sessions', piSessionDirName(hereCwd), name);
  assert.equal(result.sessionFile, local);
  const lines = fs.readFileSync(local, 'utf8').split('\n');
  assert.equal(JSON.parse(lines[0] ?? '{}').cwd, hereCwd, 'pi opens a session in the directory its header names');
  assert.equal(lines.slice(1).join('\n'), body.split('\n').slice(1).join('\n'));
  const moved = record(w);
  assert.equal(moved?.host, LOCAL_HOST);
  assert.equal(moved?.session?.value, local);
  assert.equal(moved?.transcript, local);
  assert.equal(moved?.movedFrom?.host, 'box');
  const [args] = startArgs(w.here);
  assert.deepEqual(args?.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', local]);
  assert.equal(w.box.world.panes.has('w9:p4'), false);
  assert.ok(w.ssh.remoteCalls().some((call) => call.argv[0] === 'relay-cleanup'), 'the machine it left drops its files');
  assert.ok(w.ssh.remoteCalls().some((call) => call.argv[0] === 'move-export'), 'the session was read on the machine that held it');
});

test('a pi child whose provider and model the target lacks is refused before anything moves', async (t) => {
  const w = await world(t);
  harness(w.here, { pi: '1.6.1', models: ['openrouter/deepseek-v4.1-flash'] });
  harness(w.box, { pi: '1.6.1' });
  const boxCwd = dir(w.box.user, 'work', 'repo');
  const boxFile = path.join(dir(w.box.pi, 'sessions', piSessionDirName(boxCwd)), 's_abc.jsonl');
  fs.writeFileSync(boxFile, `${JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: boxCwd })}\n{"type":"model_change","provider":"example-hosted","modelId":"deepseek-v4.1-flash"}\n`);
  w.box.world.add({ pane_id: 'w9:p4', tab_id: 'w9:t4', agent: 'pi', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: boxFile } });
  upsertChild(w.parentId, child({ kind: 'pi', harness: 'pi', host: 'box', paneId: 'w9:p4', tabId: 'w9:t4', cwd: boxCwd, session: { kind: 'path', value: boxFile } }));

  const failure = await moveChild(w.deps, w.parentId, { child: 'worker', cwd: dir(w.here.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(failure instanceof MoveRefusedError, String(failure));
  assert.match(failure.message, /example-hosted\/deepseek-v4\.1-flash/);
  assert.ok(failure.message.includes(path.join(w.here.pi, 'models.json')), failure.message);
  assert.ok(w.box.world.panes.has('w9:p4'), 'the child still runs');
  assert.equal(w.box.herdr.requests.filter((request) => request.method === 'tab.close').length, 0);
  assert.equal(fs.existsSync(path.join(w.here.pi, 'sessions')), false, 'nothing was copied');
  assert.equal(record(w)?.host, 'box');
});

test('a harness missing on the target, or a directory that does not exist there, is refused by name', async (t) => {
  const w = await world(t);
  harness(w.here, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd);

  const missing = await moveChild(w.deps, w.parentId, { child: 'worker', cwd: path.join(w.box.user, 'nowhere') }).catch((error: unknown) => error);
  assert.ok(missing instanceof MoveRefusedError, String(missing));
  assert.match(missing.message, /claude is not installed on machine box/);
  assert.match(missing.message, /nowhere does not exist on machine box/);
  await assert.rejects(moveChild(w.deps, w.parentId, { child: 'worker', kind: 'pi' }), /runs claude-code, and the move asked for pi/);
  assert.ok(w.here.world.panes.has('w1:p3'));
});

test('a different conversation already at the target path is never overwritten, and the child keeps running', async (t) => {
  const w = await world(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'repo');
  claudeHere(w, hereCwd);
  const other = path.join(dir(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd))), 'sess-1.jsonl');
  fs.writeFileSync(other, '{"type":"user","message":"a different conversation"}\n');

  const failure = await moveChild(w.deps, w.parentId, { child: 'worker', cwd: boxCwd }).catch((error: unknown) => error);
  assert.ok(failure instanceof MoveFailedError, String(failure));
  assert.match(failure.message, /refused to overwrite another conversation/);
  assert.match(failure.message, /Nothing was stopped: worker still runs on this machine in pane w1:p3/);
  assert.equal(fs.readFileSync(other, 'utf8'), '{"type":"user","message":"a different conversation"}\n');
  assert.ok(w.here.world.panes.has('w1:p3'));
  assert.equal(record(w)?.host, LOCAL_HOST);
  assert.equal(moveLog()[0]?.['outcome'], 'abandoned');
});

test('a move while another call holds the child is refused at once', async (t) => {
  const w = await world(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  await withChildLock('child-worker', 'worker', 'resume of worker', async () => {
    await assert.rejects(moveChild(w.deps, w.parentId, { child: 'worker', machine: 'box' }), /already being moved by another call/);
  });
  assert.ok(w.here.world.panes.has('w1:p3'));
});

test('agent_move through the tool list replies with where the child went and how much crossed', async (t) => {
  const w = await world(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, onEntries: () => {} });
  const resolve = async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true });
  const reply = await runBellwetherTool(
    { client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, watcher, remote: remoteOps(resolve), endpointFor: w.deps.endpointFor, knownHosts: w.deps.knownHosts },
    'agent_move',
    { child: 'worker', cwd: boxCwd },
  );
  assert.match(reply, /worker moved from this machine to machine box, as the same child child-worker/);
  assert.match(reply, /crossed as \d+ bytes and was verified/);
  assert.equal(record(w)?.host, 'box');
});


test('a resume or a restart of a child mid-move is refused, even after the lock would count as stale', async (t) => {
  const w = await world(t);
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const since = new Date().toISOString();
  upsertChild(w.parentId, { ...record(w)!, moving: { from: LOCAL_HOST, to: 'box', since, until: new Date(Date.now() + 60_000).toISOString() } });
  await assert.rejects(spawnResume(w.deps.clientFor, w.parentId, { target: 'worker', prompt: 'hello' }), /worker \(child child-worker\) is being moved to machine box/);
  await assert.rejects(restartChild(w.here.client, w.parentId, 'child-worker'), /worker \(child child-worker\) is being moved to machine box/);
  assert.ok(w.here.world.panes.has('w1:p3'), 'the refused restart closed nothing');
  // A second move is refused by the same mark.
  await assert.rejects(moveChild(w.deps, w.parentId, { child: 'worker', machine: 'box' }), /already being moved to machine box/);
});

test('a move whose rollback also fails leaves the child stranded on the source, says so, and agent_spawn with resume brings it back', async (t) => {
  let sourceStarts = false;
  const refuse = (where: string) => ({ error: { code: 'agent_start_failed', message: `${where} would not start claude` } });
  const w = await world(t, {
    box: (_world, request) => (harnessStart(request) !== undefined ? refuse('box') : undefined),
    here: (_world, request) => (harnessStart(request) !== undefined && !sourceStarts ? refuse('here') : undefined),
  });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'Source', 'repo');
  const source = claudeHere(w, hereCwd);

  const failure = await moveChild(w.deps, w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd }).catch((error: unknown) => error);
  assert.ok(failure instanceof MoveFailedError, String(failure));
  assert.match(failure.message, /box would not start claude/);
  assert.match(failure.message, /start it again on this machine, and that failed too: .*here would not start claude/);
  assert.ok(failure.message.includes(`its session is intact on this machine at ${source.file}`), failure.message);
  assert.match(failure.message, /Call agent_spawn with resume worker to bring it back there/);

  // The record names the source and says the child is not running, which is what agent_list shows.
  const stranded = record(w);
  assert.equal(stranded?.id, 'child-worker');
  assert.equal(stranded?.host, LOCAL_HOST);
  assert.equal(stranded?.cwd, hereCwd);
  assert.ok(stranded?.exitedAt, 'the child is recorded as not running');
  assert.equal(stranded?.moving, undefined);
  assert.equal(stranded?.session?.value, 'sess-1');
  assert.equal(fs.readFileSync(source.file, 'utf8'), TRANSCRIPT, 'the session on the source is untouched');
  assert.equal(fs.existsSync(path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl')), false, 'the copy on the target is removed');
  const [line] = moveLog();
  assert.equal(line?.['outcome'], 'stranded');
  assert.match(String(line?.['rollbackError']), /here would not start claude/);
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, onEntries: () => {} });
  const listed = await runBellwetherTool({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, watcher }, 'agent_list', {});
  assert.match(listed, /^worker\tclaude\tbare\texited\t.*\tlocal\t/m);

  // The named recovery: once the source can start it, the same child comes back on its own session.
  sourceStarts = true;
  const resumed = await spawnResume(w.deps.clientFor, w.parentId, { target: 'worker', startupTimeoutMs: 5_000, redrawMs: 20 });
  assert.equal(resumed.action, 'resumed');
  assert.equal(resumed.child.id, 'child-worker');
  assert.equal(resumed.child.host, LOCAL_HOST);
  assert.equal(record(w)?.exitedAt, undefined);
  const args = startArgs(w.here).at(-1);
  assert.deepEqual(args?.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
});
