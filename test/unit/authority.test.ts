// Tier 1: the decision table in src/core/authority.ts (issue #279). Each row
// is a standing a child can have, each column an act a parent asks for, and
// every cell is pinned here: a permit as a permit, and a refusal with the
// words of its reason, because a refusal without a reason reads as a bug.
// The doctor lines and the judgement of a pane's holders are pinned too.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTS, STANDINGS, authorityLines, contestedRefusal, heldByAdoption, judgeHolders, refusal, standingOf, type Act, type PaneHolder, type Standing } from '../../src/core/authority.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import type { RelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord, ParentRecord } from '../../src/core/types.ts';

const AT = '2026-11-28T08:00:00.000Z';

/** A child record on each row of the table. */
function childOn(standing: Standing): ChildRecord {
  const base = { id: 'c-0279', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p2', host: LOCAL_HOST, startedAt: AT, lastStatus: 'idle', statusChangedAt: AT, lastBusyAt: AT, depth: 1 } as const;
  const rows: Record<Standing, Partial<ChildRecord>> = {
    started: { origin: 'spawn' },
    adopted: { origin: 'adopt' },
    claimed: { origin: 'adopt', host: 'child-box' },
    stale: { origin: 'spawn', host: 'child-box', farRecordLost: { at: AT, host: 'child-box', reason: 'machine child-box holds no running child c-0279' } },
    unconfirmed: { origin: 'adopt', host: 'child-box', adoptInDoubt: { at: AT, host: 'child-box', reason: 'machine child-box did not answer within 1 ms' } },
    contested: { origin: 'adopt', host: 'child-box', farRecordLost: { at: AT, host: 'child-box', reason: 'pane w1:p2 is already a child of pi-other', contested: true } },
    replaced: { origin: 'adopt', host: 'child-box', replacedBy: 'c-new' },
    freed: { origin: 'spawn' },
  };
  return { ...base, ...rows[standing] } as ChildRecord;
}

/**
 * The table as an operator reads it: a cell is either `yes` or the words its
 * refusal must contain. A freed child leaves its parent's registry (issue
 * #262), so no child record carries the freed standing, and its cells are
 * read with the standing named.
 */
const EXPECTED: Record<Standing, Record<Act, 'yes' | RegExp>> = {
  started: { message: 'yes', restart: 'yes', resume: 'yes', move: 'yes', teleport: 'yes', retire: 'yes', free: 'yes' },
  adopted: {
    message: 'yes',
    restart: /was adopted, not started by Bellwether, so agent_restart will not close pane w1:p2: it closes only panes Bellwether started\./,
    resume: 'yes',
    move: /was adopted, not started by Bellwether, so agent_move will not close pane w1:p2: a move closes the pane it leaves, and Bellwether closes only panes it started\./,
    teleport: /worker is an adopted child\. .*issues\/219/,
    retire: /was adopted, not spawned by Bellwether, so Bellwether never removes its worktree/,
    free: /worker is an adopted child: Bellwether did not start it, so its session holds no record of a parent to leave/,
  },
  claimed: {
    message: 'yes',
    restart: /was adopted, not started by Bellwether, so agent_restart will not close pane w1:p2/,
    resume: 'yes',
    move: /was adopted, not started by Bellwether, so agent_move will not close pane w1:p2/,
    teleport: /worker is an adopted child\. .*issues\/219/,
    retire: /was adopted, not spawned by Bellwether, so Bellwether never removes its worktree/,
    free: /worker is an adopted child/,
  },
  stale: { message: 'yes', restart: 'yes', resume: 'yes', move: 'yes', teleport: 'yes', retire: 'yes', free: 'yes' },
  unconfirmed: Object.fromEntries(ACTS.map((act) => [act, new RegExp(`is unconfirmed: the relay lost machine child-box's answer to its adoption at ${AT} \\(machine child-box did not answer within 1 ms\\), so this parent does not know whether it holds pane w1:p2 or another parent does\\. The watcher asks that machine again, and ${verb(act)} waits for its answer\\.`)])) as Record<Act, RegExp>,
  contested: Object.fromEntries(ACTS.map((act) => [act, new RegExp(`^Two sources of authority disagree about worker \\(child c-0279\\): this parent's registry holds it in pane w1:p2 on machine child-box, and that machine's claims answer otherwise since ${AT}: pane w1:p2 is already a child of pi-other\\. Bellwether does not pick one, so it refuses ${verb(act)} for worker\\.`)])) as Record<Act, RegExp>,
  replaced: Object.fromEntries(ACTS.map((act) => [act, new RegExp(`was replaced: machine child-box holds its session as child c-new, so ${verb(act)} goes to c-new, not to this record\\.`)])) as Record<Act, RegExp>,
  freed: Object.fromEntries(ACTS.map((act) => [act, new RegExp(`^freed: no parent holds worker \\(child c-0279\\), so ${verb(act)} has no parent to act for\\.`)])) as Record<Act, RegExp>,
};

function verb(act: Act): string {
  return { message: 'a message', restart: 'agent_restart', resume: 'a resume', move: 'agent_move', teleport: 'agent_teleport', retire: 'retirement', free: 'agent_free' }[act];
}

test('each record sits on the row it describes', () => {
  for (const standing of STANDINGS) {
    if (standing === 'freed') continue;
    assert.equal(standingOf(childOn(standing)), standing, standing);
  }
  assert.equal(standingOf({ host: LOCAL_HOST }), 'started', 'a record from before origin means spawn');
  assert.equal(standingOf({ origin: 'resume', host: LOCAL_HOST }), 'started', 'a session Bellwether resumed is one it started');
  assert.equal(standingOf({ origin: 'adopt', launchedAt: AT, host: LOCAL_HOST }), 'started', 'an adopted child a resume relaunched is held as started (issue #256)');
  assert.equal(refusal({ ...childOn('adopted'), launchedAt: AT }, 'restart'), undefined, 'so a restart may close the pane Bellwether opened');
});

for (const standing of STANDINGS) {
  test(`row ${standing}: every act is permitted or refused with its reason`, () => {
    for (const act of ACTS) {
      const why = refusal(childOn(standing), act, { target: 'hawthorne' }, standing);
      const expected = EXPECTED[standing][act];
      if (expected === 'yes') assert.equal(why, undefined, `${standing} × ${act} should be permitted, and was refused: ${why}`);
      else assert.match(why ?? '(permitted)', expected, `${standing} × ${act}`);
    }
  });
}

test("a claim whose machine has not confirmed it since the relay came back is unconfirmed, and every act waits (issue #257)", () => {
  const open = { ...childOn('claimed'), claimUnconfirmed: { at: AT, host: 'child-box', reason: 'machine child-box predates relay-adopt' } };
  assert.equal(standingOf(open), 'unconfirmed');
  for (const act of ACTS) assert.match(refusal(open, act) ?? '(permitted)', new RegExp(`is unconfirmed: since ${AT}, machine child-box has not confirmed it still holds the pane for this parent \\(machine child-box predates relay-adopt\\), so this parent does not know whether it holds pane w1:p2 or another parent does\\. The watcher asks that machine again, and ${verb(act)} waits for its answer\\.`), act);
});

test('a stale record answers as the row of how its parent holds it', () => {
  const adoptedStale = { ...childOn('adopted'), farRecordLost: { at: AT, host: LOCAL_HOST, reason: 'gone' } };
  assert.equal(standingOf(adoptedStale), 'stale');
  assert.match(refusal(adoptedStale, 'restart') ?? '', /was adopted, not started by Bellwether/);
  assert.equal(refusal(adoptedStale, 'message'), undefined);
});

test('the teleport refusal names the destination it would carry the disagreement to', () => {
  assert.match(refusal(childOn('adopted'), 'teleport', { target: 'hawthorne' }) ?? '', /carry that disagreement to machine hawthorne\./);
  assert.match(refusal(childOn('adopted'), 'teleport', { target: LOCAL_HOST }) ?? '', /carry that disagreement to this machine\./);
});

test('the answer that discovers a conflict refuses as the contested row does', () => {
  assert.match(contestedRefusal(childOn('claimed'), 'message', { host: 'child-box', reason: 'pane w1:p2 is already a child of pi-other' }, new Date(AT)), EXPECTED.contested.message as RegExp);
});

test('one line decides every policy that differs for an adopted child, which issue #256 changes', () => {
  assert.equal(heldByAdoption({ origin: 'adopt' }), true);
  assert.equal(heldByAdoption({ origin: 'adopt', launchedAt: AT }), false, 'a resume relaunched it in a tab Bellwether opened (issue #256)');
  assert.equal(heldByAdoption({ origin: 'resume' }), false);
  assert.equal(heldByAdoption({ origin: 'spawn' }), false);
  assert.equal(heldByAdoption({}), false);
});

const holder = (source: PaneHolder['source'], parentId: string, childId: string, extra: Partial<PaneHolder> = {}): PaneHolder => ({ source, parentId, childId, name: childId, ...extra });

test('a pane with one holder, or one holder named twice, has that holder', () => {
  assert.deepEqual(judgeHolders(LOCAL_HOST, 'w1:p2', []), { kind: 'none' });
  const one = holder('registry', 'pi-a', 'c-1');
  assert.deepEqual(judgeHolders(LOCAL_HOST, 'w1:p2', [one, { ...one }]), { kind: 'one', holder: one });
});

test("an adoption's claim for a session the pane no longer runs is stale and yields", () => {
  const live = holder('registry', 'pi-a', 'c-1', { session: 'S-now' });
  const stale = holder('claim', 'pi-far', 'c-far', { adopted: true, session: 'S-before' });
  assert.deepEqual(judgeHolders(LOCAL_HOST, 'w1:p2', [live, stale]), { kind: 'one', holder: live });
});

test('two registries, or a registry and a claim on the same session, disagree, and the reason names both', () => {
  const two = judgeHolders(LOCAL_HOST, 'w1:p2', [holder('registry', 'pi-a', 'c-1', { session: 'S1' }), holder('registry', 'pi-b', 'c-2', { session: 'S2' })]);
  assert.equal(two.kind, 'contested');
  assert.match(two.kind === 'contested' ? two.reason : '', /^Pane w1:p2 on this machine is held by two sources of authority that disagree: the registry of parent pi-a on this machine, as child c-1 \(c-1\) on session S1, and the registry of parent pi-b on this machine, as child c-2 \(c-2\) on session S2\. Bellwether does not pick one\.$/);
  const claimed = judgeHolders(LOCAL_HOST, 'w1:p2', [holder('registry', 'pi-a', 'c-1', { session: 'S1' }), holder('claim', 'pi-far', 'c-far', { adopted: true, session: 'S1' })]);
  assert.match(claimed.kind === 'contested' ? claimed.reason : '', /the registry of parent pi-a on this machine, .* and the adoption claim of parent pi-far on another machine, as child c-far/);
});

test('doctor prints who holds each live child, on which machine and by what evidence', () => {
  const parent = (id: string, children: ChildRecord[]): ParentRecord => ({ id, children }) as unknown as ParentRecord;
  const started = { ...childOn('started'), id: 'c-s', name: 'builder', session: { kind: 'id', value: 'S1' } } as ChildRecord;
  const claimed = { ...childOn('claimed'), id: 'c-c', name: 'first-mate' } as ChildRecord;
  const doubtful = { ...childOn('unconfirmed'), id: 'c-u', name: 'doubtful' } as ChildRecord;
  const contested = { ...childOn('contested'), id: 'c-x', name: 'contested' } as ChildRecord;
  const exited = { ...childOn('started'), id: 'c-e', exitedAt: AT } as ChildRecord;
  const lines = authorityLines([parent('pi-a', [started, claimed, doubtful, contested, exited])], []);
  assert.deepEqual(lines, [
    'ok    authority: builder (child c-s) on this machine is started, held by parent pi-a; evidence: the registry of parent pi-a on this machine, which started it in pane w1:p2.',
    'ok    authority: first-mate (child c-c) on machine child-box is claimed, held by parent pi-a; evidence: the registry of parent pi-a on this machine, which adopted pane w1:p2, and the claim it left on machine child-box.',
    `warn  authority: doubtful (child c-u) on machine child-box is unconfirmed, held by parent pi-a; evidence: the registry of parent pi-a on this machine alone: machine child-box has not confirmed the claim since ${AT}.`,
    `fail  authority: contested (child c-x) on machine child-box is contested, held by parent pi-a; evidence: Two sources of authority disagree about contested (child c-x): this parent's registry holds it in pane w1:p2 on machine child-box, and that machine's claims answer otherwise since ${AT}: pane w1:p2 is already a child of pi-other.`,
  ]);
});

test('doctor names a pane whose sources disagree with a fail line, and a pane a far parent holds here', () => {
  const parent = (id: string, children: ChildRecord[]): ParentRecord => ({ id, children }) as unknown as ParentRecord;
  const adoptedHere = { ...childOn('adopted'), id: 'c-a', name: 'hand-started', session: { kind: 'id', value: 'S1' } } as ChildRecord;
  const claim = (paneId: string, session: string): RelayRecord => ({ schema: 1, childId: `c-far-${paneId}`, name: 'far-held', kind: 'claude', parentId: 'pi-far', registeredAt: AT, paneId, adopted: true, session }) as RelayRecord;
  const lines = authorityLines([parent('pi-a', [adoptedHere])], [claim('w1:p2', 'S1'), claim('w1:p9', 'S9')]);
  assert.ok(lines.includes('fail  authority: Pane w1:p2 on this machine is held by two sources of authority that disagree: the registry of parent pi-a on this machine, as child c-a (hand-started) on session S1, and the adoption claim of parent pi-far on another machine, as child c-far-w1:p2 (far-held) on session S1. Bellwether does not pick one.'), lines.join('\n'));
  assert.ok(lines.includes('ok    authority: pane w1:p9 on this machine is held by parent pi-far on another machine, as child c-far-w1:p9 (far-held); evidence: its adoption claim in this machine\'s relay records.'), lines.join('\n'));
});

test("a claim on a pane a parent here started is stale, because Bellwether opened that pane after it", () => {
  const parent = { id: 'pi-a', children: [{ ...childOn('started'), session: { kind: 'id', value: 'S1' } }] } as unknown as ParentRecord;
  const claim = { schema: 1, childId: 'c-far', name: 'far', kind: 'claude', parentId: 'pi-far', registeredAt: AT, paneId: 'w1:p2', adopted: true } as RelayRecord;
  assert.ok(!authorityLines([parent], [claim]).some((line) => line.startsWith('fail')));
});
