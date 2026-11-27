// The brief file: private, numbered so no resume writes over one, and handed to each harness as
// one line that never carries the prompt text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { briefRead, nextBrief } from '../../src/core/brief-history.ts';
import { removeBrief, writeBrief } from '../../src/core/brief.ts';
import { promptPath } from '../../src/core/paths.ts';
import { briefArgument } from '../../src/core/harnesses/index.ts';

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-brief-'));
  process.env['BELLWETHER_HOME'] = root;
  return root;
}

test('each brief number has its own file, and removing a child\'s briefs leaves another child\'s', () => {
  const root = scratch();
  const first = writeBrief('child-a', 'the task');
  const second = writeBrief('child-a', 'continue', 2);
  const other = writeBrief('child-a-b', 'another child');
  assert.equal(first, promptPath('child-a'));
  assert.equal(second, path.join(root, 'prompts', 'child-a-2.md'));
  assert.equal(fs.readFileSync(first, 'utf8'), 'the task', 'brief 2 does not write over brief 1');
  removeBrief('child-a');
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'another child');
  fs.rmSync(root, { recursive: true, force: true });
});

test('only a report after the brief, or a finished turn in its pane, proves a child read it', () => {
  const brief = { n: 1, file: '/x.md', at: '2026-11-27T10:00:00.000Z', paneId: 'w1:p1' };
  const base = { id: 'c', startedAt: brief.at, briefs: [brief] };
  assert.equal(briefRead(base, brief), false, 'a record with nothing proves nothing');
  assert.equal(briefRead({ ...base, lastReport: { status: 'done', text: '', at: '2026-11-27T10:05:00.000Z', seq: 1 } }, brief), true);
  assert.equal(briefRead({ ...base, lastReport: { status: 'done', text: '', at: '2026-11-27T09:00:00.000Z', seq: 1 } }, brief), false, 'a report from before the brief');
  assert.equal(briefRead({ ...base, turnNotified: { paneId: 'w1:p1', seq: 1 } }, brief), true);
  assert.equal(briefRead({ ...base, turnNotified: { paneId: 'w1:p0', seq: 4 } }, brief), false, 'a turn in an earlier pane');
});

test('a resume repeats an unread brief ahead of its prompt, and hands over only the prompt once the brief was read', () => {
  const root = scratch();
  const file = writeBrief('child-r', 'the task');
  const at = '2026-11-27T10:00:00.000Z';
  const unread = { id: 'child-r', startedAt: at, briefs: [{ n: 1, file, at, paneId: 'w1:p1' }] };
  const carried = nextBrief(unread, 'continue', '2026-11-27T11:00:00.000Z');
  assert.equal(carried?.brief.n, 2);
  assert.deepEqual(carried?.brief.carries, [1]);
  assert.ok((carried?.text.indexOf('the task') ?? -1) < (carried?.text.lastIndexOf('continue') ?? -1));
  const again = nextBrief(unread, undefined, '2026-11-27T11:00:00.000Z');
  assert.equal(again?.reused, true);
  assert.equal(again?.text, 'the task');
  const read = { ...unread, lastReport: { status: 'done' as const, text: '', at: '2026-11-27T10:30:00.000Z', seq: 1 } };
  assert.equal(nextBrief(read, 'continue', '2026-11-27T11:00:00.000Z')?.text, 'continue');
  assert.equal(nextBrief(read, undefined, '2026-11-27T11:00:00.000Z'), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Claude Code gets a quoted mention for a path with a space', () => {
  assert.equal(briefArgument('claude', '/home/a b/brief.md'), '@"/home/a b/brief.md"');
  assert.equal(briefArgument('claude', '/home/ab/brief.md'), '@/home/ab/brief.md');
  assert.equal(briefArgument('pi', '/home/a b/brief.md'), '@/home/a b/brief.md');
  assert.equal(briefArgument('opencode', '/x.md'), 'Your task is in /x.md. Read it, then do what it says.');
});
