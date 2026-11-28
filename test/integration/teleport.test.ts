// Tier 2: agent_teleport between two fake machines (issue #226). A teleport
// starts the agent at the destination, in a directory that exists there,
// resuming its session; proves it alive; and tells it, as a message in its
// session before its first turn, where it came from and where it is now.
//
// The session here is a fake inbox that records each push. A model that takes
// the push sends its read receipt and begins a turn, which herdr on the
// destination reports, as a real adapter and herdr do. herdr records every
// agent.prompt, so a case knows nothing was typed.
import { briefAdded } from '../../src/core/delivery.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promptPath } from '../../src/core/paths.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { readParent, updateChild } from '../../src/core/registry.ts';
import type { Inbox } from '../../src/core/send.ts';
import { TeleportFailedError, TeleportRefusedError, teleportChild, teleportLogPath, type TeleportDeps } from '../../src/core/teleport.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { harnessStart, harnessStarts } from '../fixtures/fake-herdr.ts';
import { claudeHere, dir, harness, twoMachines, type TwoMachines } from '../fixtures/two-machines.ts';

interface Push {
  id: string;
  host: string;
  paneId: string;
  text: string;
  /** How many harness starts the destination's herdr had seen when the push came. */
  startsBefore: number;
}

/** A session that records each push and, when `take` says so, reads it and begins a turn on it. */
function fakeSession(w: TwoMachines, take: boolean): { inbox: Inbox; pushes: Push[] } {
  const pushes: Push[] = [];
  const reads = new Map<string, string>();
  const inbox: Inbox = async (_parentId, child, message) => {
    const m = child.host === 'box' ? w.box : w.here;
    pushes.push({ id: message.id, host: child.host ?? LOCAL_HOST, paneId: child.paneId, text: message.text, startsBefore: harnessStarts(m.herdr).length });
    if (take) {
      setTimeout(() => {
        reads.set(message.id, new Date().toISOString());
        const pane = m.world.panes.get(child.paneId);
        if (pane) pane.agent_status = 'working';
        m.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });
      }, 10).unref();
    }
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
  return { inbox, pushes };
}

function deps(w: TwoMachines, inbox: Inbox | undefined, inbound?: TeleportDeps['inbound']): TeleportDeps {
  return { ...w.deps, inbox, by: w.parentId, from: 'your parent', ...(inbound ? { inbound } : {}) };
}

function record(w: TwoMachines): ChildRecord | undefined {
  return readParent(w.parentId)?.children.find((entry) => entry.id === 'child-worker');
}

function teleportLog(): Record<string, unknown>[] {
  if (!fs.existsSync(teleportLogPath())) return [];
  return fs.readFileSync(teleportLogPath(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function typed(w: TwoMachines): number {
  return [...w.here.herdr.requests, ...w.box.herdr.requests].filter((request) => request.method === 'agent.prompt').length;
}

test('a live child crosses to the other machine, resumes its session there, and takes the notice as its first input, with nothing typed', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'Source', 'repo', 'main');
  claudeHere(w, hereCwd);
  const session = fakeSession(w, true);

  const result = await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd, reason: 'it needs more memory' });

  assert.equal(result.state, 'live');
  assert.deepEqual(result.from, { host: LOCAL_HOST, cwd: hereCwd });
  assert.deepEqual(result.to, { host: 'box', cwd: boxCwd });
  const moved = record(w);
  assert.equal(moved?.id, 'child-worker');
  assert.equal(moved?.host, 'box');
  assert.equal(moved?.cwd, boxCwd);
  assert.match(moved?.paneId ?? '', /^w9:/);
  assert.equal(moved?.exitedAt, undefined);
  assert.equal(moved?.moving, undefined);
  assert.equal(moved?.movedFrom?.host, LOCAL_HOST, 'the relay drains the machine it left once more');
  assert.equal(w.here.world.panes.has('w1:p3'), false, 'the source tab is closed');
  const copied = path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl');
  assert.equal(result.sessionFile, copied);

  // One push, into the new pane on the destination, after the harness started there.
  assert.equal(session.pushes.length, 1, session.pushes.map((push) => push.text).join('\n---\n'));
  const [notice] = session.pushes;
  assert.equal(notice?.host, 'box');
  assert.equal(notice?.paneId, moved?.paneId);
  assert.ok((notice?.startsBefore ?? 0) >= 1, 'the notice went to a harness already started');
  assert.ok(notice?.text.includes(`teleported from machine ${os.hostname()}, directory ${hereCwd}, to machine box, directory ${boxCwd}`), notice?.text);
  assert.match(notice?.text ?? '', /because it needs more memory/);
  assert.equal(typed(w), 0, 'nothing was typed into a pane');

  // The record says where it went, what it was told, and how Bellwether knows it runs.
  const entry = moved?.teleports?.at(-1);
  assert.equal(entry?.state, 'live');
  assert.equal(entry?.by, w.parentId, 'the record keeps who asked by id, not the phrase the child reads');
  assert.match(notice?.text ?? '', /at your parent's request, because it needs more memory/);
  assert.doesNotMatch(notice?.text ?? '', /claude-code-|pi session/);
  assert.equal(entry?.reason, 'it needs more memory');
  assert.deepEqual(entry?.from, { host: LOCAL_HOST, cwd: hereCwd, paneId: 'w1:p3' });
  assert.deepEqual(entry?.to, { host: 'box', cwd: boxCwd, paneId: moved?.paneId });
  assert.equal(entry?.notice.message, notice?.id);
  assert.ok(entry?.notice.takenAt, JSON.stringify(entry?.notice));
  assert.equal(entry?.notice.undelivered, undefined);
  assert.equal(entry?.alive.proof, 'took-notice');
  assert.equal(result.notice.takenAt, entry?.notice.takenAt);
  const [line] = teleportLog();
  assert.equal(line?.['outcome'], 'teleported');
  assert.equal(line?.['state'], 'live');
  assert.equal(line?.['to'], 'box');
});

test('a stopped child crosses without a stop, starts at the destination at once, and its notice says it was stopped', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'repo');
  claudeHere(w, hereCwd, { stopped: true });
  const session = fakeSession(w, true);

  const result = await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd });

  assert.equal(result.state, 'stopped');
  assert.equal(w.here.herdr.requests.filter((request) => request.method === 'tab.close' || request.method === 'pane.close').length, 0, 'a stopped child has nothing to stop');
  const moved = record(w);
  assert.equal(moved?.host, 'box');
  assert.equal(moved?.exitedAt, undefined, 'it runs at the destination now');
  assert.equal(harnessStarts(w.box.herdr).length, 1);
  assert.equal(session.pushes.length, 1);
  assert.match(session.pushes[0]?.text ?? '', /You were stopped/);
  assert.equal(moved?.teleports?.at(-1)?.state, 'stopped');
  assert.equal(typed(w), 0);
});

test('an unread brief rides behind the notice in the same message, so the notice is still the first thing the session reads', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'repo');
  claudeHere(w, hereCwd);
  const file = promptPath('child-worker', 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'Rebase the branch on main.', { mode: 0o600 });
  updateChild(w.parentId, 'child-worker', (entry) => {
    briefAdded(entry, [], { n: 1, file, at: new Date().toISOString() });
  });
  const session = fakeSession(w, true);

  await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd });

  assert.equal(session.pushes.length, 1, 'one message, not two');
  const text = session.pushes[0]?.text ?? '';
  const notice = text.indexOf('teleported from');
  const brief = text.indexOf('Rebase the branch on main.');
  assert.ok(notice >= 0 && brief > notice, text);
});

test('a start that succeeds with a notice the session never takes keeps the agent running at the destination, types nothing, and records the notice as undelivered', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'repo');
  claudeHere(w, hereCwd);
  const session = fakeSession(w, false);

  const result = await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd });

  const moved = record(w);
  assert.equal(moved?.host, 'box', 'no rollback: the session is intact and live at the destination');
  assert.equal(moved?.exitedAt, undefined);
  assert.ok(w.box.world.panes.get(moved?.paneId ?? '')?.agent, 'its pane on the destination still runs it');
  assert.equal(typed(w), 0, 'the notice is never typed');
  assert.equal(result.notice.takenAt, undefined);
  assert.match(result.notice.undelivered ?? '', /did not read it and begin a turn on it/);
  const entry = moved?.teleports?.at(-1);
  assert.match(entry?.notice.undelivered ?? '', /did not read it and begin a turn on it/);
  assert.equal(entry?.alive.proof, 'detected', 'herdr saw the session start, which is the weaker proof');
  assert.equal(teleportLog()[0]?.['outcome'], 'teleported-untold');
});

test('a destination start that fails puts a live child back on its source, from its own session, and tells it nothing', async (t) => {
  const refuse = (_world: unknown, request: Parameters<typeof harnessStart>[0]) => (harnessStart(request) !== undefined ? { error: { code: 'agent_start_failed', message: 'claude would not start' } } : undefined);
  const w = await twoMachines(t, { box: refuse });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  claudeHere(w, hereCwd);
  const session = fakeSession(w, true);

  const failure = await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: dir(w.box.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportFailedError, String(failure));
  assert.match(failure.message, /rolled it back: worker runs again on this machine in pane w1:p\d+/);
  const back = record(w);
  assert.equal(back?.host, LOCAL_HOST);
  assert.equal(back?.cwd, hereCwd);
  assert.equal(back?.exitedAt, undefined);
  assert.equal(back?.moving, undefined);
  assert.equal(back?.teleports, undefined, 'a teleport that did not happen is not on the record');
  assert.ok(w.here.world.panes.get(back?.paneId ?? '')?.agent, 'the child runs in a new pane on the source');
  assert.equal(session.pushes.length, 0, 'an agent that never left is not told it was teleported');
  assert.equal(teleportLog()[0]?.['outcome'], 'rolled-back');
});

test('a destination start that fails leaves a stopped child stopped, with its record unchanged', async (t) => {
  const refuse = (_world: unknown, request: Parameters<typeof harnessStart>[0]) => (harnessStart(request) !== undefined ? { error: { code: 'agent_start_failed', message: 'claude would not start' } } : undefined);
  const w = await twoMachines(t, { box: refuse });
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  const hereCwd = dir(w.here.user, 'src', 'repo');
  const boxCwd = dir(w.box.user, 'repo');
  claudeHere(w, hereCwd, { stopped: true });
  const before = record(w);
  const session = fakeSession(w, true);

  const failure = await teleportChild(deps(w, session.inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportFailedError, String(failure));
  assert.match(failure.message, /claude would not start/);
  assert.match(failure.message, /worker stays stopped on this machine/);
  const after = record(w);
  assert.equal(after?.host, LOCAL_HOST);
  assert.equal(after?.exitedAt, before?.exitedAt);
  assert.equal(after?.cwd, hereCwd);
  assert.equal(after?.moving, undefined);
  assert.equal(harnessStarts(w.here.herdr).length, 0, 'a stopped child is not started on its source');
  assert.equal(fs.existsSync(path.join(w.box.claude, 'projects', claudeProjectDir(fs.realpathSync(boxCwd)), 'sess-1.jsonl')), false, 'the copy at the destination is removed');
  assert.equal(session.pushes.length, 0);
  assert.equal(teleportLog()[0]?.['outcome'], 'abandoned');
});

/** A refused teleport touches nothing: the child still runs where it was, and nothing was copied. */
function untouched(w: TwoMachines): void {
  assert.ok(w.here.world.panes.has('w1:p3'), 'the child still runs');
  assert.equal(w.here.herdr.requests.filter((request) => request.method === 'tab.close').length, 0);
  assert.equal(harnessStarts(w.box.herdr).length, 0);
  assert.equal(fs.existsSync(path.join(w.box.claude, 'projects')), false, 'nothing was copied');
  assert.equal(record(w)?.host, LOCAL_HOST);
  assert.equal(record(w)?.teleports, undefined);
}

test('contract 1: a destination directory that does not exist is refused, and Bellwether does not create it', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const missing = path.join(w.box.user, 'nowhere');
  const failure = await teleportChild(deps(w, fakeSession(w, true).inbox), w.parentId, { child: 'worker', machine: 'box', cwd: missing }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportRefusedError, String(failure));
  assert.match(failure.message, /nowhere does not exist on machine box/);
  assert.match(failure.message, /Bellwether does not create it/);
  assert.equal(fs.existsSync(missing), false);
  untouched(w);
});

test('contract 2: a destination harness older than the one that wrote the session is refused', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.290' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const failure = await teleportChild(deps(w, fakeSession(w, true).inbox), w.parentId, { child: 'worker', machine: 'box', cwd: dir(w.box.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportRefusedError, String(failure));
  assert.match(failure.message, /claude 2\.1\.290 on machine box is older than claude 2\.1\.300/);
  untouched(w);
});

test('contract 3: a destination with no inbound path for the notice is refused before anything moves', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const inbound: TeleportDeps['inbound'] = async (host) => (host === 'box' ? 'the Bellwether on machine box runs 0.1.7, which predates relay-message, brought by 0.1.8' : undefined);
  const failure = await teleportChild(deps(w, fakeSession(w, true).inbox, inbound), w.parentId, { child: 'worker', machine: 'box', cwd: dir(w.box.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportRefusedError, String(failure));
  assert.match(failure.message, /no inbound path into worker's claude-code session on machine box/);
  assert.match(failure.message, /predates relay-message/);
  untouched(w);

  // A caller with no way into any session at all is refused the same way.
  const bare = await teleportChild(deps(w, undefined), w.parentId, { child: 'worker', machine: 'box', cwd: dir(w.box.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(bare instanceof TeleportRefusedError, String(bare));
  assert.match(bare.message, /no inbound path/);
  untouched(w);
});

test('contract 4: an adopted child is refused by name, with the issue that lifts the refusal', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.332' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'), { extra: { origin: 'adopt' } });
  const failure = await teleportChild(deps(w, fakeSession(w, true).inbox), w.parentId, { child: 'worker', machine: 'box', cwd: dir(w.box.user, 'repo') }).catch((error: unknown) => error);
  assert.ok(failure instanceof TeleportRefusedError, String(failure));
  assert.match(failure.message, /worker is an adopted child/);
  assert.match(failure.message, /issues\/219/);
  untouched(w);
});

test('agent_teleport through the tool list replies first with whether the child was told, then with what crossed and what stayed', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'), { stopped: true });
  const boxCwd = dir(w.box.user, 'repo');
  const session = fakeSession(w, true);
  const watcher = new Watcher({ client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, onEntries: () => {} });
  const resolve = async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true });
  const reply = await runBellwetherTool(
    { client: w.here.client, clientFor: w.deps.clientFor, parentId: w.parentId, watcher, remote: remoteOps(resolve), endpointFor: w.deps.endpointFor, knownHosts: w.deps.knownHosts, inbox: session.inbox },
    'agent_teleport',
    { child: 'worker', cwd: boxCwd, reason: 'the old machine is going down' },
  );
  const [first, ...rest] = reply.split('\n');
  assert.match(first ?? '', /^worker teleported from this machine to machine box, as the same child child-worker, .* its model read the notice and began a turn on it/);
  assert.match(rest.join('\n'), /worker was stopped on this machine, which agent_move refuses, and it runs now/);
  assert.match(rest.join('\n'), /The worktree, the shell jobs and any file outside the session stayed on this machine/);
  assert.match(session.pushes[0]?.text ?? '', /because the old machine is going down/);
  assert.equal(record(w)?.host, 'box');
});

test('a first notice copy that never enters the session is sent again, and the copy the session takes is its first input, with nothing before it', async (t) => {
  const w = await twoMachines(t);
  harness(w.here, { claude: '2.1.300' });
  harness(w.box, { claude: '2.1.300' });
  claudeHere(w, dir(w.here.user, 'src', 'repo'));
  const boxCwd = dir(w.box.user, 'repo');
  // The adapter receives every push, but the first never reaches the model,
  // as the real crossing saw: no read receipt and no turn for it.
  const pushes: Push[] = [];
  const entered: string[] = [];
  const reads = new Map<string, string>();
  const inbox: Inbox = async (_parentId, child, message) => {
    pushes.push({ id: message.id, host: child.host ?? LOCAL_HOST, paneId: child.paneId, text: message.text, startsBefore: harnessStarts(w.box.herdr).length });
    if (pushes.length > 1) {
      setTimeout(() => {
        entered.push(message.id);
        reads.set(message.id, new Date().toISOString());
        w.box.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: child.paneId, agent_status: 'working' } });
      }, 10).unref();
    }
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

  const result = await teleportChild(deps(w, inbox), w.parentId, { child: 'worker', machine: 'box', cwd: boxCwd });

  assert.equal(pushes.length, 2, 'the notice went once more after the first copy was not taken');
  assert.ok(pushes.every((push) => /teleported from/.test(push.text)), 'both copies are the notice');
  // The property: the first input the session takes is the notice, and nothing entered before it.
  assert.deepEqual(entered, [pushes[1]?.id]);
  assert.equal(result.notice.message, pushes[1]?.id, 'the record names the copy the session took');
  assert.ok(result.notice.takenAt);
  assert.equal(record(w)?.teleports?.at(-1)?.alive.proof, 'took-notice');
  assert.equal(typed(w), 0, 'neither copy was typed');
});
