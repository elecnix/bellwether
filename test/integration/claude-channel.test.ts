// The channel, started the way Claude Code starts it: an MCP server over
// stdio with the session id in the environment. The test speaks the protocol
// to it, pushes a child event through the outbox, and then writes the receipt
// to a fake transcript to prove the event is marked read.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['agent_adopt', 'agent_grant_depth', 'agent_list', 'agent_move', 'agent_read', 'agent_restart', 'agent_send', 'agent_spawn', 'agent_stop']);
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

// Issue #146: the registry holds a second child, and the event about the first carries one line about it.
test('a channel event carries one roster line about the parent\'s other live child, built from the registry', async () => {
  const room = lab();
  seed(room, entry('bw-roster000001'));
  const quiet = new Date(Date.now() - 40 * 60_000 - 5_000).toISOString();
  const record = emptyParent('claude-code', session, room.cwd, { host: 'local' });
  const child = (id: string, name: string, pane: string, lastStatus: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: 'pi', harness: 'pi', host: 'local', paneId: pane, depth: 1, startedAt: quiet, lastStatus, statusChangedAt: quiet, lastBusyAt: quiet, ...extra });
  record.children = [
    child('child-1', 'builder', 'w1:p2', 'idle'),
    child('child-2', 'reviewer', 'w1:p3', 'idle'),
    child('child-3', 'gone', 'w1:p4', 'idle', { exitedAt: quiet }),
  ] as unknown as typeof record.children;
  fs.mkdirSync(room.parents, { recursive: true });
  fs.writeFileSync(path.join(room.parents, `${slug(record.id)}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const { client, notifications } = await connect(room.env);
  try {
    const pushed = await until('the channel notification', () => notifications.find((each) => entryMethod(each) === 'notifications/claude/channel'));
    const content = (pushed.params as { content: string }).content;
    const lines = content.split('\n');
    assert.deepEqual(lines.filter((line) => line.startsWith('children ')), ['children 2: reviewer idle 40m'], content);
    assert.ok(content.endsWith('All tests pass.\n\nchildren 2: reviewer idle 40m\n\nRead more with agent_read. Reply with agent_send.'), content);
  } finally {
    await client.close();
    await closeLab(room);
  }
});

function entryMethod(notification: { method: string }): string {
  return notification.method;
}

/** The line Claude Code writes when a channel message reaches the model. */
function delivery(receipt: string): string {
  const prompt = `<channel source="bellwether" receipt="${receipt}">child event</channel>`;
  return `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'channel', server: 'bellwether' } } })}\n`;
}

test('a channel delivery in the transcript marks the event read, and a tool result quoting it does not', async () => {
  const room = lab();
  seed(room, entry('bw-feedfacecafe'));
  const { client, notifications } = await connect(room.env);
  try {
    await until('the channel notification', () => notifications.length || undefined);
    assert.equal(outboxOf(room)[0]?.read, false);
    // The parent cats its outbox file: the receipt reaches the model as tool output, which is not a delivery.
    fs.appendFileSync(room.transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '"receipt": "bw-feedfacecafe"' }] } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(outboxOf(room)[0]?.read, false, 'a shell read of the outbox does not consume the notification');
    fs.appendFileSync(room.transcript, delivery('bw-feedfacecafe'));
    await until('the entry to be marked read', () => (outboxOf(room)[0]?.read ? true : undefined));
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a receipt already in the transcript is not pushed a second time', async () => {
  const room = lab();
  seed(room, entry('bw-0123456789ab'));
  fs.appendFileSync(room.transcript, delivery('bw-0123456789ab'));
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

/** A real repository under the lab, with a linked worktree on branch feat. */
function worktreeIn(root: string): string {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' });
  };
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const worktree = path.join(root, 'feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', worktree);
  // A commit of its own, so the branch is not merged yet.
  fs.writeFileSync(path.join(worktree, 'b.txt'), 'b\n');
  git(worktree, 'add', 'b.txt');
  git(worktree, 'commit', '-q', '-m', 'b');
  return fs.realpathSync(worktree);
}

/** A process's working directory, from /proc or from lsof. */
function cwdOf(pid: number): string {
  if (fs.existsSync(`/proc/${pid}/cwd`)) return fs.readlinkSync(`/proc/${pid}/cwd`);
  const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  return out.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
}

test('a child asks to be retired through its own server, and the daemon records the intent from real git', async () => {
  const room = lab();
  const worktree = worktreeIn(room.root);
  const parentRecord = emptyParent('claude-code', 'the-retiring-parent', room.cwd, { paneId: 'w1:p1' });
  const at = new Date().toISOString();
  parentRecord.children.push({ id: 'kid-9', name: 'finisher', kind: 'claude', harness: 'claude-code', paneId: 'w1:p8', host: 'local', origin: 'spawn', cwd: worktree, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1 });
  fs.mkdirSync(room.parents, { recursive: true });
  const registry = path.join(room.parents, `${slug(parentRecord.id)}.json`);
  fs.writeFileSync(registry, JSON.stringify(parentRecord));

  const configured = mcpConfig('kid-9').mcpServers['bellwether'];
  assert.ok(configured);
  const client = new Client({ name: 'claude-code', version: '0.0.0' }, { capabilities: {} });
  // The server starts in the child's worktree, as Claude Code starts it.
  await client.connect(new StdioClientTransport({ command: configured.command, args: configured.args, cwd: worktree, env: { ...room.env, HERDR_PANE_ID: 'w1:p8' }, stderr: 'pipe' }));
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'request_retirement'), 'a child named by --child gets request_retirement');
    const reply = (await client.callTool({ name: 'request_retirement', arguments: { reason: 'done' } })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(reply.isError, undefined, reply.content[0]?.text);
    assert.match(reply.content[0]?.text ?? '', new RegExp(`^Retirement requested for finisher: ${worktree} on branch feat\\. Nothing has been removed\\.`));
    assert.match(reply.content[0]?.text ?? '', /Passed now: the worktree is clean; no stash on the branch\./);
    assert.match(reply.content[0]?.text ?? '', /Failing now: branch feat is not merged into main/);
    const saved = JSON.parse(fs.readFileSync(registry, 'utf8')) as { children: { retireRequestedAt?: string; retireIntent?: { worktree: string; branch: string } }[] };
    assert.ok(saved.children[0]?.retireRequestedAt);
    assert.equal(saved.children[0]?.retireIntent?.worktree, worktree);
    assert.ok(fs.existsSync(worktree), 'the request removes nothing');

    // The daemon this child started works from its home, not from the worktree.
    const [daemon] = daemonsUnder(room.root);
    assert.ok(daemon, 'the channel started a daemon');
    assert.equal(cwdOf(daemon.pid), fs.realpathSync(room.home));
  } finally {
    await client.close();
    await closeLab(room);
  }
});

test('a parent session does not get request_retirement', async () => {
  const room = lab();
  const { client } = await connect({ ...room.env, BELLWETHER_PARENT: parentId('claude-code', session) });
  try {
    const listed = await client.listTools();
    assert.ok(!listed.tools.some((tool) => tool.name === 'request_retirement'));
  } finally {
    await client.close();
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
