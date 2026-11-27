// The channel, started the way Claude Code starts it: an MCP server over
// stdio with the session id in the environment. The test speaks the protocol
// to it, pushes a child event through the outbox, and then writes the receipt
// to a fake transcript to prove the event is marked read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import { emptyParent, parentId, slug } from '../../src/core/registry.ts';
import { mcpConfig } from '../../src/core/mcp-config.ts';
import type { OutboxEntry } from '../../src/core/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', '..', 'bin', 'bellwether-mcp.js');
const session = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';

interface Lab {
  root: string;
  home: string;
  cwd: string;
  env: Record<string, string>;
  transcript: string;
  outbox: string;
  parents: string;
}

/** Every lab this file opened, so the last case can prove none left a daemon. */
const roots: string[] = [];

function lab(): Lab {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-channel-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'worktree');
  const config = path.join(root, 'claude');
  const transcript = path.join(config, 'projects', claudeProjectDir(cwd), `${session}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: root,
    BELLWETHER_HOME: home,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PROJECT_DIR: cwd,
    HERDR_SOCKET_PATH: path.join(root, 'no-such-herdr.sock'),
  };
  return { root, home, cwd, env, transcript, outbox: path.join(home, 'outbox', `${slug(parentId('claude-code', session))}.json`), parents: path.join(home, 'parents') };
}

/**
 * Stop the daemon the channel started in this lab, then remove the lab. The
 * daemon runs detached, so without this it keeps running after the test, and
 * it writes into the home while the directory is being removed.
 */
async function closeLab(room: Lab): Promise<void> {
  await stopDaemonsUnder(room.root, room.home);
  fs.rmSync(room.root, { recursive: true, force: true });
}

function entry(receipt: string): OutboxEntry {
  return {
    receipt,
    childId: 'child-1',
    name: 'builder',
    kind: 'pi',
    paneId: 'w1:p2',
    event: 'idle',
    text: 'builder went idle after 30s:\nAll tests pass.',
    at: new Date().toISOString(),
    read: false,
  };
}

function seed(room: Lab, entry: OutboxEntry): void {
  fs.mkdirSync(path.dirname(room.outbox), { recursive: true });
  fs.writeFileSync(room.outbox, `${JSON.stringify([entry], null, 2)}\n`);
}

function outboxOf(room: Lab): OutboxEntry[] {
  return JSON.parse(fs.readFileSync(room.outbox, 'utf8')) as OutboxEntry[];
}

interface Opened {
  client: Client;
  notifications: { method: string; params: unknown }[];
}

async function connect(env: Record<string, string>): Promise<Opened> {
  const notifications: { method: string; params: unknown }[] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  // Unregistered methods land here, which is how a client sees a custom channel.
  client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    notifications.push(notification as { method: string; params: unknown });
  };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'pipe' }));
  return { client, notifications };
}

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('the channel declares claude/channel and registers the Bellwether tools', async () => {
  const room = lab();
  const { client } = await connect(room.env);
  try {
    assert.deepEqual(client.getServerCapabilities()?.experimental?.['claude/channel'], {});
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['agent_adopt', 'agent_list', 'agent_read', 'agent_resume', 'agent_send', 'agent_spawn', 'agent_stop']);
    const spawn = listed.tools.find((tool) => tool.name === 'agent_spawn');
    assert.ok(spawn?.inputSchema.properties?.['kind']);
    const list = await client.callTool({ name: 'agent_list', arguments: {} });
    assert.match(JSON.stringify(list.content), /No children yet/);
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a child event arrives as a channel notification with its receipt', async () => {
  const room = lab();
  seed(room, entry('bw-abcdef123456'));
  const { client, notifications } = await connect(room.env);
  try {
    const pushed = await until('the channel notification', () => notifications.find((each) => entryMethod(each) === 'notifications/claude/channel'));
    const params = pushed.params as { content: string; meta: Record<string, string> };
    assert.equal(params.meta['child'], 'builder');
    assert.equal(params.meta['pane'], 'w1:p2');
    assert.equal(params.meta['child_id'], 'child-1');
    assert.equal(params.meta['event'], 'idle');
    assert.equal(params.meta['receipt'], 'bw-abcdef123456');
    assert.match(params.content, /^\[bellwether\] builder \(w1:p2\) idle, a pi agent — receipt /);
    assert.match(params.content, /All tests pass/);
    // The receipt rides in the body, which is what reaches the transcript.
    assert.ok(params.content.includes('bw-abcdef123456'));
  } finally {
    await client.close();
    await closeLab(room);
  }
});

function entryMethod(notification: { method: string }): string {
  return notification.method;
}

test('a receipt in the transcript marks the event read', async () => {
  const room = lab();
  seed(room, entry('bw-feedfacecafe'));
  const { client, notifications } = await connect(room.env);
  try {
    await until('the channel notification', () => notifications.length || undefined);
    assert.equal(outboxOf(room)[0]?.read, false);
    fs.appendFileSync(room.transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '<channel source="bellwether" receipt="bw-feedfacecafe">child event</channel>' } })}\n`);
    await until('the entry to be marked read', () => (outboxOf(room)[0]?.read ? true : undefined));
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a receipt already in the transcript is not pushed a second time', async () => {
  const room = lab();
  seed(room, entry('bw-0123456789ab'));
  fs.appendFileSync(room.transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'receipt bw-0123456789ab' } })}\n`);
  const { client, notifications } = await connect(room.env);
  try {
    await until('the entry to be marked read', () => (outboxOf(room)[0]?.read ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(notifications, []);
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a child session also gets parent_report', async () => {
  const room = lab();
  const { client } = await connect({ ...room.env, BELLWETHER_PARENT: parentId('claude-code', session) });
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'parent_report'));
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a server started from a spawn MCP config reports through the daemon to the parent that holds the child', async () => {
  const room = lab();
  // The parent's registry, with the child the spawn wrote before it started the tab.
  const parentRecord = emptyParent('claude-code', 'the-real-parent', room.cwd, { paneId: 'w1:p1' });
  const at = new Date().toISOString();
  parentRecord.children.push({ id: 'kid-7', name: 'reporter', kind: 'claude', harness: 'claude-code', paneId: 'w1:p9', host: 'local', startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 });
  fs.mkdirSync(room.parents, { recursive: true });
  fs.writeFileSync(path.join(room.parents, `${slug(parentRecord.id)}.json`), JSON.stringify(parentRecord));

  // Exactly what Claude Code runs from the file: no BELLWETHER_* variable at all.
  const configured = mcpConfig('kid-7').mcpServers['bellwether'];
  assert.ok(configured);
  const notifications: { method: string; params: unknown }[] = [];
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (notification: { method: string }): Promise<void> => {
    notifications.push(notification as { method: string; params: unknown });
  };
  await client.connect(new StdioClientTransport({ command: configured.command, args: configured.args, env: { ...room.env, HERDR_PANE_ID: 'w1:p9' }, stderr: 'pipe' }));
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'parent_report'), 'a child named by --child gets parent_report');
    const reply = (await client.callTool({ name: 'parent_report', arguments: { status: 'done', text: 'shipped' } })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(reply.isError, undefined, reply.content[0]?.text);
    const spool = path.join(room.home, 'spool', `${slug(parentRecord.id)}.jsonl`);
    const report = JSON.parse(fs.readFileSync(spool, 'utf8').trim()) as { childId: string; childName: string; paneId: string };
    assert.deepEqual([report.childId, report.childName, report.paneId], ['kid-7', 'reporter', 'w1:p9']);
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('the server exits when stdin closes', async () => {
  const room = lab();
  const child = spawn(process.execPath, [server], { env: room.env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await until('the registry record', () => (fs.existsSync(room.parents) ? true : undefined));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin?.end();
    assert.equal(await exited, 0);
  } finally {
    child.kill('SIGKILL');
    await closeLab(room);
  }
});

// Runs last: node:test runs the cases of one file in order.
test('no daemon outlives the channel cases', async () => {
  const left = roots.flatMap((root) => daemonsUnder(root));
  // Stop them anyway, so a failure here leaves no process behind.
  for (const root of roots) await stopDaemonsUnder(root, path.join(root, 'home'));
  assert.deepEqual(left, [], `daemons outlived their test: ${left.map((daemon) => `${daemon.pid} on ${daemon.socket}`).join(', ')}`);
});
