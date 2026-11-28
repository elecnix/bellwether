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
import { Watcher } from '../../src/core/watcher.ts';
import { adoptTarget, runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';

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
  assert.deepEqual(adoptTarget('w32:p1'), { host: 'local', target: 'w32:p1', otherReading: { host: 'w32', target: 'p1' } });
  assert.deepEqual(adoptTarget('w32:p1', 'child-box'), { host: 'child-box', target: 'w32:p1' });
  assert.deepEqual(adoptTarget('child-box:w32:p1'), { host: 'child-box', target: 'w32:p1' });
  assert.deepEqual(adoptTarget('child-box:first-mate'), { host: 'child-box', target: 'first-mate' });
  assert.deepEqual(adoptTarget('first-mate'), { host: 'local', target: 'first-mate' });
  assert.deepEqual(adoptTarget('child-box:w32:p1', 'child-box'), { host: 'child-box', target: 'w32:p1' });
  assert.throws(() => adoptTarget('child-box:w32:p1', 'other-box'), /names machine other-box, but its target child-box:w32:p1 names machine child-box/);
});

// Issue #233: a fleet past a hundred workspaces gets ids such as w7R, and
// a pane there is w7R:p1. Every other fixture uses w1, where the old pattern,
// w and digits, never failed.
test('a pane id from a workspace with a letter, as w7R:p1, is a pane on this machine, not the agent p1 on a machine w7R (issue #233)', () => {
  assert.deepEqual(adoptTarget('w7R:p1'), { host: 'local', target: 'w7R:p1', otherReading: { host: 'w7R', target: 'p1' } });
  assert.deepEqual(adoptTarget('w7R:p1', 'child-box'), { host: 'child-box', target: 'w7R:p1' });
  assert.deepEqual(adoptTarget('child-box:w7R:p1'), { host: 'child-box', target: 'w7R:p1' });
  assert.deepEqual(adoptTarget('child-box:w7R:pB'), { host: 'child-box', target: 'w7R:pB' });
  // Halves that are not a pane id name a machine and an agent, as before.
  assert.deepEqual(adoptTarget('w7R:first-mate'), { host: 'w7R', target: 'first-mate' });
  assert.deepEqual(adoptTarget('web-box:p1'), { host: 'web-box', target: 'p1' });
});

/** A tool context whose herdr on this machine shows these panes, and whose saved machines are these. */
function adoptContext(panes: HerdrPane[], hosts: string[]): ToolContext {
  const client = { agentList: async () => panes, paneList: async () => panes } as unknown as HerdrClient;
  const parentId = saveParent(emptyParent('pi', `adopt-${hosts.join('-')}-${panes.length}`, '/work', {})).id;
  return { client, clientFor: async () => client, parentId, watcher: new Watcher({ client, parentId, onEntries: () => {} }), knownHosts: async () => hosts };
}

test('agent_adopt w7R:p1 adopts pane w7R:p1 on this machine (issue #233)', async () => {
  const pane: HerdrPane = { paneId: 'w7R:p1', workspaceId: 'w7R', tabId: 'w7R:t1', terminalId: 't71', focused: false, revision: 0, agent: 'claude', agentStatus: 'idle', name: 'deep-diver' };
  const text = await runBellwetherTool(adoptContext([pane], ['local']), 'agent_adopt', { target: 'w7R:p1' });
  assert.match(text, /^Adopted deep-diver, a claude agent in pane w7R:p1, as child /);
});

test('agent_adopt w7R:p1 with no such pane here and a saved machine labelled w7R refuses, naming both readings (issue #233)', async () => {
  await assert.rejects(
    runBellwetherTool(adoptContext([], ['local', 'w7R']), 'agent_adopt', { target: 'w7R:p1' }),
    /^Error: w7R:p1 reads two ways: pane w7R:p1 on this machine, which herdr does not show \(No pane or live agent on local matches w7R:p1\), or the agent p1 on the saved machine w7R\. Name the machine to adopt there/,
  );
  // With no machine of that label, the pane reading stands, and its own error comes back.
  await assert.rejects(runBellwetherTool(adoptContext([], ['local']), 'agent_adopt', { target: 'w7R:p1' }), /^Error: No pane or live agent on local matches w7R:p1\.$/);
});

test('relay-adopt parses with its claim, and refuses one without a pane', () => {
  assert.deepEqual(parseRequest(JSON.stringify({ type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', name: 'mate', kind: 'claude', paneId: 'w1:p5', session: 's1' })), { type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', name: 'mate', kind: 'claude', paneId: 'w1:p5', session: 's1' });
  assert.throws(() => parseRequest(JSON.stringify({ type: 'relay-adopt', id: 'r1', parentId: 'p', childId: 'c', kind: 'claude' })), /a relay adopt needs/);
});
