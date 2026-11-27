// The agent tree as `bellwether ancestry` answers it: a pure function of the
// registry, the connected sessions and the parents the daemon watches. Each
// case builds the records by hand, so it names exactly what the daemon knows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANCESTRY_SCHEMA, ancestry, parseAgent, type AncestryAnswer, type AncestryLevel } from '../../src/core/ancestry.ts';
import { emptyParent } from '../../src/core/registry.ts';
import type { ChildRecord, ParentRecord } from '../../src/core/types.ts';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T11:00:00.000Z';
const T2 = '2026-11-01T12:00:00.000Z';
const T3 = '2026-11-01T13:00:00.000Z';

function child(id: string, kind: string, session: string | undefined, extra: Partial<ChildRecord> = {}): ChildRecord {
  return {
    id,
    name: `name-${id}`,
    kind,
    harness: kind === 'claude' ? 'claude-code' : kind,
    paneId: `w1:${id}`,
    host: 'local',
    startedAt: T0,
    lastStatus: 'idle',
    statusChangedAt: T0,
    lastBusyAt: T0,
    depth: 1,
    ...(session ? { session: { kind: kind === 'pi' ? 'path' : 'id', value: session } } : {}),
    ...extra,
  };
}

function parent(harness: ParentRecord['harness'], session: string, children: ChildRecord[], extra: Partial<ParentRecord> = {}): ParentRecord {
  return { ...emptyParent(harness, session, '/work', { host: 'local', ...extra }), children };
}

/** root (claude, connected) → mid (pi child of root) → leaf (claude child of mid). */
function threeLevels(leafExtra: Partial<ChildRecord> = {}, midExtra: Partial<ChildRecord> = {}): ParentRecord[] {
  const mid = child('mid0000000000001', 'pi', '/home/u/.pi/agent/sessions/--work--/2026-11-01T10-00-00-000Z_pi-mid-session.jsonl', midExtra);
  const leaf = child('leaf000000000001', 'claude', 'claude-leaf-session', { depth: 2, ...leafExtra });
  return [
    parent('claude-code', 'claude-root-session', [mid]),
    parent('pi', 'pi-mid-session', [leaf], { childId: mid.id, depth: 1 }),
  ];
}

const live = { connected: [{ parentId: 'claude-code-claude-root-session', connectedAt: T1 }], watched: ['claude-code-claude-root-session', 'pi-pi-mid-session'] };

test('the agent notation names a harness and a session, and a bare value is a child id or a session', () => {
  assert.deepEqual(parseAgent('claude:abc'), { prefix: 'claude', session: 'abc' });
  assert.deepEqual(parseAgent('claude-code:abc'), { prefix: 'claude', session: 'abc' });
  assert.deepEqual(parseAgent('pi:/x/2026-11-01T10-00-00-000Z_uuid-1.jsonl'), { prefix: 'pi', session: 'uuid-1' });
  assert.deepEqual(parseAgent('abc'), { session: 'abc' });
  assert.equal(parseAgent('  '), undefined);
});

test('a two-level tree: the child retired, its parent is alive, and the chain names the parent first', () => {
  const records = threeLevels({ exitedAt: T2, retiredAt: T3, retireOutcome: 'removed' });
  const answer = ancestry('claude:claude-leaf-session', records, live);
  assert.equal(answer.status, 'known');
  assert.equal(answer.stale, false);
  assert.equal(answer.agent?.alive, false);
  assert.equal(answer.agent?.evidence, 'exited');
  assert.equal(answer.agent?.since, T2);
  assert.equal(answer.agent?.retiredAt, T3);
  assert.equal(answer.chain[0]?.agent, 'pi:pi-mid-session');
  assert.equal(answer.chain[0]?.childName, 'name-mid0000000000001');
  assert.equal(answer.chain[0]?.alive, true);
  assert.equal(answer.chain[0]?.evidence, 'watched');
  assert.equal(answer.chain[1]?.agent, 'claude:claude-root-session');
  assert.equal(answer.chain[1]?.alive, true);
  assert.equal(answer.chain[1]?.evidence, 'connected');
  assert.equal(answer.chain[1]?.childName, null);
  assert.equal(answer.nearestAlive, 0);
  assert.equal(answer.top, 'root');
});

test('a middle agent that exited is marked not alive, and nearestAlive points past it', () => {
  const records = threeLevels({ exitedAt: T2 }, { exitedAt: T1 });
  const answer = ancestry('claude:claude-leaf-session', records, live);
  assert.deepEqual(answer.chain.map((level) => [level.agent, level.alive, level.evidence]), [
    ['pi:pi-mid-session', false, 'exited'],
    ['claude:claude-root-session', true, 'connected'],
  ]);
  assert.equal(answer.nearestAlive, 1);
});

test('an agent Bellwether never knew is unknown, not an empty chain', () => {
  const answer = ancestry('claude:never-seen', threeLevels(), live);
  assert.equal(answer.status, 'unknown');
  assert.equal(answer.agent, null);
  assert.equal(answer.top, null);
  assert.equal(answer.nearestAlive, null);
  // A root is known with an empty chain, which is the other answer a caller must tell apart.
  const root = ancestry('claude:claude-root-session', threeLevels(), live);
  assert.equal(root.status, 'known');
  assert.deepEqual(root.chain, []);
  assert.equal(root.top, 'root');
});

test('two records on one session: the alive one wins, then the latest start, and the answer names the rule', () => {
  // The leaf ran under mid, exited, and the root resumed it as a child of its own.
  const records = threeLevels({ exitedAt: T1 });
  const resumed = child('leaf000000000002', 'claude', 'claude-leaf-session', { origin: 'resume', startedAt: T2 });
  records[0]!.children.push(resumed);
  const answer = ancestry('claude:claude-leaf-session', records, live);
  assert.equal(answer.agent?.childId, 'leaf000000000002');
  assert.equal(answer.agent?.match.rule, 'alive');
  assert.deepEqual(answer.agent?.match.records.map((record) => record.childId), ['leaf000000000002', 'leaf000000000001']);
  assert.equal(answer.chain[0]?.agent, 'claude:claude-root-session');

  // Both exited: the latest start wins.
  resumed.exitedAt = T3;
  const both = ancestry('claude:claude-leaf-session', records, live);
  assert.equal(both.agent?.childId, 'leaf000000000002');
  assert.equal(both.agent?.match.rule, 'latest-start');

  // The same answer whatever order the files were read in.
  const reversed = ancestry('claude:claude-leaf-session', [...records].reverse().map((record) => ({ ...record, children: [...record.children].reverse() })), live);
  assert.deepEqual(reversed, both);
});

test('with the daemon down, the answer is stale: an exit on record stands, and nothing else is vouched for', () => {
  const records = threeLevels({ exitedAt: T2 });
  const answer = ancestry('claude:claude-leaf-session', records, { stale: 'no daemon answers on /h/daemon.sock' });
  assert.equal(answer.status, 'known');
  assert.equal(answer.stale, true);
  assert.equal(answer.staleReason, 'no daemon answers on /h/daemon.sock');
  assert.equal(answer.source, 'registry');
  assert.deepEqual([answer.agent, ...answer.chain].map((level) => [level?.alive, level?.evidence]), [
    [false, 'exited'],
    [null, 'stale'],
    [null, 'stale'],
  ]);
  assert.equal(answer.nearestAlive, null);
});

test('a session whose parent registry is on another machine ends the chain as outside', () => {
  const records = [parent('claude-code', 'far-child', [], { childId: 'c0ffee0000000001', depth: 1 })];
  const answer = ancestry('claude:far-child', records, { connected: [{ parentId: 'claude-code-far-child', connectedAt: T1 }], watched: [] });
  assert.equal(answer.top, 'outside');
  assert.equal(answer.agent?.alive, true);
  assert.equal(answer.agent?.childId, 'c0ffee0000000001');
});

test('an open child no running service watches is neither alive nor dead', () => {
  const answer = ancestry('claude:claude-leaf-session', threeLevels(), { connected: [], watched: [] });
  assert.equal(answer.agent?.alive, null);
  assert.equal(answer.agent?.evidence, 'unwatched');
  assert.equal(answer.chain[1]?.alive, false);
  assert.equal(answer.chain[1]?.evidence, 'disconnected');
});

/**
 * The contract: another program reads these names. Renaming one, or adding
 * one without documenting it in docs/tools.md, fails here first.
 */
test('the JSON shape is the documented contract', () => {
  const answer: AncestryAnswer = ancestry('claude:claude-leaf-session', threeLevels({ exitedAt: T2 }), live);
  assert.equal(ANCESTRY_SCHEMA, 1);
  assert.deepEqual(Object.keys(answer).sort(), ['agent', 'chain', 'nearestAlive', 'query', 'schema', 'source', 'stale', 'status', 'top']);
  const level: AncestryLevel = answer.chain[0]!;
  assert.deepEqual(Object.keys(level).sort(), ['agent', 'alive', 'childId', 'childName', 'depth', 'evidence', 'harness', 'host', 'match', 'registryId', 'retiredAt', 'session', 'since']);
  assert.deepEqual(Object.keys(level.match).sort(), ['records', 'rule']);
  assert.deepEqual(Object.keys(level.match.records[0]!).sort(), ['childId', 'parentId', 'startedAt']);
  const stale = ancestry('claude:x', [], { stale: 'down' });
  assert.deepEqual(Object.keys(stale).sort(), ['agent', 'chain', 'nearestAlive', 'query', 'schema', 'source', 'stale', 'staleReason', 'status', 'top']);
});
