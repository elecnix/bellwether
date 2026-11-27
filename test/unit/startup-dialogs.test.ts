// The pieces of the startup-dialog answer that need no socket: which dialog a
// screen shows, which key moves toward the accepting option, and whose trust
// counts for a repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeTrustsRepository } from '../../src/core/claude-trust.ts';
import { detectDialog, keyToward } from '../../src/core/startup-dialogs.ts';

test('the trust question and the channel confirmation are told apart', () => {
  assert.equal(detectDialog('Quick safety check: Is this a project you created or one you trust?'), 'trust');
  assert.equal(detectDialog('WARNING: Loading development channels'), 'channel');
  assert.equal(detectDialog('╭───╮\n│ > │'), undefined);
});

test('the key moves the selection toward the wanted option, then confirms it', () => {
  const below = ' ❯ 1. No, exit\n   2. Yes, I trust this folder';
  const above = '   1. Yes, I trust this folder\n ❯ 2. No, exit';
  const on = ' ❯ 1. Yes, I trust this folder\n   2. No, exit';
  assert.equal(keyToward(below, 'Yes, I trust this folder'), 'Down');
  assert.equal(keyToward(above, 'Yes, I trust this folder'), 'Up');
  assert.equal(keyToward(on, 'Yes, I trust this folder'), 'Enter');
  assert.equal(keyToward('drawing…', 'Yes, I trust this folder'), undefined);
});

function scratch(): { root: string; state: (projects: string[]) => string; done: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-trust-')));
  return {
    root,
    state: (projects) => {
      const file = path.join(root, 'claude.json');
      fs.writeFileSync(file, JSON.stringify({ projects: Object.fromEntries(projects.map((dir) => [dir, { hasTrustDialogAccepted: true }])) }));
      return file;
    },
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a worktree counts as trusted when another checkout of its repository is', () => {
  const space = scratch();
  try {
    const repo = path.join(space.root, 'repo');
    const worktree = path.join(space.root, 'feature');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
    assert.equal(claudeTrustsRepository(worktree, space.state([repo])), true);
    assert.equal(claudeTrustsRepository(worktree, space.state([])), false);
    // A trusted folder above the repository does not vouch for it: Claude
    // Code itself reads trust only inside the repository.
    assert.equal(claudeTrustsRepository(worktree, space.state([space.root])), false);
  } finally {
    space.done();
  }
});

test('outside git, a trusted folder vouches for the folders under it', () => {
  const space = scratch();
  try {
    const dir = path.join(space.root, 'notes', 'today');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(claudeTrustsRepository(dir, space.state([path.join(space.root, 'notes')])), true);
    assert.equal(claudeTrustsRepository(dir, space.state([path.join(space.root, 'other')])), false);
  } finally {
    space.done();
  }
});
