// Tier 2: a Claude Code child that opens on its folder-trust question and its
// development-channel confirmation. The fake herdr plays both screens and
// moves between them on the keys the spawn sends, the way Claude Code does.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';

const TRUST_ON_NO = [
  'Accessing workspace:',
  '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).',
  '',
  ' ❯ 1. No, exit',
  '   2. Yes, I trust this folder',
].join('\n');
const TRUST_ON_YES = TRUST_ON_NO.replace(' ❯ 1. No, exit', '   1. No, exit').replace('   2. Yes, I trust this folder', ' ❯ 2. Yes, I trust this folder');
const CHANNEL = [
  'WARNING: Loading development channels',
  '',
  '--dangerously-load-development-channels is for local channel development only.',
  'Channels: server:bellwether',
  '',
  ' ❯ 1. I am using this for local development',
  '   2. Exit',
].join('\n');
const READY = '╭──────────╮\n│ >        │\n╰──────────╯';

type Screen = 'trust-no' | 'trust-yes' | 'channel' | 'ready';

interface Room {
  root: string;
  repo: string;
  herdr: FakeHerdr;
  keys: string[];
  screen: () => Screen;
  close: () => Promise<void>;
}

/** A scratch home, a git repository, a Claude config, and a fake herdr that plays the dialogs. */
async function room(options: { trusted: boolean }): Promise<Room> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-dialogs-')));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'feature');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
  const config = path.join(root, 'claude');
  fs.mkdirSync(config);
  // The person trusted the repository's main checkout, never the new worktree.
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: options.trusted ? { [repo]: { hasTrustDialogAccepted: true } } : {} }));

  const saved = { home: process.env['BELLWETHER_HOME'], config: process.env['CLAUDE_CONFIG_DIR'] };
  process.env['BELLWETHER_HOME'] = path.join(root, 'home');
  process.env['CLAUDE_CONFIG_DIR'] = config;

  let screen: Screen = 'trust-no';
  const keys: string[] = [];
  let herdr: FakeHerdr | undefined;
  const status = (agentStatus: string): void => {
    setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: agentStatus } }), 20);
  };
  herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'agent.start') {
        status('blocked');
        return undefined;
      }
      if (request.method === 'pane.read') {
        const text = { 'trust-no': TRUST_ON_NO, 'trust-yes': TRUST_ON_YES, channel: CHANNEL, ready: READY }[screen];
        return { result: { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'visible', format: 'text', text } } };
      }
      if (request.method === 'agent.send_keys') {
        const pressed = (request.params['keys'] as string[]).join(' ');
        keys.push(pressed);
        if (screen === 'trust-no' && pressed === 'Down') screen = 'trust-yes';
        else if (screen === 'trust-yes' && pressed === 'Enter') screen = 'channel';
        else if (screen === 'channel' && pressed === 'Enter') {
          screen = 'ready';
          status('idle');
        } else if (screen === 'trust-no' && pressed === 'Enter') throw new Error('Enter on "No, exit" quits Claude Code');
      }
      return undefined;
    },
  });
  return {
    root,
    repo: worktree,
    herdr,
    keys,
    screen: () => screen,
    close: async () => {
      await herdr?.stop();
      for (const [name, value] of [['BELLWETHER_HOME', saved.home], ['CLAUDE_CONFIG_DIR', saved.config]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a child in a worktree of a trusted repository reaches its prompt with no one at the pane', async () => {
  const space = await room({ trusted: true });
  try {
    const parent = saveParent(emptyParent('pi', 'dialogs-trusted', space.root, { workspaceId: 'w1' }));
    const { child } = await spawnChild(new HerdrClient({ socketPath: space.herdr.socketPath }), parent, { kind: 'claude', name: 'worker', cwd: space.repo, prompt: 'Do the work.' });
    assert.deepEqual(space.keys, ['Down', 'Enter', 'Enter']);
    assert.equal(space.screen(), 'ready');
    // The watcher holds a child's events only while its dialogs are answered.
    assert.equal(readParent(parent.id)?.children.find((entry) => entry.id === child.id)?.startingUntil, undefined);
  } finally {
    await space.close();
  }
});

test('a child in a repository nobody trusted is left on the question, for a person to answer', async () => {
  const space = await room({ trusted: false });
  try {
    const parent = saveParent(emptyParent('pi', 'dialogs-untrusted', space.root, { workspaceId: 'w1' }));
    const { child } = await spawnChild(new HerdrClient({ socketPath: space.herdr.socketPath }), parent, { kind: 'claude', name: 'worker', cwd: space.repo, prompt: 'Do the work.' });
    assert.deepEqual(space.keys, []);
    assert.equal(space.screen(), 'trust-no');
    // The hold is lifted, so the watcher reports the blocked child.
    assert.equal(readParent(parent.id)?.children.find((entry) => entry.id === child.id)?.startingUntil, undefined);
  } finally {
    await space.close();
  }
});
