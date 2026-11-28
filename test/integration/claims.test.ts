// Tier 2: who watches a pane, after the pane's session changes under an
// adoption. Each case replays a trace that the model in model/Claims.tla found
// (issue #211, items 6 and 7), and asserts the invariant it named.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptPane } from '../../src/core/adopt.ts';
import { adoptedParentOf } from '../../src/core/adopted-session.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { claimPane } from '../../src/core/pane-claims.ts';
import { listRelayRecords } from '../../src/core/relay-records.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { PANE, farAdopt, farRecords, herdr, herdrPanes, liveOnPane, localAdopt, machines, newParent, on } from '../fixtures/claim-machines.ts';
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

/**
 * A far parent's watcher ends an adopted child whose pane runs another
 * session, and its relay-cleanup fails, as when the relay is down at that
 * moment: the claim on the pane machine stays, naming the session that left.
 */
function leaveWithClaimKept(parentHome: string, parentId: string, childId: string, session: string): void {
  on(parentHome, () =>
    updateChild(parentId, childId, (entry) => {
      entry.exitedAt = new Date().toISOString();
      entry.paneEnd = { pane: entry.paneId, how: 'session-changed', at: entry.exitedAt, session };
    }),
  );
}

// OneSessionPerId (issue #244). Trace: FarAdopt(f1, x), SessionChange(x, s2), WatcherLeave, FarAdopt(f1, x).
test('a far parent that adopts a pane again over its own claim for a session that left the pane gives the new session a new id, not the old one', async (t) => {
  const m = machines(t);
  const f1 = newParent(m.f1, 'f1');
  const pane = { session: 's1' };
  const client = herdr(pane);

  const first = (await farAdopt(m.f1, f1, m.pane, client)).child.id;
  pane.session = 's2';
  leaveWithClaimKept(m.f1, f1, first, 's2');
  assert.deepEqual(farRecords(m.pane).map((record) => [record.childId, record.session]), [[first, 's1']], 'the stale claim stays on the pane machine');

  const again = await farAdopt(m.f1, f1, m.pane, client);
  assert.notEqual(again.child.id, first, `child id ${first} stands for session s1, and adopting the pane on session s2 gave it to s2 as well`);
  assert.equal(again.child.session?.value, 's2');
  assert.deepEqual(farRecords(m.pane).map((record) => [record.childId, record.session]), [[again.child.id, 's2']], 'one claim on the pane, for the session it runs');
  const old = on(m.f1, () => readParent(f1)!.children.find((entry) => entry.id === first))!;
  assert.equal(old.session?.value, 's1');
  assert.ok(old.exitedAt, 'the child adopted on s1 stays exited');
});

// IdStableBySession (issue #244). Trace: FarAdopt(f1, x), FarAdopt(f1, y), SessionChange(x, none), SessionChange(y, s1), WatcherLeave, FarAdopt(f1, y).
test('a far parent that adopts again a session resumed by hand over its own stale claim in that pane keeps the id it first gave the session', async (t) => {
  const m = machines(t);
  const f1 = newParent(m.f1, 'f1');
  const panes: Record<string, string | undefined> = { [X]: 's1', [Y]: 's2' };
  const client = herdrPanes(panes);

  const a = (await farAdopt(m.f1, f1, m.pane, client, false, X)).child.id;
  const b = (await farAdopt(m.f1, f1, m.pane, client, false, Y)).child.id;
  panes[X] = undefined;
  panes[Y] = 's1';
  leaveWithClaimKept(m.f1, f1, b, 's1');

  const again = await farAdopt(m.f1, f1, m.pane, client, false, Y);
  assert.equal(again.child.id, a, `session s1 was first adopted as ${a}, and adopting it again in pane ${Y} gave ${again.child.id}`);
  const rows = on(m.f1, () => readParent(f1)!.children.map((entry) => [entry.id, entry.paneId, entry.session?.value, entry.exitedAt ? 'exited' : 'live']));
  assert.deepEqual(rows.sort(), [[a, Y, 's1', 'live'], [b, Y, 's2', 'exited']].sort());
  const claims = on(m.pane, () => listRelayRecords().filter((record) => record.adopted && !record.retiredAt).map((record) => [record.childId, record.paneId, record.session]));
  assert.deepEqual(claims, [[a, Y, 's1']], 'the pane machine holds one claim, for the session pane y runs');
});

// RouteUnambiguous, with every relay answer and cleanup arriving (issue #244).
// Trace: LocalAdopt(l1, x), SessionChange(x, none), WatcherExit, SessionChange(x, s1), FarAdopt(f1, x), ComeBack.
test('a local adopted child that waits for its session yields its pane to a far claim made before the session came back, so the session answers to one parent', async (t) => {
  const { r, first } = await adoptAndWatch(t);
  quit(r, X);
  await until('the exit, waiting for the session', () => r.child(first)?.awaitsResume !== undefined);
  // The session comes back, and a parent on another machine adopts the pane before this watcher hears of it.
  runsQuietly(r, X, S1);
  assert.deepEqual(claimPane({ parentId: 'claude-code-far', childId: 'kid-far', name: 'far-mate', kind: 'claude', paneId: X, session: S1 }), { childId: 'kid-far', held: false });
  r.fake.send({ event: 'pane_agent_detected', data: { pane_id: X, workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: sess(S1) } });
  await until('the wait to end', () => r.child(first)?.awaitsResume === undefined);
  assert.ok(r.child(first)?.exitedAt, `child ${first} came back in pane ${X} while a parent on another machine holds it`);
  assert.deepEqual(adoptedParentOf({ paneId: X, session: S1 }), { parentId: 'claude-code-far', childId: 'kid-far', name: 'far-mate', where: 'away' });
});
