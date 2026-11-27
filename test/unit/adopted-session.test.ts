// Tier 1: which parent a session Bellwether did not start answers to, once a
// parent adopts its pane, and when a reused pane id answers to nobody.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptedParentOf, sameSession } from '../../src/core/adopted-session.ts';
import { emptyParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, saveRelayRecord } from '../../src/core/relay-records.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { isolate } from '../fixtures/isolated.ts';

function adopted(id: string, paneId: string, session: string, extra: Partial<ChildRecord> = {}): ChildRecord {
  const at = new Date().toISOString();
  return { id, name: id, kind: 'pi', harness: 'pi', paneId, host: 'local', origin: 'adopt', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, session: { kind: 'path', value: session }, ...extra };
}

test('a session matches the adopted one by Claude Code id or by the pi session file that ends in its id', () => {
  assert.equal(sameSession('abc-123', 'abc-123'), true);
  assert.equal(sameSession('01a2-uuid', '/sessions/--w--/2026-11-27T00-00-00-000Z_01a2-uuid.jsonl'), true);
  assert.equal(sameSession('other', 'abc-123'), false);
  assert.equal(sameSession(undefined, 'abc-123'), true, 'an adapter that names no session leaves it to the pane');
  assert.equal(sameSession('pid-4242', 'abc-123'), true, 'a Claude Code server started outside Claude Code does not know its session');
  assert.equal(sameSession('abc-123', undefined), true, 'an adoption whose pane reported no session leaves it to the pane');
});

test('a session answers to the parent that adopted its pane here, then to one on another machine by its claim, and to nobody otherwise', (t) => {
  isolate(t, 'bellwether-adopted-unit-');
  const here = saveParent(emptyParent('claude-code', 'here', '/w', { paneId: 'w1:p0' })).id;
  upsertChild(here, adopted('kid-here', 'w1:p3', '/s/x_sess-here.jsonl'));
  upsertChild(here, adopted('kid-gone', 'w1:p4', '/s/x_sess-gone.jsonl', { exitedAt: new Date().toISOString() }));
  upsertChild(here, { ...adopted('kid-spawned', 'w1:p6', '/s/x_sess-spawned.jsonl'), origin: 'spawn' });
  saveRelayRecord({ schema: RELAY_SCHEMA, childId: 'kid-away', name: 'away', kind: 'claude', parentId: 'claude-code-far', registeredAt: new Date().toISOString(), paneId: 'w1:p5', adopted: true, session: 'sess-away' });

  assert.deepEqual(adoptedParentOf({ paneId: 'w1:p3', session: 'sess-here' }), { parentId: here, childId: 'kid-here', name: 'kid-here', where: 'here' });
  assert.deepEqual(adoptedParentOf({ paneId: 'w1:p5', session: 'sess-away' }), { parentId: 'claude-code-far', childId: 'kid-away', name: 'away', where: 'away' });
  assert.equal(adoptedParentOf({ paneId: 'w1:p3', session: 'sess-later' }), undefined, 'herdr reused the pane for another session');
  assert.equal(adoptedParentOf({ paneId: 'w1:p5', session: 'sess-later' }), undefined, 'the same holds for a claim from another machine');
  assert.equal(adoptedParentOf({ paneId: 'w1:p4', session: 'sess-gone' }), undefined, 'an exited child answers for nobody');
  assert.equal(adoptedParentOf({ paneId: 'w1:p6', session: 'sess-spawned' }), undefined, 'a spawned child gets its parent from its start, not from its pane');
  assert.equal(adoptedParentOf({ paneId: 'w1:p3', session: 'sess-here', childId: 'its-own' }), undefined, 'a session with a child id keeps it');
  assert.equal(adoptedParentOf({ session: 'sess-here' }), undefined, 'a session outside herdr has no pane to be adopted in');
});
