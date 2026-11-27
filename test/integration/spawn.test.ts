// Tier 2: agent_spawn against the fake herdr socket, in a scratch home. The
// fake refuses an argument with a line break, the way herdr does, so a prompt
// that reaches the command line fails here as it failed in use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { promptPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import type { ParentRecord } from '../../src/core/types.ts';
import { startFakeHerdr, type FakeHerdr, type FakeHerdrOptions } from '../fixtures/fake-herdr.ts';

const brief = 'Publish the package.\n\nRun the gates first, then tag the release.\nTell the parent when it is done.';

interface Room {
  home: string;
  herdr: FakeHerdr;
  client: HerdrClient;
  parent: ParentRecord;
  close: () => Promise<void>;
}

async function room(options: FakeHerdrOptions = {}): Promise<Room> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-spawn-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr(options);
  const parent = saveParent(emptyParent('pi', `spawn-${path.basename(home)}`, home, { workspaceId: 'w1' }));
  return {
    home,
    herdr,
    client: new HerdrClient({ socketPath: herdr.socketPath }),
    parent,
    close: async () => {
      await herdr.stop();
      if (previous === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function startArgs(herdr: FakeHerdr): string[] {
  const start = herdr.requests.find((request) => request.method === 'agent.start');
  assert.ok(start, 'herdr was never asked to start the agent');
  return start.params['args'] as string[];
}

test('a multi-line prompt reaches Claude Code as an @ mention of a private file', async () => {
  // The child reaches its prompt with no dialog, and herdr reports it idle,
  // which is what lets the spawn return.
  let herdr: FakeHerdr | undefined;
  const space = await room({
    respond: (request) => {
      if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  herdr = space.herdr;
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: 'claude', name: 'npm-publish', prompt: brief });
    const file = promptPath(child.id);
    const args = startArgs(space.herdr);
    assert.ok(args.includes(`@${file}`), `no @ mention of ${file} in ${JSON.stringify(args)}`);
    assert.ok(!args.some((arg) => arg.includes('Publish the package')), 'the prompt text reached the command line');
    assert.equal(fs.readFileSync(file, 'utf8'), brief);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  } finally {
    await space.close();
  }
});

test('Pi gets the same @ mention, and another harness a one-line pointer', async () => {
  const space = await room();
  try {
    const { child: pi } = await spawnChild(space.client, space.parent, { kind: 'pi', name: 'pi-child', prompt: brief });
    assert.ok(startArgs(space.herdr).includes(`@${promptPath(pi.id)}`));
    space.herdr.requests.length = 0;
    const { child: codex } = await spawnChild(space.client, readParent(space.parent.id) ?? space.parent, { kind: 'codex', name: 'codex-child', prompt: brief });
    assert.deepEqual(startArgs(space.herdr), [`Your task is in ${promptPath(codex.id)}. Read it, then do what it says.`]);
  } finally {
    await space.close();
  }
});

test('a spawn herdr refuses leaves no record, no tab and no brief behind', async () => {
  const space = await room({
    respond: (request) => (request.method === 'agent.start' ? { error: { code: 'agent_start_failed', message: 'no such agent kind' } } : undefined),
  });
  try {
    await assert.rejects(spawnChild(space.client, space.parent, { kind: 'claude', name: 'ghost', prompt: brief }), /no such agent kind/);
    assert.deepEqual(readParent(space.parent.id)?.children, []);
    assert.ok(space.herdr.requests.some((request) => request.method === 'tab.close' && request.params['tab_id'] === 'w1:t1'), 'the tab was left open');
    const prompts = path.join(space.home, 'prompts');
    assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], []);
  } finally {
    await space.close();
  }
});
