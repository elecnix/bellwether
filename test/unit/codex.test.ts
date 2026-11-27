// Tier 1: the Codex entry's launch line, its per-child server override with
// exactly three pre-approved tools, and the rollout lookup against fixture
// rollouts in a scratch Codex home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codex, CODEX_PREAPPROVED_TOOLS, codexServerOverride, codexTrustOverride, HERDR_COMMAND_CAP } from '../../src/core/harnesses/codex.ts';
import { codexHome, codexLastMessage, findCodexSession, findRollout } from '../../src/core/harnesses/codex-store.ts';
import { briefSentence } from '../../src/core/harnesses/shared.ts';
import { writeRollout } from '../fixtures/codex-rollout.ts';

function scratch(t: test.TestContext): { home: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return { home: path.join(root, 'codex-home'), cwd };
}

/** The `tools={…}` table of the server override, as the names it pre-approves. */
function preapproved(override: string): string[] {
  const table = /tools=\{(.*)\}\}$/.exec(override)?.[1] ?? '';
  return [...table.matchAll(/(\w+)=\{approval_mode="approve"\}/g)].map((match) => match[1] ?? '');
}

test('the server override pre-approves exactly parent_report, request_retirement and agent_request_depth', () => {
  const override = codexServerOverride('child-abc');
  // A fourth name added later fails here: agent_spawn and agent_send stay gated by Codex's approval policy.
  assert.deepEqual(preapproved(override), ['parent_report', 'request_retirement', 'agent_request_depth']);
  assert.deepEqual([...CODEX_PREAPPROVED_TOOLS], ['parent_report', 'request_retirement', 'agent_request_depth']);
  assert.equal((override.match(/approval_mode/g) ?? []).length, 3);
  assert.doesNotMatch(override, /default_tools_approval_mode|agent_spawn|agent_send/);
});

test('the server override starts the channel entry for this child, and forwards the variables it needs', () => {
  const override = codexServerOverride('child-abc');
  assert.match(override, /^mcp_servers\.bellwether=\{command="[^"]+",args=\[.*"--child","child-abc"\],/);
  assert.match(override, /channel\.(ts|js)"/);
  const vars = /env_vars=\[([^\]]*)\]/.exec(override)?.[1]?.split(',').map((name) => JSON.parse(name) as string);
  assert.deepEqual(vars, ['BELLWETHER_PARENT', 'BELLWETHER_CHILD', 'BELLWETHER_DEPTH', 'BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']);
  assert.doesNotMatch(override, /\n/);
});

test('the trust override names the directory as given and as resolved', (t) => {
  const { cwd } = scratch(t);
  const link = `${cwd}-link`;
  fs.symlinkSync(cwd, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.equal(codexTrustOverride(cwd), `projects={${JSON.stringify(fs.realpathSync(cwd)) === JSON.stringify(cwd) ? `${JSON.stringify(cwd)}={trust_level="trusted"}` : `${JSON.stringify(cwd)}={trust_level="trusted"},${JSON.stringify(fs.realpathSync(cwd))}={trust_level="trusted"}`}}`);
  assert.equal(codexTrustOverride(link), `projects={${JSON.stringify(link)}={trust_level="trusted"},${JSON.stringify(fs.realpathSync(cwd))}={trust_level="trusted"}}`);
});

test('a codex launch runs unattended unless the caller says otherwise, and resumes with codex resume', () => {
  const files = { briefFile: '/b/prompts/c1.md', launchArgs: ['-c', 'trust', '-c', 'server'] };
  assert.deepEqual(codex.launchArgs({ files }), ['-a', 'never', '-s', 'workspace-write', '-c', 'trust', '-c', 'server', briefSentence('/b/prompts/c1.md')]);
  assert.deepEqual(codex.launchArgs({ files, model: 'example-model', extra: ['-a', 'on-request', '--sandbox=read-only'] }), ['--model', 'example-model', '-c', 'trust', '-c', 'server', briefSentence('/b/prompts/c1.md'), '-a', 'on-request', '--sandbox=read-only']);
  assert.deepEqual(codex.launchArgs({ files: { launchArgs: ['-c', 'server'] }, resume: codex.resume?.args({ value: 'sess-1', kind: 'id' }) }), ['-a', 'never', '-s', 'workspace-write', '-c', 'server', 'resume', 'sess-1']);
});

test('a codex launch line stays under herdr\'s command cap with long paths, and a longer one is refused', () => {
  const cwd = `/home/someone/${'deep/'.repeat(20)}worktree`;
  const files = { briefFile: '/home/someone/.bellwether/prompts/0123456789abcdef.md', launchArgs: ['-c', codexTrustOverride(cwd), '-c', codexServerOverride('0123456789abcdef')] };
  const line = codex.launchArgs({ files }).join(' ');
  assert.ok(line.length < HERDR_COMMAND_CAP, `the launch line is ${line.length} bytes`);
  assert.throws(() => codex.launchArgs({ files, extra: ['-c', `x="${'y'.repeat(1000)}"`] }), /herdr cuts a command at 1024/);
});

test('the rollout lookup finds the session in the child directory that holds the brief line', async (t) => {
  const { home, cwd } = scratch(t);
  const since = new Date(Date.now() - 1000).toISOString();
  const prompt = briefSentence('/b/prompts/c1.md');
  // Another directory, an older session, a subagent's session and one without the prompt do not count.
  writeRollout({ home, id: 'other-dir', cwd: path.join(cwd, 'elsewhere'), prompt });
  writeRollout({ home, id: 'too-old', cwd, prompt, at: new Date(Date.now() - 3_600_000) });
  writeRollout({ home, id: 'subagent', cwd, prompt, source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } });
  writeRollout({ home, id: 'no-prompt', cwd, prompt: 'something else' });
  const file = writeRollout({ home, id: 'the-one', cwd, prompt, replies: ['first', 'I reported it.'] });
  const found = await findCodexSession({ home, cwd, since, prompt, waitMs: 200, intervalMs: 20 });
  assert.deepEqual(found, { id: 'the-one', rollout: file });
  assert.equal(findRollout(home, 'the-one'), file);
  assert.equal(codexLastMessage(file), 'I reported it.');
});

test('a rollout that never appears fails naming the sessions directory and what the last look saw', async (t) => {
  const { home, cwd } = scratch(t);
  await assert.rejects(findCodexSession({ home, cwd, since: new Date().toISOString(), prompt: 'x', waitMs: 60, intervalMs: 20 }), new RegExp(`Codex never wrote a session with the brief's prompt under ${path.join(home, 'sessions')} within 60 ms: ${path.join(home, 'sessions')} does not exist`));
  writeRollout({ home, id: 'no-prompt', cwd, prompt: 'something else' });
  await assert.rejects(findCodexSession({ home, cwd, since: new Date(Date.now() - 1000).toISOString(), prompt: 'the brief', waitMs: 60, intervalMs: 20 }), /session no-prompt in .* holds no user message with the brief's prompt yet/);
});

test('Codex\'s home follows CODEX_HOME, and defaults to ~/.codex', () => {
  assert.equal(codexHome({ CODEX_HOME: '/x/codex' }), '/x/codex');
  assert.equal(codexHome({ HOME: '/home/someone' }), '/home/someone/.codex');
});
