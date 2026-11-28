// Tier 2: who watches a pane, after the pane's session changes under an
// adoption. Each case replays a trace that the model in model/Claims.tla found
// (issue #211, items 6 and 7), and asserts the invariant it named.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptPane } from '../../src/core/adopt.ts';
import { adoptedParentOf } from '../../src/core/adopted-session.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { PANE, farAdopt, farRecords, herdr, liveOnPane, localAdopt, machines, newParent, on } from '../fixtures/claim-machines.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakeWorld } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const X = 'w1:p1';
const Y = 'w1:p2';
const S1 = '3f1c2a9e-0000-4000-8000-000000000001';
const S2 = '3f1c2a9e-0000-4000-8000-000000000002';

const sess = (value: string) => ({ agent: 'claude', kind: 'id' as const, source: 'herdr:claude', value });

interface Rig {
  world: FakeWorld;
  fake: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  published: OutboxEntry[];
  child(id: string): ChildRecord | undefined;
}

async function rig(t: test.TestContext): Promise<Rig> {
  isolate(t, 'bellwether-claims-');
  const world = fakeWorld('w1');
  world.add({ pane_id: 'w1:p0', agent: 'claude', name: 'parent', agent_session: sess('parent-session') });
  world.add({ pane_id: X, agent: 'claude', name: 'hand-x', agent_session: sess(S1) });
  world.add({ pane_id: Y });
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  const parentId = saveParent(emptyParent('claude-code', 'l1', '/work', { paneId: 'w1:p0', workspaceId: 'w1' })).id;
  return { world, fake, client: new HerdrClient({ socketPath: fake.socketPath }), parentId, published: [], child: (id) => readParent(parentId)?.children.find((entry) => entry.id === id) };
}

async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The harness in the pane quits, and herdr releases the agent. */
function quit(r: Rig, pane: string): void {
  const entry = r.world.panes.get(pane)!;
  delete entry.agent;
  delete entry.agent_session;
  entry.agent_status = 'unknown';
  r.fake.send({ event: 'pane_agent_detected', data: { pane_id: pane, workspace_id: 'w1', agent: 'claude', final_status: 'idle', released: true } });
}

/** A harness in the pane runs `session` now, and herdr detects it: a /clear, a /resume, or herdr reusing the pane id. */
function runs(r: Rig, pane: string, session: string): void {
  const entry = r.world.panes.get(pane)!;
  entry.agent = 'claude';
  entry.agent_session = sess(session);
  entry.agent_status = 'idle';
  r.fake.send({ event: 'pane_agent_detected', data: { pane_id: pane, workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: sess(session) } });
}

async function adoptAndWatch(t: test.TestContext): Promise<{ r: Rig; first: string; watcher: Watcher }> {
  const r = await rig(t);
  const first = (await adoptPane(r.client, readParent(r.parentId)!, { target: X })).child.id;
  const watcher = new Watcher({ client: r.client, parentId: r.parentId, onEntries: (entries) => r.published.push(...entries.filter((entry) => !r.published.some((seen) => seen.receipt === entry.receipt))), tickMs: 60_000, screenPollMs: 0 });
  t.after(() => watcher.stop());
  watcher.start();
  await r.fake.waitFor('events.subscribe');
  return { r, first, watcher };
}

// OneSessionPerId. Trace: LocalAdopt, SessionChange(x, s2), the watcher's next step.
test('an adopted child whose pane starts another session exits, still naming the session it was adopted on, and the parent hears which session took the pane', async (t) => {
  const { r, first } = await adoptAndWatch(t);
  runs(r, X, S2);
  await until('the adopted child to exit', () => r.child(first)?.exitedAt !== undefined);
  const record = r.child(first)!;
  assert.equal(record.session?.value, S1, `child ${first} was adopted on session ${S1}, and its record names ${record.session?.value}`);
  assert.equal(record.paneEnd?.how, 'session-changed');
  assert.equal(record.paneEnd?.session, S2);
  assert.equal(record.awaitsResume, undefined, 'another session holds the pane, so the watcher does not wait there');
  await until('the exit event', () => r.published.some((entry) => entry.childId === first && entry.event === 'exited'));
  const text = r.published.find((entry) => entry.childId === first && entry.event === 'exited')!.text;
  assert.match(text, new RegExp(`herdr reports session ${S2} in pane ${X} now, not ${S1}, the session this parent adopted\\. Bellwether stopped watching the pane: adopt it again to watch the new session\\.`), text);
  assert.equal(adoptedParentOf({ paneId: X, session: S2 }), undefined, 'the new session answers to no parent');
});

// IdStableInPane. Trace: LocalAdopt, SessionChange(x, s2), Next, SessionChange(x, none), Next, SessionChange(x, s1), LocalAdopt.
test('a session that comes back to its pane after another session ran there is adopted again under the id it first had in that pane', async (t) => {
  const { r, first, watcher } = await adoptAndWatch(t);
  runs(r, X, S2);
  await until('the adopted child to exit', () => r.child(first)?.exitedAt !== undefined);
  quit(r, X);
  await new Promise((resolve) => setTimeout(resolve, 100));
  watcher.stop();
  runs(r, X, S1);
  const again = await adoptPane(r.client, readParent(r.parentId)!, { target: X });
  assert.equal(again.child.id, first, `pane ${X} on session ${S1} was first adopted as ${first}, and adopting it again gave ${again.child.id}`);
  assert.equal(again.revived, true);
  assert.deepEqual(readParent(r.parentId)!.children.map((entry) => entry.id), [first], 'one record for the pane and session');
});

// RouteUnambiguous and NoPaneTwoParents, as the pane machine sees them. Trace: FarAdopt(f1, x), SessionChange(x, s2), LocalAdopt(l1, x), SessionChange(x, s1).
test('a local adoption over a far claim whose session left the pane removes that claim, so a session in the pane answers to one parent', async (t) => {
  const m = machines(t);
  const f1 = newParent(m.f1, 'f1');
  const l1 = newParent(m.pane, 'l1');
  const pane = { session: 's1' };
  const client = herdr(pane);

  await farAdopt(m.f1, f1, m.pane, client);
  pane.session = 's2';
  const { child } = await localAdopt(m.pane, l1, client);
  assert.deepEqual(farRecords(m.pane).map((record) => [record.parentId, record.session]), [], 'the stale far claim is gone from the pane machine');
  assert.deepEqual(on(m.pane, () => adoptedParentOf({ paneId: PANE, session: 's2' })), { parentId: l1, childId: child.id, name: child.name, where: 'here' });

  // The first session comes back to the pane: neither the old claim nor the new child stands for it.
  pane.session = 's1';
  assert.equal(on(m.pane, () => adoptedParentOf({ paneId: PANE, session: 's1' })), undefined);
  assert.deepEqual(liveOnPane(m.pane, 'local').map((entry) => entry.session), ['s2']);
});

// IdStableBySession. Trace: LocalAdopt(l1, x), SessionChange(x, none), SessionChange(y, s1), LocalAdopt(l1, y).
// No watcher runs, so the first child is still recorded live on x, as the trace leaves it.
test('a session resumed by hand in another pane, adopted again while its first record still shows it live in the old pane, keeps its first id and moves to the new pane', async (t) => {
  const r = await rig(t);
  const first = (await adoptPane(r.client, readParent(r.parentId)!, { target: X })).child.id;
  quitQuietly(r, X);
  runsQuietly(r, Y, S1);
  const second = await adoptPane(r.client, readParent(r.parentId)!, { target: Y });
  assert.equal(second.child.id, first, `adopting session ${S1} again gave id ${second.child.id}, not its first id ${first}`);
  assert.equal(second.revived, true);
  assert.equal(second.from, X, 'the reply says which pane ran the session before');
  assert.deepEqual(readParent(r.parentId)!.children.map((entry) => [entry.id, entry.paneId, entry.session?.value, entry.exitedAt ? 'exited' : 'live']), [[first, Y, S1, 'live']]);
});

test('a session resumed by hand in another pane after its exit was recorded is adopted again under its first id', async (t) => {
  const { r, first, watcher } = await adoptAndWatch(t);
  quit(r, X);
  await until('the exit', () => r.child(first)?.exitedAt !== undefined);
  watcher.stop();
  runsQuietly(r, Y, S1);
  const second = await adoptPane(r.client, readParent(r.parentId)!, { target: Y });
  assert.equal(second.child.id, first, `adopting session ${S1} in pane ${Y} gave id ${second.child.id}, not its first id ${first}`);
  const record = r.child(first)!;
  assert.equal(record.paneId, Y);
  assert.equal(record.exitedAt, undefined);
  assert.equal(record.awaitsResume, undefined, 'the child no longer waits in its old pane');
});

/** The harness in the pane quits, and no watcher hears it. */
function quitQuietly(r: Rig, pane: string): void {
  const entry = r.world.panes.get(pane)!;
  delete entry.agent;
  delete entry.agent_session;
  entry.agent_status = 'unknown';
}

/** A harness in the pane runs `session` now, and no watcher hears it. */
function runsQuietly(r: Rig, pane: string, session: string): void {
  const entry = r.world.panes.get(pane)!;
  entry.agent = 'claude';
  entry.name = `hand-${pane}`;
  entry.agent_session = sess(session);
  entry.agent_status = 'idle';
}
