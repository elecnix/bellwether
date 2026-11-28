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
import { startFakeHerdr, type FakeHerdr, type RecordedRequest, harnessStarts } from '../fixtures/fake-herdr.ts';
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
    assert.equal(harnessStarts(local.fake).length, 0, 'no start');
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
  upsertChild(id, worker({ exitedAt: new Date().toISOString(), exitCode: 0, harnessSeenAt: new Date().toISOString(), harnessEnded: 'in-pane' }));

  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  assert.match(text, /worker resumed session sess-1 in pane w1:p\d+, as the same child child-worker/);
  assert.equal(calls(local.fake, 'tab.create').length, 1, 'one tab');
  const newPane = children(id)[0]?.paneId;
  assert.notEqual(newPane, 'w1:p3');
  // The brief is typed into the new pane once, and nothing goes to the pane that is gone.
  assert.deepEqual(calls(local.fake, 'agent.prompt').map((request) => [request.params['target'], request.params['text']]), [[newPane, prompt]]);

  const args = harnessStarts(local.fake)[0]?.args as string[];
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.equal(
    args.some((arg) => arg.includes('Pick up where')),
    false,
    'the prompt text never reaches the command line',
  );
  const file = promptPath('child-worker');
  assert.ok(!args.some((arg) => arg.includes(file)), `the launch line points at ${file}: ${JSON.stringify(args)}`);
  assert.equal(fs.readFileSync(file, 'utf8'), prompt);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const [child, ...rest] = children(id);
  assert.equal(rest.length, 0, 'no second child record');
  assert.equal(child?.id, 'child-worker');
  assert.equal(child?.exitedAt, undefined);
  // The new harness is checked once after its start window, as a new child's is.
  assert.equal(child?.harnessSeenAt, undefined);
  assert.equal(child?.harnessEnded, undefined);
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
  assert.equal(harnessStarts(local.fake).length, 1);
  assert.equal(children(id).length, 1);

  // Once the winner is done, the same call finds the child alive and messages it.
  const text = await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt: 'third' });
  assert.match(text, /still alive/);
  assert.equal(calls(local.fake, 'tab.create').length, 1);
  assert.equal(calls(local.fake, 'agent.prompt').at(-1)?.params['text'], 'third');
});

// SessionOnePane in model/Claims.tla (issue #211, item 8): a parent that knows the
// session as its child locks the child id, and one that does not locks the
// session, so before the session lock the two never met.
test('two parents that resume one session at once, one that knows it as its child and one that names it by id, start it in one pane', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const knows = parent('knows');
  const stranger = parent('stranger');
  upsertChild(knows, worker({ exitedAt: new Date().toISOString() }));

  const results = await Promise.allSettled([
    runBellwetherTool(context(knows, local), 'agent_spawn', { resume: 'worker', prompt: 'from the parent that knows it' }),
    runBellwetherTool(context(stranger, local), 'agent_spawn', { resume: 'sess-1', kind: 'claude', name: 'stray', cwd: '/work/repo', prompt: 'from a parent that does not' }),
  ]);
  const holding = [...local.world.panes.values()].filter((pane) => pane.agent_session?.value === 'sess-1').map((pane) => pane.pane_id);
  assert.equal(holding.length, 1, `session sess-1 runs in ${holding.length} panes (${holding.join(', ')}); results: ${JSON.stringify(results.map((result) => result.status))}`);
  assert.equal(harnessStarts(local.fake).length, 1);
  const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(lost.length, 1, JSON.stringify(results));
  assert.match(String(lost[0]?.reason), /Session sess-1 is already being brought back by another call \(process \d+/);
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
  await assert.rejects(runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'sess-404', prompt }), /"sess-404" is neither a child of this session nor a live session on local\. Call agent_list .* or pass kind \(pi or claude or codex or kilo or omp\) with resume/);
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

// Issue #256, and OneSessionPerId, IdStableBySession and IdStableInPane in
// model/Claims.tla: a resume starts the harness in a tab Bellwether opened, with
// the child id in its own adapter, so the parent holds the child as one it
// started. A /clear there is the same child under a new session, not an exit.
test('an adopted child brought back by a resume takes a new session in its pane under its own id, as a child Bellwether started does', async (t) => {
  isolate(t, 'bellwether-resume-');
  const local = await herdr(t);
  const id = parent('resumed-adoption');
  upsertChild(id, worker({ origin: 'adopt', exitedAt: new Date().toISOString(), harnessSeenAt: new Date().toISOString(), harnessEnded: 'in-pane' }));

  await runBellwetherTool(context(id, local), 'agent_spawn', { resume: 'worker', prompt });
  const resumed = children(id)[0] as ChildRecord;
  assert.equal(resumed.origin, 'adopt', 'the record keeps how the child first came to the parent');

  const published: string[] = [];
  const watcher = new Watcher({ client: local.client, parentId: id, onEntries: (entries) => published.push(...entries.map((entry) => entry.event)), tickMs: 60_000, screenPollMs: 0 });
  t.after(() => watcher.stop());
  local.fake.requests.length = 0;
  watcher.start();
  await local.fake.waitFor('events.subscribe');

  // A /clear: the same process, a new session.
  const pane = local.world.panes.get(resumed.paneId)!;
  pane.agent_session = { ...SESSION_1, value: 'sess-2' };
  local.fake.send({ event: 'pane_agent_detected', data: { pane_id: resumed.paneId, workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: pane.agent_session } });
  const deadline = Date.now() + 5_000;
  while (children(id)[0]?.session?.value !== 'sess-2' && children(id)[0]?.exitedAt === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

  const after = children(id)[0] as ChildRecord;
  assert.equal(after.exitedAt, undefined, `the child exited as ${after.paneEnd?.how}, though Bellwether started the process that took the new session`);
  assert.equal(after.session?.value, 'sess-2');
  assert.equal(after.id, 'child-worker');
  assert.ok(!published.includes('exited'), `the parent heard: ${published.join(', ')}`);
  assert.equal(after.origin, 'adopt');
});
