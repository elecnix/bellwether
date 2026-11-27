// Tier 2: a resume keeps the brief a child never read (issue #132). A pi child
// whose harness exits at once never reads its first brief, so a resume with a
// short prompt must still hand it the task, and a person must still find the
// task in the state directory. A child that read its brief and reported gets
// only the new prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { promptPath, promptsDir } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { harnessStarts, prompted, startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const TASK = 'Write the release notes for 0.1.5, then call parent_report.\nThe second line keeps its line break.';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  cwd: string;
  watcher: Watcher;
}

async function room(t: test.TestContext): Promise<Room> {
  const { root } = isolate(t, 'bellwether-resume-brief-');
  const cwd = path.join(root, 'work', 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parentId = saveParent(emptyParent('claude-code', `resume-brief-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  const watcher = new Watcher({ client, parentId, onEntries: () => {}, tickMs: 60_000 });
  t.after(() => watcher.stop());
  return { world, fake, client, parentId, cwd, watcher };
}

function context(space: Room): ToolContext {
  return { client: space.client, clientFor: async () => space.client, parentId: space.parentId, watcher: space.watcher };
}

function record(space: Room, childId: string): ChildRecord | undefined {
  return readParent(space.parentId)?.children.find((child) => child.id === childId);
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

/** Start the watcher, then end the child's pane the way herdr reports a harness that exits. */
async function exitPane(space: Room, paneId: string, childId: string): Promise<ChildRecord> {
  const subscriptions = (): number => space.fake.requests.filter((request) => request.method === 'events.subscribe').length;
  const before = subscriptions();
  space.watcher.start();
  await until('the watcher subscription', () => (subscriptions() > before ? true : undefined));
  space.world.panes.delete(paneId);
  space.fake.send({ event: 'pane_exited', data: { pane_id: paneId } });
  return until('the exit', () => {
    const entry = record(space, childId);
    return entry?.exitedAt ? entry : undefined;
  });
}

/**
 * The file of the brief the last start handed over. The launch line carries
 * no brief (issue #162): the start types it, since no daemon carries these
 * calls, so the last text herdr typed is that file's text, and the record's
 * newest brief names the file.
 */
function lastBriefArgument(space: Room, childId: string): string {
  const args = harnessStarts(space.fake).at(-1)?.args ?? [];
  assert.ok(!args.some((arg) => arg.startsWith('@')), `the launch line points at a brief: ${JSON.stringify(args)}`);
  const newest = record(space, childId)?.briefs?.at(-1);
  assert.ok(newest, 'the record names no brief');
  const typed = prompted(space.fake, record(space, childId)?.paneId ?? '').at(-1);
  assert.equal(typed, fs.readFileSync(newest.file, 'utf8'), 'the start typed the text of its newest brief');
  assert.equal(newest.delivery?.path, 'keystrokes');
  return newest.file;
}

test('a child that exits before it reads its brief keeps the task through a resume with a short prompt', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'keyless', prompt: TASK, cwd: space.cwd });
  const first = promptPath(child.id);
  assert.equal(lastBriefArgument(space, child.id), first);

  // The harness exits at once, as pi does with a provider that has no key.
  const exited = await exitPane(space, child.paneId, child.id);
  assert.equal(exited.harnessEnded, undefined);
  assert.equal(fs.readFileSync(first, 'utf8'), TASK, 'the exit keeps a brief nothing shows the child read');

  const reply = await runBellwetherTool(context(space), 'agent_spawn', { resume: 'keyless', prompt: 'continue' });
  assert.match(reply, /keyless resumed session/);
  assert.ok(reply.includes(first), `the reply names the file that holds the first brief: ${reply}`);

  // The child reads the task first, then the resume's prompt.
  const delivered = lastBriefArgument(space, child.id);
  assert.notEqual(delivered, first, 'the resume writes a file of its own');
  const text = fs.readFileSync(delivered, 'utf8');
  const task = text.indexOf(TASK);
  const resumePrompt = text.lastIndexOf('continue');
  assert.ok(task >= 0, `the delivered file holds the task: ${text}`);
  assert.ok(resumePrompt > task + TASK.length, `the resume's prompt comes after the task: ${text}`);
  assert.equal(fs.statSync(delivered).mode & 0o777, 0o600);

  // A person looking at the state directory finds the task unchanged, beside the resume's file.
  assert.equal(fs.readFileSync(first, 'utf8'), TASK);
  const files = fs.readdirSync(promptsDir()).filter((name) => name.startsWith(child.id)).sort();
  assert.deepEqual(files, [`${child.id}-2.md`, `${child.id}.md`].sort());
  const briefs = record(space, child.id)?.briefs ?? [];
  assert.deepEqual(
    briefs.map((brief) => [brief.n, brief.file, brief.carries ?? []]),
    [
      [1, first, []],
      [2, delivered, [1]],
    ],
  );
});

test('a child that read its brief and reported gets only the new prompt on a resume', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'pi', name: 'reader', prompt: TASK, cwd: space.cwd });
  const first = promptPath(child.id);
  // The child read its brief and reported: the record now proves it.
  updateChild(space.parentId, child.id, (entry) => {
    entry.lastReport = { status: 'done', text: 'notes written', at: new Date(Date.now() + 1_000).toISOString(), seq: 1 };
  });
  await exitPane(space, child.paneId, child.id);
  assert.equal(fs.existsSync(first), false, 'the exit of a child that read its brief removes it, as before');

  const reply = await runBellwetherTool(context(space), 'agent_spawn', { resume: 'reader', prompt: 'Now tag the release.' });
  assert.match(reply, /reader resumed session/);
  assert.doesNotMatch(reply, /had not read/);
  const delivered = lastBriefArgument(space, child.id);
  assert.equal(fs.readFileSync(delivered, 'utf8'), 'Now tag the release.');
  assert.equal(delivered, path.join(promptsDir(), `${child.id}-2.md`));
});
