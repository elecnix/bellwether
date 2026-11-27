// The inactivity notification, end to end inside the unit tier: a spawn stores
// the threshold on the child record, the record gives the limits, and the
// classifier fires on a fake clock. Nothing waits on a real timer, and no
// herdr is reached. The registry is the file-backed one pointed at a scratch
// home, the same convention the registry and outbox tests use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  DEFAULT_LIMITS,
  advance,
  initialState,
  limitsFor,
  markReported,
  seedFor,
  type ClassifierState,
  type Observation,
  type SettleLimits,
} from '../../src/core/classifier.ts';
import { DEFAULT_INACTIVE_MS, MAX_INACTIVE_MS, MIN_INACTIVE_MS, resolveInactiveMs } from '../../src/core/inactivity.ts';
import { isSuperseded } from '../../src/core/outbox.ts';
import type { HerdrClient } from '../../src/core/herdr-client.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import type { Watcher } from '../../src/core/watcher.ts';
import type { ChildEventKind, ChildRecord } from '../../src/core/types.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-inactivity-'));
process.env['BELLWETHER_HOME'] = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const MINUTE = 60_000;

/** A herdr stand-in that answers only the calls a spawn makes. */
function fakeHerdr(): HerdrClient {
  let tabs = 0;
  const client = {
    tabCreate: async () => {
      tabs += 1;
      return { tabId: `tab-${tabs}`, paneId: `w1:p${tabs}` };
    },
    agentStart: async () => undefined,
    agentList: async () => [],
    tabClose: async () => undefined,
  };
  return client as unknown as HerdrClient;
}

let session = 0;

/** Spawn a child through the real spawn path and read its record back from the registry. */
async function spawnedChild(inactiveMinutes?: number): Promise<ChildRecord> {
  session += 1;
  const parent = saveParent(emptyParent('pi', `inactivity-${session}`, '/work'));
  await spawnChild(fakeHerdr(), parent, { kind: 'pi', name: 'worker', inactiveMinutes });
  const child = readParent(parent.id)?.children[0];
  assert.ok(child, 'the child record is in the registry');
  return child;
}

type Event = { at: number; event: ChildEventKind };

/**
 * Step a fake clock one second at a time. `observed` maps a second to the
 * observation made then; every other second repeats the current status.
 */
function run(
  limits: SettleLimits,
  to: number,
  observed: Record<number, Observation> = {},
  start: ClassifierState = initialState('working', 0),
  from = 0,
): { state: ClassifierState; events: Event[]; inactive: number[] } {
  let state = start;
  const events: Event[] = [];
  for (let now = from; now <= to; now += 1_000) {
    const observation = observed[now] ?? { status: state.status };
    const result = advance(state, observation, now, limits);
    state = result.state;
    if (result.event) events.push({ at: now, event: result.event });
  }
  return { state, events, inactive: events.filter((entry) => entry.event === 'inactive').map((entry) => entry.at) };
}

test('a child spawned with no value fires inactive at five minutes', async () => {
  const child = await spawnedChild();
  assert.equal(child.inactiveMs, 5 * MINUTE);
  assert.equal(DEFAULT_INACTIVE_MS, 5 * MINUTE);

  const limits = limitsFor(child, DEFAULT_LIMITS);
  const { inactive } = run(limits, 10 * MINUTE);
  assert.deepEqual(inactive, [5 * MINUTE], 'once, at exactly five minutes');
});

test('an explicit override from the spawn sets the threshold on the record', async () => {
  const child = await spawnedChild(2);
  assert.equal(child.inactiveMs, 2 * MINUTE);

  const { inactive } = run(limitsFor(child, DEFAULT_LIMITS), 10 * MINUTE);
  assert.deepEqual(inactive, [2 * MINUTE]);
});

test('the spawn tool passes inactive_minutes through to the stored record', async () => {
  session += 1;
  const parent = saveParent(emptyParent('pi', `inactivity-${session}`, '/work'));
  const ctx = { client: fakeHerdr(), parentId: parent.id, watcher: undefined as unknown as Watcher };
  await runBellwetherTool(ctx, 'agent_spawn', { kind: 'pi', name: 'tooled', inactive_minutes: 7 });
  assert.equal(readParent(parent.id)?.children[0]?.inactiveMs, 7 * MINUTE);
});

test('a threshold above twenty-four hours is clamped to twenty-four hours', async () => {
  const child = await spawnedChild(48 * 60);
  assert.equal(child.inactiveMs, MAX_INACTIVE_MS);

  const { inactive } = run(limitsFor(child, DEFAULT_LIMITS), MAX_INACTIVE_MS + MINUTE);
  assert.deepEqual(inactive, [MAX_INACTIVE_MS]);
});

test('the clamp holds through the spawn tool too', async () => {
  session += 1;
  const parent = saveParent(emptyParent('pi', `inactivity-${session}`, '/work'));
  const ctx = { client: fakeHerdr(), parentId: parent.id, watcher: undefined as unknown as Watcher };
  await runBellwetherTool(ctx, 'agent_spawn', { kind: 'pi', name: 'huge', inactive_minutes: 1_000_000 });
  assert.equal(readParent(parent.id)?.children[0]?.inactiveMs, MAX_INACTIVE_MS);
});

test('no value disables the notification', () => {
  // Zero and negative values would otherwise switch it off or fire on every tick.
  assert.equal(resolveInactiveMs(0), MIN_INACTIVE_MS);
  assert.equal(resolveInactiveMs(-5), MIN_INACTIVE_MS);
  assert.equal(resolveInactiveMs(-Infinity), MIN_INACTIVE_MS);
  // Values that are not numbers fall back to the default rather than to nothing.
  assert.equal(resolveInactiveMs(Number.NaN), DEFAULT_INACTIVE_MS);
  assert.equal(resolveInactiveMs(undefined), DEFAULT_INACTIVE_MS);
  // Infinity is above the range and is clamped to it.
  assert.equal(resolveInactiveMs(Number.POSITIVE_INFINITY), MAX_INACTIVE_MS);
  assert.equal(resolveInactiveMs(1e12), MAX_INACTIVE_MS);
});

test('a zero override still leaves a live notification, at the one-minute floor', async () => {
  const child = await spawnedChild(0);
  assert.equal(child.inactiveMs, MIN_INACTIVE_MS);

  const { inactive } = run(limitsFor(child, DEFAULT_LIMITS), 3 * MINUTE);
  assert.deepEqual(inactive, [MIN_INACTIVE_MS]);
});

test('a quiet period fires inactive once and never repeats inside it', () => {
  const limits = { ...DEFAULT_LIMITS, inactiveMs: 2 * MINUTE };
  const { inactive, state } = run(limits, 30 * MINUTE);
  assert.deepEqual(inactive, [2 * MINUTE]);

  // Further ticks with no activity keep the period closed.
  const later = run(limits, 40 * MINUTE, {}, state, 30 * MINUTE);
  assert.deepEqual(later.inactive, [], 'a second run over the same quiet period sends nothing');
});

test('a blocked child counts as inactive, after its own blocked event', () => {
  const limits = { ...DEFAULT_LIMITS, inactiveMs: 5 * MINUTE };
  // The status change into blocked is itself activity, so the clock starts there.
  const { events, inactive } = run(limits, 10 * MINUTE, { 0: { status: 'blocked' } });
  assert.deepEqual(events.slice(0, 2), [
    { at: 3_000, event: 'blocked' },
    { at: 5 * MINUTE, event: 'inactive' },
  ]);
  assert.deepEqual(inactive, [5 * MINUTE], 'a dialog nobody answers is reported again at five minutes');
});

test('any observed activity restarts the clock', () => {
  const limits = { ...DEFAULT_LIMITS, inactiveMs: 5 * MINUTE };

  // Output or a moving transcript.
  const busy = run(limits, 15 * MINUTE, { [4 * MINUTE]: { status: 'working', busy: true } });
  assert.deepEqual(busy.inactive, [9 * MINUTE], 'the clock restarts at four minutes');

  // A status change and a new turn.
  const turn = run(limits, 15 * MINUTE, { [4 * MINUTE]: { status: 'idle', completionSeq: 1 } });
  assert.deepEqual(turn.inactive, [9 * MINUTE]);
});

test('a report restarts the clock', () => {
  const limits = { ...DEFAULT_LIMITS, inactiveMs: 5 * MINUTE };
  const first = run(limits, 4 * MINUTE);
  assert.deepEqual(first.inactive, []);

  // The child reports at four minutes; markReported starts a new period there,
  // so the first notice is at nine minutes, not at the five minutes the
  // child's first quiet period would have reached.
  const reported = markReported(first.state, 4 * MINUTE);
  const after = run(limits, 15 * MINUTE, {}, reported, 4 * MINUTE);
  assert.deepEqual(after.inactive, [9 * MINUTE]);
});

test('a restart resumes the quiet period instead of starting a new one', async () => {
  // A record whose last activity was at t=0, whose inactive event already went
  // out for that period, and which was then left alone.
  const child = await spawnedChild(5);
  const restored: ChildRecord = {
    ...child,
    lastBusyAt: new Date(0).toISOString(),
    statusChangedAt: new Date(0).toISOString(),
    inactiveNotifiedFor: new Date(0).toISOString(),
  };
  const limits = limitsFor(restored, DEFAULT_LIMITS);

  const quiet = run(limits, 20 * MINUTE, {}, seedFor(restored, 0));
  assert.deepEqual(quiet.inactive, [], 'the period that already fired is not sent again after a restart');

  // Activity after the restart opens a new period, which then fires once.
  const moved = run(limits, 20 * MINUTE, { [6 * MINUTE]: { status: 'working', busy: true } }, seedFor(restored, 0));
  assert.deepEqual(moved.inactive, [11 * MINUTE]);
});

test('a record that never fired still fires after a restart', async () => {
  const child = await spawnedChild(5);
  const restored: ChildRecord = { ...child, lastBusyAt: new Date(0).toISOString(), statusChangedAt: new Date(0).toISOString() };
  const { inactive } = run(limitsFor(restored, DEFAULT_LIMITS), 10 * MINUTE, {}, seedFor(restored, 0));
  assert.deepEqual(inactive, [5 * MINUTE]);
});

test('the threshold is read from the record, so an older record without one gets the default', () => {
  session += 1;
  const parent = saveParent(emptyParent('pi', `inactivity-${session}`, '/work'));
  const legacy: ChildRecord = {
    id: 'legacy',
    name: 'legacy',
    kind: 'pi',
    harness: 'pi',
    host: 'local',
    paneId: 'w9:p1',
    startedAt: new Date(0).toISOString(),
    lastStatus: 'working',
    statusChangedAt: new Date(0).toISOString(),
    lastBusyAt: new Date(0).toISOString(),
    depth: 1,
  };
  upsertChild(parent.id, legacy);
  const read = readParent(parent.id)?.children[0];
  assert.ok(read);
  assert.deepEqual(run(limitsFor(read, DEFAULT_LIMITS), 6 * MINUTE).inactive, [5 * MINUTE]);
});

test('an unread inactive notice is dropped once the child shows activity after it', () => {
  const writtenAt = new Date(5 * MINUTE).toISOString();
  const entry = { receipt: 'bw-1', childId: 'c', name: 'c', kind: 'pi', paneId: 'w1:p1', event: 'inactive' as const, text: 'quiet', at: writtenAt, read: false };
  const quiet: ChildRecord = { ...restoredChild(), lastBusyAt: new Date(0).toISOString(), statusChangedAt: new Date(0).toISOString() };
  assert.equal(isSuperseded(entry, quiet), false, 'still quiet, so the notice stands');

  const moved: ChildRecord = { ...quiet, lastBusyAt: new Date(6 * MINUTE).toISOString() };
  assert.equal(isSuperseded(entry, moved), true, 'output after the notice drops it');
});

function restoredChild(): ChildRecord {
  return {
    id: 'c',
    name: 'c',
    kind: 'pi',
    harness: 'pi',
    host: 'local',
    paneId: 'w1:p1',
    startedAt: new Date(0).toISOString(),
    lastStatus: 'working',
    statusChangedAt: new Date(0).toISOString(),
    lastBusyAt: new Date(0).toISOString(),
    depth: 1,
  };
}
