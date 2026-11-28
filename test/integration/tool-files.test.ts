// Tier 2: the daemon rewrites a child's tool file that an upgrade broke
// (issue #266). `brew upgrade` of Bellwether or of Node deletes the Cellar
// directory a child's MCP configuration names. A hand-over follows every
// upgrade of Bellwether, so a daemon that starts checks every child's files;
// an upgrade of Node leaves the daemon running, so a child's hello checks that
// child's files again. doctor warns about each rewrite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { channelEntry, mcpConfig } from '../../src/core/mcp-config.ts';
import { mcpConfigPath } from '../../src/core/paths.ts';
import { stablePath } from '../../src/core/stable-path.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { startDaemon, type ParentService } from '../../src/daemon/server.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const GONE_NODE = '/gone/brew/Cellar/node/26.13.1_4/bin/node';
const GONE_CHANNEL = '/gone/brew/Cellar/bellwether/0.1.9/libexec/lib/node_modules/@elecnix/bellwether/dist/integrations/claude/channel.js';

function space(t: test.TestContext): { home: string; socket: string } {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const home = fs.mkdtempSync('/tmp/bw-toolfiles-');
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  t.after(() => {
    process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, socket: path.join(home, 'daemon.sock') };
}

function stubService(): ParentService {
  return { tool: async (name) => `ran ${name}`, markRead: () => {}, onEvents: () => {}, pending: () => [], watchPane: () => () => {}, stop: () => {} };
}

/** A configuration as a 0.1.9 install under a Homebrew Cellar wrote it, before brew upgrade deleted that directory. */
function brokenConfig(childId: string): string {
  const file = mcpConfigPath(childId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { bellwether: { type: 'stdio', command: GONE_NODE, args: ['--disable-warning=ExperimentalWarning', GONE_CHANNEL, '--child', childId] } } }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function server(file: string): { command: string; args: string[] } | undefined {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers['bellwether'];
}

test('a daemon that starts writes this install\'s paths into a tool file that names a deleted Cellar, and leaves an intact one alone', async (t) => {
  const s = space(t);
  const broken = brokenConfig('example-broken');
  const intact = mcpConfigPath('example-intact');
  fs.writeFileSync(intact, `${JSON.stringify(mcpConfig('example-intact'), null, 2)}\n`, { mode: 0o600 });
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(intact, stamp, stamp);
  const before = fs.readFileSync(intact);

  const logs: string[] = [];
  const daemon = await startDaemon({ socketPath: s.socket, home: s.home, factory: () => stubService(), log: (line) => logs.push(line) });
  t.after(() => daemon.close());

  assert.equal(server(broken)?.command, stablePath(process.execPath));
  assert.deepEqual(server(broken)?.args, ['--disable-warning=ExperimentalWarning', stablePath(channelEntry()), '--child', 'example-broken']);
  assert.ok(logs.some((line) => line.includes(GONE_CHANNEL)), logs.join('\n'));
  assert.deepEqual(fs.readFileSync(intact), before);
  assert.equal(fs.statSync(intact).mtimeMs, stamp.getTime(), 'the intact file was not written again');
});

test("a child's hello rewrites its own tool file, which an upgrade of Node broke while the daemon ran", async (t) => {
  const s = space(t);
  const daemon = await startDaemon({ socketPath: s.socket, home: s.home, factory: () => stubService() });
  t.after(() => daemon.close());
  // brew upgrade node, with the daemon still running from the new Node's opt link.
  const broken = brokenConfig('example-child');
  const other = brokenConfig('example-other');

  const client = await DaemonClient.connect({ harness: 'claude-code', session: 'session-example-child', cwd: os.tmpdir(), host: 'machine', depth: 1, herdrSocket: path.join(s.home, 'no-herdr.sock'), childId: 'example-child' }, { home: s.home, socketPath: s.socket, spawn: false });
  t.after(() => client.close());

  assert.equal(server(broken)?.command, stablePath(process.execPath));
  assert.equal(server(other)?.command, GONE_NODE, "a hello checks that child's files only; the next start checks the rest");
});

test('doctor warns about each tool file the daemon rewrote, and about one that still names a deleted path', async (t) => {
  const s = space(t);
  brokenConfig('example-rewritten');
  const daemon = await startDaemon({ socketPath: s.socket, home: s.home, factory: () => stubService() });
  await daemon.close();
  brokenConfig('example-waiting');

  const stdout = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'doctor'], { env: { ...process.env, BELLWETHER_HOME: s.home, BELLWETHER_DAEMON_SOCKET: s.socket, HERDR_SOCKET_PATH: path.join(s.home, 'no-herdr.sock') }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('close', () => resolve(out));
  });
  const lines = stdout.split('\n').filter((line) => line.includes('tool file:'));
  assert.ok(lines.some((line) => /warn {2}tool file: child example-rewritten: .* named .*channel\.js, which no longer exists, and the daemon wrote .* in its place/.test(line)), stdout);
  assert.ok(lines.some((line) => /warn {2}tool file: child example-waiting: .* names .*channel\.js, which no longer exists; the daemon writes .* in its place at its next start or the child's next hello/.test(line)), stdout);
});
