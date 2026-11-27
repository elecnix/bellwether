#!/usr/bin/env node
// The bellwether command.
//
// `watch` is the dogfood driver: it runs the same core the Pi extension and the
// Claude channel run, and prints one line per child event, so a supervisor can
// read the stream instead of polling herdr.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HerdrClient, resolveSocketPath } from './core/herdr-client.ts';
import { bellwetherHome } from './core/paths.ts';
import { emptyParent, listParents, readParent, saveParent } from './core/registry.ts';
import { isReportStatus } from './core/report.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, removeRelayRecord, saveRelayRecord, updateRelayRecord } from './core/relay-records.ts';
import { relayChildPath, relayOutboxDir } from './core/paths.ts';
import { removeBriefAt, writeBrief, writeBriefIn } from './core/brief.ts';
import { removeChildFiles, writeMcpConfig } from './core/mcp-config.ts';
import { describeUpgrade, gatherUpgrade } from './daemon/upgrade-status.ts';
import { HEARTBEAT_MISSES } from './core/ssh.ts';
import { DaemonClient, REFUSED_EXIT, ReportRefused, drainDaemon, ensureDaemon, postReport, relayStatus } from './daemon/client.ts';
import { readMemory, runsOn } from './daemon/relay-links.ts';
import type { RelayHostState } from './daemon/protocol.ts';
import { guardlessPiCopies, resolvePiExtension } from './core/pi-extension.ts';
import { describeDaemonEntry, readLock } from './daemon/lock.ts';
import { DAEMON_PROTOCOL } from './daemon/protocol.ts';
import { BELLWETHER_BUILD, BELLWETHER_BUILD_ID, BELLWETHER_VERSION, describeBuild } from './core/version.ts';
import { daemonIsLive, startDaemon } from './daemon/server.ts';
import type { ChildRecord, OutboxEntry } from './core/types.ts';
import { LOCAL_HOST, hostOf, knownHosts } from './core/machine.ts';
import { MOVE_VERBS, moveEndpoints, serveMoveVerb, type MoveVerb } from './core/move-endpoint.ts';
import { moveRefusals, pairLabel, type MovableHarness, type ModelPair } from './core/move-plan.ts';
import type { ProbeResult } from './core/session-state.ts';

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
  // A pi child starts with -e beside whatever pi's settings load, and pi exits on a duplicate tool.
  for (const copy of guardlessPiCopies()) {
    bad('pi settings', `${copy} predates the guard against a second copy, so a pi child would exit at startup. Run pi install npm:@elecnix/bellwether.`);
    failures += 1;
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
  console.log(`bellwether ${describeBuild(BELLWETHER_VERSION, BELLWETHER_BUILD)}, daemon protocol ${DAEMON_PROTOCOL}`);
  console.log(`bellwether home  ${bellwetherHome()}`);
  const daemonSocket = path.join(bellwetherHome(), 'daemon.sock');
  const daemonLive = daemonIsLive(bellwetherHome());
  // The upgrade report: which code the daemon and each session run, and whether a hand-over has finished.
  for (const line of describeUpgrade(await gatherUpgrade(bellwetherHome(), daemonSocket)).lines) console.log(`  ${line}`);
  if (daemonLive) console.log(`  ${describeDaemonEntry(readLock(bellwetherHome()), path.join(import.meta.dirname, 'daemon', `main${path.extname(import.meta.url)}`))}`);
  failures += checkPackaging();
  failures += await checkRelay(daemonLive, daemonSocket);
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
  await checkMoves();
  return failures;
}

function machineLabel(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

function harnessLine(probe: ProbeResult, harness: MovableHarness): string {
  const name = harness === 'pi' ? 'pi' : 'claude';
  const found = probe.harnesses[harness];
  if (!found?.path) return `${name} missing${found?.error ? ` (${found.error})` : ''}`;
  return found.version ? `${name} ${found.version}` : `${name} at ${found.path}, version unreadable${found.error ? ` (${found.error})` : ''}`;
}

/**
 * What agent_move would need on each known machine: the harness, its version,
 * and pi's models, then for each live claude or pi child, whether each other
 * machine could take it. These are information, not failures: a machine that
 * cannot take a child only refuses a move to it.
 */
async function checkMoves(): Promise<void> {
  let hosts: string[];
  try {
    hosts = await knownHosts();
  } catch (error) {
    console.log(`  info  move: the saved herdr machines could not be listed (${(error as Error).message}), so only this machine is checked`);
    hosts = [LOCAL_HOST];
  }
  const children = listParents().flatMap((parent) => parent.children).filter((child): child is ChildRecord & { harness: MovableHarness } => !child.exitedAt && (child.harness === 'pi' || child.harness === 'claude-code'));
  const endpointFor = moveEndpoints(undefined, { timeoutMs: 30_000 });
  const probes = new Map<string, ProbeResult | string>();
  await Promise.all(
    hosts.map(async (host) => {
      const piSessions = children.filter((child) => hostOf(child) === host && child.harness === 'pi' && child.session?.value).map((child) => child.session?.value as string);
      try {
        probes.set(host, await endpointFor(host).probe({ piModels: true, piSessions }));
      } catch (error) {
        probes.set(host, (error as Error).message);
      }
    }),
  );
  for (const host of hosts) {
    const probe = probes.get(host);
    if (typeof probe !== 'object') {
      console.log(`  info  move ${machineLabel(host)}: no child can move there or from there until this is fixed: ${probe ?? 'no answer'}`);
      continue;
    }
    const models = probe.piModels ? `${probe.piModels.length} pi models` : `pi models unknown (${probe.piModelsError ?? 'not listed'})`;
    console.log(`  info  move ${machineLabel(host)} (${probe.hostname}): ${harnessLine(probe, 'claude-code')}, ${harnessLine(probe, 'pi')}, ${models}, bellwether ${probe.bellwether}`);
  }
  for (const child of children) {
    const source = hostOf(child);
    const sourceProbe = probes.get(source);
    if (typeof sourceProbe !== 'object') {
      console.log(`  info  move ${child.name}: not checked, because its machine ${source === LOCAL_HOST ? 'here' : source} could not be read`);
      continue;
    }
    const pair: ModelPair | undefined = child.session?.value ? (sourceProbe.piSessionModels?.[child.session.value] ?? undefined) : undefined;
    for (const target of hosts) {
      if (target === source) continue;
      const targetProbe = probes.get(target);
      if (typeof targetProbe !== 'object') continue;
      const reasons = moveRefusals({
        childName: child.name,
        harness: child.harness,
        status: 'idle',
        exited: false,
        source,
        target,
        hasSession: Boolean(child.session),
        sourceHarness: sourceProbe.harnesses[child.harness],
        targetHarness: targetProbe.harnesses[child.harness],
        piModel: pair,
        targetModels: targetProbe.piModels,
        targetModelsError: targetProbe.piModelsError,
        targetModelsFile: targetProbe.piModelsFile,
      });
      const about = `${child.name} (${child.harness === 'pi' ? `pi${pair ? `, ${pairLabel(pair)}` : ''}` : 'claude'}) from ${machineLabel(source)} to ${machineLabel(target)}`;
      if (reasons.length) console.log(`  info  move ${about} would be refused: ${reasons.join(' ')}`);
      else console.log(`  ok    move ${about}: the harness and its version${child.harness === 'pi' ? ', and the provider and model,' : ''} are there. The working directory is checked when the move runs.`);
    }
  }
}

async function main(): Promise<number> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (command === 'version' || command === '--version') {
    console.log(BELLWETHER_VERSION);
    return 0;
  }

  if (command === 'help' || command === '--help') {
    console.log('Usage: bellwether <daemon|drain|spawn|watch|list|read|send|stop|move|report|parents|doctor|version>');
    console.log('  daemon [--socket PATH]                   run the local daemon in the foreground');
    console.log('  drain  [--socket PATH]                   stop the running daemon once its calls finish, so the next session starts the installed one');
    console.log('  version                                  print the installed version (also --version); doctor names the commit it was built from');
    console.log('  spawn  --kind KIND --name NAME [--cwd DIR] [--prompt TEXT] [--model M] [--parent ID] [--focus]');
    console.log('  watch  [--parent ID] [--tick-ms N]      one line per child event, then keeps reading');
    console.log('  list   [--parent ID]');
    console.log('  read   CHILD [--lines N]');
    console.log('  send   CHILD [--text TEXT | --keys KEY,...]');
    console.log('  stop   CHILD [--force]');
    console.log('  move   CHILD [--machine M] [--cwd DIR] [--reason TEXT]  move a live claude or pi child to another machine, keeping its id and conversation');
    console.log('  report --child ID --status done|needs-input|progress --text TEXT [--parent ID] [--receipt ID]');
    console.log('  relay-register --child ID --name NAME --kind KIND --parent ID [--cwd DIR] [--brief-stdin yes]');
    console.log('  relay-cleanup --child ID                 remove the brief and MCP config relay-register wrote');
    console.log('  relay-bridge [--heartbeat-ms N]          join stdin and stdout to this machine\'s daemon; a parent\'s daemon runs it over SSH');
    console.log('  move-probe|move-export|move-import|move-discard|move-commit   the machine side of a move: a JSON request on stdin, one JSON line out; a parent\'s daemon runs them over SSH');
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

  if (command === 'drain') {
    const socketPath = str(flags, 'socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(bellwetherHome(), 'daemon.sock');
    const lock = readLock(bellwetherHome());
    if (!(await drainDaemon(socketPath))) {
      console.log(`no daemon answers on ${socketPath}; the next session starts one from its own install`);
      return 0;
    }
    console.log(`drained the daemon ${lock?.version ?? 'from before 0.1.5'} on protocol ${lock?.protocol ?? 'unknown'} (pid ${lock?.pid ?? 'unknown'}); the next session call starts the daemon from that session's install`);
    return 0;
  }

  if (command === 'parents') {
    for (const parent of listParents()) console.log(`${parent.id}\t${parent.children.length} children\t${parent.updatedAt}\t${parent.cwd}`);
    return 0;
  }

  if (command === 'report') return report(rest);
  if (command === 'relay-register') return farEnd(command, () => relayRegister(rest));
  if (command === 'relay-cleanup') return farEnd(command, () => relayCleanup(rest));
  if (command === 'relay-bridge') return relayBridge(rest);
  if ((MOVE_VERBS as readonly string[]).includes(command)) return moveVerb(command as MoveVerb);

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
    } else if (command === 'move') {
      const child = positional[0];
      if (!child) throw new Error('move needs a child');
      console.log(await daemon.tool('agent_move', { child, machine: str(flags, 'machine'), cwd: str(flags, 'cwd'), reason: str(flags, 'reason') }));
    } else if (command === 'stop') {
      const child = positional[0];
      if (!child) throw new Error('stop needs a child');
      console.log(await daemon.tool('agent_stop', { child, force: flags['force'] === true }));
    } else {
      console.log('Usage: bellwether <daemon|drain|spawn|watch|list|read|send|stop|move|report|parents|doctor|version>');
      return 1;
    }
  } finally {
    await daemon.close();
  }
  return 0;
}

/**
 * Post one report to this machine's daemon. A child's own shell may leave out
 * --child, which then comes from the BELLWETHER_CHILD its tab carries. The
 * daemon checks the child, and the parent when given, against its own records.
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
 * Run a command a parent's daemon runs here over SSH. Its error goes to
 * standard error as one line, which the parent quotes, rather than as a stack
 * whose last lines say nothing about what went wrong.
 */
function farEnd(command: string, run: () => number): number {
  try {
    return run();
  } catch (error) {
    console.error(`bellwether ${command}: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Record, on this machine, a child whose parent runs on another machine. A
 * parent's daemon runs it here over SSH before it creates the child's tab.
 * With --brief-stdin it reads the child's brief from standard input and
 * writes it inside the child's working directory here, in a `.bellwether`
 * directory that git ignores, so the harness reads a file that exists where it
 * runs without asking to leave its working directory. A child with no working
 * directory gets the brief in this machine's prompts directory. The record
 * names the parent, and no address for it: this machine never connects to the
 * parent's, whose daemon connects here to collect reports. It prints the
 * record path, the brief, this install's version and build and, for a Claude
 * Code child, the MCP config the child starts with, or for a pi child, the
 * extension it loads, as one JSON line.
 */
function relayRegister(argv: string[]): number {
  const values = exactFlags(argv, ['child', 'name', 'kind', 'parent', 'cwd', 'brief-stdin']);
  const childId = values['child'];
  const parentId = values['parent'];
  if (!childId || !parentId) throw new Error('relay-register needs --child and --parent');
  // A pi child loads this machine's own extension, so a missing one fails here, before anything is written.
  const piExtension = values['kind'] === 'pi' ? resolvePiExtension() : undefined;
  const cwd = values['cwd'];
  let brief: string | undefined;
  if (values['brief-stdin'] === 'yes') {
    const text = fs.readFileSync(0, 'utf8');
    brief = cwd ? writeBriefIn(cwd, childId, text) : writeBrief(childId, text);
  }
  saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: values['name'] ?? childId, kind: values['kind'] ?? 'other', parentId, ...(cwd ? { cwd } : {}), ...(brief ? { brief } : {}), registeredAt: new Date().toISOString() });
  const mcpConfig = values['kind'] === 'claude' ? writeMcpConfig(childId) : undefined;
  console.log(JSON.stringify({ record: relayChildPath(childId), version: BELLWETHER_VERSION, build: BELLWETHER_BUILD_ID, ...(brief ? { brief } : {}), ...(mcpConfig ? { mcpConfig } : {}), ...(piExtension ? { piExtension } : {}) }));
  return 0;
}

/**
 * Remove everything relay-register wrote for a child that is gone: its brief,
 * wherever it went, its MCP config and its relay record. A record whose
 * reports still wait for the parent's daemon stays, marked retired, and goes
 * with the last of them.
 */
function relayCleanup(argv: string[]): number {
  const values = exactFlags(argv, ['child']);
  const childId = values['child'];
  if (!childId) throw new Error('relay-cleanup needs --child');
  const record = readRelayRecord(childId);
  if (record?.brief) removeBriefAt(record.brief);
  removeChildFiles(childId);
  const waiting = listForwards().filter((entry) => entry.childId === childId && !entry.refused).length;
  if (waiting) updateRelayRecord(childId, (entry) => {
    entry.retiredAt = new Date().toISOString();
  });
  else removeRelayRecord(childId);
  console.log(JSON.stringify({ removed: childId, ...(waiting ? { recordKept: `${waiting} report(s) still wait for the parent's daemon` } : {}) }));
  return 0;
}

/**
 * The far end of a parent's relay connection: join stdin and stdout to this
 * machine's daemon socket, starting the daemon when none runs, and exit when
 * either side closes. It writes nothing of its own to stdout, which belongs
 * to the protocol.
 *
 * With --heartbeat-ms, the parent promises a line at least that often. A
 * connection that dies without closing, as a network does, never ends this
 * process's standard input, so after three intervals with nothing from the
 * parent the bridge exits on its own. Its socket closes, and the daemon drops
 * the subscription, so it sends no more reports into a dead connection.
 */
async function relayBridge(argv: string[]): Promise<number> {
  const heartbeatMs = Number(exactFlags(argv, ['heartbeat-ms'])['heartbeat-ms'] ?? 0);
  const home = bellwetherHome();
  const socketPath = process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(home, 'daemon.sock');
  await ensureDaemon(home, socketPath);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    connection.once('error', reject);
    connection.once('connect', () => {
      connection.off('error', reject);
      resolve(connection);
    });
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdout.on('error', () => socket.destroy());
  process.stdin.on('end', () => socket.end());
  if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
    let heard = Date.now();
    process.stdin.on('data', () => {
      heard = Date.now();
    });
    const watchdog = setInterval(() => {
      if (Date.now() - heard <= heartbeatMs * HEARTBEAT_MISSES) return;
      console.error(`bellwether relay-bridge: nothing from the parent for ${Date.now() - heard} ms, over ${HEARTBEAT_MISSES} heartbeats of ${heartbeatMs} ms; the connection is dead, so the bridge exits`);
      clearInterval(watchdog);
      socket.destroy();
    }, heartbeatMs);
    watchdog.unref();
  }
  await new Promise<void>((resolve) => {
    socket.on('close', () => resolve());
    socket.on('error', (error) => {
      console.error(`bellwether relay-bridge: ${error.message}`);
      resolve();
    });
  });
  // stdin stays open until the far side hangs up, so leave without waiting for it.
  process.exit(0);
}

/**
 * The machine side of a move, which a parent's daemon on another machine runs
 * here over SSH. The request arrives as JSON on standard input, so a session
 * never sits on a command line, and one JSON line goes back on standard
 * output: the result, or the error.
 */
async function moveVerb(verb: MoveVerb): Promise<number> {
  try {
    const input = fs.readFileSync(0, 'utf8');
    const result = await serveMoveVerb(verb, input.trim() ? JSON.parse(input) : {});
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`);
    return 1;
  }
}

/** The doctor line for one remote host's connection. */
export function describeRelayHost(state: RelayHostState): { ok: boolean; label: string; detail: string } {
  const label = `relay ${state.host}`;
  const as = state.target && state.target !== state.host ? ` as ${state.target}` : '';
  const drain = state.lastDrainAt ? `, last drain ${state.lastDrainAt}` : ', not drained yet';
  const children = `${state.children.length} child(ren) there`;
  if (state.status === 'connected') return { ok: true, label, detail: `connected since ${state.since}${as}, running ${runsOn({ version: state.farVersion, build: state.farBuild }).replace(/^bellwether /, '')}${drain}, ${children}` };
  const next = state.nextAttemptAt ? `, next attempt ${state.nextAttemptAt}` : '';
  const heard = state.lastConnectedAt ? `last connected ${state.lastConnectedAt}` : 'never connected';
  return { ok: false, label, detail: `${state.status} since ${state.since}${as}, ${state.attempts} failed attempt(s)${next}, ${heard}${drain}, ${children}, not hearing from them: ${state.lastError ?? 'no attempt has finished yet'}` };
}

/**
 * The relay, from both ends: each remote host this machine's daemon connects
 * to, and the reports that wait on this machine for a parent elsewhere.
 */
async function checkRelay(daemonLive: boolean, daemonSocket: string): Promise<number> {
  let failures = 0;
  if (daemonLive) {
    try {
      for (const state of await relayStatus(daemonSocket)) {
        const { ok: connected, label, detail } = describeRelayHost(state);
        if (connected) ok(label, detail);
        else {
          bad(label, detail);
          failures += 1;
        }
      }
    } catch (error) {
      console.log(`  info  relay: the running daemon did not report its connections (${(error as Error).message}); bellwether drain replaces it with this install's`);
    }
  } else {
    for (const [host, known] of Object.entries(readMemory())) {
      console.log(`  info  relay ${host}: no daemon runs, so no connection; last drain ${known.lastDrainAt ?? 'never'}${known.lastError ? `, last error ${known.lastError}` : ''}`);
    }
  }
  const waiting = listForwards();
  const refused = waiting.filter((entry) => entry.refused).length;
  if (waiting.length) console.log(`  info  relay outbox: ${waiting.length - refused} report(s) wait for a parent's daemon to collect them${refused ? `, ${refused} refused` : ''} (${relayOutboxDir()})`);
  return failures;
}

process.exitCode = await main();
