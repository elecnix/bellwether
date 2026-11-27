// Tier 2: where a session's Bellwether tools come from. A Claude Code child
// gets exactly one set, from its own server, whatever else its environment
// holds, and its record says so. A session takes its list from the daemon, so
// a newer daemon brings a newer tool to a session already connected.
//
// Claude Code itself does not run here. What it does with the files a spawn
// writes was checked against Claude Code 2.1.332 by hand: `--settings` with
// `enabledPlugins: {"<id>": false}` drops that plugin's server and keeps every
// other one, and a server in `--mcp-config` replaces a user-scope server of the
// same name. `loadedServers` below plays those two rules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent, slug } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { startDaemon, type Daemon } from '../../src/daemon/server.ts';
import { servedTools, toolNames } from '../../src/integrations/tools.ts';
import { FEATURES } from '../../src/daemon/features.ts';
import type { ParentHello, ServedTool } from '../../src/daemon/protocol.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { isolate } from '../fixtures/isolated.ts';

type Server = { command?: string; args?: string[] };

/** A fake herdr whose child goes idle once started, so a Claude Code spawn finishes without dialogs. */
async function idleHerdr(t: test.TestContext): Promise<Awaited<ReturnType<typeof startFakeHerdr>>> {
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
  herdr = await startFakeHerdr({
    respond: (request) => {
      if (harnessStart(request) !== undefined) setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  t.after(() => herdr?.stop());
  return herdr;
}

function startArgs(herdr: Awaited<ReturnType<typeof startFakeHerdr>>): string[] {
  return (harnessStarts(herdr)[0]?.args as string[]) ?? [];
}

function flag(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The MCP servers a Claude Code child loads, by name, from its environment and
 * the flags its spawn passed: each enabled plugin's server, each user-scope
 * server, then each `--mcp-config` server, which wins a shared name. A plugin
 * that `--settings` turns off loads nothing.
 */
function loadedServers(configDir: string, args: string[], plugins: Record<string, Server>): Map<string, Server> {
  const settings = readJson(path.join(configDir, 'settings.json'));
  const enabled: Record<string, unknown> = { ...(settings['enabledPlugins'] as Record<string, unknown>) };
  const extra = flag(args, '--settings');
  if (extra) Object.assign(enabled, readJson(extra)['enabledPlugins'] as Record<string, unknown>);
  const loaded = new Map<string, Server>();
  for (const [id, server] of Object.entries(plugins)) if (enabled[id] === true) loaded.set(`plugin:${id.split('@')[0]}:${id.split('@')[0]}`, server);
  for (const [name, server] of Object.entries(readJson(path.join(configDir, '.claude.json'))['mcpServers'] as Record<string, Server>)) loaded.set(name, server);
  const config = flag(args, '--mcp-config');
  if (config) for (const [name, server] of Object.entries(readJson(config)['mcpServers'] as Record<string, Server>)) loaded.set(name, server);
  return loaded;
}

/** The tools one MCP server offers, asked over stdio as Claude Code asks. */
async function listTools(server: Server, env: Record<string, string>): Promise<string[]> {
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: server.command ?? '', args: server.args ?? [], env, stderr: 'pipe' }));
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test('a Claude Code child whose environment already has Bellwether servers gets one set of tools, and its record says its own server won', async (t) => {
  const { root } = isolate(t, 'bellwether-tools-');
  const configDir = process.env['CLAUDE_CONFIG_DIR'] as string;
  // The operator's plugin, and a server they added by hand under another name.
  const plugin = { command: '/opt/example/bellwether/bin/bellwether-mcp.js' };
  writeJson(path.join(configDir, 'settings.json'), { enabledPlugins: { 'bellwether@example-market': true, 'example-other@example-market': true } });
  writeJson(path.join(configDir, '.claude.json'), { mcpServers: { 'example-bw': { command: 'bellwether-mcp' }, 'example-notes': { command: 'example-notes-server' } } });
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const parent = saveParent(emptyParent('claude-code', 'deduper', cwd, { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);

  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'single', cwd, startupTimeoutMs: 2_000, redrawMs: 10 });

  const args = startArgs(herdr);
  const loaded = loadedServers(configDir, args, { 'bellwether@example-market': plugin, 'example-other@example-market': { command: 'example-other' } });
  // Every other server stays, the plugin's included for the plugin that is not Bellwether.
  assert.ok(loaded.has('example-notes'), 'a server that is not Bellwether is left alone');
  assert.ok(loaded.has('plugin:example-other:example-other'), 'a plugin that is not Bellwether is left alone');
  assert.ok(!loaded.has('plugin:bellwether:bellwether'), `the Bellwether plugin is turned off for the child: ${args.join(' ')}`);
  // Of the servers that answer to a Bellwether name, one offers tools: the child's own, with its id.
  const env = { PATH: process.env['PATH'] ?? '', HOME: root };
  const offering: string[] = [];
  for (const name of ['bellwether', 'example-bw']) {
    const server = loaded.get(name);
    assert.ok(server, `${name} is loaded`);
    if (name === 'bellwether') {
      assert.deepEqual(server.args?.slice(-2), ['--child', child.id]);
      offering.push(name);
    } else if ((await listTools(server, env)).length) offering.push(name);
  }
  assert.deepEqual(offering, ['bellwether'], 'one server offers Bellwether\'s tools');

  const record = readParent(parent.id)?.children.find((entry) => entry.id === child.id);
  assert.deepEqual(record?.toolSource, {
    server: 'per-child',
    suppressed: [
      { kind: 'plugin', name: 'bellwether@example-market', file: path.join(configDir, 'settings.json'), how: 'plugin-disabled' },
      { kind: 'user', name: 'example-bw', file: path.join(configDir, '.claude.json'), how: 'stood-down' },
    ],
  });
});

test('a Claude Code child with no Bellwether server in its environment gets its own, and reports through it', async (t) => {
  const { root, home } = isolate(t, 'bellwether-tools-');
  t.after(() => stopDaemonsUnder(root, home));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const parent = saveParent(emptyParent('claude-code', 'plain', cwd, { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);

  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'plain-child', cwd, startupTimeoutMs: 2_000, redrawMs: 10 });

  const args = startArgs(herdr);
  // The settings file holds the dialog hook and the read set, and no plugin to turn off.
  assert.deepEqual(Object.keys(readJson(flag(args, '--settings') ?? '')).sort(), ['hooks', 'permissions', 'sandbox']);
  assert.deepEqual(readParent(parent.id)?.children.find((entry) => entry.id === child.id)?.toolSource, { server: 'per-child', suppressed: [] });

  // The server Claude Code would start from the child's config, with nothing from the tab's environment.
  const server = (readJson(flag(args, '--mcp-config') ?? '')['mcpServers'] as Record<string, Server>)['bellwether'] as Server;
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: server.command ?? '', args: server.args ?? [], env: { PATH: process.env['PATH'] ?? '', HOME: root, BELLWETHER_HOME: home, CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] as string, HERDR_PANE_ID: child.paneId, HERDR_SOCKET_PATH: path.join(root, 'no-such-herdr.sock') }, stderr: 'pipe' }));
  try {
    const reply = (await client.callTool({ name: 'parent_report', arguments: { status: 'done', text: 'one set, and it reports' } })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(reply.isError, undefined, reply.content[0]?.text);
    const report = JSON.parse(fs.readFileSync(path.join(home, 'spool', `${slug(parent.id)}.jsonl`), 'utf8').trim()) as { childId: string; text: string };
    assert.deepEqual([report.childId, report.text], [child.id, 'one set, and it reports']);
  } finally {
    await client.close();
  }
});

/** A tool no release has, which only the second daemon serves. */
const NEWER: ServedTool = { name: 'example_newer_tool', description: 'A tool from a newer daemon.', schema: { type: 'object', properties: {} } };

test('a session connected to a daemon sees a tool a newer daemon serves without restarting, in pi and in Claude Code', async (t) => {
  const { root, home } = isolate(t, 'bellwether-tools-');
  const socketPath = path.join(home, 'daemon.sock');
  fs.mkdirSync(home, { recursive: true });
  let daemon: Daemon = await startDaemon({ socketPath, home, idleMs: 60_000, pruneEveryMs: false });
  t.after(async () => {
    await daemon.close();
    await stopDaemonsUnder(root, home);
  });

  // pi: the extension registers what the daemon serves at session start.
  const registered: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: { name: string }) => registered.push(tool.name),
    sendMessage: () => {},
  };
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  bellwether(pi);
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => 'pi-session', getCwd: () => root, getEntries: () => [] } };
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  assert.ok(registered.includes('agent_spawn'));
  assert.ok(!registered.includes(NEWER.name));

  // Claude Code: the channel answers tools/list from the daemon.
  const changed: string[] = [];
  const claude = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  claude.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    changed.push(notification.method);
  };
  const channel = path.join(import.meta.dirname, '..', '..', 'bin', 'bellwether-mcp.js');
  await claude.connect(new StdioClientTransport({ command: process.execPath, args: [channel], env: { PATH: process.env['PATH'] ?? '', HOME: root, BELLWETHER_HOME: home, BELLWETHER_DAEMON_SOCKET: socketPath, CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] as string, CLAUDE_CODE_SESSION_ID: 'claude-session', CLAUDE_PROJECT_DIR: root, HERDR_SOCKET_PATH: path.join(root, 'no-such-herdr.sock') }, stderr: 'pipe' }));
  t.after(() => claude.close());
  assert.ok(!(await claude.listTools()).tools.some((tool) => tool.name === NEWER.name));

  // The daemon goes, and a newer one takes the socket. Neither session restarts.
  await daemon.close();
  daemon = await startDaemon({ socketPath, home, idleMs: 60_000, pruneEveryMs: false, tools: (parent: ParentHello) => [...servedTools({ reportsTo: parent.reportsTo, childId: parent.childId }), NEWER] });

  const deadline = Date.now() + 10_000;
  while (!registered.includes(NEWER.name) || !changed.includes('notifications/tools/list_changed')) {
    if (Date.now() > deadline) throw new Error(`the sessions never saw the newer tool: pi registered ${registered.join(', ')}; the channel sent ${changed.join(', ') || 'nothing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok((await claude.listTools()).tools.some((tool) => tool.name === NEWER.name), 'Claude Code asks again, and the list has the newer tool');
  assert.equal(registered.filter((name) => name === 'agent_spawn').length, 1, 'a tool pi already has is not registered twice');
  for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, ctx);
});

test('the tool list a daemon serves is the feature table\'s, and every tool in the table has a definition', () => {
  const names = servedTools({ reportsTo: 'some-parent', childId: 'some-child' }).map((tool) => tool.name);
  assert.ok(names.includes('agent_move') && names.includes('agent_restart'), 'a session gets the tools added in 0.1.5');
  assert.deepEqual(servedTools({ reportsTo: 'some-parent', childId: 'some-child' }, []), [], 'a tool missing from the table is not served');
  const tabled = FEATURES.filter((feature) => feature.kind === 'tool').map((feature) => feature.name).sort();
  assert.deepEqual(toolNames().sort(), tabled, 'each tool has a feature entry, and each tool entry a definition');
});
