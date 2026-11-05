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
import { reportToParent, writeReport } from './core/report.ts';
import { Watcher } from './core/watcher.ts';
import { AGENT_KINDS, spawnChild, type SpawnOptions } from './core/spawn.ts';
import { parentTools, runBellwetherTool } from './integrations/tools.ts';
import type { OutboxEntry, ReportStatus } from './core/types.ts';

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
    } else if (key === 'stuck-minutes' || key === 'max-depth' || key === 'lines') {
      flags[key] = Number(next);
    } else {
      flags[key] = next;
    }
    index += 1;
  }
  return { positional, flags };
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

  const mcpEntry = path.join(root, 'bin', 'bellwether-mcp.js');
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
    console.log('Usage: bellwether <spawn|watch|list|read|send|stop|report|parents|doctor>');
    console.log('  spawn  --kind KIND --name NAME [--cwd DIR] [--prompt TEXT] [--model M] [--parent ID] [--focus]');
    console.log('  watch  [--parent ID] [--tick-ms N]      one line per child event, then keeps reading');
    console.log('  list   [--parent ID]');
    console.log('  read   CHILD [--lines N]');
    console.log('  send   CHILD [--text TEXT | --keys KEY,...]');
    console.log('  stop   CHILD [--force]');
    console.log('  report --status done|needs-input|progress --text TEXT');
    return 0;
  }

  if (command === 'doctor') return doctor();

  if (command === 'parents') {
    for (const parent of listParents()) console.log(`${parent.id}\t${parent.children.length} children\t${parent.updatedAt}\t${parent.cwd}`);
    return 0;
  }

  if (command === 'report') {
    const status = (str(flags, 'status') ?? 'progress') as ReportStatus;
    const text = str(flags, 'text') ?? '';
    if (!text) throw new Error('report needs --text');
    if (!reportToParent(status, text)) {
      const parentId = str(flags, 'parent');
      if (!parentId) throw new Error('report needs BELLWETHER_PARENT or --parent');
      writeReport({ parentId, childName: process.env['BELLWETHER_CHILD_NAME'] ?? 'child', status, text });
    }
    return 0;
  }

  const { id: parentId } = parentFor(flags);
  const client = clientFrom(flags);

  if (command === 'spawn') {
    const parent = readParent(parentId);
    if (!parent) throw new Error(`No parent registry ${parentId}. Run bellwether list once to create it.`);
    const kind = str(flags, 'kind') ?? 'pi';
    if (!AGENT_KINDS.includes(kind as (typeof AGENT_KINDS)[number])) throw new Error(`Unknown kind ${kind}; expected one of ${AGENT_KINDS.join(', ')}`);
    const name = str(flags, 'name');
    if (!name) throw new Error('spawn needs --name');
    const options: SpawnOptions = {
      kind,
      name,
      cwd: str(flags, 'cwd'),
      prompt: str(flags, 'prompt'),
      model: str(flags, 'model'),
      focus: flags['focus'] === true,
      stuckMinutes: num(flags, 'stuck-minutes'),
      maxDepth: num(flags, 'max-depth'),
      args: str(flags, 'args')?.split('\u0000'),
    };
    const { child, link } = await spawnChild(client, parent, options);
    console.log(`spawned ${child.name}`);
    console.log(`  id      ${child.id}`);
    console.log(`  pane    ${child.paneId}`);
    console.log(`  tab     ${child.tabId ?? '-'}`);
    console.log(`  link    ${link}`);
    console.log(`  parent  ${parent.id}`);
    return 0;
  }

  const watcher = new Watcher({
    client,
    parentId,
    tickMs: num(flags, 'tick-ms') ?? 5_000,
    onEntries: () => {},
  });

  if (command === 'watch') {
    const printed = new Set<string>();
    const controller = new AbortController();
    const emit = (entry: OutboxEntry): void => {
      console.log(`CHILD ${entry.event} ${entry.name} ${entry.paneId} unread=${entry.receipt} at=${entry.at}`);
      console.log(`  ${entry.text.split('\n').join('\n  ')}`);
      printed.add(entry.receipt);
      watcher.markDelivered(entry.receipt);
    };
    const live = new Watcher({
      client,
      parentId,
      tickMs: num(flags, 'tick-ms') ?? 5_000,
      onEntries: (entries) => {
        for (const entry of entries) if (!entry.deliveredAt && !printed.has(entry.receipt)) emit(entry);
      },
    });
    live.start();
    // The watcher's own timer is unref'd, so the watch loop holds the process open.
    const keepAlive = setInterval(() => {}, 60_000);
    process.on('SIGINT', () => {
      live.stop();
      clearInterval(keepAlive);
      controller.abort();
      process.exit(0);
    });
    console.log(`READY watch parent=${parentId} home=${bellwetherHome()}`);
    await new Promise(() => {});
    return 0;
  }

  watcher.start();
  // One reconcile pass, then answer.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const context = { client, parentId, watcher };

  if (command === 'list') {
    console.log(await runBellwetherTool(context, 'agent_list', {}));
  } else if (command === 'read') {
    const child = positional[0];
    if (!child) throw new Error('read needs a child');
    console.log(await runBellwetherTool(context, 'agent_read', { child, lines: num(flags, 'lines') }));
  } else if (command === 'send') {
    const child = positional[0];
    if (!child) throw new Error('send needs a child');
    const keys = str(flags, 'keys')?.split(',').map((key) => key.trim()).filter(Boolean);
    console.log(await runBellwetherTool(context, 'agent_send', { child, text: str(flags, 'text'), keys }));
  } else if (command === 'stop') {
    const child = positional[0];
    if (!child) throw new Error('stop needs a child');
    console.log(await runBellwetherTool(context, 'agent_stop', { child, force: flags['force'] === true }));
  } else {
    console.log('Usage: bellwether <spawn|watch|list|read|send|stop|report|parents|doctor>');
    watcher.stop();
    return 1;
  }
  watcher.stop();
  return 0;
}

void parentTools;
process.exitCode = await main();
