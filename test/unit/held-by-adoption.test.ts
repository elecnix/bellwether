// Tier 1: how a parent holds a child now, against how the child first came to
// it (issue #256).
import assert from 'node:assert/strict';
import test from 'node:test';
import { heldByAdoption } from '../../src/core/authority.ts';
import { backInPane } from '../../src/core/adopt.ts';
import type { ChildRecord } from '../../src/core/types.ts';

function child(extra: Partial<ChildRecord>): ChildRecord {
  const at = '2026-11-28T00:00:00.000Z';
  return { id: 'c1', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p1', host: 'local', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra };
}

test('an adopted child is held by adoption until Bellwether starts its harness, and again once its session comes back under an adoption', () => {
  assert.equal(heldByAdoption(child({ origin: 'adopt' })), true);
  const resumed = child({ origin: 'adopt', launchedAt: '2026-11-28T01:00:00.000Z' });
  assert.equal(heldByAdoption(resumed), false, 'a resume started the harness in a tab Bellwether opened');
  backInPane(resumed, { paneId: 'w1:p1', agentStatus: 'idle', tabId: 'w1:t1', workspaceId: 'w1' });
  assert.equal(heldByAdoption(resumed), true, 'the session came back in a process Bellwether did not start');
  assert.equal(resumed.origin, 'adopt');
});

test('a child Bellwether spawned or resumed from a session id is never held by adoption', () => {
  assert.equal(heldByAdoption(child({})), false);
  assert.equal(heldByAdoption(child({ origin: 'spawn' })), false);
  assert.equal(heldByAdoption(child({ origin: 'resume' })), false);
});
