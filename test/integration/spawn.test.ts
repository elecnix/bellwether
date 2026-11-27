// Tier 2: agent_spawn against the fake herdr socket, in a scratch home. The
// fake refuses an argument with a line break, the way herdr does, so a prompt
// that reaches the command line fails here as it failed in use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { channelEntry } from '../../src/core/mcp-config.ts';
import { mcpConfigPath, promptPath } from '../../src/core/paths.ts';
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

/** The tab environment herdr was asked for, which is what the child's shell inherits. */
function tabEnv(herdr: FakeHerdr): Record<string, string> {
  const create = herdr.requests.find((request) => request.method === 'tab.create');
  assert.ok(create, 'herdr was never asked for a tab');
  return create.params['env'] as Record<string, string>;
}

/** The --mcp-config argument, in the equals form that keeps the flag to one value. */
function mcpArgument(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith('--mcp-config='))?.slice('--mcp-config='.length);
}

function idleOnStart(): { options: FakeHerdrOptions; bind: (herdr: FakeHerdr) => void } {
  let herdr: FakeHerdr | undefined;
  return {
    options: {
      respond: (request) => {
        if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
        return undefined;
      },
    },
    bind: (next) => {
      herdr = next;
    },
  };
}

test('a Claude Code spawn hands the child its own MCP server through a private --mcp-config file', async () => {
  const idle = idleOnStart();
  const space = await room(idle.options);
  idle.bind(space.herdr);
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: 'claude', name: 'reporter', prompt: brief });
    const file = mcpConfigPath(child.id);
    const args = startArgs(space.herdr);
    assert.equal(mcpArgument(args), file, `no --mcp-config=${file} in ${JSON.stringify(args)}`);
    assert.ok(args.includes('--dangerously-load-development-channels=server:bellwether'), 'the channel flag is still there');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

    // The file names the packaged server, and nothing else.
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env?: unknown }> };
    assert.deepEqual(Object.keys(config), ['mcpServers']);
    assert.deepEqual(Object.keys(config.mcpServers), ['bellwether']);
    const server = config.mcpServers['bellwether'];
    assert.ok(server);
    assert.equal(server.command, process.execPath);
    assert.equal(server.env, undefined, 'no identity rides in a process environment');
    const entry = server.args.find((arg) => /integrations[\\/]claude[\\/]channel\.(ts|js)$/.test(arg));
    assert.ok(entry && fs.existsSync(entry), `the packaged channel entry is missing from ${JSON.stringify(server.args)}`);
    assert.equal(entry, channelEntry());

    // The server names its child by the record the daemon holds, and that id
    // is the one the tab's environment carries.
    assert.deepEqual(server.args.slice(server.args.indexOf('--child'), server.args.indexOf('--child') + 2), ['--child', child.id]);
    assert.equal(tabEnv(space.herdr)['BELLWETHER_CHILD'], child.id);
    assert.ok(readParent(space.parent.id)?.children.some((entry) => entry.id === child.id));
  } finally {
    await space.close();
  }
});

test('a Pi spawn gets no MCP config, because its extension is its adapter', async () => {
  const space = await room();
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: 'pi', name: 'pi-child', prompt: brief });
    assert.equal(mcpArgument(startArgs(space.herdr)), undefined);
    assert.equal(fs.existsSync(mcpConfigPath(child.id)), false);
  } finally {
    await space.close();
  }
});

test('a failed Claude Code spawn removes its MCP config with its brief', async () => {
  const space = await room({
    respond: (request) => (request.method === 'agent.start' ? { error: { code: 'agent_start_failed', message: 'no such agent kind' } } : undefined),
  });
  try {
    await assert.rejects(spawnChild(space.client, space.parent, { kind: 'claude', name: 'ghost', prompt: brief }), /no such agent kind/);
    const dir = path.join(space.home, 'mcp');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  } finally {
    await space.close();
  }
});
