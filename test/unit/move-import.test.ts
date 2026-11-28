// The destination's side of a crossing's copy (issue #226). A crossing lists
// the files an import wrote in its mark once the import answers, so a daemon
// that stops between the two leaves files the mark never names. The
// destination keeps its own list, written before any file, and a discard or a
// commit settles every file on it, whatever list the caller sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupPath, commitImport, discardImport, importSession } from '../../src/core/session-state.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';

function scratch(t: test.TestContext): { cwd: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const config = process.env['CLAUDE_CONFIG_DIR'] as string;
  return { cwd, dir: path.join(config, 'projects', claudeProjectDir(fs.realpathSync(cwd))) };
}

const b64 = (text: string): string => Buffer.from(text).toString('base64');

test('a discard that names no file still undoes an import the mark never listed', (t) => {
  const { cwd, dir } = scratch(t);
  // An earlier copy of the session's side file is already there, as when a child returns to a machine it ran on.
  fs.mkdirSync(path.join(dir, 'sess-1'), { recursive: true });
  const side = path.join(dir, 'sess-1', 'side.txt');
  fs.writeFileSync(side, 'before');
  importSession({ harness: 'claude-code', childId: 'child-a', cwd, fileName: 'sess-1.jsonl', files: [{ rel: 'sess-1.jsonl', data: b64('{"a":1}\n') }, { rel: 'sess-1/side.txt', data: b64('before and after') }] });
  assert.ok(fs.existsSync(path.join(dir, 'sess-1.jsonl')));

  // The daemon stopped before its mark listed the files, so the recovery's discard names none.
  discardImport({ childId: 'child-a', files: [] });
  assert.equal(fs.existsSync(path.join(dir, 'sess-1.jsonl')), false, 'the file the import created is gone');
  assert.equal(fs.readFileSync(side, 'utf8'), 'before', 'the file the import replaced is back');
  assert.equal(fs.existsSync(backupPath(side, 'child-a')), false);
});

test('a commit that names no file still removes the backups of an import the mark never listed', (t) => {
  const { cwd, dir } = scratch(t);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, '{"a":1}\n');
  importSession({ harness: 'claude-code', childId: 'child-b', cwd, fileName: 'sess-1.jsonl', files: [{ rel: 'sess-1.jsonl', data: b64('{"a":1}\n{"b":2}\n') }] });
  assert.ok(fs.existsSync(backupPath(file, 'child-b')));
  commitImport({ childId: 'child-b', files: [] });
  assert.equal(fs.existsSync(backupPath(file, 'child-b')), false, 'the backup goes');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n{"b":2}\n', 'the copy stays');
  // The list goes with the settled import, so a later discard for the same child touches nothing.
  discardImport({ childId: 'child-b', files: [] });
  assert.ok(fs.existsSync(file));
});

test('a second import in one crossing keeps the first one\'s word on which files it created', (t) => {
  const { cwd, dir } = scratch(t);
  importSession({ harness: 'claude-code', childId: 'child-c', cwd, fileName: 'sess-1.jsonl', files: [{ rel: 'sess-1.jsonl', data: b64('{"a":1}\n') }] });
  importSession({ harness: 'claude-code', childId: 'child-c', cwd, fileName: 'sess-1.jsonl', files: [{ rel: 'sess-1.jsonl', data: b64('{"a":1}\n{"b":2}\n') }] });
  discardImport({ childId: 'child-c', files: [] });
  assert.equal(fs.existsSync(path.join(dir, 'sess-1.jsonl')), false, 'the file the first import created is gone after the second grew it');
});
