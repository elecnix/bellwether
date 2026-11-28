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
import { crossingLines } from '../../src/core/recover-crossing.ts';
import { readParent } from '../../src/core/registry.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import type { RecordedRequest } from '../fixtures/fake-herdr.ts';
import { harnessStarts } from '../fixtures/fake-herdr.ts';
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

test('doctor fails on a child a crossing left on neither machine, and names the resume that brings it back', () => {
  const lines = crossingLines([{ children: [{ id: 'c1', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p3', host: 'local', startedAt: '', lastStatus: 'done', statusChangedAt: '', lastBusyAt: '', depth: 1, exitedAt: '2026-11-28T04:00:00.000Z', crossingFailed: { at: '2026-11-28T04:00:00.000Z', verb: 'move', from: 'local', to: 'box', stage: 'stopped', error: 'the daemon running the move stopped after the child\'s tab closed, and resuming it on this machine failed: claude would not start', sourceFile: '/s/sess-1.jsonl', reopen: 'agent_spawn with resume worker, which resumes it on this machine from /s/sess-1.jsonl', interrupted: true } }] }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^fail  crossing: worker \(child c1\) runs on neither machine/);
  assert.match(lines[0] ?? '', /Bring it back with agent_spawn with resume worker, which resumes it on this machine from \/s\/sess-1\.jsonl\./);
});
