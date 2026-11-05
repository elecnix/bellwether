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
import { claudeProjectDir } from '../../src/core/transcript.ts';
import { parentId, slug } from '../../src/core/registry.ts';
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

function lab(): Lab {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-channel-'));
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
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['agent_list', 'agent_read', 'agent_send', 'agent_spawn', 'agent_stop']);
    const spawn = listed.tools.find((tool) => tool.name === 'agent_spawn');
    assert.ok(spawn?.inputSchema.properties?.['kind']);
    const list = await client.callTool({ name: 'agent_list', arguments: {} });
    assert.match(JSON.stringify(list.content), /No children yet/);
  } finally {
    await client.close();
    fs.rmSync(room.root, { recursive: true, force: true });
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
    assert.equal(params.meta['event'], 'idle');
    assert.equal(params.meta['receipt'], 'bw-abcdef123456');
    assert.match(params.content, /builder \(pi, w1:p2\) idle/);
    assert.match(params.content, /All tests pass/);
    // The receipt rides in the body, which is what reaches the transcript.
    assert.ok(params.content.includes('bw-abcdef123456'));
  } finally {
    await client.close();
    fs.rmSync(room.root, { recursive: true, force: true });
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
    fs.rmSync(room.root, { recursive: true, force: true });
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
    fs.rmSync(room.root, { recursive: true, force: true });
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
    fs.rmSync(room.root, { recursive: true, force: true });
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
    fs.rmSync(room.root, { recursive: true, force: true });
  }
});
