// Tier 1: the decisions agent_move makes, as pure functions. The refusal
// matrix, where each harness keeps a session for a working directory on the
// target, what a failure at each stage undoes, and how the target is chosen.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { compareVersions, claudeVersionsOf, moveRefusals, newestVersion, parsePiModelList, pickTarget, piModelOf, piSessionDirName, rewriteForTarget, rollbackPlan, sha256, targetSessionLayout, type RefusalInput } from '../../src/core/move-plan.ts';
import { verifyCopy } from '../../src/core/move.ts';

const DIRS = { claudeConfigDir: '/home/op/.claude', piAgentDir: '/home/op/.pi/agent' };

function ready(extra: Partial<RefusalInput> = {}): RefusalInput {
  return {
    childName: 'worker',
    harness: 'claude-code',
    status: 'idle',
    exited: false,
    source: LOCAL_HOST,
    target: 'hawthorne',
    hasSession: true,
    sourceHarness: { path: '/usr/local/bin/claude', version: '2.1.300' },
    targetHarness: { path: '/home/op/.local/bin/claude', version: '2.1.332' },
    recordedVersions: ['2.1.290', '2.1.300'],
    targetCwd: '/home/op/src/repo',
    targetCwdExists: true,
    ...extra,
  };
}

test('a child with everything in place on the target is not refused', () => {
  assert.deepEqual(moveRefusals(ready()), []);
  assert.deepEqual(moveRefusals(ready({ harness: 'pi', sourceHarness: { path: '/bin/pi', version: '1.6.1' }, targetHarness: { path: '/bin/pi', version: '1.6.1' }, recordedVersions: [], piModel: { provider: 'example-hosted', model: 'deepseek-v4.1-flash' }, targetModels: [{ provider: 'example-hosted', model: 'deepseek-v4.1-flash' }] })), []);
});

test('a move to another harness is refused, naming both harnesses', () => {
  const [reason] = moveRefusals(ready({ requestedHarness: 'pi' }));
  assert.match(reason ?? '', /runs claude-code, and the move asked for pi/);
  assert.match(reason ?? '', /only a move that keeps the same harness exists/);
  assert.match(moveRefusals(ready({ harness: 'pi', requestedHarness: 'claude-code', sourceHarness: { path: '/bin/pi', version: '1' }, targetHarness: { path: '/bin/pi', version: '1' } }))[0] ?? '', /runs pi, and the move asked for claude-code/);
});

test('a harness Bellwether cannot resume is refused before anything else', () => {
  const reasons = moveRefusals(ready({ harness: 'other' }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /moves only claude and pi children/);
});

test('a harness missing on the target is refused', () => {
  const [reason] = moveRefusals(ready({ targetHarness: { error: 'no claude on PATH' } }));
  assert.match(reason ?? '', /claude is not installed on machine hawthorne \(no claude on PATH\)/);
});

test('a target harness older than the version that wrote the session is refused, as a data-loss risk', () => {
  const [reason] = moveRefusals(ready({ targetHarness: { path: '/bin/claude', version: '2.1.299' } }));
  assert.match(reason ?? '', /claude 2\.1\.299 on machine hawthorne is older than claude 2\.1\.300/);
  // The transcript can name a writer newer than the source's binary, after an update mid-session.
  assert.match(moveRefusals(ready({ recordedVersions: ['2.1.340'] }))[0] ?? '', /older than claude 2\.1\.340/);
  // A version that cannot be read on either side is refused too, never assumed compatible.
  assert.match(moveRefusals(ready({ targetHarness: { path: '/bin/claude' } }))[0] ?? '', /did not report a version/);
  assert.match(moveRefusals(ready({ sourceHarness: { error: 'gone' }, recordedVersions: [] }))[0] ?? '', /could not read which claude version wrote/);
});

test('a pi pair the target does not offer is refused, naming the pair and the file that would hold it', () => {
  const pi = ready({ harness: 'pi', sourceHarness: { path: '/bin/pi', version: '1.6.1' }, targetHarness: { path: '/bin/pi', version: '1.6.1' }, recordedVersions: [], piModel: { provider: 'example-hosted', model: 'deepseek-v4.1-flash' }, targetModelsFile: '/home/op/.pi/agent/models.json' });
  const [reason] = moveRefusals({ ...pi, targetModels: [{ provider: 'openrouter', model: 'deepseek-v4.1-flash' }, { provider: 'example-hosted', model: 'example-other' }] });
  assert.match(reason ?? '', /example-hosted\/deepseek-v4\.1-flash/);
  assert.match(reason ?? '', /add provider example-hosted with model deepseek-v4\.1-flash to \/home\/op\/\.pi\/agent\/models\.json on machine hawthorne/);
  assert.match(moveRefusals({ ...pi, targetModelsError: 'pi --list-models exited with 1' })[0] ?? '', /could not list pi's models/);
});

test('a working directory missing on the target is refused', () => {
  assert.match(moveRefusals(ready({ targetCwdExists: false }))[0] ?? '', /\/home\/op\/src\/repo does not exist on machine hawthorne/);
});

test('a busy, exited, sessionless, already-moving or same-machine child is refused, each by name', () => {
  assert.match(moveRefusals(ready({ status: 'working' }))[0] ?? '', /worker is working/);
  assert.match(moveRefusals(ready({ status: 'blocked' }))[0] ?? '', /worker is blocked/);
  assert.match(moveRefusals(ready({ exited: true }))[0] ?? '', /is not running/);
  assert.match(moveRefusals(ready({ hasSession: false }))[0] ?? '', /no recorded session/);
  assert.match(moveRefusals(ready({ moveInFlight: { to: 'hawthorne', since: '2026-11-27T00:00:00.000Z' } }))[0] ?? '', /already being moved to machine hawthorne/);
  assert.match(moveRefusals(ready({ target: LOCAL_HOST }))[0] ?? '', /already runs on this machine/);
});

test('every refusal that applies is reported at once', () => {
  const reasons = moveRefusals(ready({ status: 'working', targetCwdExists: false, targetHarness: { path: '/bin/claude', version: '1.0.0' } }));
  assert.equal(reasons.length, 3);
});

test('Claude Code keeps a session under its project directory for the working directory, with a side directory', () => {
  const layout = targetSessionLayout('claude-code', 'sess-1.jsonl', '/home/op/Source/bell.wether/main', DIRS);
  assert.equal(layout.dir, '/home/op/.claude/projects/-home-op-Source-bell-wether-main');
  assert.equal(layout.file, '/home/op/.claude/projects/-home-op-Source-bell-wether-main/sess-1.jsonl');
  assert.equal(layout.sideDir, '/home/op/.claude/projects/-home-op-Source-bell-wether-main/sess-1');
  // A different path on the other machine lands in a different directory, which is the point.
  assert.equal(targetSessionLayout('claude-code', 'sess-1.jsonl', '/Users/op/Source/bell.wether/main', DIRS).dir, '/home/op/.claude/projects/-Users-op-Source-bell-wether-main');
  // A long path keeps 200 characters and a hash, as Claude Code does.
  const long = `/home/op/${'deep/'.repeat(50)}repo`;
  const name = path.basename(targetSessionLayout('claude-code', 'sess-1.jsonl', long, DIRS).dir);
  assert.match(name, /^-home-op-deep-.{180,}-[0-9a-z]+$/);
  assert.ok(name.length > 200);
});

test('pi keeps a session under its encoded directory, or in PI_CODING_AGENT_SESSION_DIR when set', () => {
  assert.equal(piSessionDirName('/home/op/Source/bell.wether/main'), '--home-op-Source-bell.wether-main--');
  const file = '2026-11-16T01-38-19-939Z_01a1e201.jsonl';
  assert.equal(targetSessionLayout('pi', file, '/home/op/repo', DIRS).file, `/home/op/.pi/agent/sessions/--home-op-repo--/${file}`);
  assert.equal(targetSessionLayout('pi', file, '/home/op/repo', DIRS).sideDir, undefined);
  assert.equal(targetSessionLayout('pi', file, '/home/op/repo', { ...DIRS, piSessionDir: '/srv/pi-sessions' }).file, `/srv/pi-sessions/${file}`);
  assert.throws(() => targetSessionLayout('pi', '../escape.jsonl', '/home/op/repo', DIRS), /not a session file name/);
});

test('a pi session is rewritten to name the target working directory, and a Claude Code transcript is not', () => {
  const body = '{"type":"session","version":3,"id":"abc","cwd":"/Users/op/repo"}\n{"type":"message"}\n';
  const out = rewriteForTarget('pi', Buffer.from(body), '/home/op/repo').toString('utf8');
  assert.equal(out.split('\n')[0], '{"type":"session","version":3,"id":"abc","cwd":"/home/op/repo"}');
  assert.equal(out.split('\n').slice(1).join('\n'), '{"type":"message"}\n');
  assert.equal(rewriteForTarget('pi', Buffer.from(body), '/Users/op/repo').toString('utf8'), body);
  assert.equal(rewriteForTarget('claude-code', Buffer.from(body), '/home/op/repo').toString('utf8'), body);
  assert.throws(() => rewriteForTarget('pi', Buffer.from('{"type":"message"}\n'), '/x'), /does not start with its session header/);
});

test('a failure before the source stops only removes the copy, and one after it restarts the source', () => {
  assert.deepEqual(rollbackPlan('checked'), { discardTarget: false, restartSource: false, closeTarget: false });
  assert.deepEqual(rollbackPlan('copied'), { discardTarget: true, restartSource: false, closeTarget: false });
  assert.deepEqual(rollbackPlan('verified'), { discardTarget: true, restartSource: false, closeTarget: false });
  assert.deepEqual(rollbackPlan('stopped'), { discardTarget: true, restartSource: true, closeTarget: false });
  assert.deepEqual(rollbackPlan('recopied'), { discardTarget: true, restartSource: true, closeTarget: false });
  assert.deepEqual(rollbackPlan('started'), { discardTarget: true, restartSource: true, closeTarget: true });
});

test('the target is the one named, the only other machine, or refused as ambiguous', () => {
  assert.equal(pickTarget([LOCAL_HOST, 'hawthorne'], LOCAL_HOST), 'hawthorne');
  assert.equal(pickTarget([LOCAL_HOST, 'hawthorne'], 'hawthorne'), LOCAL_HOST);
  assert.equal(pickTarget([LOCAL_HOST, 'hawthorne', 'mac'], LOCAL_HOST, 'mac'), 'mac');
  assert.throws(() => pickTarget([LOCAL_HOST, 'hawthorne', 'mac'], LOCAL_HOST), /hawthorne, mac are all known, so the target is ambiguous/);
  assert.throws(() => pickTarget([LOCAL_HOST], LOCAL_HOST), /nowhere to move to/);
});

test('versions compare part by part, and the newest writer wins', () => {
  assert.equal(compareVersions('2.1.332 (Claude Code)', '2.1.40'), 1);
  assert.equal(compareVersions('1.6.1', '1.6.1'), 0);
  assert.equal(compareVersions('1.6', '1.6.1'), -1);
  assert.equal(compareVersions('dev', '1.0.0'), undefined);
  assert.equal(newestVersion(['2.1.9', undefined, '2.1.10', 'junk']), '2.1.10');
});

test('a session names its model and its writers', () => {
  const pi = ['{"type":"session","version":3}', '{"type":"model_change","provider":"example-a","modelId":"example-m1"}', '{"type":"message","message":{"role":"assistant","provider":"example-b","model":"example-m2"}}'].join('\n');
  assert.deepEqual(piModelOf(pi), { provider: 'example-b', model: 'example-m2' });
  assert.deepEqual(piModelOf(pi.split('\n').slice(0, 2).join('\n')), { provider: 'example-a', model: 'example-m1' });
  assert.deepEqual(claudeVersionsOf('{"version":"2.1.300","x":1}\n{"version":"2.1.332"}\n{"version":"2.1.300"}').sort(), ['2.1.300', '2.1.332']);
  assert.deepEqual(parsePiModelList('provider  model  context\nexample-hosted  deepseek-v4.1-flash  1.0M\nopenrouter  deepseek/stub-x  1M\n'), [{ provider: 'example-hosted', model: 'deepseek-v4.1-flash' }, { provider: 'openrouter', model: 'deepseek/stub-x' }]);
});

test('a copy that reads back with other bytes, or is missing a file, fails verification', () => {
  const data = Buffer.from('hello\n');
  const sent = [{ rel: 's.jsonl', data, bytes: data.length, sha256: sha256(data) }];
  const good = { sessionFile: '/t/s.jsonl', files: [{ rel: 's.jsonl', path: '/t/s.jsonl', bytes: data.length, sha256: sha256(data), created: true }] };
  verifyCopy(sent, good, 'hawthorne');
  assert.throws(() => verifyCopy(sent, { ...good, files: [{ ...good.files[0]!, bytes: 5, sha256: sha256(Buffer.from('hello')) }] }, 'hawthorne'), /reads back as 5 bytes/);
  assert.throws(() => verifyCopy(sent, { ...good, files: [] }, 'hawthorne'), /missing s\.jsonl/);
});
