// Tier 2: herdr learns a pi session only through its own pi integration. On a
// machine whose herdr lacks it, herdr shows the child's pane with no session,
// so Bellwether records none, and a move, a restart or a resume by session has
// nothing to reopen. Each refusal names that cause and the command that fixes
// it, read from herdr's integration.list on the child's machine, and a spawn
// warns when it starts a child there (issue #169).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { MoveRefusedError, moveChild, type MoveDeps } from '../../src/core/move.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { restartChild } from '../../src/core/restart.ts';
import { resumeChild } from '../../src/core/resume.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { spawnResume } from '../../src/core/spawn-resume.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

type PiState = 'current' | 'not_installed';

interface Machine {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
}

/** herdr's answer to integration.list, with pi in the state a case needs, as herdr 0.9.5 lists it. */
function integrations(pi: PiState): (request: RecordedRequest) => { result: unknown } | undefined {
  return (request) =>
    request.method === 'integration.list'
      ? { result: { type: 'integration_list', integrations: [{ target: 'pi', label: 'pi', command: 'pi', available: true, state: pi }, { target: 'claude', label: 'claude', command: 'claude', available: true, state: 'current' }] } }
      : undefined;
}

async function machine(t: test.TestContext, workspace: string, pi: PiState): Promise<Machine> {
  const world = fakeWorld(workspace);
  const answer = integrations(pi);
  const fake = await startFakeHerdr({ respond: (request) => answer(request) ?? world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }) };
}

function room(t: test.TestContext): { parentId: string; cwd: string } {
  const { root: scratch } = isolate(t, 'bellwether-herdr-integration-');
  const cwd = path.join(scratch, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return { parentId: saveParent(emptyParent('pi', `herdr-integration-${path.basename(scratch)}`, scratch, { workspaceId: 'w1' })).id, cwd };
}

/** A pi child Bellwether started, idle in its pane, whose machine's herdr never reported a session. */
function sessionless(parentId: string, extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const child: ChildRecord = { id: 'child-worker', name: 'worker', kind: 'pi', harness: 'pi', paneId: 'w1:p3', tabId: 'w1:t3', host: LOCAL_HOST, origin: 'spawn', cwd: '/work', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra };
  upsertChild(parentId, child);
  return child;
}

function asked(m: Machine, method: string): boolean {
  return m.fake.requests.some((request) => request.method === method);
}

test('agent_spawn starts a pi child on a machine whose herdr has no pi integration, and its reply warns with the fix', async (t) => {
  const here = await machine(t, 'w1', 'not_installed');
  const { parentId, cwd } = room(t);
  const ctx: ToolContext = { client: here.client, clientFor: async () => here.client, parentId, watcher: new Watcher({ client: here.client, parentId, onEntries: () => {} }) };
  const reply = await runBellwetherTool(ctx, 'agent_spawn', { kind: 'pi', name: 'unseen', prompt: 'report back', cwd });
  assert.match(reply, /^unseen started as a pi agent/);
  assert.match(reply, /Warning: herdr on this machine has no pi integration, so it will not report unseen's session/);
  assert.ok(reply.includes('`herdr integration install pi`'), reply);
  assert.equal(readParent(parentId)?.children.length, 1, 'a warning, not a refusal');
});

test('agent_spawn says nothing about the integration when herdr has it', async (t) => {
  const here = await machine(t, 'w1', 'current');
  const { parentId, cwd } = room(t);
  const ctx: ToolContext = { client: here.client, clientFor: async () => here.client, parentId, watcher: new Watcher({ client: here.client, parentId, onEntries: () => {} }) };
  const reply = await runBellwetherTool(ctx, 'agent_spawn', { kind: 'pi', name: 'seen', prompt: 'report back', cwd });
  assert.doesNotMatch(reply, /herdr integration install|Warning:/);
  assert.ok(asked(here, 'integration.list'), 'the spawn asked herdr');
});

test('a pi spawn on another machine asks that machine\'s herdr, and warns naming the machine', async (t) => {
  const here = await machine(t, 'w1', 'current');
  const far = await machine(t, 'w7', 'not_installed');
  const { parentId } = room(t);
  const registerRemote = async (): Promise<{ piExtension: string }> => ({ piExtension: '/far/extension.js' });
  const result = await spawnChild(far.client, readParent(parentId)!, { kind: 'pi', name: 'far-pi', host: 'example-box' }, undefined, { registerRemote });
  assert.match(result.integrationNote ?? '', /herdr on machine example-box has no pi integration/);
  assert.ok(asked(far, 'integration.list'));
  assert.equal(asked(here, 'integration.list'), false, 'this machine\'s herdr says nothing about the other one');
});

test('a move of a sessionless pi child names the missing integration on its machine, and touches nothing', async (t) => {
  const here = await machine(t, 'w1', 'current');
  const far = await machine(t, 'w7', 'not_installed');
  const { parentId } = room(t);
  sessionless(parentId, { host: 'example-box', paneId: 'w7:p3', tabId: 'w7:t3' });
  const deps: MoveDeps = {
    clientFor: async (host) => (host === LOCAL_HOST ? here.client : far.client),
    endpointFor: () => {
      throw new Error('a refused move reaches no machine');
    },
    knownHosts: async () => [LOCAL_HOST, 'example-box'],
  };
  const failure = await moveChild(deps, parentId, { child: 'worker', machine: LOCAL_HOST }).catch((error: unknown) => error);
  assert.ok(failure instanceof MoveRefusedError, String(failure));
  assert.match(failure.message, /worker has no recorded session, so there is no conversation to carry across\. herdr on machine example-box has no pi integration, so it never reported worker's session/);
  assert.ok(failure.message.includes('`herdr integration install pi` on machine example-box'), failure.message);
  assert.equal(asked(far, 'tab.close'), false);
});

test('a move of a sessionless pi child keeps the plain refusal when herdr has the integration', async (t) => {
  const here = await machine(t, 'w1', 'current');
  const { parentId } = room(t);
  sessionless(parentId);
  const deps: MoveDeps = { clientFor: async () => here.client, endpointFor: () => { throw new Error('unused'); }, knownHosts: async () => [LOCAL_HOST, 'example-box'] };
  const failure = await moveChild(deps, parentId, { child: 'worker', machine: 'example-box' }).catch((error: unknown) => error);
  assert.ok(failure instanceof MoveRefusedError, String(failure));
  assert.match(failure.message, /no recorded session, so there is no conversation to carry across\.$/m);
  assert.doesNotMatch(failure.message, /herdr integration install/);
});

test('a restart of a sessionless pi child names the missing integration', async (t) => {
  const here = await machine(t, 'w1', 'not_installed');
  const { parentId } = room(t);
  sessionless(parentId);
  await assert.rejects(restartChild(here.client, parentId, 'child-worker'), (error: Error) => /has no recorded session, so agent_restart cannot reopen it/.test(error.message) && error.message.includes('herdr on this machine has no pi integration') && error.message.includes('`herdr integration install pi`'));
});

test('a resume of a sessionless pi child names the missing integration, by name and by record', async (t) => {
  const here = await machine(t, 'w1', 'not_installed');
  const { parentId } = room(t);
  const child = sessionless(parentId, { exitedAt: new Date().toISOString() });
  await assert.rejects(spawnResume(async () => here.client, parentId, { target: 'worker' }), (error: Error) => /has no recorded session/.test(error.message) && error.message.includes('herdr on this machine has no pi integration'));
  await assert.rejects(resumeChild(here.client, readParent(parentId)!, { child }), (error: Error) => /has no recorded session, so there is nothing to resume/.test(error.message) && error.message.includes('`herdr integration install pi`'));
});
