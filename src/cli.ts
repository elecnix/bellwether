#!/usr/bin/env node
// The bellwether command.
//
// `watch` is the dogfood driver: it runs the same core the Pi extension and the
// Claude channel run, and prints one line per child event, so a supervisor can
// read the stream instead of polling herdr.
import fs from 'node:fs';
import path from 'node:path';
import { HerdrClient, resolveSocketPath } from './core/herdr-client.ts';
import { bellwetherHome } from './core/paths.ts';
import { emptyParent, listParents, readParent, saveParent } from './core/registry.ts';
import { isReportStatus } from './core/report.ts';
import { RELAY_SCHEMA, saveRelayRecord } from './core/relay-records.ts';
import { relayChildPath } from './core/paths.ts';
import { writeMcpConfig } from './core/mcp-config.ts';
import { REFUSED_EXIT } from './core/ssh.ts';
import { lastAssistantMessage, resolveTranscript } from './core/transcript.ts';
import { DaemonClient, ReportRefused, postReport } from './daemon/client.ts';
import { daemonIsLive, startDaemon } from './daemon/server.ts';
import type { OutboxEntry } from './core/types.ts';

interface Flags {
  [key: string]: string | number | boolean | undefined;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    if (key === 'keys' || key === 'args') {
      flags[key] = next;
    } else if (key === 'stuck-minutes' || key === 'inactive-minutes' || key === 'max-depth' || key === 'lines') {
      flags[key] = Number(next);
    } else {
      flags[key] = next;
    }
    index += 1;
  }
  return { positional, flags };
}

/**
 * Parse flags that each take the next word verbatim, whatever it starts with.
 * A report's text arrives from another machine and may begin with dashes.
 */
function exactFlags(argv: string[], names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (!names.includes(name)) throw new Error(`unknown argument ${token}; expected ${names.map((entry) => `--${entry}`).join(', ')}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function num(flags: Flags, key: string): number | undefined {
  const value = flags[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The registry this CLI run works against: an explicit id, the environment, or the newest. */
function parentFor(flags: Flags): { id: string; created: boolean } {
  const explicit = str(flags, 'parent') ?? process.env['BELLWETHER_PARENT'];
  if (explicit) return { id: explicit, created: false };
  const name = `cli-${path.basename(process.cwd())}`;
  const existing = readParent(name);
  if (existing) return { id: existing.id, created: false };
  saveParent({
    ...emptyParent('pi', name, process.cwd(), { host: process.env['HOSTNAME'] ?? '', paneId: process.env['HERDR_PANE_ID'], workspaceId: process.env['HERDR_WORKSPACE_ID'] }),
    id: name,
  });
  return { id: name, created: true };
}

function clientFrom(flags: Flags): HerdrClient {
  return new HerdrClient({ socketPath: str(flags, 'socket'), session: str(flags, 'session') });
}

function ok(label: string, detail: string): void {
  console.log(`  ok    ${label}: ${detail}`);
}

function bad(label: string, detail: string): void {
  console.log(`  fail  ${label}: ${detail}`);
}

/** The package root, found by walking up from this file to its package.json. */
function packageRoot(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

type PackageManifest = {
  bin?: Record<string, string>;
  pi?: { extensions?: string[] };
};

/** Harnesses load these two paths by name, so a missing one fails at load time.
 *  doctor names it here, before a user meets it inside a session. */
function checkPackaging(): number {
  const root = packageRoot();
  if (!root) {
    bad('package root', 'no package.json above the CLI');
    return 1;
  }
  let failures = 0;
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest;
  } catch (error) {
    bad('package.json', String(error));
    return 1;
  }

  const extensions = manifest.pi?.extensions ?? [];
  if (!extensions.length) {
    bad('pi extension', 'package.json declares none');
    failures += 1;
  }
  for (const entry of extensions) {
    const file = path.resolve(root, entry);
    if (fs.existsSync(file)) {
      ok('pi extension', path.relative(root, file));
    } else {
      bad('pi extension', `${entry} does not exist`);
      failures += 1;
    }
  }

  const declared = manifest.bin?.['bellwether-mcp'];
  if (!declared) {
    bad('mcp entry', 'package.json declares no bellwether-mcp bin');
    return failures + 1;
  }
  const mcpEntry = path.resolve(root, declared);
  const label = path.relative(root, mcpEntry);
  if (!fs.existsSync(mcpEntry)) {
    bad('mcp entry', `${label} does not exist`);
    failures += 1;
  } else if (!(fs.statSync(mcpEntry).mode & 0o111)) {
    bad('mcp entry', `${label} is not executable`);
    failures += 1;
  } else {
    ok('mcp entry', label);
  }
  return failures;
}

async function doctor(): Promise<number> {
  let failures = 0;
  console.log(`bellwether home  ${bellwetherHome()}`);
  const daemonSocket = path.join(bellwetherHome(), 'daemon.sock');
  const daemonLive = daemonIsLive(bellwetherHome());
  console.log(`  ${daemonLive ? 'ok   ' : 'info '} daemon: ${daemonLive ? 'running' : 'idle, starts on demand'} (${daemonSocket})`);
  failures += checkPackaging();
  const socket = resolveSocketPath();
  if (!fs.existsSync(socket)) {
    console.log(`  fail  herdr socket: ${socket} does not exist`);
    return 1;
  }
  console.log(`  ok    herdr socket: ${socket}`);
  try {
    const panes = await new HerdrClient({ socketPath: socket }).paneList();
    console.log(`  ok    herdr api: ${panes.length} panes`);
  } catch (error) {
    console.log(`  fail  herdr api: ${String(error)}`);
    failures += 1;
  }
  for (const parent of listParents()) {
    const live = parent.children.filter((child) => !child.exitedAt);
    console.log(`  ${parent.id}: ${live.length} live of ${parent.children.length} children, updated ${parent.updatedAt}`);
  }
  return failures;
}

async function main(): Promise<number> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (command === 'help' || command === '--help') {
    console.log('Usage: bellwether <daemon|spawn|watch|list|read|send|stop|report|parents|doctor>');
    console.log('  daemon [--socket PATH]                   run the local daemon in the foreground');
    console.log('  spawn  --kind KIND --name NAME [--cwd DIR] [--prompt TEXT] [--model M] [--parent ID] [--focus]');
    console.log('  watch  [--parent ID] [--tick-ms N]      one line per child event, then keeps reading');
    console.log('  list   [--parent ID]');
    console.log('  read   CHILD [--lines N]');
    console.log('  send   CHILD [--text TEXT | --keys KEY,...]');
    console.log('  stop   CHILD [--force]');
    console.log('  report --child ID --status done|needs-input|progress --text TEXT [--parent ID] [--receipt ID]');
    console.log('  relay-register --child ID --name NAME --kind KIND --parent ID --parent-host SSH_TARGET [--cwd DIR]');
    console.log('  last-message --harness pi|claude-code --session ID [--cwd DIR]');
    return 0;
  }

  if (command === 'doctor') return doctor();

  if (command === 'daemon') {
    const socketPath = str(flags, 'socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(bellwetherHome(), 'daemon.sock');
    const daemon = await startDaemon({ socketPath, home: bellwetherHome(), log: (message) => console.error('[bellwether-daemon]', message) });
    console.error(`[bellwether-daemon] listening on ${socketPath} with pid ${daemon.pid}`);
    const stop = (): void => void daemon.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await daemon.whenClosed();
    return 0;
  }

  if (command === 'parents') {
    for (const parent of listParents()) console.log(`${parent.id}\t${parent.children.length} children\t${parent.updatedAt}\t${parent.cwd}`);
    return 0;
  }

  if (command === 'report') return report(rest);
  if (command === 'relay-register') return relayRegister(rest);
  if (command === 'last-message') return lastMessage(rest);

  const { id: parentId } = parentFor(flags);
  const parent = readParent(parentId);
  if (!parent) throw new Error(`No parent registry ${parentId}. Run bellwether list once to create it.`);
  const daemon = await DaemonClient.connect({
    harness: parent.harness,
    session: parent.session,
    cwd: parent.cwd,
    host: parent.host,
    paneId: parent.paneId,
    workspaceId: parent.workspaceId,
    depth: parent.depth,
    herdrSocket: resolveSocketPath({ socketPath: str(flags, 'socket'), session: str(flags, 'session') }),
  }, { log: (message) => console.error('[bellwether]', message) });

  if (command === 'watch') {
    const printed = new Set<string>();
    const emit = (entry: OutboxEntry): void => {
      if (printed.has(entry.receipt) || entry.read) return;
      printed.add(entry.receipt);
      console.log(`CHILD ${entry.event} ${entry.name} ${entry.paneId} unread=${entry.receipt} at=${entry.at}`);
      console.log(`  ${entry.text.split('\n').join('\n  ')}`);
    };
    daemon.onEvents((entries) => entries.forEach(emit));
    (await daemon.pending()).forEach(emit);
    console.log(`READY watch parent=${parentId} home=${bellwetherHome()}`);
    const keepAlive = setInterval(() => {}, 60_000);
    process.on('SIGINT', () => {
      clearInterval(keepAlive);
      void daemon.close().then(() => process.exit(0));
    });
    await new Promise(() => {});
    return 0;
  }

  try {
    if (command === 'spawn') {
      const name = str(flags, 'name');
      if (!name) throw new Error('spawn needs --name');
      console.log(await daemon.tool('agent_spawn', {
        kind: str(flags, 'kind') ?? 'pi',
        name,
        cwd: str(flags, 'cwd'),
        prompt: str(flags, 'prompt'),
        model: str(flags, 'model'),
        focus: flags['focus'] === true,
        stuckMinutes: num(flags, 'stuck-minutes'),
        inactive_minutes: num(flags, 'inactive-minutes'),
        maxDepth: num(flags, 'max-depth'),
        args: str(flags, 'args')?.split('\u0000'),
      }));
    } else if (command === 'list') {
      console.log(await daemon.tool('agent_list', {}));
    } else if (command === 'read') {
      const child = positional[0];
      if (!child) throw new Error('read needs a child');
      console.log(await daemon.tool('agent_read', { child, lines: num(flags, 'lines') }));
    } else if (command === 'send') {
      const child = positional[0];
      if (!child) throw new Error('send needs a child');
      const keys = str(flags, 'keys')?.split(',').map((key) => key.trim()).filter(Boolean);
      console.log(await daemon.tool('agent_send', { child, text: str(flags, 'text'), keys }));
    } else if (command === 'stop') {
      const child = positional[0];
      if (!child) throw new Error('stop needs a child');
      console.log(await daemon.tool('agent_stop', { child, force: flags['force'] === true }));
    } else {
      console.log('Usage: bellwether <daemon|spawn|watch|list|read|send|stop|report|parents|doctor>');
      return 1;
    }
  } finally {
    await daemon.close();
  }
  return 0;
}

/**
 * Post one report to this machine's daemon. The far end of a relay hop runs
 * it with every flag set; a child's own shell may leave out --child, which
 * then comes from the BELLWETHER_CHILD its tab carries. The daemon checks the
 * child, and the parent when given, against its own records.
 */
async function report(argv: string[]): Promise<number> {
  const values = exactFlags(argv, ['parent', 'child', 'receipt', 'status', 'text']);
  const childId = values['child'] ?? process.env['BELLWETHER_CHILD'];
  const status = values['status'] ?? 'progress';
  const text = values['text'] ?? '';
  if (!childId) throw new Error('report needs --child, or a BELLWETHER_CHILD in the environment');
  if (!isReportStatus(status)) throw new Error('report --status must be done, needs-input or progress');
  if (!text.trim()) throw new Error('report needs --text');
  try {
    const posted = await postReport({ childId, status, text, ...(values['parent'] ? { parentId: values['parent'] } : {}), ...(values['receipt'] ? { receipt: values['receipt'] } : {}) });
    console.log(posted.text);
    return 0;
  } catch (error) {
    console.error(`bellwether report: ${(error as Error).message}`);
    // A refusal is final; anything else is worth another try by the sender.
    return error instanceof ReportRefused ? REFUSED_EXIT : 1;
  }
}

/**
 * Record, on this machine, a child whose parent runs on another machine. A
 * parent's daemon runs it here over SSH before it creates the child's tab.
 * It prints the record path and, for a Claude Code child, the MCP config the
 * child starts with, as one JSON line.
 */
function relayRegister(argv: string[]): number {
  const values = exactFlags(argv, ['child', 'name', 'kind', 'parent', 'parent-host', 'cwd']);
  const childId = values['child'];
  const parentId = values['parent'];
  const parentHost = values['parent-host']?.trim();
  if (!childId || !parentId || !parentHost) throw new Error('relay-register needs --child, --parent and --parent-host');
  saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: values['name'] ?? childId, kind: values['kind'] ?? 'other', parentId, parentHost, ...(values['cwd'] ? { cwd: values['cwd'] } : {}), registeredAt: new Date().toISOString() });
  const mcpConfig = values['kind'] === 'claude' ? writeMcpConfig(childId) : undefined;
  console.log(JSON.stringify({ record: relayChildPath(childId), ...(mcpConfig ? { mcpConfig } : {}) }));
  return 0;
}

/** Print a harness session's last assistant message from this machine's transcript. */
function lastMessage(argv: string[]): number {
  const values = exactFlags(argv, ['harness', 'session', 'cwd']);
  const harness = values['harness'];
  const session = values['session'];
  if (!harness || !session) throw new Error('last-message needs --harness and --session');
  const transcript = resolveTranscript(harness, session, values['cwd']);
  if (!transcript) {
    console.error(`no transcript for ${harness} session ${session} on this machine`);
    return 1;
  }
  const text = lastAssistantMessage(transcript);
  if (!text) {
    console.error(`the transcript ${transcript} holds no assistant message`);
    return 1;
  }
  process.stdout.write(text);
  return 0;
}

process.exitCode = await main();
