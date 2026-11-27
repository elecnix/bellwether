// Tier 2: a spawn that resumes, adopt and machines against the fake herdr socket. Each case
// drives the tools the way the daemon does, with a herdr world behind the
// socket, and reads the registry back from a scratch home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import type { RemoteOps } from '../../src/core/remote.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Herdr {
  fake: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

async function herdr(workspace = 'w1'): Promise<Herdr> {
  const world = fakeWorld(workspace);
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  return { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

/** A scratch root for HOME, Bellwether and herdr, so no case reads the real transcripts or sockets. */
function scratch(t: test.TestContext): void {
  isolate(t, 'bellwether-shape-');
}

function parent(session: string): string {
  return saveParent(emptyParent('claude-code', session, '/work', { workspaceId: 'w1' })).id;
}

/** A child's machine that registers each Claude Code child, and writes its MCP config there. */
const farRegistry: RemoteOps = {
  register: async (_parent, child) => ({ mcpConfig: `/far/.bellwether/mcp/${child.id}.json`, toolSource: { server: 'per-child', suppressed: [] } }),
  cleanup: async () => {},
  lastMessage: async () => undefined,
};

function context(parentId: string, local: Herdr, machines: Record<string, Herdr> = {}): ToolContext {
  const watcher = new Watcher({ client: local.client, parentId, onEntries: () => {} });
  return {
    remote: farRegistry,
    client: local.client,
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return local.client;
      const machine = machines[host];
      if (!machine) throw new Error(`herdr has no saved machine ${host}`);
      return machine.client;
    },
    parentId,
    watcher,
  };
}

function exitedChild(name: string, extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: `child-${name}`,
    name,
    kind: 'claude',
    harness: 'claude-code',
    paneId: 'w1:p3',
    tabId: 'w1:t3',
    host: LOCAL_HOST,
    cwd: '/work/repo',
    startedAt: at,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    transcript: '/home/x/.claude/projects/-work-repo/sess-1.jsonl',
    depth: 1,
    exitedAt: at,
    ...extra,
  };
}

function childOf(parentId: string, name: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((child) => child.name === name);
}

test('a resumed child comes back with the same session and id, and takes a prompt', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('resume-one');
  upsertChild(id, exitedChild('worker'));

  const prompt = 'What did you tell me last time?\n\nAnswer in one line.';
  let holdDuringStart: string | undefined;
  local.world.onStart = () => {
    holdDuringStart = childOf(id, 'worker')?.startingUntil;
  };
  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  assert.match(text, /resumed session sess-1/);

  const start = local.fake.requests.find((request) => request.method === 'agent.start');
  const args = start?.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  // The prompt travels in a private file, never on the command line.
  assert.equal(args.some((arg) => arg.includes('What did you tell me')), false, 'no prompt text in the arguments');
  const pointer = args.find((arg) => arg.startsWith('@'));
  assert.ok(pointer, 'the harness gets a pointer to the brief');
  const briefFile = pointer.slice(1);
  assert.equal(fs.readFileSync(briefFile, 'utf8'), prompt);
  assert.equal(fs.statSync(briefFile).mode & 0o777, 0o600);

  // A resumed Claude child gets its own MCP server again, named by the same child id.
  const mcpFile = mcpConfigPath('child-worker');
  assert.ok(args.includes(`--mcp-config=${mcpFile}`), `no --mcp-config=${mcpFile} in ${JSON.stringify(args)}`);
  const server = (JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers['bellwether'];
  assert.deepEqual(server?.args.slice(-2), ['--child', 'child-worker']);
  const create = local.fake.requests.find((request) => request.method === 'tab.create');
  assert.equal((create?.params['env'] as Record<string, string>)['BELLWETHER_CHILD'], 'child-worker', 'the tab and the MCP file agree on the child');

  // The resumed Claude child paints the channel dialog, and the resume answers it.
  assert.ok(holdDuringStart && Date.parse(holdDuringStart) > Date.now(), 'the watcher holds the child while its dialog is answered');
  const keys = local.fake.requests.filter((request) => request.method === 'agent.send_keys');
  assert.deepEqual(keys.map((request) => request.params['keys']), [['Enter']]);

  const child = childOf(id, 'worker');
  assert.equal(child?.id, 'child-worker', 'the same child id, so its history continues');
  assert.equal(child?.exitedAt, undefined);
  assert.notEqual(child?.paneId, 'w1:p3', 'a new pane');
  assert.equal(child?.resumedAt !== undefined, true);
  const pane = local.world.panes.get(child?.paneId ?? '');
  assert.equal(pane?.agent_session?.value, 'sess-1', 'the harness reopened the same session');
  assert.equal(child?.startingUntil, undefined, 'the hold is lifted once the dialog is answered');

  // The resumed child is addressable again.
  await runBellwetherTool(context(id, local), 'agent_send', { child: 'worker', text: 'and now?' });
  const sent = local.fake.requests.find((request) => request.method === 'agent.prompt');
  assert.equal(sent?.params['target'], child?.paneId);
});

test('a pi child resumes with --session and its transcript path', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('resume-pi');
  const transcript = '/home/x/.pi/agent/sessions/--work--/2026_abc.jsonl';
  upsertChild(id, exitedChild('pi-worker', { kind: 'pi', harness: 'pi', transcript }));
  await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'pi-worker' });
  const args = local.fake.requests.find((request) => request.method === 'agent.start')?.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2), ['--session', transcript]);
});

test('a spawn that resumes refuses a harness with no resume flag', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('resume-codex');
  upsertChild(id, exitedChild('codex-worker', { kind: 'codex', harness: 'other' }));
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'codex-worker' }), /cannot resume a codex agent: only pi and claude and omp have a resume flag it knows\. Call agent_spawn without resume/);
});

test('resume takes a session no child ran, as a new child', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('resume-new');
  await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'sess-9', kind: 'claude', name: 'old-talk', cwd: '/work/repo' });
  const child = childOf(id, 'old-talk');
  assert.equal(child?.origin, 'resume');
  assert.equal(local.world.panes.get(child?.paneId ?? '')?.agent_session?.value, 'sess-9');
});

test('an adopted pane produces events for its parent and is refused to a second parent', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  local.world.add({ pane_id: 'w1:p9', agent: 'pi', name: 'hand-started', cwd: '/work/other' });
  const first = parent('adopt-first');
  const second = parent('adopt-second');

  const text = await runBellwetherTool(context(first, local), 'agent_adopt', { target: 'hand-started' });
  assert.match(text, /Adopted hand-started/);
  const child = childOf(first, 'hand-started');
  assert.equal(child?.paneId, 'w1:p9');
  assert.equal(child?.origin, 'adopt');
  assert.equal(child?.session, undefined, 'a pane herdr reports no session for has none recorded');
  assert.equal(child?.host, LOCAL_HOST);

  const entries: OutboxEntry[] = [];
  const watcher = new Watcher({ client: local.client, parentId: first, tickMs: 50, onEntries: (next) => entries.push(...next) });
  watcher.start();
  t.after(() => watcher.stop());
  const deadline = Date.now() + 3000;
  while (!local.fake.requests.some((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes('w1:p9'))) {
    if (Date.now() > deadline) throw new Error('the watcher never subscribed to the adopted pane');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  local.fake.send({ event: 'pane_exited', data: { pane_id: 'w1:p9', exit_code: 0 } });
  while (!entries.some((entry) => entry.event === 'exited' && entry.paneId === 'w1:p9')) {
    if (Date.now() > deadline) throw new Error('the adopted pane produced no event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // While the first parent still watches it, a second one is refused.
  const live = parent('adopt-third');
  local.world.add({ pane_id: 'w1:p11', agent: 'claude', name: 'shared' });
  await runBellwetherTool(context(first, local), 'agent_adopt', { target: 'w1:p11' });
  await assert.rejects(runBellwetherTool(context(second, local), 'agent_adopt', { target: 'w1:p11' }), /already a child of claude-code-adopt-first/);
  await assert.rejects(runBellwetherTool(context(live, local), 'agent_adopt', { target: 'shared' }), /already a child/);
  assert.match(await runBellwetherTool(context(first, local), 'agent_adopt', { target: 'w1:p11' }), /already a child of this session/);
});

test('adopt refuses a pane with no recognized agent', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  local.world.add({ pane_id: 'w1:p4' });
  local.world.add({ pane_id: 'w1:p5', agent: 'vim' });
  const id = parent('adopt-bare');
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_adopt', { target: 'w1:p4' }), /holds no agent herdr recognizes/);
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_adopt', { target: 'w1:p5' }), /not an agent kind Bellwether supervises/);
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_adopt', { target: 'nobody' }), /No pane or live agent/);
  assert.equal(readParent(id)?.children.length, 0);
});

test('a spawn on a machine records the host, targets that machine, and resumes there', async (t) => {
  scratch(t);
  const local = await herdr('w1');
  const remote = await herdr('w7');
  t.after(() => local.fake.stop());
  t.after(() => remote.fake.stop());
  const id = parent('machine-one');
  const ctx = context(id, local, { hawthorne: remote });

  await runBellwetherTool(ctx, 'agent_spawn', { kind: 'claude', name: 'far', cwd: '/home/far/repo', machine: 'hawthorne' });
  const child = childOf(id, 'far');
  assert.equal(child?.host, 'hawthorne');
  assert.match(child?.paneId ?? '', /^w7:/);
  const create = remote.fake.requests.find((request) => request.method === 'tab.create');
  assert.equal(create?.params['workspace_id'], null, 'the local workspace id is not sent to another machine');
  assert.equal(local.fake.requests.some((request) => request.method === 'tab.create' || request.method === 'agent.start'), false, 'nothing starts locally');
  // A server talks to the daemon on its own machine, so the child gets the
  // MCP config that machine wrote, and no file is left here.
  const remoteArgs = remote.fake.requests.find((request) => request.method === 'agent.start')?.params['args'] as string[];
  assert.ok(remoteArgs.includes(`--mcp-config=/far/.bellwether/mcp/${child?.id}.json`), `a remote child got ${JSON.stringify(remoteArgs)}`);
  assert.deepEqual(child?.toolSource, { server: 'per-child', suppressed: [] });
  assert.equal(fs.existsSync(mcpConfigPath(child?.id ?? '?')), false);

  // The watcher follows the child on its own machine.
  const watcher = new Watcher({ client: local.client, clientFor: ctx.clientFor, parentId: id, tickMs: 50, onEntries: () => {} });
  watcher.start();
  t.after(() => watcher.stop());
  const deadline = Date.now() + 3000;
  while (!remote.fake.requests.some((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(child?.paneId ?? '?'))) {
    if (Date.now() > deadline) throw new Error('the watcher never subscribed on the machine');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(local.fake.requests.some((request) => request.method === 'events.subscribe' && JSON.stringify(request.params).includes(child?.paneId ?? '?')), false);
  watcher.stop();

  // Read goes to the machine too, and a resume goes back to it.
  await runBellwetherTool(ctx, 'agent_read', { child: 'far', lines: 5 });
  assert.equal(remote.fake.requests.some((request) => request.method === 'pane.read'), true);
  // The spawn recorded the remote session, so the resume needs no transcript.
  const first = remote.world.panes.get(child?.paneId ?? '')?.agent_session?.value;
  assert.ok(first);
  assert.deepEqual(child?.session, { kind: 'id', value: first });
  assert.equal(child?.transcript, undefined, 'a remote transcript is not looked up on this disk');
  remote.world.panes.delete(child?.paneId ?? '');
  const { updateChild } = await import('../../src/core/registry.ts');
  updateChild(id, child?.id ?? '', (entry) => {
    entry.exitedAt = new Date().toISOString();
  });
  await runBellwetherTool(ctx, 'agent_spawn', { resume: 'far' });
  const resumed = childOf(id, 'far');
  assert.match(resumed?.paneId ?? '', /^w7:/);
  assert.equal(remote.world.panes.get(resumed?.paneId ?? '')?.agent_session?.value, first);
  assert.equal(local.fake.requests.some((request) => request.method === 'agent.start'), false);
});

test('a spawn on an unknown machine is refused before any record is written', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('machine-typo');
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { kind: 'pi', name: 'lost', machine: 'nowhere' }), /no saved machine nowhere/);
  assert.equal(readParent(id)?.children.length, 0);
});

test('a resume herdr refuses leaves the exited child as it was, and no brief behind', async (t) => {
  scratch(t);
  const world = fakeWorld();
  const fake = await startFakeHerdr({ respond: (request) => (request.method === 'agent.start' ? { error: { code: 'agent_start_failed', message: 'no such agent kind' } } : world.respond(request)) });
  t.after(() => fake.stop());
  const local: Herdr = { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
  const id = parent('resume-fails');
  upsertChild(id, exitedChild('worker'));
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt: 'hello' }), /no such agent kind/);
  const child = childOf(id, 'worker');
  assert.equal(child?.paneId, 'w1:p3', 'the record points at its last pane again');
  assert.ok(child?.exitedAt);
  assert.equal(child?.startingUntil, undefined);
  assert.equal(fs.existsSync(path.join(process.env['BELLWETHER_HOME'] ?? '', 'prompts', 'child-worker.md')), false);
  assert.equal(fs.existsSync(mcpConfigPath('child-worker')), false, 'a failed resume removes its MCP config');
  assert.equal(fake.requests.filter((request) => request.method === 'tab.close').length, 1, 'the new tab is closed');

  // A session no child ran leaves no record at all.
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'sess-x', kind: 'pi', name: 'stranger' }), /no such agent kind/);
  assert.equal(childOf(id, 'stranger'), undefined);
});

test('resume reads the session herdr reported, with no transcript on the record', async (t) => {
  scratch(t);
  const local = await herdr();
  t.after(() => local.fake.stop());
  const id = parent('resume-session');
  upsertChild(id, exitedChild('recorded', { transcript: undefined, session: { kind: 'id', value: 'sess-recorded' } }));
  await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'recorded' });
  const child = childOf(id, 'recorded');
  assert.equal(local.world.panes.get(child?.paneId ?? '')?.agent_session?.value, 'sess-recorded');
  assert.deepEqual(child?.session, { kind: 'id', value: 'sess-recorded' });
});
