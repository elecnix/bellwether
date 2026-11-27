// Tier 2: a report from a child on another machine. Two machines are two
// Bellwether homes in one temporary root, joined by a fake ssh on PATH that
// runs each remote command against the home assigned to its target. The
// child's machine runs its daemon in this process; the parent's machine gets
// whatever daemon `bellwether report` starts there, as it would in use.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { configPath, relayChildPath, relayOutboxDir, spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, saveRelayRecord, type RelayRecord } from '../../src/core/relay-records.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord, SpoolReport } from '../../src/core/types.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { Relay } from '../../src/daemon/relay.ts';
import { startDaemon, type Daemon, type ParentService } from '../../src/daemon/server.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { stopDaemonsUnder } from '../fixtures/daemons.ts';
import { startFakeHerdr, type FakeHerdrOptions } from '../fixtures/fake-herdr.ts';
import { installFakeSsh, type FakeSsh } from '../fixtures/fake-ssh.ts';
import { LIVE_HOME } from '../fixtures/isolation.ts';

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');
const PARENT_ID = 'claude-code-the-parent';

interface World {
  root: string;
  /** The child's machine: this process. */
  childHome: string;
  /** The parent's machine, reached as `parent-box`. */
  parentHome: string;
  /** A third machine a parent spawns onto, reached as `remote-box`. */
  remoteHome: string;
  ssh: FakeSsh;
  logs: string[];
  /** Run at the end of the case, newest first, so a client closes before its daemon. */
  closers: (() => Promise<void> | void)[];
}

/** Run `fn` with this process's Bellwether home pointed at `home`. */
function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

function world(t: test.TestContext): World {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-relay-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const childHome = path.join(root, 'child', '.bellwether');
  const parentHome = path.join(root, 'parent', '.bellwether');
  const remoteHome = path.join(root, 'remote', '.bellwether');
  for (const home of [childHome, parentHome, remoteHome]) fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, {
    'parent-box': { home: parentHome, userHome: path.dirname(parentHome) },
    'remote-box': { home: remoteHome, userHome: path.dirname(remoteHome) },
  });
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = childHome;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(childHome, 'daemon.sock');
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await stopDaemonsUnder(root);
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, childHome, parentHome, remoteHome, ssh, logs: [], closers };
}

function childRecord(id: string, host: string): ChildRecord {
  const at = new Date().toISOString();
  return { id, name: `child-${id}`, kind: 'claude', harness: 'claude-code', paneId: 'w1:p5', host, startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 };
}

/** The parent's machine holds the parent and a record of the child on `child-box`. */
function parentHolds(w: World, childId: string): void {
  inHome(w.parentHome, () => {
    saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
    upsertChild(PARENT_ID, childRecord(childId, 'child-box'));
  });
}

function relayRecord(childId: string, parentHost = 'parent-box'): RelayRecord {
  return { schema: RELAY_SCHEMA, childId, name: `child-${childId}`, kind: 'claude', parentId: PARENT_ID, parentHost, registeredAt: new Date().toISOString() };
}

function spoolOf(home: string, parentId: string): SpoolReport[] {
  const file = inHome(home, () => spoolPath(parentId));
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpoolReport);
}

/** A session service that must never be reached: the relay answers first, or the test says so. */
function stubService(): ParentService {
  return {
    tool: async (name) => `the session service ran ${name}`,
    markRead: () => {},
    onEvents: () => {},
    pending: () => [],
    watchPane: () => () => {},
    stop: () => {},
  };
}

async function childDaemon(w: World, relayOptions: ConstructorParameters<typeof Relay>[0] = {}, extra: { idleMs?: number; idleCheckMs?: number } = {}): Promise<Daemon> {
  const relay = new Relay({ initialDelayMs: 50, maxDelayMs: 200, hopTimeoutMs: 20_000, log: (line) => w.logs.push(line), ...relayOptions });
  const daemon = await startDaemon({ socketPath: path.join(w.childHome, 'daemon.sock'), home: w.childHome, factory: () => stubService(), relay, log: (line) => w.logs.push(line), ...extra });
  w.closers.push(() => daemon.close());
  return daemon;
}

/** The child's own Bellwether server, as the spawn's MCP config starts it. */
async function childClient(w: World, childId: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(
    { harness: 'claude-code', session: `session-${childId}`, cwd: '/work', host: 'child-box', depth: 1, herdrSocket: path.join(w.root, 'no-herdr.sock'), childId, paneId: 'w1:p5' },
    { home: w.childHome, socketPath: path.join(w.childHome, 'daemon.sock'), spawn: false },
  );
  w.closers.push(() => client.close());
  return client;
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

test('a report for a child this machine holds is served here and never forwarded', async (t) => {
  const w = world(t);
  const daemon = await childDaemon(w);
  // This machine holds the parent, and a stale relay record names the same child.
  saveParent(emptyParent('claude-code', 'the-parent', '/work'));
  upsertChild(PARENT_ID, childRecord('c-local', 'local'));
  saveRelayRecord(relayRecord('c-local'));
  const client = await childClient(w, 'c-local');
  const text = await client.tool('parent_report', { status: 'done', text: 'served here' });
  assert.equal(text, 'the session service ran parent_report', 'the local session tool served it');
  assert.deepEqual(w.ssh.calls(), [], 'nothing went over ssh');
  assert.deepEqual(listForwards(), [], 'nothing waits in the relay outbox');
});

test('a report for a child of a parent on another machine is forwarded once, with the exact flags', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-remote');
  saveRelayRecord(relayRecord('c-remote'));
  const daemon = await childDaemon(w);
  const client = await childClient(w, 'c-remote');
  // Quotes, a line break and leading dashes: the shell on the far side must hand them over unchanged.
  const body = `--not-a-flag it's "done"\nsecond line $HOME \`id\``;
  const text = await client.tool('parent_report', { status: 'done', text: body });
  assert.match(text, /Reported done to the parent on machine parent-box/);

  const calls = w.ssh.calls();
  assert.equal(calls.length, 1, 'one ssh hop');
  assert.deepEqual(calls[0]?.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', 'parent-box']);
  const [remote, ...more] = w.ssh.remoteCalls();
  assert.equal(more.length, 0);
  assert.equal(remote?.target, 'parent-box');
  const receipt = remote?.argv[6] ?? '';
  assert.match(receipt, /^rp-[0-9a-f]{16}$/);
  assert.deepEqual(remote?.argv, ['report', '--parent', PARENT_ID, '--child', 'c-remote', '--receipt', receipt, '--status', 'done', '--text', body]);

  const landed = spoolOf(w.parentHome, PARENT_ID);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]?.receipt, receipt);
  assert.equal(landed[0]?.text, body);
  assert.equal(landed[0]?.childId, 'c-remote');
  assert.equal(landed[0]?.childName, 'child-c-remote', 'the name comes from the parent machine\'s record');
  assert.deepEqual(listForwards(), []);
  assert.ok(w.logs.some((line) => line.includes('forwarding report') && line.includes('parent-box')), 'the log names the host');
});

test('a relay child whose pane id matches a local child is still forwarded, by its child id', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-shared');
  saveRelayRecord(relayRecord('c-shared'));
  // A local parent on the child's machine has a child in the same pane id.
  saveParent(emptyParent('pi', 'local-parent', '/work'));
  upsertChild('pi-local-parent', childRecord('c-other', 'local'));
  await childDaemon(w);
  const client = await childClient(w, 'c-shared');
  assert.match(await client.tool('parent_report', { status: 'done', text: 'mine' }), /parent-box/);
  assert.equal(spoolOf(w.childHome, 'pi-local-parent').length, 0, 'the local child got nothing');
  assert.equal(spoolOf(w.parentHome, PARENT_ID)[0]?.childId, 'c-shared');
});

test('a failed hop spools the report, retries with backoff, and the receiver keeps one copy', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-flaky');
  saveRelayRecord(relayRecord('c-flaky'));
  // Refused outright, then delivered with the connection dropped before the exit status, then fine.
  w.ssh.plan(['refuse', 'drop', 'ok']);
  const daemon = await childDaemon(w);
  const client = await childClient(w, 'c-flaky');

  const text = await client.tool('parent_report', { status: 'progress', text: 'halfway there' });
  assert.match(text, /could not reach machine parent-box yet/);
  assert.match(text, /retries it with backoff/);
  const record = readRelayRecord('c-flaky');
  assert.equal(record?.unforwarded, 1, 'the child record says a report waits');
  assert.match(record?.lastForwardError ?? '', /parent-box.*255/);
  assert.ok(w.logs.some((line) => /forwarding report rp-\w+ to parent-box failed/.test(line)), w.logs.join('\n'));

  await until(() => listForwards().length === 0, 'the relay outbox to empty');
  assert.equal(w.ssh.calls().length, 3, 'refused, dropped, then delivered');
  assert.equal(w.ssh.remoteCalls().length, 2, 'the far side ran twice');
  const landed = spoolOf(w.parentHome, PARENT_ID);
  assert.equal(landed.length, 1, 'the retry after the dropped connection was a duplicate, accepted once');
  assert.equal(landed[0]?.text, 'halfway there');
  const settled = readRelayRecord('c-flaky');
  assert.equal(settled?.unforwarded, undefined);
  assert.equal(settled?.lastForwardError, undefined);
  assert.ok(settled?.lastForwardedAt);
});

test('a daemon restarted with a report still waiting forwards it, and stays up until it does', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-wait');
  saveRelayRecord(relayRecord('c-wait'));
  w.ssh.plan(['refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse']);
  const first = await childDaemon(w, { initialDelayMs: 60_000 });
  const client = await childClient(w, 'c-wait');
  await client.tool('parent_report', { status: 'done', text: 'kept across a restart' });
  await client.close();
  await first.close();
  assert.equal(listForwards().length, 1, 'the report is on disk');

  w.ssh.plan([]);
  const second = await childDaemon(w, {}, { idleMs: 1, idleCheckMs: 10 });
  await until(() => listForwards().length === 0, 'the restarted daemon to forward it');
  assert.equal(spoolOf(w.parentHome, PARENT_ID).length, 1);
  await until(() => second.closed, 'the idle daemon to close once nothing waits');
});

test('the receiving daemon accepts a duplicate receipt once', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-dup');
  const env = { ...process.env, BELLWETHER_HOME: w.parentHome, BELLWETHER_DAEMON_SOCKET: path.join(w.parentHome, 'daemon.sock') };
  const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'report', '--parent', PARENT_ID, '--child', 'c-dup', '--receipt', 'rp-0123456789abcdef', '--status', 'done', '--text', 'once only'], { env, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Reported done/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already received/);
  const landed = spoolOf(w.parentHome, PARENT_ID);
  assert.deepEqual(landed.map((entry) => [entry.receipt, entry.text]), [['rp-0123456789abcdef', 'once only']]);
});

test('the receiving daemon refuses a child its parent does not hold, and the sender stops retrying', async (t) => {
  const w = world(t);
  inHome(w.parentHome, () => saveParent(emptyParent('claude-code', 'the-parent', '/work')));
  saveRelayRecord(relayRecord('c-stranger'));
  const daemon = await childDaemon(w);
  const client = await childClient(w, 'c-stranger');
  const text = await client.tool('parent_report', { status: 'done', text: 'who am I' });
  assert.match(text, /refused report/);
  assert.match(text, /holds no child c-stranger/);
  await delay(300);
  assert.equal(w.ssh.calls().length, 1, 'a refusal is not retried');
  const [kept] = listForwards();
  assert.ok(kept?.refused, 'the refused report stays on disk');
  assert.deepEqual(spoolOf(w.parentHome, PARENT_ID), []);
});

test('a relay record that names no host is refused, naming the record', async (t) => {
  const w = world(t);
  saveRelayRecord(relayRecord('c-nohost', ''));
  const daemon = await childDaemon(w);
  const client = await childClient(w, 'c-nohost');
  await assert.rejects(client.tool('parent_report', { status: 'done', text: 'x' }), (error: Error) => {
    assert.ok(error.message.includes(relayChildPath('c-nohost')), error.message);
    assert.match(error.message, /names no remote host/);
    return true;
  });
  assert.deepEqual(w.ssh.calls(), []);
  assert.deepEqual(listForwards(), []);
});

test('a spawn on another machine registers the child there and starts it with that machine\'s MCP config', async (t) => {
  const w = world(t);
  fs.writeFileSync(configPath(), JSON.stringify({ sshTarget: 'parent-box' }));
  const parent = saveParent(emptyParent('claude-code', 'spawner', '/work', { workspaceId: 'w1' }));
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
  herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  t.after(() => herdr?.stop());
  const ops = remoteOps(async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }));
  const { child, reportWarning } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'far-away', host: 'remote-box', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry) => ops.register(parent, entry) });
  assert.equal(reportWarning, undefined);

  const [remote] = w.ssh.remoteCalls();
  assert.equal(remote?.target, 'remote-box');
  assert.deepEqual(remote?.argv, ['relay-register', '--child', child.id, '--name', 'far-away', '--kind', 'claude', '--parent', parent.id, '--parent-host', 'parent-box']);
  const record = inHome(w.remoteHome, () => readRelayRecord(child.id));
  assert.equal(record?.parentHost, 'parent-box');
  assert.equal(record?.parentId, parent.id);
  const start = herdr.requests.find((request) => request.method === 'agent.start');
  const args = (start?.params['args'] as string[]) ?? [];
  const mcp = args.find((arg) => arg.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? '';
  assert.ok(mcp.startsWith(path.join(w.remoteHome, 'mcp')), `the config is the remote machine's: ${mcp}`);
  assert.ok(!fs.existsSync(path.join(w.childHome, 'mcp')), 'none was written on the parent machine');
  // The registry of record stays on the parent's machine.
  assert.equal(readParent(parent.id)?.children[0]?.host, 'remote-box');
});

test('a spawn on another machine whose registration fails still starts, and says the child cannot report', async (t) => {
  const w = world(t);
  w.ssh.plan(['refuse']);
  const parent = saveParent(emptyParent('pi', 'spawner-fail', '/work'));
  const herdr = await startFakeHerdr();
  t.after(() => herdr.stop());
  const ops = remoteOps(async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }));
  const { reportWarning } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'pi', name: 'unregistered', host: 'remote-box' }, undefined, { registerRemote: (entry) => ops.register(parent, entry) });
  assert.match(reportWarning ?? '', /could not be registered on machine remote-box.*cannot call parent_report.*255/);
});

test('agent_read for a child on another machine reads its transcript over ssh, and falls back to its last report', async (t) => {
  const w = world(t);
  const session = '7f3c2a10-aaaa-bbbb-cccc-000000000001';
  const cwd = '/work/far';
  const transcriptDir = path.join(path.dirname(w.remoteHome), '.claude', 'projects', claudeProjectDir(cwd));
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${session}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the remote answer' }] } })}\n`);

  const parent = saveParent(emptyParent('claude-code', 'reader', '/work'));
  const exited = { ...childRecord('c-read', 'remote-box'), cwd, session: { kind: 'id', value: session }, exitedAt: new Date().toISOString(), lastReport: { status: 'done' as const, text: 'the reported answer', at: new Date().toISOString(), seq: 1 } };
  upsertChild(parent.id, exited);
  const client = new HerdrClient({ socketPath: path.join(w.root, 'no-herdr.sock') });
  const remote = remoteOps(async (label) => ({ id: label, label, target: label, session: 'default', enabled: true }));
  const ctx = { client, clientFor: async () => client, parentId: parent.id, watcher: new Watcher({ client, parentId: parent.id, onEntries: () => {} }), remote };

  assert.equal((await runBellwetherTool(ctx, 'agent_read', { child: 'c-read' })).trim(), 'the remote answer');
  assert.deepEqual(w.ssh.remoteCalls()[0]?.argv, ['last-message', '--harness', 'claude-code', '--session', session, '--cwd', cwd]);

  w.ssh.plan(['refuse']);
  const fallback = await runBellwetherTool(ctx, 'agent_read', { child: 'c-read' });
  assert.match(fallback, /could not be read/);
  assert.match(fallback, /the reported answer/);
});

test('the relay outbox and records are private to the operator', async (t) => {
  const w = world(t);
  parentHolds(w, 'c-mode');
  saveRelayRecord(relayRecord('c-mode'));
  w.ssh.plan(['refuse']);
  const daemon = await childDaemon(w, { initialDelayMs: 60_000 });
  const client = await childClient(w, 'c-mode');
  await client.tool('parent_report', { status: 'done', text: 'secret' });
  const [entry] = fs.readdirSync(relayOutboxDir());
  assert.equal(fs.statSync(path.join(relayOutboxDir(), entry ?? '')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(relayChildPath('c-mode')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(relayOutboxDir()).mode & 0o777, 0o700);
});

/** A fake herdr whose new pane goes idle after the start, so a Claude Code spawn gets past its dialog wait. */
async function idleHerdr(t: test.TestContext, respond?: FakeHerdrOptions['respond']): Promise<Awaited<ReturnType<typeof startFakeHerdr>>> {
  let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
  herdr = await startFakeHerdr({
    respond: (request) => {
      const answer = respond?.(request);
      if (answer) return answer;
      if (request.method === 'agent.start') setTimeout(() => herdr?.send({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } }), 20);
      return undefined;
    },
  });
  t.after(() => herdr?.stop());
  return herdr;
}

const profiles = async (label: string) => ({ id: label, label, target: label, session: 'default', enabled: true });

function startArgs(herdr: Awaited<ReturnType<typeof startFakeHerdr>>): string[] {
  return (herdr.requests.find((request) => request.method === 'agent.start')?.params['args'] as string[]) ?? [];
}

test('a spawn on another machine copies the brief there over ssh, and points the child at that copy', async (t) => {
  const w = world(t);
  fs.writeFileSync(configPath(), JSON.stringify({ sshTarget: 'parent-box' }));
  const parent = saveParent(emptyParent('claude-code', 'brief-sender', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(profiles);
  const brief = 'Line one of the task.\nLine two, with a \'quote\' and $HOME left alone.\n';
  const { child } = await spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'briefed', host: 'remote-box', prompt: brief, startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) });

  const remoteBrief = path.join(w.remoteHome, 'prompts', `${child.id}.md`);
  assert.equal(fs.readFileSync(remoteBrief, 'utf8'), brief, 'the brief arrived whole on the child\'s machine');
  assert.equal(fs.statSync(remoteBrief).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(w.childHome, 'prompts', `${child.id}.md`)), 'no brief was left on the parent\'s machine');
  assert.ok(startArgs(herdr).includes(`@${remoteBrief}`), `the child is pointed at the copy that exists where it runs: ${startArgs(herdr).join(' ')}`);
  // The brief never rode on a command line, on either machine.
  for (const argv of w.ssh.calls()) assert.ok(!argv.join(' ').includes('Line one of the task'));
  for (const call of w.ssh.remoteCalls()) assert.ok(!call.argv.join(' ').includes('Line one of the task'));
  assert.ok(w.ssh.remoteCalls()[0]?.argv.includes('--brief-stdin'));

  // The child's exit takes the copy with it.
  await ops.cleanup(child);
  assert.ok(!fs.existsSync(remoteBrief));
  assert.ok(!fs.existsSync(path.join(w.remoteHome, 'mcp', `${child.id}.json`)));
  assert.ok(inHome(w.remoteHome, () => readRelayRecord(child.id)), 'the relay record stays for a report still in flight');
});

test('a spawn on another machine whose brief cannot be copied fails, with no tab and no record', async (t) => {
  const w = world(t);
  w.ssh.plan(['refuse']);
  const parent = saveParent(emptyParent('claude-code', 'brief-lost', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t);
  const ops = remoteOps(profiles);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'claude', name: 'mute', host: 'remote-box', prompt: 'do the thing', startupTimeoutMs: 2_000, redrawMs: 10 }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text) }),
    /mute was not started on machine remote-box, because its brief could not be copied there: ssh remote-box exited with 255/,
  );
  assert.equal(herdr.requests.filter((request) => request.method === 'tab.create').length, 0, 'no tab was opened');
  assert.equal(herdr.requests.filter((request) => request.method === 'agent.start').length, 0);
  assert.deepEqual(readParent(parent.id)?.children, [], 'the record went with the spawn');
  assert.ok(!fs.existsSync(path.join(w.childHome, 'prompts')) || fs.readdirSync(path.join(w.childHome, 'prompts')).length === 0);
});

test('a spawn that fails after its brief was copied removes the copy on the child\'s machine', async (t) => {
  const w = world(t);
  fs.writeFileSync(configPath(), JSON.stringify({ sshTarget: 'parent-box' }));
  const parent = saveParent(emptyParent('pi', 'start-fails', '/work', { workspaceId: 'w1' }));
  const herdr = await idleHerdr(t, (request) => (request.method === 'agent.start' ? { error: { code: 'agent_start_failed', message: 'no such agent kind' } } : undefined));
  const ops = remoteOps(profiles);
  await assert.rejects(
    spawnChild(new HerdrClient({ socketPath: herdr.socketPath }), parent, { kind: 'pi', name: 'never-ran', host: 'remote-box', prompt: 'a task' }, undefined, { registerRemote: (entry, text) => ops.register(parent, entry, text), cleanupRemote: (entry) => ops.cleanup(entry) }),
    /no such agent kind/,
  );
  const [registered] = w.ssh.remoteCalls();
  const childId = registered?.argv[registered.argv.indexOf('--child') + 1] ?? '';
  assert.ok(childId);
  assert.ok(w.ssh.remoteCalls().some((call) => call.argv[0] === 'relay-cleanup' && call.argv.includes(childId)));
  assert.ok(!fs.existsSync(path.join(w.remoteHome, 'prompts', `${childId}.md`)), 'the copied brief is gone');
});
