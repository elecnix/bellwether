// Tier 1: the pure parts of issue #224's check, which tell a child's
// background jobs from its harness and its servers, find the directories a
// session worked in, and word what a move would leave behind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backgroundJobs, elapsedSeconds, isShell, leftBehindLines, linkedWorktreeOf, sessionPaths, type ProcessEntry } from '../../src/core/move-leftovers.ts';

const SHELL = 100;
const HARNESS = 200;

function proc(pid: number, ppid: number, command: string, carriesChild = true, startedAt = 1_000): ProcessEntry {
  return { pid, ppid, command, carriesChild, startedAt };
}

/** A pane whose shell runs the harness, which runs an MCP server through npx, as Claude Code does. */
const IDLE: ProcessEntry[] = [
  proc(1, 0, '/sbin/init', false),
  proc(SHELL, 50, '/bin/bash'),
  proc(HARNESS, SHELL, 'claude --mcp-config=/x.json'),
  proc(210, HARNESS, 'node /usr/lib/bellwether/channel.js --child c1'),
  proc(220, HARNESS, 'node /usr/bin/npx some-mcp'),
  proc(221, 220, 'sh -c some-mcp'),
  proc(300, 1, 'sleep 99', false),
];

test('an idle harness with its servers, even one that runs a shell under npx, has no background job', () => {
  assert.deepEqual(backgroundJobs(IDLE, { shellPid: SHELL, foregroundGroup: HARNESS }), []);
});

test('a shell the harness started is a background job, reported once by its topmost process', () => {
  const table = [...IDLE, proc(230, HARNESS, '/bin/bash -c source snapshot.sh && eval "npm test"'), proc(231, 230, 'npm test'), proc(232, 231, 'node --test')];
  assert.deepEqual(backgroundJobs(table, { shellPid: SHELL, foregroundGroup: HARNESS }), [{ pid: 230, command: 'npm test' }]);
});

test('a program the harness started long after its servers, such as a watch an extension runs, is a background job', () => {
  const table = [...IDLE, proc(240, HARNESS, 'gh monitor 42', true, 5_000), proc(250, HARNESS, 'node /usr/bin/pi --mode rpc', true, 4_000)];
  assert.deepEqual(backgroundJobs(table, { shellPid: SHELL, foregroundGroup: HARNESS }), [
    { pid: 240, command: 'gh monitor 42' },
    { pid: 250, command: 'node /usr/bin/pi --mode rpc' },
  ]);
});

test("ps's elapsed time reads in seconds", () => {
  assert.equal(elapsedSeconds('05:09'), 309);
  assert.equal(elapsedSeconds('02:05:09'), 7_509);
  assert.equal(elapsedSeconds('3-02:05:09'), 266_709);
  assert.equal(elapsedSeconds('soon'), undefined);
});

test('a process that carries the child id outside the harness tree, such as an orphan of a finished shell, is a job', () => {
  const table = [...IDLE, proc(400, 1, 'gh monitor 42')];
  assert.deepEqual(backgroundJobs(table, { shellPid: SHELL, foregroundGroup: HARNESS }), [{ pid: 400, command: 'gh monitor 42' }]);
});

test('without herdr process info, carriers make the answer unknown, and no carrier at all means no job', () => {
  assert.ok('unknown' in (backgroundJobs(IDLE, undefined) as object));
  assert.deepEqual(backgroundJobs(IDLE.map((entry) => ({ ...entry, carriesChild: false })), undefined), []);
});

test('a shell is told by its program name, with a login dash or a path', () => {
  for (const command of ['/bin/sh -c x', '-zsh', 'bash', '/usr/local/bin/fish -c y']) assert.ok(isShell(command), command);
  for (const command of ['node index.js', 'sleep 3', '/usr/bin/bashful']) assert.ok(!isShell(command), command);
});

test('the paths a session worked in come from entry directories and tool inputs, never from tool output', () => {
  const lines = [
    { type: 'user', cwd: '/w/main', message: { role: 'user', content: [{ type: 'tool_result', content: 'worktree /w/other-agent\nworktree /w/third' }] } },
    { type: 'assistant', cwd: '/w/main', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /w/fix-224 && git status' } }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/w/pi-branch/src/a.ts' } }, { type: 'text', text: 'see /w/mentioned' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: '/w/printed' }] } },
  ];
  const paths = sessionPaths(lines.map((line) => JSON.stringify(line)).join('\n'));
  assert.deepEqual(paths.sort(), ['/w/fix-224', '/w/main', '/w/pi-branch/src/a.ts']);
});

test('a linked worktree is the nearest directory whose .git is a file, and a main checkout is none', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-leftovers-')));
  try {
    fs.mkdirSync(path.join(root, 'main', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'linked', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'linked', '.git'), 'gitdir: ../main/.git/worktrees/linked\n');
    assert.equal(linkedWorktreeOf(path.join(root, 'linked', 'src', 'gone.ts')), path.join(root, 'linked'));
    assert.equal(linkedWorktreeOf(path.join(root, 'main')), undefined);
    assert.equal(linkedWorktreeOf(root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the refusal names each job and worktree, and a source too old to check is refused with the way forward', () => {
  const lines = leftBehindLines('worker', 'machine box', { jobs: [{ pid: 7, command: 'gh monitor 42' }], worktrees: [{ worktree: '/w/fix', branch: 'fix', risks: ['the worktree has 1 uncommitted path(s): ?? a.ts'] }] });
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /worker runs a background job on machine box: process 7 \(`gh monitor 42`\)/);
  assert.match(lines[1] ?? '', /worktree \/w\/fix on branch fix on machine box, where the worktree has 1 uncommitted path/);
  assert.match(leftBehindLines('worker', 'machine box', undefined, '0.1.9')[0] ?? '', /Bellwether on machine box \(0\.1\.9\) predates the check .* pass accept_loss/);
  assert.deepEqual(leftBehindLines('worker', 'this machine', { jobs: [], worktrees: [] }), []);
});
