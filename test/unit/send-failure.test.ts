// Tier 1: a typed message whose herdr request fails (issue #234). An error
// from messageChild never leaves the child record silent. A request that
// never reached herdr is recorded as undelivered, and its error says so,
// so the caller may send again. The isolation preload gives this file a
// scratch home for the registry.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { messageChild } from '../../src/core/send.ts';
import type { ChildRecord } from '../../src/core/types.ts';

function codexChild(parentId: string): ChildRecord {
  const at = new Date().toISOString();
  const child: ChildRecord = { id: 'child-coder', name: 'coder', kind: 'codex', harness: 'codex', paneId: 'w7R:p2', host: LOCAL_HOST, origin: 'spawn', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 };
  upsertChild(parentId, child);
  return child;
}

test('a message whose herdr socket refuses the connection is recorded as undelivered, and the error says sending again enters it once (issue #234)', async () => {
  const parentId = saveParent(emptyParent('pi', 'send-unreachable', '/work', {})).id;
  const child = codexChild(parentId);
  const refused = Object.assign(new Error('connect ECONNREFUSED /run/herdr.sock'), { code: 'ECONNREFUSED' });
  const herdr = { agentPrompt: async () => Promise.reject(refused) } as unknown as HerdrClient;
  await assert.rejects(messageChild({ herdr, parentId, from: 'your parent', child, text: 'Run the tests again.' }), /^Error: herdr was not reachable, so nothing was typed into coder's pane: connect ECONNREFUSED \/run\/herdr\.sock\. Message m-[0-9a-f]{8} is on the record as undelivered, and sending it again enters it once\.$/);
  const [message] = readParent(parentId)?.children[0]?.messages ?? [];
  assert.equal(message?.path, 'keystrokes');
  assert.equal(message?.undelivered, 'herdr was not reachable, so nothing was typed: connect ECONNREFUSED /run/herdr.sock');
  assert.equal(message?.typedInDoubt, undefined);
});

test('a message whose herdr request times out is recorded as possibly typed (issue #234)', async () => {
  const parentId = saveParent(emptyParent('pi', 'send-timeout', '/work', {})).id;
  const child = codexChild(parentId);
  const herdr = { agentPrompt: async () => Promise.reject(new Error('herdr agent.prompt timed out after 12000ms')) } as unknown as HerdrClient;
  await assert.rejects(messageChild({ herdr, parentId, from: 'your parent', child, text: 'Run the tests again.' }), /^Error: herdr may have typed message m-[0-9a-f]{8} into coder's pane: its agent\.prompt failed after the request left, with herdr agent\.prompt timed out after 12000ms\./);
  const [message] = readParent(parentId)?.children[0]?.messages ?? [];
  assert.equal(message?.typedInDoubt, 'herdr agent.prompt timed out after 12000ms');
  assert.equal(message?.undelivered, undefined);
});
