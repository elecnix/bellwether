// Tier 2: agent_spawn with a resume target, against the fake herdr socket. The
// call is a message that resumes: herdr decides whether the child is alive, a
// live child gets the prompt as an ordinary message, and a retired one comes
// back in a new tab under the same child id. Each case runs in its own root,
// and fails if its herdr or daemon socket resolves to the live one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Herdr {
  fake: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

async function herdr(t: test.TestContext): Promise<Herdr> {
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { fake, world, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

function parent(session: string): string {
  return saveParent(emptyParent('claude-code', session, '/work', { workspaceId: 'w1' })).id;
}

function context(parentId: string, local: Herdr): ToolContext {
  return {
    client: local.client,
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return local.client;
      throw new Error(`herdr has no saved machine ${host}`);
    },
    parentId,
    watcher: new Watcher({ client: local.client, parentId, onEntries: () => {} }),
  };
}

function worker(extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: 'child-worker',
    name: 'worker',
    kind: 'claude',
    harness: 'claude-code',
    paneId: 'w1:p3',
    tabId: 'w1:t3',
    host: LOCAL_HOST,
    cwd: '/work/repo',
    startedAt: at,
    lastStatus: 'idle',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'id', value: 'sess-1' },
    depth: 1,
    ...extra,
  };
}

const SESSION_1 = { agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value: 'sess-1' };

function calls(fake: FakeHerdr, method: string): RecordedRequest[] {
  return fake.requests.filter((request) => request.method === method);
}

function children(id: string): ChildRecord[] {
  return readParent(id)?.children ?? [];
}

const prompt = 'Pick up where you stopped.\n\nRun the gates, then report.';

test('a live session gets the prompt as a message, with no tab and no new child', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('live');
  local.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_session: SESSION_1 });
  upsertChild(id, worker());

  for (const target of ['worker', 'child-worker', 'sess-1']) {
    local.fake.requests.length = 0;
    const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: target, prompt });
    assert.match(text, /worker is still alive in pane w1:p3, so the prompt went to it as a message, with no new tab/);
    const sent = calls(local.fake, 'agent.prompt');
    assert.deepEqual(
      sent.map((request) => request.params),
      [{ target: 'w1:p3', text: prompt }],
      `target ${target}`,
    );
    assert.equal(calls(local.fake, 'tab.create').length, 0, 'no tab');
    assert.equal(calls(local.fake, 'agent.start').length, 0, 'no start');
  }
  assert.deepEqual(
    children(id).map((child) => [child.id, child.paneId]),
    [['child-worker', 'w1:p3']],
    'the same child, in the same pane',
  );
  assert.equal(fs.existsSync(promptPath('child-worker')), false, 'a message writes no brief file');
});

test('a retired session comes back in a tab with --resume, the same child id, and its brief in a file', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('retired');
  upsertChild(id, worker({ exitedAt: new Date().toISOString(), exitCode: 0 }));

  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  assert.match(text, /worker resumed session sess-1 in pane w1:p\d+, as the same child child-worker/);
  assert.equal(calls(local.fake, 'tab.create').length, 1, 'one tab');
  assert.equal(calls(local.fake, 'agent.prompt').length, 0, 'no message to a pane that is gone');

  const args = calls(local.fake, 'agent.start')[0]?.params['args'] as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.equal(
    args.some((arg) => arg.includes('Pick up where')),
    false,
    'the prompt text never reaches the command line',
  );
  const file = promptPath('child-worker');
  assert.ok(args.includes(`@${file}`), `no pointer to ${file} in ${JSON.stringify(args)}`);
  assert.equal(fs.readFileSync(file, 'utf8'), prompt);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const [child, ...rest] = children(id);
  assert.equal(rest.length, 0, 'no second child record');
  assert.equal(child?.id, 'child-worker');
  assert.equal(child?.exitedAt, undefined);
  assert.notEqual(child?.paneId, 'w1:p3');
  assert.equal(local.world.panes.get(child?.paneId ?? '')?.agent_session?.value, 'sess-1');
});

test('two concurrent resumes of one retired child open one tab, and the loser says who is bringing it back', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('race');
  upsertChild(id, worker({ exitedAt: new Date().toISOString() }));

  const results = await Promise.allSettled([runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt: 'first' }), runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'sess-1', prompt: 'second' })]);
  const won = results.filter((result) => result.status === 'fulfilled');
  const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(won.length, 1, JSON.stringify(results));
  assert.equal(lost.length, 1);
  assert.match(String(lost[0]?.reason), /worker \(child child-worker\) is already being brought back by another call \(process \d+/);
  assert.equal(calls(local.fake, 'tab.create').length, 1, 'one tab between them');
  assert.equal(calls(local.fake, 'agent.start').length, 1);
  assert.equal(children(id).length, 1);

  // Once the winner is done, the same call finds the child alive and messages it.
  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt: 'third' });
  assert.match(text, /still alive/);
  assert.equal(calls(local.fake, 'tab.create').length, 1);
  assert.equal(calls(local.fake, 'agent.prompt').at(-1)?.params['text'], 'third');
});

test('a child whose session is alive in a pane this session did not start is refused by name', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('wrong-pane');
  local.world.add({ pane_id: 'w1:p8', agent: 'claude', name: 'by-hand', agent_session: SESSION_1 });
  upsertChild(id, worker({ exitedAt: new Date().toISOString() }));

  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt }), /worker \(child child-worker\) has its session sess-1 alive in pane w1:p8 \(by-hand\), but this session last ran it in pane w1:p3 and the registry marked it exited\. .*Adopt pane w1:p8 with agent_adopt/);
  assert.equal(calls(local.fake, 'agent.prompt').length, 0, 'nothing typed into a pane this session does not own');
  assert.equal(calls(local.fake, 'tab.create').length, 0, 'no second copy');
  assert.ok(children(id)[0]?.exitedAt, 'the record is left as it was');
});

test('a live agent that is not a child is refused, and points at agent_adopt', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('stranger');
  local.world.add({ pane_id: 'w1:p9', agent: 'pi', name: 'stranger' });
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'stranger', prompt }), /"stranger" is alive in pane w1:p9 \(stranger\) on local, but it is not a child of this session.*agent_adopt/);
  assert.equal(calls(local.fake, 'agent.prompt').length, 0);
  assert.equal(children(id).length, 0);
});

test('a target that is neither a child nor a live session asks for kind', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('unknown');
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'sess-404', prompt }), /"sess-404" is neither a child of this session nor a live session on local\. Call agent_list .* or pass kind \(claude or pi\) with resume/);
  assert.equal(children(id).length, 0);
  assert.equal(calls(local.fake, 'tab.create').length, 0);
});

test('a retired child with no recorded session is refused, naming what to pass', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('no-session');
  upsertChild(id, worker({ session: undefined, exitedAt: new Date().toISOString() }));
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt }), /worker \(child child-worker\) has no recorded session, .* Pass resume with the session id and kind/);
  assert.equal(calls(local.fake, 'tab.create').length, 0);
});

test('a spawn without resume still needs a kind and a name', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('plain');
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { name: 'x' }), /needs a kind for a new child, or resume/);
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { kind: 'pi' }), /needs a name for a new child, or resume/);
});

test('when the registry says running and herdr has no pane for the session, herdr wins and the child is resumed', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('stale-running');
  upsertChild(id, worker());

  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  assert.match(text, /^The registry still listed worker as running in pane w1:p3, but herdr shows no pane holding its session sess-1, so Bellwether treated it as retired and resumed it\./);
  assert.match(text, /resumed session sess-1/);
  assert.equal(calls(local.fake, 'tab.create').length, 1);
  assert.equal(children(id)[0]?.id, 'child-worker');
});

test('when the registry says exited and herdr shows the session in its own pane, herdr wins and the child is messaged', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('stale-exited');
  local.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_session: SESSION_1 });
  upsertChild(id, worker({ exitedAt: new Date().toISOString() }));

  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  assert.match(text, /^The registry marked worker exited, but herdr shows its session sess-1 in its own pane w1:p3, so Bellwether cleared the exit and treated it as alive\./);
  assert.equal(calls(local.fake, 'tab.create').length, 0);
  assert.equal(calls(local.fake, 'agent.prompt').length, 1);
  assert.equal(children(id)[0]?.exitedAt, undefined);
});
