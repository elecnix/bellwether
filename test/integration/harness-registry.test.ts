// Tier 2: a harness is its registry entry. The fixture `fake-agent` is a
// fourth harness defined only in test/fixtures/fake-harness.ts. These cases
// spawn it against the fake herdr, read its conversation with agent_read,
// resume it, offer its kind in the tool list and the daemon's feature list,
// and refuse an older daemon by name, with no file under src/ naming it.
// A harness whose child could not report is refused before anything is
// written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { agentKinds, harnessFor, registerHarness, type HarnessEntry } from '../../src/core/harnesses/index.ts';
import { mcpConfigPath, promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { resumeArgs } from '../../src/core/resume.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { FEATURES, kindFeatures, missingFeatureMessage, unservedArgument } from '../../src/daemon/features.ts';
import { parentTools, runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, harnessStarts, harnessStart, prompted } from '../fixtures/fake-herdr.ts';
import { FAKE_KIND, fakeHarness } from '../fixtures/fake-harness.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  home: string;
  scratch: string;
}

async function room(t: test.TestContext): Promise<Room> {
  const { root: scratch, home } = isolate(t, 'bellwether-harness-registry-');
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('pi', `registry-${path.basename(scratch)}`, scratch, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, home, scratch };
}

function startArgs(fake: FakeHerdr): string[] {
  const start = harnessStarts(fake)[0];
  assert.ok(start, 'herdr was never asked to start the agent');
  return start.args as string[];
}

function context(space: Room): ToolContext {
  return { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {} }) };
}

/** A session file in the JSONL form Claude Code and pi share, with one assistant message. */
function sessionFile(dir: string, text: string): string {
  const file = path.join(dir, 'fake-agent-session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`);
  return file;
}

test('the fourth entry spawns with its own launch line and MCP config, gets its brief typed, and agent_read reads its conversation', async (t) => {
  const space = await room(t);
  const file = sessionFile(space.scratch, 'fake-agent finished the task');
  // herdr reports the session as the path of its file, as it does for pi.
  space.world.onStart = (pane) => {
    pane.agent_session = { agent: FAKE_KIND, kind: 'path', source: `herdr:${FAKE_KIND}`, value: file };
  };
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: FAKE_KIND, name: 'fourth', prompt: 'report back', model: 'example-model' });

  assert.equal(child.harness, 'fake-agent');
  assert.deepEqual(startArgs(space.fake), ['--model', 'example-model', `--mcp-config=${mcpConfigPath(child.id)}`]);
  // The entry has no launch prompt and no inbox, so the brief is typed once the harness runs.
  assert.deepEqual(prompted(space.fake, child.paneId), ['report back']);
  const start = harnessStarts(space.fake)[0];
  assert.equal(start?.kind, FAKE_KIND);
  // The child's own server carries its child id, so its parent_report reaches this parent.
  const config = JSON.parse(fs.readFileSync(mcpConfigPath(child.id), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  assert.ok(Object.values(config.mcpServers).some((server) => server.args.includes(child.id)), 'the MCP config does not name the child');
  assert.equal(fs.readFileSync(promptPath(child.id), 'utf8'), 'report back');

  const saved = readParent(space.parentId)?.children.find((entry) => entry.id === child.id);
  assert.deepEqual(saved?.session, { kind: 'path', value: file });
  assert.equal(saved?.transcript, file);
  assert.equal(await runBellwetherTool(context(space), 'agent_read', { child: 'fourth' }, {}), 'fake-agent finished the task');
});

test('the fourth entry resumes with its own flag, and its kind is offered and gated by name', () => {
  assert.deepEqual(resumeArgs(FAKE_KIND, { kind: 'path', value: '/tmp/s.jsonl' }), ['--resume-from', '/tmp/s.jsonl']);
  assert.ok(agentKinds().includes(FAKE_KIND));
  const spawn = parentTools.find((tool) => tool.name === 'agent_spawn');
  const kind = (spawn?.schema['properties'] as Record<string, { enum: string[]; description: string }>)['kind'];
  assert.ok(kind?.enum.includes(FAKE_KIND), 'agent_spawn does not offer the kind');
  assert.match(JSON.stringify(spawn?.schema), /"enum":\[[^\]]*"fake-agent"/);
  assert.match(kind?.description ?? '', /fake-agent/);

  // An older daemon lacks the kind's feature, and the client refuses it by name.
  assert.deepEqual(kindFeatures([fakeHarness]), [{ name: 'agent_spawn.kind=fake-agent', kind: 'argument', protocol: 4, version: '0.1.5', summary: 'A spawn starts a child that runs Fake Agent.' }]);
  const older = { protocol: 4, version: '0.1.5', features: FEATURES.map((feature) => feature.name) };
  assert.equal(unservedArgument(older, 'agent_spawn', { kind: FAKE_KIND, name: 'x' }), 'agent_spawn.kind=fake-agent');
  assert.match(missingFeatureMessage('agent_spawn.kind=fake-agent', older), /^`agent_spawn\.kind=fake-agent` needs Bellwether 0\.1\.5 \(protocol 4\)/);
});

test('a harness whose child could not report is refused before the record, the brief or the tab', async (t) => {
  const space = await room(t);
  const mute: HarnessEntry = { ...fakeHarness, kind: 'fake-mute', harness: 'fake-mute', label: 'Fake Mute', reports: { via: 'none', reason: 'Fake Mute takes no MCP configuration' } };
  t.after(registerHarness(mute));
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'fake-mute', name: 'unheard', prompt: 'report back' }), /unheard was not started: Fake Mute takes no MCP configuration\. A fake-mute child can be adopted with agent_adopt once it runs/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || harnessStart(request) !== undefined), false);
  const prompts = path.join(space.home, 'prompts');
  assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
});

test("an entry's preflight sees the caller's extra arguments, and its spawn note reaches the agent_spawn reply", async (t) => {
  const space = await room(t);
  const gated: HarnessEntry = {
    ...fakeHarness,
    kind: 'fake-gated',
    harness: 'fake-gated',
    label: 'Fake Gated',
    async preflight({ name, args }) {
      if (!args.includes('--opt-in')) throw new Error(`${name} was not started: Fake Gated starts only with --opt-in`);
    },
    spawnNote: (_child, args) => (args.includes('--opt-in') ? 'Fake Gated runs in its opt-in mode, which costs the example tools.' : undefined),
  };
  t.after(registerHarness(gated));
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'fake-gated', name: 'closed', prompt: 'x' }), /closed was not started: Fake Gated starts only with --opt-in/);
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || harnessStart(request) !== undefined), false);

  const reply = await runBellwetherTool(context(space), 'agent_spawn', { kind: 'fake-gated', name: 'open', prompt: 'x', args: ['--opt-in'] }, {});
  assert.match(reply, /open started as a fake-gated agent/);
  assert.match(reply, /\nFake Gated runs in its opt-in mode, which costs the example tools\.$/);
  assert.equal(startArgs(space.fake).at(-1), '--opt-in');
  // An entry without a note adds no line.
  const plain = await runBellwetherTool(context(space), 'agent_spawn', { kind: FAKE_KIND, name: 'plain', prompt: 'x' }, {});
  assert.doesNotMatch(plain, /opt-in/);
});

test("an entry's preflight asks herdr on the child's machine, and its refusal leaves nothing behind", async (t) => {
  const space = await room(t);
  // A harness that herdr watches only through an integration of its own checks for it before the record.
  const checked: HarnessEntry = {
    ...fakeHarness,
    kind: 'fake-checked',
    harness: 'fake-checked',
    label: 'Fake Checked',
    async preflight({ name, herdr }) {
      const listed = (await herdr?.request('integration.list', {})) as { integrations?: { target: string }[] } | undefined;
      if (!listed?.integrations?.some((entry) => entry.target === 'fake-checked')) throw new Error(`${name} was not started: herdr lists no fake-checked integration`);
    },
  };
  t.after(registerHarness(checked));
  await assert.rejects(spawnChild(space.client, readParent(space.parentId)!, { kind: 'fake-checked', name: 'unchecked', prompt: 'report back' }), /unchecked was not started: herdr lists no fake-checked integration/);
  assert.ok(space.fake.requests.some((request) => request.method === 'integration.list'), 'the preflight reached herdr through the spawn');
  assert.deepEqual(readParent(space.parentId)?.children, []);
  assert.equal(space.fake.requests.some((request) => request.method === 'tab.create' || harnessStart(request) !== undefined), false);
});
