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
import { teleportRefusals, teleportState, type TeleportEntry, type TeleportRefusalInput } from '../../src/core/teleport-plan.ts';
import { teleportLines } from '../../src/core/teleport.ts';
import type { RelayHostState } from '../../src/core/types.ts';
import { farInboundGap } from '../../src/integrations/tools.ts';

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
  const text = teleportNotice({ from: { machine: 'alder', cwd: '/home/a/work/x' }, to: { machine: 'hawthorne', cwd: '/home/b/work/x' }, at: '2026-11-28T03:40:00.000Z', requester: 'parent', reason: 'it needs more memory', state: 'live' });
  assert.match(text, /teleported from machine alder, directory \/home\/a\/work\/x, to machine hawthorne, directory \/home\/b\/work\/x/);
  assert.match(text, /2026-11-28T03:40:00\.000Z/);
  assert.match(text, /at your parent's request, because it needs more memory\./);
  assert.match(text, /Your worktree, the shell jobs you ran and any file outside the session did not cross: your parent prepared \/home\/b\/work\/x for you\./);
  // Nothing of how Bellwether names a session leaks into the first thing a moved agent reads.
  assert.doesNotMatch(text, /pi session|claude-code-|session [0-9a-f]{8}/);
  const own = teleportNotice({ from: { machine: 'alder', cwd: '/a' }, to: { machine: 'hawthorne', cwd: '/b' }, at: '2026-11-28T03:40:00.000Z', requester: 'self', state: 'live' });
  assert.match(own, /at your own request\./);
  assert.match(own, /you prepared \/b yourself before you asked/);
  const stopped = teleportNotice({ from: { machine: 'alder', cwd: '/a' }, to: { machine: 'alder-2', cwd: '/b' }, at: '2026-11-28T03:40:00.000Z', requester: 'parent', state: 'stopped' });
  assert.match(stopped, /You were stopped/);
  assert.doesNotMatch(stopped, /because/, 'no reason given, none invented');
});

test('a far machine whose Bellwether predates relay-message has no inbound path, and one that is new enough, or not yet heard from, has one', () => {
  const state = (farVersion?: string): RelayHostState => ({ host: 'hawthorne', status: 'connected', since: '2026-11-28T03:00:00.000Z', attempts: 0, children: [], ...(farVersion ? { farVersion } : {}) });
  assert.match(farInboundGap('hawthorne', state('0.1.6')) ?? '', /machine hawthorne runs bellwether 0\.1\.6.*does not serve relay-message.*came with bellwether 0\.1\.7/);
  assert.equal(farInboundGap('hawthorne', state('0.1.7')), undefined);
  assert.equal(farInboundGap('hawthorne', state()), undefined, 'a machine not heard from yet answers the notice itself');
  assert.equal(farInboundGap(LOCAL_HOST, undefined), undefined);
});

test('doctor warns about a teleported child that has not read its notice, and notes a recent one that did', () => {
  const entry = (notice: TeleportEntry['notice'], at = '2026-11-28T03:40:00.000Z'): TeleportEntry => ({ at, by: 'claude-code-p', state: 'live', from: { host: LOCAL_HOST, cwd: '/a' }, to: { host: 'hawthorne', cwd: '/b', paneId: 'w9:p1' }, sessionFile: '/b/s.jsonl', bytes: 10, notice, alive: { at, proof: notice.takenAt ? 'took-notice' : 'detected' } });
  const child = (extra: object) => ({ id: 'c', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w9:p1', host: 'hawthorne', startedAt: '', lastStatus: 'idle' as const, statusChangedAt: '', lastBusyAt: '', depth: 1, ...extra });
  const now = Date.parse('2026-11-28T04:00:00.000Z');
  const [warn] = teleportLines([{ children: [child({ teleports: [entry({ message: 'm-1', undelivered: 'its session never connected' })] })] }], now);
  assert.match(warn ?? '', /^warn  teleport: worker went from this machine \(\/a\) to machine hawthorne \(\/b\)/);
  assert.match(warn ?? '', /its session never connected/);
  // Read later, through the session's next hello: no warning.
  const [late] = teleportLines([{ children: [child({ teleports: [entry({ message: 'm-1', undelivered: 'x' })], messages: [{ id: 'm-1', at: '', path: 'session', preview: '', readAt: '2026-11-28T03:50:00.000Z' }] })] }], now);
  assert.match(late ?? '', /^info  teleport: .* read the notice at 2026-11-28T03:50:00\.000Z/);
  assert.match(teleportLines([{ children: [child({ teleports: [entry({ takenAt: '2026-11-28T03:41:00.000Z' })] })] }], now)[0] ?? '', /^info  teleport/);
  assert.deepEqual(teleportLines([{ children: [child({ teleports: [entry({ takenAt: 'x' }, '2026-11-20T00:00:00.000Z')] })] }], now), [], 'an old teleport that went well is not news');
});
