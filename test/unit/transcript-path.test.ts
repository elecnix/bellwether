// Tier 1: where Claude Code keeps a session's transcript, and the reason a
// lookup gives when there is no file. Each case points CLAUDE_CONFIG_DIR at a
// scratch directory, so no case reads the real ~/.claude.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeProjectDir, claudeTranscriptPath } from '../../src/core/transcript.ts';
import { locateTranscript } from '../../src/core/harnesses/index.ts';

function scratch(t: test.TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-tpath-')));
  const previous = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = path.join(root, 'claude');
  t.after(() => {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('Claude Code names a project directory by replacing every non-alphanumeric character with a dash', () => {
  assert.equal(claudeProjectDir('/tmp'), '-tmp');
  assert.equal(claudeProjectDir('/home/me/.agents/skills'), '-home-me--agents-skills');
  assert.equal(claudeProjectDir('/home/me/Source/git-root/bellwether.git'), '-home-me-Source-git-root-bellwether-git');
  assert.equal(claudeProjectDir('/home/me/Mes documents/Été & co'), '-home-me-Mes-documents--t----co');
});

test('a project directory name past 200 characters keeps 200, then a dash and the base-36 hash of the path', () => {
  const long = `/${'a'.repeat(250)}`;
  const name = claudeProjectDir(long);
  // Claude Code's hash is the same 32-bit sum as Java's String.hashCode, computed here a second way.
  let hash = 0;
  for (const char of long) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  assert.equal(name, `-${'a'.repeat(199)}-${Math.abs(hash).toString(36)}`);
  const exact = `/${'b'.repeat(199)}`;
  assert.equal(claudeProjectDir(exact), `-${'b'.repeat(199)}`, 'exactly 200 characters stays whole');
});

test('a Claude session with its file resolves to projects/<encoded cwd>/<session>.jsonl under the config directory', (t) => {
  const root = scratch(t);
  const cwd = path.join(root, 'work', 'repo');
  const file = claudeTranscriptPath('3ef4d234', cwd);
  assert.equal(file, path.join(root, 'claude', 'projects', claudeProjectDir(cwd), '3ef4d234.jsonl'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  assert.deepEqual(locateTranscript('claude-code', '3ef4d234', cwd), { path: file });
});

test('a Claude session started through a symbolic link resolves under the real directory', (t) => {
  const root = scratch(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link);
  const file = claudeTranscriptPath('sess-real', real);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  assert.equal(locateTranscript('claude-code', 'sess-real', link).path, file);
});

test('a Claude session with no file gives no path and says which file it expected, and why it can be absent', (t) => {
  const root = scratch(t);
  const cwd = path.join(root, 'work');
  const found = locateTranscript('claude-code', 'never-ran', cwd);
  assert.equal(found.path, undefined);
  assert.ok(found.missing?.includes(claudeTranscriptPath('never-ran', cwd)), found.missing);
  assert.match(found.missing ?? '', /first turn/);
});

test('a lookup with no session, or for a harness with no transcript, says so', () => {
  assert.deepEqual(locateTranscript('claude-code', undefined, '/tmp'), { missing: 'herdr has not reported the session yet' });
  assert.match(locateTranscript('other', 'abc', '/tmp').missing ?? '', /no transcript for the other harness/);
});
