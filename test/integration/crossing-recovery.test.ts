// Tier 2: a daemon killed in the middle of a move, and the next daemon that
// finishes or undoes it (issue #226). The parent's daemon runs in a process
// of its own (test/fixtures/crossing-daemon.ts), so the test can kill it with
// SIGKILL while the move waits on herdr, then start another on the same home.
// herdr on each machine is a fake socket in this process that holds one
// request unanswered, which fixes the step the move stops at:
//
//   1. before the stop: the source tab's close is held, so the child still
//      runs on the source and a verified copy sits at the destination;
//   2. after the stop, with no destination pane: the destination's new tab is
//      held, so the child runs nowhere;
//   3. with the destination running the session: the destination's first
//      read of the new pane is held, after the harness started there.
//
// Each case asserts what the next daemon does, and that agent_list and doctor
// call a crossing child crossing rather than exited while it lasts.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { crossingLines, recoverCrossings } from '../../src/core/recover-crossing.ts';
import { readParent, updateChild } from '../../src/core/registry.ts';
import { crossingBegun } from '../../src/core/requests.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import type { RecordedRequest } from '../fixtures/fake-herdr.ts';
import { harnessStart, harnessStarts } from '../fixtures/fake-herdr.ts';
import { claudeHere, dir, harness, twoMachines, type TwoMachines } from '../fixtures/two-machines.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'crossing-daemon.ts');

async function startCrossingDaemon(t: test.TestContext, w: TwoMachines): Promise<ChildProcess> {
  const socketPath = path.join(w.here.home, 'daemon.sock');
  const config = { socketPath, home: w.here.home, hereHerdr: w.here.herdr.socketPath, boxHerdr: w.box.herdr.socketPath };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', FIXTURE], { env: { ...process.env, CROSSING_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the crossing daemon did not start: ${stderr}`)), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`the crossing daemon exited with ${code}: ${stderr}`)));
  });
  return child;
}

async function connectParent(t: test.TestContext, w: TwoMachines): Promise<DaemonClient> {
  const client = await DaemonClient.connect({ harness: 'claude-code', session: 'mover', cwd: '/work', host: os.hostname(), workspaceId: 'w1', depth: 0, herdrSocket: w.here.herdr.socketPath }, { socketPath: path.join(w.here.home, 'daemon.sock'), home: w.here.home, spawn: false });
  t.after(() => client.close().catch(() => {}));
  return client;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await gone;
}

function record(w: TwoMachines): ChildRecord | undefined {
  return readParent(w.parentId)?.children.find((entry) => entry.id === 'child-worker');
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

function moveLog(w: TwoMachines): Record<string, unknown>[] {
  const file = path.join(w.here.home, 'move.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Start a move through a daemon process, wait until it reaches the held
 * request, and kill that daemon there. Returns the record the dead daemon
 * left and what agent_list showed at that moment.
 */
async function interruptedMove(t: test.TestContext, w: TwoMachines, held: { on: 'here' | 'box'; methods: string[] }, boxCwd: string): Promise<{ left: ChildRecord; listed: string }> {
  const first = await startCrossingDaemon(t, w);
  const parent = await connectParent(t, w);
  const move = parent.tool('agent_move', { child: 'worker', machine: 'box', cwd: boxCwd }).catch((error: Error) => error);
  const herdr = held.on === 'box' ? w.box.herdr : w.here.herdr;
  await until(`the move to reach ${held.methods.join(' or ')} on ${held.on}`, () => herdr.requests.some((request) => held.methods.includes(request.method)));
  const listed = await parent.tool('agent_list', {});
  await kill(first);
  await move;
  await parent.close().catch(() => {});
  const left = record(w);
  assert.ok(left?.moving?.daemon, `the killed daemon left its mark: ${JSON.stringify(left?.moving)}`);
  return { left: left as ChildRecord, listed };
}

function holdOnce(method: string): (request: RecordedRequest) => boolean {
  let held = false;
  return (request) => {
    if (held || request.method !== method) return false;
    held = true;
    return true;
  };
}

function boxCopy(w: TwoMachines, boxCwd: string): string {
  return path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl');
}

test('stage 1: a daemon killed before the source tab closes leaves the child running; the next daemon removes the copy and changes nothing else', async (t) => {
  const w = await twoMachines(t, {}, { here: holdOnce('tab.close') });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');

  const { left, listed } = await interruptedMove(t, w, { on: 'here', methods: ['tab.close'] }, boxCwd);
  assert.equal(left.moving?.stage, 'verified');
  assert.ok(fs.existsSync(boxCopy(w, boxCwd)), 'the dead daemon left a verified copy at the destination');
  assert.match(listed, /^worker\t.*\tmoving to box since /m, 'agent_list calls a crossing child moving, not exited');
  assert.match(crossingLines(readParent(w.parentId) ? [readParent(w.parentId)!] : [])[0] ?? '', /^info  crossing: worker .* is moving to box/);

  await startCrossingDaemon(t, w);
  await connectParent(t, w);
  await until('the next daemon to undo the move', () => moveLog(w).some((line) => line['recovered'] === true));
  const after = record(w) as ChildRecord;
  assert.equal(after.moving, undefined);
  assert.equal(after.host, 'local');
  assert.equal(after.paneId, 'w1:p3', 'the child still runs in its own pane');
  assert.equal(after.exitedAt, undefined);
  assert.equal(after.crossingFailed, undefined);
  assert.ok(w.here.world.panes.has('w1:p3'));
  assert.equal(fs.existsSync(boxCopy(w, boxCwd)), false, 'the copy at the destination is gone');
  assert.equal(harnessStarts(w.here.herdr).length, 0, 'nothing was started on the source');
  assert.deepEqual(moveLog(w).map((line) => [line['outcome'], line['recovered']]), [['abandoned', true]]);
});

test('stage 2: a daemon killed after the source tab closed and before the destination started leaves the child nowhere; the next daemon resumes it on the source', async (t) => {
  const w = await twoMachines(t, {}, { box: (request) => request.method === 'tab.create' || request.method === 'workspace.create' });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd);
  const boxCwd = dir(w.box.user, 'repo');

  const { left, listed } = await interruptedMove(t, w, { on: 'box', methods: ['tab.create', 'workspace.create'] }, boxCwd);
  assert.ok(['stopped', 'recopied'].includes(left.moving?.stage ?? ''), `the move had stopped the source: ${left.moving?.stage}`);
  assert.equal(w.here.world.panes.has('w1:p3'), false, 'the source tab is closed');
  assert.match(listed, /^worker\t.*\tmoving to box since /m, 'a child that runs nowhere mid-move is moving, not exited');

  await startCrossingDaemon(t, w);
  await connectParent(t, w);
  await until('the next daemon to resume the child on the source', () => moveLog(w).some((line) => line['recovered'] === true));
  const after = record(w) as ChildRecord;
  assert.equal(after.moving, undefined);
  assert.equal(after.host, 'local');
  assert.equal(after.cwd, hereCwd);
  assert.equal(after.exitedAt, undefined, 'it runs again');
  assert.equal(after.crossingFailed, undefined);
  assert.notEqual(after.paneId, 'w1:p3');
  assert.ok(w.here.world.panes.get(after.paneId)?.agent, 'a new pane on the source runs it');
  const [args] = harnessStarts(w.here.herdr).map((request) => request.args);
  assert.deepEqual(args?.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1'], 'it resumed its own session');
  assert.equal(fs.existsSync(boxCopy(w, boxCwd)), false, 'the copy at the destination is gone');
  assert.deepEqual(moveLog(w).map((line) => [line['outcome'], line['recovered']]), [['rolled-back', true]]);
});

test('stage 2b: a daemon killed after it typed the launch line on the destination, before herdr reported the session there, leaves one session on one machine', async (t) => {
  // herdr on the destination takes the launch line and reports nothing yet:
  // the harness is still loading when the daemon dies. The next daemon finds
  // no session there and undoes the crossing, and the harness then comes up.
  let launched: RecordedRequest | undefined;
  const w = await twoMachines(
    t,
    {
      box: (world, request) => {
        if (!launched && harnessStart(request)) {
          launched = request;
          return { result: { type: 'ok' } };
        }
        return world.respond(request);
      },
    },
    { box: (request) => launched !== undefined && request.method === 'pane.process_info' },
  );
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd);
  const boxCwd = dir(w.box.user, 'repo');

  const { left } = await interruptedMove(t, w, { on: 'box', methods: ['pane.process_info'] }, boxCwd);
  const typedIn = String(launched?.params['pane_id'] ?? '');
  assert.ok(typedIn && w.box.world.panes.has(typedIn), 'the dead daemon typed the launch line into a tab on the destination');
  assert.equal(left.moving?.stage, 'launching', 'the mark says the launch line may have gone out');
  assert.equal(left.moving?.target?.paneId, typedIn, 'the mark names the destination pane before the harness starts');

  await startCrossingDaemon(t, w);
  await connectParent(t, w);
  await until('the next daemon to resume the child on the source', () => moveLog(w).some((line) => line['recovered'] === true));
  // The destination's harness finishes loading now, in whatever pane still holds the line.
  if (launched && w.box.world.panes.has(typedIn)) w.box.world.answer({ ...launched, params: { ...launched.params } });

  const after = record(w) as ChildRecord;
  assert.equal(after.moving, undefined);
  assert.equal(after.host, 'local');
  assert.equal(after.exitedAt, undefined, 'it runs again on the source');
  assert.ok(w.here.world.panes.get(after.paneId)?.agent, 'a new pane on the source runs it');
  assert.equal(w.box.world.panes.has(typedIn), false, "the recovery closed the destination's tab before it resumed the child on the source");
  const running = [w.here, w.box].flatMap((m) => [...m.world.panes.values()].filter((pane) => pane.agent_session?.value === 'sess-1'));
  assert.equal(running.length, 1, `the session runs in one place: ${running.map((pane) => pane.pane_id).join(', ')}`);
  assert.equal(fs.existsSync(boxCopy(w, boxCwd)), false, 'the copy at the destination is gone');
  assert.deepEqual(moveLog(w).map((line) => [line['outcome'], line['recovered']]), [['rolled-back', true]]);
});

test('stage 2b: when the destination tab the crossing typed into will not close, the next daemon changes nothing rather than start the session on the source as well', async (t) => {
  let launched: RecordedRequest | undefined;
  const w = await twoMachines(
    t,
    {
      box: (world, request) => {
        if (!launched && harnessStart(request)) {
          launched = request;
          return { result: { type: 'ok' } };
        }
        if (request.method === 'tab.close' || request.method === 'pane.close') return { error: { code: 'internal', message: 'herdr is busy' } };
        return world.respond(request);
      },
    },
    { box: (request) => launched !== undefined && request.method === 'pane.process_info' },
  );
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');

  const { left } = await interruptedMove(t, w, { on: 'box', methods: ['pane.process_info'] }, boxCwd);
  const typedIn = String(launched?.params['pane_id'] ?? '');
  const startsBefore = harnessStarts(w.here.herdr).length;

  const second = await startCrossingDaemon(t, w);
  let stderr = '';
  second.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  await connectParent(t, w);
  await until('the next daemon to report the crossing it could not settle', () => /crossing of worker \(child child-worker\): unknown: .*did not close/.test(stderr));
  const after = record(w) as ChildRecord;
  assert.deepEqual(after.moving, left.moving, 'the mark stays for the next start');
  assert.equal(harnessStarts(w.here.herdr).length, startsBefore, 'nothing started on the source');
  assert.ok(w.box.world.panes.has(typedIn), 'the destination tab is still there');
  assert.ok(fs.existsSync(boxCopy(w, boxCwd)), 'the copy stays for a session that may be loading there');
  assert.deepEqual(moveLog(w), []);
});

test('stage 3: a daemon killed after the destination started the session leaves it running there; the next daemon finishes the move', async (t) => {
  const w = await twoMachines(t, {}, { box: holdOnce('agent.get') });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');

  const { left } = await interruptedMove(t, w, { on: 'box', methods: ['agent.get'] }, boxCwd);
  const pane = [...w.box.world.panes.values()].find((entry) => entry.agent_session?.value === 'sess-1');
  assert.ok(pane, 'the destination runs the session');
  assert.ok(left.moving, 'the record still says it is moving');

  await startCrossingDaemon(t, w);
  await connectParent(t, w);
  await until('the next daemon to finish the move', () => moveLog(w).some((line) => line['recovered'] === true));
  const after = record(w) as ChildRecord;
  assert.equal(after.moving, undefined);
  assert.equal(after.host, 'box');
  assert.equal(after.paneId, pane.pane_id);
  assert.equal(after.cwd, boxCwd);
  assert.equal(after.exitedAt, undefined);
  assert.equal(after.movedFrom?.host, 'local');
  assert.ok(fs.existsSync(boxCopy(w, boxCwd)), 'the copy stays: it is the session that runs');
  assert.equal(harnessStarts(w.here.herdr).length, 0, 'the session never ran twice');
  assert.deepEqual(moveLog(w).map((line) => [line['outcome'], line['recovered']]), [['moved', true]]);
});

/** A record no act works on that names no pane, no exit, no mark and no crossingFailed: nothing repairs it, and nothing tells a person where the session is. */
function stranded(child: ChildRecord): boolean {
  return !child.paneId && !child.exitedAt && !child.moving && !child.crossingFailed;
}

test('a recovery whose own daemon stops before the source tab opens leaves a record doctor names, not a stranded one', async (t) => {
  let holdHere = false;
  const w = await twoMachines(t, {}, { box: (request) => request.method === 'tab.create' || request.method === 'workspace.create', here: (request) => holdHere && (request.method === 'tab.create' || request.method === 'workspace.create') });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');
  await interruptedMove(t, w, { on: 'box', methods: ['tab.create', 'workspace.create'] }, boxCwd);

  // The recovery points the record at the source and opens a tab there, which herdr holds; its daemon dies then.
  holdHere = true;
  const seen = w.here.herdr.requests.length;
  const second = await startCrossingDaemon(t, w);
  await connectParent(t, w);
  await until('the recovery to ask for a tab on the source', () => w.here.herdr.requests.slice(seen).some((request) => request.method === 'tab.create' || request.method === 'workspace.create'));
  await kill(second);

  const left = record(w) as ChildRecord;
  assert.equal(stranded(left), false, `the record names a pane, an exit, a mark or crossingFailed: ${JSON.stringify({ paneId: left.paneId, exitedAt: left.exitedAt, moving: left.moving, crossingFailed: left.crossingFailed })}`);
  assert.ok(left.exitedAt, 'with no pane, the record says the child is not running');
  assert.match(crossingLines([readParent(w.parentId)!])[0] ?? '', /^fail  crossing: worker \(child child-worker\) runs on neither machine .*Bring it back with agent_spawn with resume worker/);
});

test('a rollback whose daemon stops before the source tab opens leaves a record doctor names, not a stranded one', async (t) => {
  const w = await twoMachines(
    t,
    { box: (world, request) => (harnessStart(request) ? { error: { code: 'agent_start_failed', message: 'box would not start claude' } } : world.respond(request)) },
    // The move creates no tab on the source, so the one it asks for is the rollback's.
    { here: (request) => request.method === 'tab.create' || request.method === 'workspace.create' },
  );
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');

  const first = await startCrossingDaemon(t, w);
  const parent = await connectParent(t, w);
  const move = parent.tool('agent_move', { child: 'worker', machine: 'box', cwd: boxCwd }).catch((error: Error) => error);
  await until('the rollback to ask for a tab on the source', () => w.here.herdr.requests.some((request) => request.method === 'tab.create' || request.method === 'workspace.create'));
  await kill(first);
  await move;

  const left = record(w) as ChildRecord;
  assert.equal(left.moving, undefined, 'the rollback had put the original record back, with no mark');
  assert.equal(stranded(left), false, `the record names a pane, an exit, a mark or crossingFailed: ${JSON.stringify({ paneId: left.paneId, exitedAt: left.exitedAt, crossingFailed: left.crossingFailed })}`);
  assert.ok(left.exitedAt, 'with no pane, the record says the child is not running');
  assert.match(crossingLines([readParent(w.parentId)!])[0] ?? '', /^fail  crossing: worker \(child child-worker\) runs on neither machine .*Bring it back with agent_spawn with resume worker/);
});

test('a daemon that stops after the copy reached the destination and before its mark listed the files leaves nothing the next daemon cannot remove', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd);
  const boxCwd = dir(w.box.user, 'repo');
  // The state the carry leaves between importSession's answer and the mark that lists its files:
  // a mark at the step "checked" with no files, from a daemon that is gone, and the copy on box.
  updateChild(w.parentId, 'child-worker', (entry) => {
    const now = new Date().toISOString();
    crossingBegun(entry, { from: 'local', to: 'box', since: now, until: now, verb: 'move', daemon: 'a-daemon-that-stopped', stage: 'checked', state: 'live', source: { cwd: hereCwd, paneId: 'w1:p3', tabId: 'w1:t3', session: { kind: 'id', value: 'sess-1' } }, target: { cwd: boxCwd } });
  });
  const bundle = await w.deps.endpointFor('local').exportSession({ harness: 'claude-code', session: 'sess-1', cwd: hereCwd });
  await w.deps.endpointFor('box').importSession({ harness: 'claude-code', childId: 'child-worker', cwd: boxCwd, fileName: bundle.fileName, files: bundle.files });
  assert.ok(fs.existsSync(boxCopy(w, boxCwd)), 'the copy is on box');
  assert.deepEqual(record(w)?.moving?.files, undefined, 'and the mark names none of its files');

  const [recovery] = await recoverCrossings(w.deps, w.parentId, 'the-next-daemon');
  assert.equal(recovery?.outcome, 'undone', recovery?.detail);
  assert.equal(fs.existsSync(boxCopy(w, boxCwd)), false, 'the copy the mark never listed is gone');
  const project = path.dirname(boxCopy(w, boxCwd));
  assert.deepEqual(fs.existsSync(project) ? fs.readdirSync(project, { recursive: true }).filter((name) => !fs.statSync(path.join(project, String(name))).isDirectory()) : [], [], 'no file of the session is left on box');
  assert.equal(record(w)?.paneId, 'w1:p3', 'the child still runs on the source');
});

test('doctor fails on a child a crossing left on neither machine, and names the resume that brings it back', () => {
  const lines = crossingLines([{ children: [{ id: 'c1', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p3', host: 'local', startedAt: '', lastStatus: 'done', statusChangedAt: '', lastBusyAt: '', depth: 1, exitedAt: '2026-11-28T04:00:00.000Z', crossingFailed: { at: '2026-11-28T04:00:00.000Z', verb: 'move', from: 'local', to: 'box', stage: 'stopped', error: 'the daemon running the move stopped after the child\'s tab closed, and resuming it on this machine failed: claude would not start', sourceFile: '/s/sess-1.jsonl', reopen: 'agent_spawn with resume worker, which resumes it on this machine from /s/sess-1.jsonl', interrupted: true } }] }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^fail  crossing: worker \(child c1\) runs on neither machine/);
  assert.match(lines[0] ?? '', /Bring it back with agent_spawn with resume worker, which resumes it on this machine from \/s\/sess-1\.jsonl\./);
});
