// Tier 2: a session whose pane is gone comes back from its own record (issue
// #187). A scripted herdr closes the pane a session ran in, and with it the
// workspace; doctor names the session, its last pane and what became of it;
// `bellwether resume` through the daemon opens a tab in the session's folder
// and starts the harness on the session file. A record whose session file is
// gone, a folder that is gone and a session that already runs are refused by
// name, with nothing opened. agent_list names how an exited child's pane
// ended, and agent_restart refuses a session running in a pane its record
// does not name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { goneSessionLines, herdrView } from '../../src/core/pane-fate.ts';
import { parentId as registryId } from '../../src/core/paths.ts';
import { emptyParent, listParents, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { resumeSession } from '../../src/core/session-resume.ts';
import { hostName } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, ParentRecord } from '../../src/core/types.ts';
import { DaemonClient, daemonResume } from '../../src/daemon/client.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, harnessStarts } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Rig {
  fake: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

/** A herdr that closes a workspace with its last pane, as the real one does. */
async function herdr(t: test.TestContext, workspace = 'w74'): Promise<Rig> {
  const world = fakeWorld(workspace, { closeEmptyWorkspaces: true });
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

/** The pane disappears the way a failed self-restart leaves it: herdr closes it, and its workspace goes with it. */
function closePane(rig: Rig, paneId: string): void {
  rig.world.panes.delete(paneId);
  rig.fake.send({ event: 'pane_closed', data: { pane_id: paneId } });
}

function calls(fake: FakeHerdr, method: string): number {
  return fake.requests.filter((request) => request.method === method).length;
}

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A pi session file under the case's own pi directory, named the way pi names it. */
function piSessionFile(root: string, session: string): string {
  const dir = path.join(root, '.pi', 'agent', 'sessions', 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-28T01-00-00_${session}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

function folder(root: string, name = 'repo'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('a session whose pane and workspace herdr closed is named by doctor, and resume brings it back from its record', async (t) => {
  const { root, home } = isolate(t, 'bellwether-resume-');
  const rig = await herdr(t);
  const session = '019ac1d2-7c4f-7700-b9d6-5ed4a695d25a';
  const file = piSessionFile(root, session);
  const cwd = folder(root);
  const id = registryId('pi', session);
  rig.world.add({ pane_id: 'w74:p1', tab_id: 'w74:t1', workspace_id: 'w74', agent: 'pi', name: 'lead', label: 'lead', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: file }, cwd });
  // A record that still names the pane the session ran in before a hand resume.
  saveParent(emptyParent('pi', session, cwd, { host: hostName(), paneId: 'w9:p2', workspaceId: 'w9' }));

  const daemon = await startDaemon({ socketPath: path.join(home, 'daemon.sock'), home, idleMs: 300_000 });
  t.after(() => daemon.close());
  const adapter = await DaemonClient.connect({ harness: 'pi', session, cwd, host: hostName(), paneId: 'w74:p1', workspaceId: 'w74', depth: 0, herdrSocket: rig.fake.socketPath }, { socketPath: daemon.socketPath, home, spawn: false });
  assert.equal(readParent(id)?.paneId, 'w74:p1', 'the hello moves the record to the pane the session runs in');
  assert.equal(readParent(id)?.workspaceId, 'w74');

  // The pane goes, the adapter in it goes with it, and herdr removes the empty workspace.
  closePane(rig, 'w74:p1');
  await adapter.close();
  const left = await until('the record to say the session left', () => readParent(id)?.disconnectedAt);

  const view = await herdrView(rig.client);
  assert.ok(view);
  const lines = goneSessionLines(listParents(), view, { connected: new Set(), now: Date.now(), isLocal: () => true });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.equal(lines[0], `info  session ${id} (pi session ${session}, folder ${cwd}): last pane w74:p1 closed, and herdr removed its workspace w74; its Bellwether connection closed at ${left}. Resume it with \`bellwether resume ${id}\`.`);

  const text = await daemonResume({ target: id, herdrSocket: rig.fake.socketPath }, { socketPath: daemon.socketPath, home, spawn: false });
  const record = readParent(id) as ParentRecord;
  const newPane = record.paneId ?? '';
  assert.ok(newPane && newPane !== 'w74:p1', `the record names the new pane: ${newPane}`);
  const pane = rig.world.panes.get(newPane);
  assert.equal(pane?.agent_session?.value, file, 'the new pane holds the same session');
  const args = harnessStarts(rig.fake).at(-1)?.args ?? [];
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', file], 'pi starts on the session file');
  assert.equal(pane?.cwd, cwd, 'in the folder on the record');
  const created = rig.fake.requests.find((request) => request.method === 'workspace.create');
  assert.ok(created, 'herdr removed workspace w74, so the session gets a new one');
  assert.equal(pane?.workspace_id, record.workspaceId);
  assert.equal(record.label, `repo-${session.slice(-6)}`, 'a label that tells two sessions in one folder apart');
  assert.match(text, new RegExp(`^Resumed session ${id} in folder ${cwd.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: started pi in pane ${newPane}, tab [^ ]+ \\(repo-${session.slice(-6)}\\), workspace ${record.workspaceId}, a new workspace, because herdr removed workspace w74, with --session `));
  assert.match(text, /Its last pane was w74:p1\. herdr reports the same session in the new pane\./);
  assert.match(text, new RegExp(`herdr link: https://herdr\\.invalid/v1/pane/${newPane}$`));

  const after = await herdrView(rig.client);
  assert.ok(after);
  assert.deepEqual(goneSessionLines(listParents(), after, { connected: new Set(), now: Date.now(), isLocal: () => true }), [], 'doctor no longer names a session that runs');
});

test('a record whose session file is gone is refused by name, and nothing opens', async (t) => {
  const { root } = isolate(t, 'bellwether-resume-');
  const rig = await herdr(t);
  const cwd = folder(root);
  const id = saveParent(emptyParent('claude-code', 'gone-session', cwd, { host: hostName(), paneId: 'w74:p1', workspaceId: 'w74' })).id;

  await assert.rejects(resumeSession(rig.client, id), (error: Error) => {
    assert.match(error.message, new RegExp(`^session ${id} names claude-code session gone-session, and its session file is gone \\(Claude Code has not written [^)]*gone-session\\.jsonl[^)]*\\), so there is nothing to resume\\.`));
    return true;
  });
  assert.equal(calls(rig.fake, 'tab.create'), 0);
  assert.equal(calls(rig.fake, 'workspace.create'), 0);
  assert.equal(harnessStarts(rig.fake).length, 0);
});

test('a folder that is gone, a session that already runs and an unknown target are refused, and nothing opens', async (t) => {
  const { root } = isolate(t, 'bellwether-resume-');
  const rig = await herdr(t);
  const running = 'running-session';
  const runningFile = piSessionFile(root, running);
  const cwd = folder(root);
  const runningId = saveParent(emptyParent('pi', running, cwd, { host: hostName(), paneId: 'w74:p1', workspaceId: 'w74' })).id;
  rig.world.add({ pane_id: 'w74:p4', tab_id: 'w74:t4', workspace_id: 'w74', agent: 'pi', agent_status: 'idle', agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: runningFile } });
  const lost = 'lost-folder-session';
  piSessionFile(root, lost);
  const lostId = saveParent(emptyParent('pi', lost, path.join(root, 'removed-worktree'), { host: hostName(), paneId: 'w74:p2', workspaceId: 'w74' })).id;

  await assert.rejects(resumeSession(rig.client, runningId), new RegExp(`^ResumeRefused: session ${runningId} already runs in pane w74:p4 \\(workspace w74\\), so Bellwether opened nothing`));
  await assert.rejects(resumeSession(rig.client, lostId), new RegExp(`ran in folder ${path.join(root, 'removed-worktree').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}, which is gone`));
  await assert.rejects(resumeSession(rig.client, 'no-such-session'), /No Bellwether record names "no-such-session"/);
  // A session named by its session id, or by the pane it last ran in, resolves to its record.
  await assert.rejects(resumeSession(rig.client, running), /already runs in pane w74:p4/);
  await assert.rejects(resumeSession(rig.client, 'w74:p2'), /which is gone/);
  assert.equal(calls(rig.fake, 'tab.create'), 0);
  assert.equal(harnessStarts(rig.fake).length, 0);
});

test('a session that is a child of a parent here is sent to its parent\'s resume, which keeps its child id', async (t) => {
  const { root } = isolate(t, 'bellwether-resume-');
  const rig = await herdr(t);
  const session = 'child-session';
  piSessionFile(root, session);
  const cwd = folder(root);
  const lead = saveParent(emptyParent('claude-code', 'lead-session', cwd, { host: hostName(), paneId: 'w74:p1', workspaceId: 'w74' })).id;
  const at = new Date().toISOString();
  upsertChild(lead, { id: 'child-scribe', name: 'scribe', kind: 'pi', harness: 'pi', paneId: 'w74:p2', workspaceId: 'w74', host: LOCAL_HOST, origin: 'spawn', cwd, startedAt: at, lastStatus: 'unknown', statusChangedAt: at, lastBusyAt: at, exitedAt: at, session: { kind: 'id', value: session }, depth: 1 });
  const id = saveParent(emptyParent('pi', session, cwd, { host: hostName(), paneId: 'w74:p2', workspaceId: 'w74', childId: 'child-scribe', depth: 1 })).id;

  await assert.rejects(resumeSession(rig.client, id), new RegExp(`^ResumeRefused: session ${id} is scribe \\(child child-scribe\\) of session ${lead}, so a resume by its own record would bring it back without its child id`));
  assert.equal(calls(rig.fake, 'tab.create'), 0);
  const view = await herdrView(rig.client);
  assert.ok(view);
  const line = goneSessionLines(listParents(), view, { connected: new Set(), now: Date.now(), isLocal: () => true }).find((entry) => entry.includes(id)) ?? '';
  assert.match(line, new RegExp(`last pane w74:p2 closed, and herdr removed its workspace w74\\. It is scribe \\(child child-scribe\\) of session ${lead}, which brings it back with agent_spawn and resume scribe, keeping its child id\\.$`));
});

test('agent_restart refuses a session that runs in a pane its record does not name, and closes nothing', async (t) => {
  isolate(t, 'bellwether-resume-');
  const rig = await herdr(t, 'w1');
  saveParent(emptyParent('claude-code', 'moved-session', '/work', { host: hostName(), paneId: 'w1:p7', workspaceId: 'w1' }));
  rig.world.add({ pane_id: 'w1:p7', tab_id: 'w1:t7', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'someone-else' } });
  rig.world.add({ pane_id: 'w1:p9', tab_id: 'w1:t9', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'moved-session' } });
  const caller = saveParent(emptyParent('claude-code', 'caller', '/work', { host: hostName(), workspaceId: 'w1' })).id;
  const ctx: ToolContext = { client: rig.client, clientFor: async () => rig.client, parentId: caller, watcher: new Watcher({ client: rig.client, parentId: caller, onEntries: () => {} }), restart: { waitTimeoutMs: 300 } };

  await assert.rejects(runBellwetherTool(ctx, 'agent_restart', { target: 'moved-session' }), /session claude-code-moved-session already runs in pane w1:p9 \(workspace w1\), not in pane w1:p7 that its record names, so agent_restart closed nothing and started nothing/);
  assert.equal(calls(rig.fake, 'pane.close'), 0);
  assert.equal(calls(rig.fake, 'tab.create'), 0);
});

test('agent_list names how an exited child\'s pane ended, and that herdr removed its workspace', async (t) => {
  isolate(t, 'bellwether-resume-');
  const rig = await herdr(t, 'w1');
  rig.world.add({ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' });
  rig.world.add({ pane_id: 'w5:p1', tab_id: 'w5:t1', workspace_id: 'w5', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-1' } });
  const id = saveParent(emptyParent('claude-code', 'lister', '/work', { host: hostName(), paneId: 'w1:p1', workspaceId: 'w1' })).id;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const child: ChildRecord = { id: 'child-worker', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w5:p1', tabId: 'w5:t1', workspaceId: 'w5', host: LOCAL_HOST, origin: 'spawn', cwd: '/work/repo', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, session: { kind: 'id', value: 'sess-1' }, depth: 1 };
  upsertChild(id, child);
  const watcher = new Watcher({ client: rig.client, parentId: id, onEntries: () => {} });
  watcher.start();
  t.after(() => watcher.stop());
  await rig.fake.waitFor('events.subscribe');

  closePane(rig, 'w5:p1');
  const ended = await until('the watcher to record how the pane ended', () => readParent(id)?.children[0]?.paneEnd);
  assert.equal(ended.how, 'closed');
  assert.equal(ended.pane, 'w5:p1');
  assert.equal(ended.workspaceId, 'w5');

  const ctx: ToolContext = { client: rig.client, clientFor: async () => rig.client, parentId: id, watcher };
  const text = await runBellwetherTool(ctx, 'agent_list', {});
  const row = text.split('\n').find((line) => line.startsWith('worker\t')) ?? '';
  assert.match(text, /\tcwd\tlast pane\n/, 'the header names the column');
  assert.match(row, new RegExp(`^worker\\tclaude\\tbare\\texited\\t.*\\t/work/repo\\tpane w5:p1 closed at ${ended.at.replace(/[.]/g, '\\.')}, and herdr removed its workspace w5$`));
});
