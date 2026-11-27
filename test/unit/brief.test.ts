// The brief file: private, pruned after a week, and handed to each harness as
// one line that never carries the prompt text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneBriefs, writeBrief } from '../../src/core/brief.ts';
import { briefArgument } from '../../src/core/harnesses/index.ts';

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-brief-'));
  process.env['BELLWETHER_HOME'] = root;
  return root;
}

test('a brief older than a week is pruned, and a fresh one stays', () => {
  const root = scratch();
  const old = writeBrief('old-child', 'old');
  const week = 7 * 24 * 60 * 60_000;
  const past = new Date(Date.now() - week - 60_000);
  fs.utimesSync(old, past, past);
  const fresh = writeBrief('fresh-child', 'fresh');
  pruneBriefs();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Claude Code gets a quoted mention for a path with a space', () => {
  assert.equal(briefArgument('claude', '/home/a b/brief.md'), '@"/home/a b/brief.md"');
  assert.equal(briefArgument('claude', '/home/ab/brief.md'), '@/home/ab/brief.md');
  assert.equal(briefArgument('pi', '/home/a b/brief.md'), '@/home/a b/brief.md');
  assert.equal(briefArgument('opencode', '/x.md'), 'Your task is in /x.md. Read it, then do what it says.');
});
