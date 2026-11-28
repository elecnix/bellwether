// Tier 1: the decisions agent_teleport makes, as pure functions (issue #226).
// The four refusals are the contract: a destination directory that does not
// exist, a destination harness older than the one that wrote the session, a
// destination with no inbound path for the notice, and an adopted child. Each
// has its own case, so a later change cannot drop one silently. The notice is
// tested here too, because what it says is what the teleported agent knows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { teleportNotice } from '../../src/core/teleport-notice.ts';
import { teleportRefusals, teleportState, type TeleportRefusalInput } from '../../src/core/teleport-plan.ts';

function ready(extra: Partial<TeleportRefusalInput> = {}): TeleportRefusalInput {
  return {
    childName: 'worker',
    harness: 'claude-code',
    status: 'idle',
    state: 'live',
    origin: 'spawn',
    source: LOCAL_HOST,
    target: 'hawthorne',
    hasSession: true,
    sourceHarness: { path: '/usr/local/bin/claude', version: '2.1.300' },
    targetHarness: { path: '/home/op/.local/bin/claude', version: '2.1.332' },
    recordedVersions: ['2.1.300'],
    targetCwd: '/home/op/src/repo',
    targetCwdExists: true,
    ...extra,
  };
}

test('a live, idle child with everything in place at the destination is not refused', () => {
  assert.deepEqual(teleportRefusals(ready()), []);
});

test('a stopped child is not refused for being stopped: teleportation carries a stopped agent, where agent_move refuses one', () => {
  assert.deepEqual(teleportRefusals(ready({ state: 'stopped', status: 'done' })), []);
  assert.deepEqual(teleportRefusals(ready({ state: 'stopped', status: 'working' })), [], 'a stopped child has no turn to cut, whatever its last status was');
});

test('a working or blocked child is refused, as agent_move refuses it, because a teleport never cuts a turn short', () => {
  for (const status of ['working', 'blocked'] as const) {
    const reasons = teleportRefusals(ready({ status }));
    assert.equal(reasons.length, 1, reasons.join('\n'));
    assert.match(reasons[0] ?? '', new RegExp(`worker is ${status}`));
  }
});

test('contract 1: a destination directory that does not exist is refused, and Bellwether says it does not create it', () => {
  const reasons = teleportRefusals(ready({ targetCwdExists: false }));
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0] ?? '', /\/home\/op\/src\/repo does not exist on machine hawthorne/);
  assert.match(reasons[0] ?? '', /Bellwether does not create it/);
  assert.match(reasons[0] ?? '', /worktree/, 'the refusal names what the requester prepares');
});

test('contract 2: a destination harness older than the one that wrote the session is refused, as agent_move refuses it', () => {
  const reasons = teleportRefusals(ready({ targetHarness: { path: '/bin/claude', version: '2.1.290' } }));
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0] ?? '', /claude 2\.1\.290 on machine hawthorne is older than claude 2\.1\.300/);
  assert.doesNotMatch(reasons[0] ?? '', /inbound|notice/, 'a harness that is too old is a different repair from a missing inbound path');
});

test('contract 3: a destination with no inbound path for the notice is refused, naming the harness, apart from a harness that is too old', () => {
  const reasons = teleportRefusals(ready({ inbound: 'the Bellwether on machine hawthorne runs 0.1.7, which predates relay-message, brought by 0.1.8' }));
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0] ?? '', /no inbound path into worker's claude-code session on machine hawthorne/);
  assert.match(reasons[0] ?? '', /predates relay-message/);
  assert.match(reasons[0] ?? '', /must be told it was teleported before its first turn/);
  assert.doesNotMatch(reasons[0] ?? '', /older than/);
  // Both at once are two refusals, each with its own repair.
  assert.equal(teleportRefusals(ready({ inbound: 'no adapter', targetHarness: { path: '/bin/claude', version: '2.1.1' } })).length, 2);
});

test('contract 4: an adopted child is refused by name, with the issue that lifts the refusal', () => {
  const reasons = teleportRefusals(ready({ origin: 'adopt' }));
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0] ?? '', /worker is an adopted child/);
  assert.match(reasons[0] ?? '', /issues\/219/);
});

test('the refusals agent_move makes still apply: the same machine, no session, a harness change and a route to another machine', () => {
  assert.match(teleportRefusals(ready({ target: LOCAL_HOST }))[0] ?? '', /already runs on this machine/);
  assert.match(teleportRefusals(ready({ hasSession: false }))[0] ?? '', /has no recorded session/);
  assert.match(teleportRefusals(ready({ requestedHarness: 'pi' }))[0] ?? '', /runs claude-code, and the move asked for pi/);
  assert.match(teleportRefusals(ready({ route: 'example-router' }))[0] ?? '', /route example-router/);
  assert.match(teleportRefusals(ready({ harness: 'codex' }))[0] ?? '', /Bellwether moves only/);
});

test('a child is stopped when its record says it exited or names no pane, and live otherwise', () => {
  assert.equal(teleportState({ paneId: 'w1:p3' }), 'live');
  assert.equal(teleportState({ paneId: 'w1:p3', exitedAt: '2026-11-28T03:00:00.000Z' }), 'stopped');
  assert.equal(teleportState({ paneId: '' }), 'stopped');
});

test('the notice names both machines and both directories as a person would, and says what did not cross', () => {
  const text = teleportNotice({ from: { machine: 'alder', cwd: '/home/a/work/x' }, to: { machine: 'hawthorne', cwd: '/home/b/work/x' }, at: '2026-11-28T03:40:00.000Z', by: 'parent pi-01a2', reason: 'it needs more memory', state: 'live' });
  assert.match(text, /teleported from machine alder, directory \/home\/a\/work\/x, to machine hawthorne, directory \/home\/b\/work\/x/);
  assert.match(text, /2026-11-28T03:40:00\.000Z/);
  assert.match(text, /by parent pi-01a2/);
  assert.match(text, /because it needs more memory/);
  assert.match(text, /worktree, the shell jobs it ran and any file outside the session did not cross/);
  const stopped = teleportNotice({ from: { machine: 'alder', cwd: '/a' }, to: { machine: 'alder-2', cwd: '/b' }, at: '2026-11-28T03:40:00.000Z', by: 'parent p', state: 'stopped' });
  assert.match(stopped, /You were stopped/);
  assert.doesNotMatch(stopped, /because/, 'no reason given, none invented');
});
