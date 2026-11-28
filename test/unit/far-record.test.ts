// Tier 1: doctor names each child whose far machine holds no record of it
// while this machine's registry still does (issue #219).
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyParent } from '../../src/core/registry.ts';
import { farRecordLines } from '../../src/core/remote.ts';
import type { ChildRecord } from '../../src/core/types.ts';

function child(extra: Partial<ChildRecord>): ChildRecord {
  return { id: 'c-far', name: 'far-one', kind: 'claude', harness: 'claude-code', paneId: 'w32:p1', host: 'child-box', origin: 'adopt', cwd: '/far', startedAt: '2026-11-28T01:00:00.000Z', lastStatus: 'idle', statusChangedAt: '2026-11-28T01:00:00.000Z', lastBusyAt: '2026-11-28T01:00:00.000Z', depth: 1, ...extra };
}

test('doctor warns about an adopted child whose far machine lost its claim, and names the command that restores it', () => {
  const parent = { ...emptyParent('pi', 'lead', '/work'), children: [child({ farRecordLost: { at: '2026-11-28T03:00:00.000Z', host: 'child-box', reason: 'pane w32:p1 is already a child of pi-other' } })] };
  assert.deepEqual(farRecordLines([parent]), [
    `warn  far record: far-one (child c-far of ${parent.id}) on machine child-box: that machine has held no record of it since 2026-11-28T03:00:00.000Z, so messages to it are typed into its pane (pane w32:p1 is already a child of pi-other). Run agent_adopt child-box:w32:p1 to claim it there again.`,
  ]);
});

test('doctor warns about a spawned child whose far machine lost its record, and says how to register it again', () => {
  const parent = { ...emptyParent('pi', 'lead', '/work'), children: [child({ origin: 'spawn', farRecordLost: { at: '2026-11-28T03:00:00.000Z', host: 'child-box', reason: 'this machine holds no running child c-far' } })] };
  assert.match(farRecordLines([parent])[0] ?? '', /^warn  far record: far-one .* Stop it and resume its session with agent_spawn to register it there again\.$/);
});

test('doctor says nothing about a child whose records agree, or one that exited', () => {
  const parent = { ...emptyParent('pi', 'lead', '/work'), children: [child({}), child({ id: 'gone', exitedAt: '2026-11-28T04:00:00.000Z', farRecordLost: { at: '2026-11-28T03:00:00.000Z', host: 'child-box', reason: 'x' } })] };
  assert.deepEqual(farRecordLines([parent]), []);
});
