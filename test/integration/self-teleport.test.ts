// Tier 2: a child teleports itself (issue #226), as a session restarts itself.
// The child calls agent_teleport from its own session with no child named.
// The daemon records the request, replies first, and acts once the child's
// turn ends, within the same bound a self-restart waits under. The crossing is
// carry.ts's, run as the child's parent, and the notice says the child asked
// for it. A turn that never ends, or a teleport refused at the moment it would
// run, leaves teleportStalled on the record and moves nothing.
//
// The child's parent and the child run on this machine, and the destination
// is `box`, through the fake ssh of two-machines.ts. The deferred act is
// captured, so each case awaits it.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { remoteOps } from '../../src/core/remote.ts';
import type { Inbox } from '../../src/core/send.ts';
import { armPendingTeleports, teleportLines } from '../../src/core/teleport.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { harnessStarts } from '../fixtures/fake-herdr.ts';
import { claudeHere, dir, harness, twoMachines, type TwoMachines } from '../fixtures/two-machines.ts';

const CALLER = { childId: 'child-worker', paneId: 'w1:p3' };

/** A session that takes each push at once: a read receipt, and a turn herdr reports. */
function takingInbox(w: TwoMachines, pushes: string[]): Inbox {
  const reads = new Map<string, string>();
  const inbox: Inbox = async (_parentId, child, message) => {
    pushes.push(message.text);
    setTimeout(() => {
      reads.set(message.id, new Date().toISOString());
      const m = child.host === 'box' ? w.box : w.here;
      m.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });
    }, 10).unref();
    return { delivered: true, via: 'claude-channel' };
  };
  inbox.read = (_parentId, _childId, messageId, signal) =>
    new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        const at = reads.get(messageId);
        if (at) {
          clearInterval(timer);
          resolve(at);
        }
      }, 5);
      signal.addEventListener('abort', () => {
        clearInterval(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
  inbox.turnWaitMs = 300;
  return inbox;
}

interface Room {
  w: TwoMachines;
  ctx: ToolContext;
  jobs: Promise<void>[];
  pushes: string[];
  boxCwd: string;
}

/** A child working in pane w1:p3 on this machine, its own session's context, and the deferred acts it arms. */
async function room(t: test.TestContext, deferTimeoutMs = 2_000): Promise<Room> {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd, { extra: { lastStatus: 'working' } });
  w.here.world.panes.get('w1:p3')!.agent_status = 'working';
  // The child's own session, which calls the tool, as its adapter's hello records it.
  const own = saveParent(emptyParent('claude-code', 'sess-1', hereCwd, { paneId: 'w1:p3', childId: 'child-worker', depth: 1 })).id;
  const resolve = async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true });
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: own, onEntries: () => {} });
  const jobs: Promise<void>[] = [];
  const pushes: string[] = [];
  const ctx: ToolContext = {
    client: w.here.client,
    clientFor: w.deps.clientFor,
    parentId: own,
    watcher,
    remote: remoteOps(resolve),
    endpointFor: w.deps.endpointFor,
    knownHosts: w.deps.knownHosts,
    inbox: takingInbox(w, pushes),
    restart: { deferTimeoutMs, startupTimeoutMs: 5_000, redrawMs: 20, defer: (_key, job) => jobs.push(job()) },
  };
  return { w, ctx, jobs, pushes, boxCwd: dir(w.box.user, 'repo') };
}

function record(w: TwoMachines): ChildRecord | undefined {
  return readParent(w.parentId)?.children.find((entry) => entry.id === 'child-worker');
}

/** herdr reports the child's turn over, after the deferred act has subscribed to its pane. */
async function endTurn(w: TwoMachines): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  w.here.world.panes.get('w1:p3')!.agent_status = 'idle';
  w.here.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p3', agent_status: 'idle' } });
}

test('a child that teleports itself gets the reply first, moves once its turn ends, and reads a notice that says it asked', async (t) => {
  const { w, ctx, jobs, pushes, boxCwd } = await room(t);

  const reply = await runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: boxCwd, reason: 'it needs more memory' }, CALLER);

  assert.match(reply, /^worker is teleported to machine box, directory .*\/repo, once this turn ends/);
  assert.match(reply, /within 2\.0 s/);
  assert.match(reply, /your next input there is the notice/i);
  const pending = record(w);
  assert.equal(pending?.teleportRequest?.machine, 'box');
  assert.equal(pending?.teleportRequest?.wait?.paneId, 'w1:p3');
  assert.ok(w.here.world.panes.has('w1:p3'), 'nothing moved before the turn ended');
  assert.equal(fs.existsSync(path.join(w.box.claude, 'projects')), false);
  assert.equal(jobs.length, 1, 'the act is deferred');

  await endTurn(w);
  await jobs[0];

  const moved = record(w);
  assert.equal(moved?.host, 'box');
  assert.equal(moved?.cwd, boxCwd);
  assert.equal(moved?.teleportRequest, undefined);
  assert.equal(moved?.teleportStalled, undefined);
  const entry = moved?.teleports?.at(-1);
  assert.equal(entry?.by, 'self');
  assert.equal(entry?.reason, 'it needs more memory');
  assert.equal(entry?.alive.proof, 'took-notice');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0] ?? '', /at your own request, because it needs more memory\./);
  assert.match(pushes[0] ?? '', /you prepared .*\/repo yourself before you asked/);
  assert.ok(fs.existsSync(path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl')));
});

test('a self-teleport whose turn never ends within the bound moves nothing, and says why on the record and in doctor', async (t) => {
  const { w, ctx, jobs, boxCwd } = await room(t, 300);

  await runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: boxCwd }, CALLER);
  await jobs[0];

  const after = record(w);
  assert.equal(after?.host, LOCAL_HOST);
  assert.equal(after?.teleportRequest, undefined, 'the request ends at its bound');
  assert.match(after?.teleportStalled?.reason ?? '', /did not end its turn within 0\.3 s/);
  assert.equal(after?.teleportStalled?.paneId, 'w1:p3');
  assert.ok(w.here.world.panes.has('w1:p3'));
  assert.equal(harnessStarts(w.box.herdr).length, 0);
  assert.match(teleportLines(readParent(w.parentId) ? [readParent(w.parentId)!] : []).join('\n'), /^warn  teleport: worker's request to teleport itself to machine box, made at .*, did not run: .*did not end its turn/m);
});

test('a self-teleport refused when it would run moves nothing, and the refusal goes on the record', async (t) => {
  const { w, ctx, jobs } = await room(t);
  const missing = path.join(w.box.user, 'nowhere');

  await runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: missing }, CALLER);
  await endTurn(w);
  await jobs[0];

  const after = record(w);
  assert.equal(after?.host, LOCAL_HOST);
  assert.equal(after?.teleportRequest, undefined);
  assert.match(after?.teleportStalled?.reason ?? '', /nowhere does not exist on machine box, and Bellwether does not create it/);
  assert.equal(fs.existsSync(missing), false);
});

test('a session with no child id, or an adopted child, cannot teleport itself, and nothing is recorded', async (t) => {
  const { w, ctx, jobs, boxCwd } = await room(t);
  await assert.rejects(runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: boxCwd }, {}), /needs a child, or a session Bellwether started as a child/);
  const adopted = readParent(w.parentId)!;
  saveParent({ ...adopted, children: adopted.children.map((child) => ({ ...child, origin: 'adopt' as const })) });
  await assert.rejects(runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: boxCwd }, CALLER), /worker is an adopted child/);
  assert.equal(jobs.length, 0);
  assert.equal(record(w)?.teleportRequest, undefined);
});

test('a self-teleport whose daemon stopped during the wait is armed again from the record when the session reconnects, and then runs', async (t) => {
  const { w, ctx, jobs, pushes, boxCwd } = await room(t);
  const stopped = new AbortController();
  ctx.restart = { ...ctx.restart, signal: stopped.signal };
  const subscribed = (): number => w.here.herdr.requests.filter((request) => request.method === 'events.subscribe').length;
  const before = subscribed();
  await runBellwetherTool(ctx, 'agent_teleport', { machine: 'box', cwd: boxCwd }, CALLER);
  // The daemon stops in the middle of the wait: the wait ends, and the request stays on the record.
  for (let tries = 0; subscribed() <= before && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  stopped.abort();
  await jobs[0];
  assert.equal(record(w)?.teleportRequest?.machine, 'box');
  assert.equal(record(w)?.teleportStalled, undefined);

  // The next daemon's service for the child's session arms it again.
  const remote = remoteOps(async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true }));
  const again: Promise<void>[] = [];
  const armed = armPendingTeleports({ clientFor: w.deps.clientFor, endpointFor: w.deps.endpointFor, knownHosts: w.deps.knownHosts, inbox: ctx.inbox, registerFor: (parentId) => (child, brief) => remote.register({ id: parentId }, child, brief), cleanupRemote: (child) => remote.cleanup(child) }, { childId: 'child-worker', paneId: 'w1:p3' }, { deferTimeoutMs: 2_000, startupTimeoutMs: 5_000, redrawMs: 20, defer: (_key, job) => again.push(job()) });
  assert.equal(armed, true);
  await endTurn(w);
  await again[0];
  assert.equal(record(w)?.host, 'box', JSON.stringify({ stalled: record(w)?.teleportStalled, request: record(w)?.teleportRequest }));
  assert.equal(record(w)?.teleportRequest, undefined);
  assert.match(pushes[0] ?? '', /at your own request/);
});
