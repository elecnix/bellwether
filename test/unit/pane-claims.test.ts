// Tier 1: who may adopt a pane (issue #118). The decision is a pure function
// of the claim and the pane's holder, and the target of agent_adopt names its
// machine or not. A case that touches disk uses the scratch home the
// isolation preload gives this file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptPane } from '../../src/core/adopt.ts';
import type { HerdrClient, HerdrPane } from '../../src/core/herdr-client.ts';
import { claimPane, decideClaim, type Claimant } from '../../src/core/pane-claims.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, readRelayRecord, removeRelayRecord, saveRelayRecord, type RelayRecord } from '../../src/core/relay-records.ts';
import { parseRequest } from '../../src/daemon/protocol.ts';
import { adoptTarget } from '../../src/integrations/tools.ts';

/** A claim a parent on another machine left here. */
const relay = (record: Partial<RelayRecord> = {}): RelayRecord => ({ schema: RELAY_SCHEMA, childId: 'kid-a', name: 'mate', kind: 'claude', parentId: 'parent-a', registeredAt: '2026-11-27T00:00:00.000Z', paneId: 'w1:p5', adopted: true, session: 's1', ...record });
const away = (record: Partial<RelayRecord> = {}): Claimant => ({ where: 'away', record: relay(record) });

test('a pane nobody holds is taken', () => {
  assert.deepEqual(decideClaim({ parentId: 'parent-b', paneId: 'w1:p5', session: 's1' }, undefined), { kind: 'take' });
});

test('a pane a parent on that machine holds is refused with its parent and name', () => {
  const decision = decideClaim({ parentId: 'parent-b', paneId: 'w1:p5' }, { where: 'here', parentId: 'pi-local', childId: 'kid-l', name: 'worker' });
  assert.deepEqual(decision, { kind: 'refuse', reason: 'pane w1:p5 is already a child of pi-local, a parent on that machine, as worker' });
});

test('a pane a parent on another machine holds is refused, and the same parent gets its own child id back', () => {
  assert.deepEqual(decideClaim({ parentId: 'parent-b', paneId: 'w1:p5', session: 's1' }, away()), { kind: 'refuse', reason: 'pane w1:p5 is already a child of parent-a, a parent on another machine, as mate' });
  assert.deepEqual(decideClaim({ parentId: 'parent-a', paneId: 'w1:p5', session: 's1' }, away()), { kind: 'held', childId: 'kid-a' });
});

test('a claim for another session in the same pane id is stale, and one with no session to compare still holds', () => {
  assert.deepEqual(decideClaim({ parentId: 'parent-b', paneId: 'w1:p5', session: 's2' }, away()), { kind: 'take' });
  assert.equal(decideClaim({ parentId: 'parent-b', paneId: 'w1:p5' }, away()).kind, 'refuse');
  assert.equal(decideClaim({ parentId: 'parent-b', paneId: 'w1:p5', session: 's2' }, away({ session: undefined })).kind, 'refuse');
});

test('claimPane writes an adopted relay record, and replaces a stale one', () => {
  saveRelayRecord(relay());
  assert.throws(() => claimPane({ parentId: 'parent-b', childId: 'kid-b', name: 'mine', kind: 'claude', paneId: 'w1:p5', session: 's1' }), /already a child of parent-a/);
  assert.deepEqual(claimPane({ parentId: 'parent-b', childId: 'kid-b', name: 'mine', kind: 'claude', paneId: 'w1:p5', session: 's9' }), { childId: 'kid-b', held: false });
  assert.equal(readRelayRecord('kid-a'), undefined);
  const record = readRelayRecord('kid-b');
  assert.equal(record?.adopted, true);
  assert.equal(record?.paneId, 'w1:p5');
  assert.equal(record?.session, 's9');
  assert.deepEqual(claimPane({ parentId: 'parent-b', childId: 'kid-other', name: 'mine', kind: 'claude', paneId: 'w1:p5', session: 's9' }), { childId: 'kid-b', held: true });
  removeRelayRecord('kid-b');
});

test('a local adoption is refused when a parent on another machine adopted the pane here', async () => {
  const pane: HerdrPane = { paneId: 'w1:p7', workspaceId: 'w1', tabId: 'w1:t7', terminalId: 't7', focused: false, revision: 0, agent: 'claude', name: 'far-watched', agentStatus: 'idle', agentSessionId: 's7' };
  const client = { agentList: async () => [pane], paneList: async () => [pane] } as unknown as HerdrClient;
  const parent = saveParent(emptyParent('pi', 'local-adopter', '/work', {}));
  saveRelayRecord(relay({ childId: 'kid-r', paneId: 'w1:p7', session: 's7' }));
  await assert.rejects(adoptPane(client, parent, { target: 'w1:p7' }), /Pane w1:p7 on local cannot be adopted: pane w1:p7 is already a child of parent-a, a parent on another machine, as mate\./);
  removeRelayRecord('kid-r');
  assert.equal((await adoptPane(client, parent, { target: 'w1:p7' })).child.host, 'local');
});

test('a remote adoption without a relay is refused before any record', async () => {
  const pane: HerdrPane = { paneId: 'w1:p8', workspaceId: 'w1', tabId: 'w1:t8', terminalId: 't8', focused: false, revision: 0, agent: 'claude', agentStatus: 'idle' };
  const client = { agentList: async () => [pane], paneList: async () => [pane] } as unknown as HerdrClient;
  const parent = saveParent(emptyParent('pi', 'no-relay', '/work', {}));
  await assert.rejects(adoptPane(client, parent, { target: 'w1:p8', host: 'child-box' }), /holds no relay connection to machine child-box/);
});

test('an adoption target names its machine before the pane, and a bare pane id names none', () => {
  assert.deepEqual(adoptTarget('w32:p1'), { host: 'local', target: 'w32:p1' });
  assert.deepEqual(adoptTarget('w32:p1', 'child-box'), { host: 'child-box', target: 'w32:p1' });
  assert.deepEqual(adoptTarget('child-box:w32:p1'), { host: 'child-box', target: 'w32:p1' });
  assert.deepEqual(adoptTarget('child-box:first-mate'), { host: 'child-box', target: 'first-mate' });
  assert.deepEqual(adoptTarget('first-mate'), { host: 'local', target: 'first-mate' });
  assert.deepEqual(adoptTarget('child-box:w32:p1', 'child-box'), { host: 'child-box', target: 'w32:p1' });
  assert.throws(() => adoptTarget('child-box:w32:p1', 'other-box'), /names machine other-box, but its target child-box:w32:p1 names machine child-box/);
});

test('relay-adopt parses with its claim, and refuses one without a pane', () => {
  assert.deepEqual(parseRequest(JSON.stringify({ type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', name: 'mate', kind: 'claude', paneId: 'w1:p5', session: 's1' })), { type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', name: 'mate', kind: 'claude', paneId: 'w1:p5', session: 's1' });
  assert.throws(() => parseRequest(JSON.stringify({ type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', kind: 'claude' })), /a relay adopt needs/);
});
