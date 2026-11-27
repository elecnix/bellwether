// Tier 2: the transcript path a child record carries, through each way a
// child comes to run. Claude Code writes its session file at the first turn,
// which can come after the spawn looks, so the spawn, the watcher, the exit
// and the resume each get a case of their own. HOME moves under the case's
// root, so ~/.claude here is a scratch directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { resumeChild } from '../../src/core/resume.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { claudeTranscriptPath } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

interface Room {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  cwd: string;
}

async function room(t: test.TestContext): Promise<Room> {
  const { root } = isolate(t, 'bellwether-transcript-');
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  delete process.env['CLAUDE_CONFIG_DIR'];
  t.after(() => {
    if (configDir !== undefined) process.env['CLAUDE_CONFIG_DIR'] = configDir;
  });
  const cwd = path.join(root, 'work', 'repo.git');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('claude-code', `transcript-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, cwd };
}

/** Start the watcher, then close the child's pane the way herdr reports it. */
async function exitPane(space: Room, watcher: Watcher, paneId: string): Promise<void> {
  // The spawn subscribed too, so wait for one more subscription than it made.
  const subscriptions = (): number => space.fake.requests.filter((request) => request.method === 'events.subscribe').length;
  const before = subscriptions();
  watcher.start();
  await until('the watcher subscription', () => (subscriptions() > before ? true : undefined));
  space.world.panes.delete(paneId);
  space.fake.send({ event: 'pane_exited', data: { pane_id: paneId } });
}

function writeTranscript(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } })}\n`);
}

function record(parentId: string, childId: string): ChildRecord | undefined {
  return readParent(parentId)?.children.find((child) => child.id === childId);
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

test('a Claude spawn records the transcript path when Claude Code has written the file', async (t) => {
  const space = await room(t);
  let expected = '';
  space.world.onStart = (pane) => {
    expected = claudeTranscriptPath(pane.agent_session?.value ?? '', space.cwd);
    writeTranscript(expected);
  };
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'claude', name: 'fast', prompt: 'go', cwd: space.cwd });
  assert.match(expected, /\/\.claude\/projects\/-.*-work-repo-git\/fresh-w1:p\d+\.jsonl$/);
  const saved = record(space.parentId, child.id);
  assert.equal(saved?.session?.value, `fresh-${child.paneId}`);
  assert.equal(saved?.transcript, expected);
  assert.equal(saved?.transcriptMissing, undefined);
});

test('a Claude spawn that looks before the first turn records why, and the watcher records the path once the file appears', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'claude', name: 'slow', prompt: 'go', cwd: space.cwd });
  const expected = claudeTranscriptPath(`fresh-${child.paneId}`, space.cwd);
  const saved = record(space.parentId, child.id);
  assert.equal(saved?.transcript, undefined);
  assert.ok(saved?.transcriptMissing?.includes(expected), `the reason names the expected file: ${saved?.transcriptMissing}`);
  assert.match(saved?.transcriptMissing ?? '', /first turn/);

  writeTranscript(expected);
  const watcher = new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {}, tickMs: 20 });
  t.after(() => watcher.stop());
  watcher.start();
  const found = await until('the transcript on the record', () => record(space.parentId, child.id)?.transcript);
  assert.equal(found, expected);
  assert.equal(record(space.parentId, child.id)?.transcriptMissing, undefined);
});

test('a Claude child that exits before the watcher looks again keeps its transcript path on the record', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'claude', name: 'brief', prompt: 'go', cwd: space.cwd });
  assert.equal(record(space.parentId, child.id)?.transcript, undefined);
  // The child takes its turn, writes its file and exits, all between two looks.
  const expected = claudeTranscriptPath(`fresh-${child.paneId}`, space.cwd);
  writeTranscript(expected);
  const watcher = new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {}, tickMs: 60_000 });
  t.after(() => watcher.stop());
  await exitPane(space, watcher, child.paneId);
  const exited = await until('the exit', () => {
    const entry = record(space.parentId, child.id);
    return entry?.exitedAt ? entry : undefined;
  });
  assert.equal(exited.transcript, expected);
  assert.equal(exited.session?.value, `fresh-${child.paneId}`, 'the session stays too, so the child can be resumed');
});

test('a Claude child whose session never had a turn keeps a null transcript and the reason', async (t) => {
  const space = await room(t);
  const { child } = await spawnChild(space.client, readParent(space.parentId)!, { kind: 'claude', name: 'stillborn', prompt: 'go', cwd: space.cwd });
  const watcher = new Watcher({ client: space.client, parentId: space.parentId, onEntries: () => {}, tickMs: 60_000 });
  t.after(() => watcher.stop());
  await exitPane(space, watcher, child.paneId);
  const exited = await until('the exit', () => {
    const entry = record(space.parentId, child.id);
    return entry?.exitedAt ? entry : undefined;
  });
  assert.equal(exited.transcript, undefined);
  assert.match(exited.transcriptMissing ?? '', /first turn/);
});

test('a resumed Claude child keeps the transcript path of its session', async (t) => {
  const space = await room(t);
  const expected = claudeTranscriptPath('sess-kept', space.cwd);
  writeTranscript(expected);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const exited: ChildRecord = {
    id: 'child-kept',
    name: 'kept',
    kind: 'claude',
    harness: 'claude-code',
    paneId: 'w1:p9',
    host: LOCAL_HOST,
    cwd: space.cwd,
    startedAt: at,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'id', value: 'sess-kept' },
    transcript: expected,
    depth: 1,
    exitedAt: at,
  };
  upsertChild(space.parentId, exited);
  const parent = readParent(space.parentId)!;
  await resumeChild(space.client, parent, { child: parent.children[0] });
  const resumed = record(space.parentId, 'child-kept');
  assert.equal(resumed?.exitedAt, undefined);
  assert.notEqual(resumed?.paneId, 'w1:p9');
  assert.equal(resumed?.session?.value, 'sess-kept');
  assert.equal(resumed?.transcript, expected);
  assert.equal(resumed?.transcriptMissing, undefined);
});

test('a resume records the transcript a spawn missed, once the session has its file', async (t) => {
  const space = await room(t);
  const expected = claudeTranscriptPath('sess-late', space.cwd);
  writeTranscript(expected);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  upsertChild(space.parentId, {
    id: 'child-late',
    name: 'late',
    kind: 'claude',
    harness: 'claude-code',
    paneId: 'w1:p9',
    host: LOCAL_HOST,
    cwd: space.cwd,
    startedAt: at,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    session: { kind: 'id', value: 'sess-late' },
    transcriptMissing: 'Claude Code has not written it yet',
    depth: 1,
    exitedAt: at,
  });
  const parent = readParent(space.parentId)!;
  await resumeChild(space.client, parent, { child: parent.children[0] });
  const resumed = record(space.parentId, 'child-late');
  assert.equal(resumed?.transcript, expected);
  assert.equal(resumed?.transcriptMissing, undefined);
});
