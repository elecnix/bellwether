// Tier 2: a codex child against the fake herdr socket and a fixture Codex
// home. herdr reports no session for Codex, so the fake world plays Codex's
// part by writing the rollout when the agent starts. The launch line is
// asserted as arguments, the session is found in the rollouts, a rollout that
// never appears fails the spawn by the sessions directory, the hooks review
// fails it by name without a keystroke, and agent_read answers from the
// rollout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { codexServerOverride, codexTrustOverride } from '../../src/core/harnesses/codex.ts';
import { briefSentence } from '../../src/core/harnesses/shared.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild, type SpawnHooks } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { writeRollout } from '../fixtures/codex-rollout.ts';
import { startFakeHerdr, type FakeHerdr, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  cwd: string;
  home: string;
}

async function room(t: test.TestContext): Promise<Room> {
  const { root } = isolate(t, 'bellwether-codex-');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const home = path.join(root, 'codex-home');
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('claude-code', `codex-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, cwd, home };
}

/** Codex's part: herdr reports no session, the pane goes idle, and the rollout holds the prompt it was given. */
function codexWrites(space: Room, options: { replies?: string[]; screen?: string; write?: boolean } = {}): void {
  space.world.onStart = (pane: FakePane) => {
    delete pane.agent_session;
    const prompt = (pane.args ?? []).at(-1) ?? '';
    if (options.write !== false) writeRollout({ home: space.home, id: `0000-${pane.pane_id}`, cwd: space.cwd, prompt, ...(options.replies ? { replies: options.replies } : {}) });
    setTimeout(() => {
      if (options.screen) pane.screen = options.screen;
      space.world.emit({ event: 'pane_agent_status_changed', data: { pane_id: pane.pane_id, agent_status: 'idle' } });
    }, 30);
  };
}

function hooks(space: Room): SpawnHooks {
  return { harness: { store: space.home, waitMs: 400, intervalMs: 20 } };
}

function startArgs(fake: FakeHerdr): string[] {
  const start = harnessStarts(fake)[0];
  assert.ok(start, 'herdr was never asked to start the agent');
  assert.equal(start.kind, 'codex');
  return start.args as string[];
}

test('a codex spawn starts Codex with its own server and trust on the launch line, and finds its session in the rollouts', async (t) => {
  const space = await room(t);
  codexWrites(space);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'line one\nline two', cwd: space.cwd }, undefined, hooks(space));

  const brief = promptPath(child.id);
  assert.equal(fs.readFileSync(brief, 'utf8'), 'line one\nline two');
  assert.deepEqual(startArgs(space.fake), ['-a', 'never', '-s', 'workspace-write', '-c', codexTrustOverride(space.cwd), '-c', codexServerOverride(child.id), briefSentence(brief)]);
  const create = space.fake.requests.find((request) => request.method === 'tab.create' || request.method === 'workspace.create');
  const env = (create?.params['env'] ?? {}) as Record<string, string>;
  assert.equal(env['CODEX_HOME'], space.home);
  assert.equal(env['BELLWETHER_CHILD'], child.id);

  const saved = readParent(space.parentId)?.children.find((entry) => entry.id === child.id);
  assert.equal(saved?.harness, 'codex');
  assert.deepEqual(saved?.session, { kind: 'id', value: `0000-${child.paneId}` });
  assert.equal(saved?.store, space.home);
  // Nothing typed into the pane but the launch line: no Codex dialog is answered by a key.
  assert.equal(space.fake.requests.filter((request) => request.method === 'agent.send_keys' || (request.method === 'pane.send_input' && harnessStart(request) === undefined)).length, 0);
});

test('a codex spawn whose session never reaches the rollouts fails naming the sessions directory, and keeps the brief', async (t) => {
  const space = await room(t);
  codexWrites(space, { write: false });
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'the brief', cwd: space.cwd }, undefined, hooks(space)), (error: Error) => {
    assert.match(error.message, new RegExp(`cx was not started: Codex never wrote a session with the brief's prompt under ${path.join(space.home, 'sessions')}`));
    assert.match(error.message, /The brief stays at .* for inspection, and the pane is closed\./);
    return true;
  });
  assert.deepEqual(readParent(space.parentId)?.children, []);
});

test('Codex on its hooks review fails the spawn by name, and no key answers it', async (t) => {
  const space = await room(t);
  const screen = ['  Hooks need review', '  1 hook is new or changed.', '  Hooks can run outside the sandbox after you trust them.', '› 1. Review hooks', '  2. Trust all and continue', "  3. Continue without trusting (hooks won't run)"].join('\n');
  codexWrites(space, { write: false, screen });
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'the brief', cwd: space.cwd }, undefined, hooks(space)), /Codex (in pane \S+ )?stopped on the "Hooks need review" dialog, which Bellwether never answers: trusting a hook lets it run outside the sandbox/);
  // The launch line is the only input the pane gets.
  assert.equal(space.fake.requests.filter((request) => request.method === 'agent.send_keys' || (request.method === 'pane.send_input' && harnessStart(request) === undefined)).length, 0);
  assert.deepEqual(readParent(space.parentId)?.children, []);
});

test('agent_read for a codex child answers from its rollout', async (t) => {
  const space = await room(t);
  codexWrites(space, { replies: ['I reported it.'] });
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'the brief', cwd: space.cwd }, undefined, hooks(space));
  const ctx: ToolContext = { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
  assert.equal(await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {}), 'I reported it.');
});

test('a codex child on another machine, or without cwd, is refused before anything is written', async (t) => {
  const space = await room(t);
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'x' }, undefined, hooks(space)), /cx was not started: a codex child needs cwd/);
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'codex', name: 'cx', prompt: 'x', cwd: space.cwd, host: 'elsewhere' }, undefined, hooks(space)), /cx was not started: a codex child runs on this machine only for now/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
});
