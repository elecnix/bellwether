// The receipt scan is the only thing that decides an event is read, so it is
// tested without a session: a real file, a real byte offset, a real append.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReceiptScan, claudeConfigDir, findTranscript } from '../../src/integrations/claude/transcript.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';

function scratch(): { root: string; cwd: string; session: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-scan-'));
  const cwd = '/tmp/some worktree';
  const session = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(root, 'projects', claudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return { root, cwd, session, file: path.join(dir, `${session}.jsonl`) };
}

function append(file: string, text: string): void {
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
}

test('findTranscript falls back to any project directory', () => {
  const { root, session } = scratch();
  const other = path.join(root, 'projects', '-elsewhere-');
  fs.mkdirSync(other, { recursive: true });
  const file = path.join(other, `${session}.jsonl`);
  fs.writeFileSync(file, '');
  assert.equal(findTranscript(session, '/not/that/worktree', root), file);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan ignores a receipt written before it started', () => {
  const { root, cwd, session, file } = scratch();
  append(file, 'receipt bw-aaaaaaaaaaaa from an earlier run');
  const scan = new ReceiptScan(session, cwd, root);
  scan.start();
  assert.deepEqual([...scan.scan(['bw-aaaaaaaaaaaa'])], []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan reports only the receipts in the bytes since the last look', () => {
  const { root, cwd, session, file } = scratch();
  const scan = new ReceiptScan(session, cwd, root);
  scan.start();
  append(file, 'event one, receipt bw-111111111111');
  assert.deepEqual([...scan.scan(['bw-111111111111', 'bw-222222222222'])], ['bw-111111111111']);
  append(file, 'event two, receipt bw-222222222222');
  assert.deepEqual([...scan.scan(['bw-111111111111', 'bw-222222222222'])], ['bw-222222222222']);
  // A second look over the same bytes finds nothing new.
  assert.deepEqual([...scan.scan(['bw-222222222222'])], []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('search finds a receipt from before this server started', () => {
  const { root, cwd, session, file } = scratch();
  append(file, 'event from the previous server, receipt bw-333333333333');
  const scan = new ReceiptScan(session, cwd, root);
  assert.deepEqual([...scan.search(['bw-333333333333', 'bw-444444444444'])], ['bw-333333333333']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing transcript is quiet, not thrown', () => {
  const scan = new ReceiptScan('no-such-session', '/nowhere', fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-empty-')));
  scan.start();
  assert.deepEqual([...scan.scan(['bw-555555555555'])], []);
  assert.deepEqual([...scan.search(['bw-555555555555'])], []);
});

test('the config root honours CLAUDE_CONFIG_DIR', () => {
  const previous = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = '/tmp/lab-config';
  assert.equal(claudeConfigDir(), '/tmp/lab-config');
  if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = previous;
});
