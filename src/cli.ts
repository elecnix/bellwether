#!/usr/bin/env node
// The bellwether command.
//
// `watch` is the dogfood driver: it runs the same core the Pi extension and the
// Claude channel run, and prints one line per child event, so a supervisor can
// read the stream instead of polling herdr.
import { describeRoutes, readRoutes } from './core/routes.ts';
import { checkReads } from './core/reads.ts';
import { workspaceColumn } from './core/workspace.ts';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HerdrClient, resolveSocketPath } from './core/herdr-client.ts';
import { bellwetherHome } from './core/paths.ts';
import { emptyParent, listParents, readParent, saveParent } from './core/registry.ts';
import { restartFailureLines, restartWaitLines } from './core/restart.ts';
import { teleportLines } from './core/teleport.ts';
import { crossingLines } from './core/recover-crossing.ts';
import { farRecordLines } from './core/remote.ts';
import { goneSessionLines, herdrView } from './core/pane-fate.ts';
import { PROMPT_NOTICE, isReportStatus } from './core/report.ts';
import { HOOK_COMMAND, dialogFromHook } from './core/claude-hooks.ts';
import { farChildFiles, hostName } from './core/spawn.ts';
import { RELAY_SCHEMA, listForwards, readRelayRecord, removeRelayRecord, retireWaitLines, saveRelayRecord, teleportWaitLines, updateRelayRecord } from './core/relay-records.ts';
import { relayChildPath, relayOutboxDir } from './core/paths.ts';
import { removeBriefAt, writeBrief, writeBriefIn } from './core/brief.ts';
import { removeChildFiles } from './core/mcp-config.ts';
import { harnessFor, harnessNamed } from './core/harnesses/index.ts';
import { daemonHerdrLine, describeUpgrade, farPairing, gatherUpgrade } from './daemon/upgrade-status.ts';
import { describeState } from './core/hygiene.ts';
import { HEARTBEAT_MISSES } from './core/ssh.ts';
import { relayAgentLine } from './core/ssh-agent.ts';
import { DaemonClient, REFUSED_EXIT, ReportRefused, daemonAncestry, daemonResume, drainDaemon, ensureDaemon, postReport, relayStatus } from './daemon/client.ts';
import { ancestry, type AncestryAnswer, type AncestryLevel } from './core/ancestry.ts';
import { readMemory, runsOn } from './daemon/relay-links.ts';
import type { RelayHostState } from './daemon/protocol.ts';
import { describePiTools, guardlessPiCopies } from './core/pi-extension.ts';
import { describeClaudeTools, describeToolSource, findAmbientServers } from './core/tool-source.ts';
import { toolFileLines } from './core/tool-files.ts';
import { DAEMON_ENTRY, lockPath, readLock } from './daemon/lock.ts';
import { BELLWETHER_BUILD, BELLWETHER_BUILD_ID, BELLWETHER_VERSION, describeBuild } from './core/version.ts';
import { canConnect, daemonIsLive, startDaemon } from './daemon/server.ts';
import type { ChildRecord, OutboxEntry } from './core/types.ts';
import { LOCAL_HOST, hostOf, knownHosts, machineClients } from './core/machine.ts';
import { describeIntegrations, integrationOf, listIntegrations } from './core/herdr-integration.ts';
import { MOVE_CHECK_BUDGET_MS, MOVE_CHECK_CALL_MS, MOVE_VERBS, RemoteTimeoutError, moveEndpoints, serveMoveVerb, type MoveVerb } from './core/move-endpoint.ts';
import { describePiModels, moveRefusals, pairLabel, type MovableHarness, type ModelPair } from './core/move-plan.ts';
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
    // --json takes no value, so the word after it stays positional, as in `ancestry --json claude:<id>`.
    if (next === undefined || next.startsWith('--') || key === 'json') {
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
  // The versions line in the upgrade report names this install's build, so the header does not repeat it.
  console.log(`bellwether home  ${bellwetherHome()}`);
  const daemonSocket = path.join(bellwetherHome(), 'daemon.sock');
  const daemonLive = daemonIsLive(bellwetherHome());
  // The upgrade report: which code the daemon and each session run, and whether a hand-over has finished.
  const upgrade = await gatherUpgrade(bellwetherHome(), daemonSocket);
  for (const line of describeUpgrade(upgrade).lines) console.log(`  ${line}`);
  const herdrLine = daemonHerdrLine(upgrade.sessions);
  if (herdrLine) {
    console.log(`  ${herdrLine.line}`);
    if (herdrLine.failed) failures += 1;
  }
  failures += checkPackaging();
  failures += checkToolSources();
  // Each tool file that names, or named, an install path an upgrade deleted (issue #266).
  for (const line of toolFileLines()) console.log(`  ${line}`);
  failures += await checkRelay(daemonLive, daemonSocket);
  // The size of the home, and what the next prune would remove, before it becomes a problem.
  const connected = new Set(upgrade.sessions && 'sessions' in upgrade.sessions ? upgrade.sessions.sessions.map((session) => session.parentId) : []);
  const listed = Boolean(upgrade.sessions && 'sessions' in upgrade.sessions);
  for (const line of describeState({ connected, now: Date.now(), connectedUnknown: !listed })) console.log(`  ${line}`);
  const socket = resolveSocketPath();
  if (!fs.existsSync(socket)) {
    console.log(`  fail  herdr socket: ${socket} does not exist`);
    return 1;
  }
  console.log(`  ok    herdr socket: ${socket}`);
  const herdr = new HerdrClient({ socketPath: socket });
  let panes: Awaited<ReturnType<HerdrClient['paneList']>> | undefined;
  try {
    panes = await herdr.paneList();
    console.log(`  ok    herdr api: ${panes.length} panes`);
  } catch (error) {
    console.log(`  fail  herdr api: ${String(error)}`);
    failures += 1;
  }
  // A parent with no running child is counted in the state line, not listed.
  for (const parent of listParents()) {
    const live = parent.children.filter((child) => !child.exitedAt);
    if (!live.length) continue;
    console.log(`  ${parent.id}: ${live.length} live of ${parent.children.length} children, updated ${parent.updatedAt}`);
    for (const child of live) console.log(`    ${child.name} on ${machineLabel(hostOf(child))}, workspace ${workspaceColumn(child)}${child.toolSource ? `, tools from ${describeToolSource(child.toolSource)}` : ''}`);
  }
  // Each route a child can start on, and what a child on it sees that a bare one does not.
  const routeLines = describeRoutes(() => readRoutes(), listParents().flatMap((parent) => parent.children).filter((child) => !child.exitedAt));
  for (const line of routeLines) console.log(`  ${line}`);
  failures += routeLines.filter((line) => line.startsWith('fail')).length;
  // A restart that closed a session's pane and never brought it back (issue #185).
  const lostRestarts = restartFailureLines(listParents());
  for (const line of lostRestarts) console.log(`  ${line}`);
  failures += lostRestarts.length;
  // What each pending self-restart waits for, and why one gave up (issue #188).
  for (const line of restartWaitLines(listParents())) console.log(`  ${line}`);
  // Each child whose machine holds no record of it while this registry does (issue #219).
  for (const line of farRecordLines(listParents())) console.log(`  ${line}`);
  // A recent teleport, and a teleported child that has not read its notice (issue #226).
  for (const line of teleportLines(listParents())) console.log(`  ${line}`);
  // A crossing under way shows as one, not as an exit, and a child a crossing left on neither machine fails (issue #226).
  const crossings = crossingLines(listParents());
  for (const line of crossings) console.log(`  ${line}`);
  failures += crossings.filter((line) => line.startsWith('fail')).length;
  // Each session on this machine whose pane is gone, and the command that brings it back (issue #187).
  const view = panes ? await herdrView(herdr, panes) : undefined;
  if (view) {
    const here = hostName();
    const gone = goneSessionLines(listParents(), view, { connected, now: Date.now(), isLocal: (record) => record.host === LOCAL_HOST || record.host === here });
    for (const line of gone) console.log(`  ${line}`);
  }
  await checkMoves(socket);
  return failures;
}

/**
 * One line per harness: which server gives a session on this machine its
 * Bellwether tools, and what a spawned child gets instead, with each duplicate
 * the spawn keeps out and how. Claude Code's project scope is read from the
 * directory doctor runs in.
 */
function checkToolSources(): number {
  const lines = [describeClaudeTools(findAmbientServers(process.cwd())), describePiTools()];
  for (const line of lines) console.log(`  ${line.level.padEnd(5)} ${line.text}`);
  return lines.filter((line) => line.level === 'fail').length;
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

/** Settle with `work`, or reject once `signal` aborts, with a message that names the bound. */
function within<T>(work: Promise<T>, signal: AbortSignal, budgetMs: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new RemoteTimeoutError(`no answer within ${budgetMs / 1000} s, the bound doctor sets on the whole move check`));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }),
  ]);
}

/** The herdr integrations doctor reports for each machine: the ones the movable harnesses need for their sessions. */
const INTEGRATION_TARGETS = ['claude', 'pi'].map((kind) => integrationOf(harnessFor(kind))).filter((target): target is string => Boolean(target));

/**
 * Why doctor could not read a machine for the move check. A timeout is only
 * that: the machine did not answer within doctor's bound, which agent_move,
 * with 120 s for each call, does not share. Any other failure is one that
 * agent_move would meet too.
 */
function unreadMachine(failure: Error | undefined): string {
  if (!failure || failure instanceof RemoteTimeoutError) {
    return `unknown, because it did not answer within ${MOVE_CHECK_CALL_MS / 1000} s, the bound doctor sets on each call of the move check (${failure?.message ?? 'no answer'}). That alone shows no fault there, so doctor cannot tell whether a child can move there or from there.`;
  }
  return `no child can move there or from there until this is fixed: ${failure.message}`;
}

/**
 * What agent_move would need on each known machine: the harness, its version,
 * and pi's models, then for each live claude or pi child, whether each other
 * machine could take it. These are information, not failures: a machine that
 * cannot take a child only refuses a move to it. The whole check runs within
 * MOVE_CHECK_BUDGET_MS.
 */
async function checkMoves(herdrSocket: string): Promise<void> {
  const budgetMs = MOVE_CHECK_BUDGET_MS;
  const signal = AbortSignal.timeout(budgetMs);
  let hosts: string[];
  try {
    hosts = await within(knownHosts(), signal, budgetMs);
  } catch (error) {
    console.log(`  info  move: the saved herdr machines could not be listed (${(error as Error).message}), so only this machine is checked`);
    hosts = [LOCAL_HOST];
  }
  const children = listParents().flatMap((parent) => parent.children).filter((child): child is ChildRecord & { harness: MovableHarness } => !child.exitedAt && harnessNamed(child.harness)?.movable === true);
  const endpointFor = moveEndpoints(undefined, { timeoutMs: MOVE_CHECK_CALL_MS, signal });
  const probes = new Map<string, ProbeResult | Error>();
  // herdr's integrations on each machine, from the integration.list call a move makes there, beside the probe.
  const clientFor = machineClients(new HerdrClient({ socketPath: herdrSocket }));
  const integrations = new Map<string, Map<string, string> | Error>();
  const readIntegrations = async (host: string): Promise<void> => {
    try {
      const client = await within(clientFor(host), signal, budgetMs);
      const requester = { request: (method: string, params?: Record<string, unknown>) => client.request(method, params, { signal, timeoutMs: MOVE_CHECK_CALL_MS }) };
      integrations.set(host, await within(listIntegrations(requester), signal, budgetMs));
    } catch (error) {
      integrations.set(host, error instanceof Error ? error : new Error(String(error)));
    }
  };
  await Promise.all([
    ...hosts.map(async (host) => {
      const piSessions = children.filter((child) => hostOf(child) === host && child.harness === 'pi' && child.session?.value).map((child) => child.session?.value as string);
      try {
        probes.set(host, await within(endpointFor(host).probe({ piModels: true, piSessions }), signal, budgetMs));
      } catch (error) {
        probes.set(host, error instanceof Error ? error : new Error(String(error)));
      }
    }),
    ...hosts.map(readIntegrations),
  ]);
  for (const host of hosts) {
    const probe = probes.get(host);
    if (!probe || probe instanceof Error) {
      console.log(`  info  move ${machineLabel(host)}: ${unreadMachine(probe)}`);
      continue;
    }
    const models = describePiModels(probe.piModels, probe.piModelsError);
    const herdrSays = describeIntegrations(integrations.get(host) ?? new Error('not read'), INTEGRATION_TARGETS, host);
    console.log(`  info  move ${machineLabel(host)} (${probe.hostname}): ${harnessLine(probe, 'claude-code')}, ${harnessLine(probe, 'pi')}, ${models}, ${herdrSays}, bellwether ${probe.bellwether}`);
  }
  for (const child of children) {
    const source = hostOf(child);
    const sourceProbe = probes.get(source);
    if (!sourceProbe || sourceProbe instanceof Error) {
      console.log(`  info  move ${child.name}: not checked, because its machine ${source === LOCAL_HOST ? 'here' : source} could not be read`);
      continue;
    }
    const pair: ModelPair | undefined = child.session?.value ? (sourceProbe.piSessionModels?.[child.session.value] ?? undefined) : undefined;
    for (const target of hosts) {
      if (target === source) continue;
      const targetProbe = probes.get(target);
      if (!targetProbe || targetProbe instanceof Error) continue;
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

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  // From the build alone: no daemon, herdr or home is read, so a daemon of any protocol cannot make it fail.
  if (command === 'version' || command === '--version') {
    console.log(describeBuild(BELLWETHER_VERSION, BELLWETHER_BUILD));
    return 0;
  }

  if (command === 'help' || command === '--help') {
    console.log('Usage: bellwether <daemon|drain|spawn|watch|list|read|send|stop|move|teleport|resume|report|parents|ancestry|doctor|version> [--debug]');
    console.log('  --debug                                  print the stack trace of a failure, as BELLWETHER_DEBUG=1 does');
    console.log('  daemon [--socket PATH]                   run the local daemon in the foreground');
    console.log('  drain  [--socket PATH]                   stop the running daemon once its calls finish, so the next session starts the installed one');
    console.log('  version                                  print the installed version and the commit it was built from (also --version), without asking the daemon');
    console.log('  spawn  --kind KIND --name NAME [--cwd DIR] [--prompt TEXT] [--model M] [--provider P] [--machine M] [--stuck-minutes N] [--inactive-minutes N] [--max-depth N] [--workspace new|ID|LABEL [--workspace-label L]] [--parent ID] [--focus]');
    console.log('         --workspace new                   start the child in a workspace of its own, on its machine, where its own children open too; Bellwether closes it once it is empty');
    console.log('  watch  [--parent ID] [--tick-ms N]      one line per child event, then keeps reading');
    console.log('  list   [--parent ID]');
    console.log('  read   CHILD [--lines N]');
    console.log('  send   CHILD [--text TEXT | --keys KEY,...]');
    console.log('  stop   CHILD [--force]');
    console.log('  move   CHILD [--machine M] [--cwd DIR] [--reason TEXT]  move a live claude or pi child to another machine, keeping its id and conversation');
    console.log('  resume SESSION [--label L]               bring back a session whose pane is gone, from its record: a registry id, a session id or its last pane');
    console.log('  ancestry AGENT [--json] [--socket PATH]  the agent\'s ancestors, nearest first, and which still run; AGENT is <harness>:<session>, such as claude:<id> or pi:<id>');
    console.log('  report --child ID --status done|needs-input|progress --text TEXT [--parent ID] [--receipt ID]');
    console.log('  claude-hook --child ID                   a Claude Code child\'s Notification hook: the hook input on stdin, the dialog to the daemon, nothing on stdout');
    console.log('  relay-register --child ID --name NAME --kind KIND --parent ID [--cwd DIR] [--reads JSON] [--brief-stdin yes]');
    console.log('  relay-cleanup --child ID                 remove the brief and MCP config relay-register wrote');
    console.log('  relay-bridge [--heartbeat-ms N]          join stdin and stdout to this machine\'s daemon; a parent\'s daemon runs it over SSH');
    console.log('  move-probe|move-export|move-import|move-discard|move-commit   the machine side of a move: a JSON request on stdin, one JSON line out; a parent\'s daemon runs them over SSH');
    return 0;
  }

  if (command === 'doctor') return doctor();

  if (command === 'daemon') {
    const socketPath = str(flags, 'socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(bellwetherHome(), 'daemon.sock');
    // The lock names this install's daemon entry point, so doctor can say which install a hand-started daemon runs.
    const daemon = await startDaemon({ socketPath, home: bellwetherHome(), entry: DAEMON_ENTRY, foreground: true, log: (message) => console.error('[bellwether-daemon]', message) });
    console.error(`[bellwether-daemon] listening on ${socketPath} with pid ${daemon.pid}`);
    const stop = (): void => void daemon.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await daemon.whenClosed();
    return 0;
  }

  if (command === 'drain') {
    const socketPath = str(flags, 'socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(bellwetherHome(), 'daemon.sock');
    // The daemon that answers on a socket keeps its lock beside it, whatever BELLWETHER_HOME says.
    const lockHome = path.dirname(path.resolve(socketPath));
    const lock = readLock(lockHome);
    if (!(await drainDaemon(socketPath))) {
      console.log(`no daemon answers on ${socketPath}; the next session starts one from its own install`);
      return 0;
    }
    const described = lock ? `${lock.version ?? 'from a release before 0.1.5'} on protocol ${lock.protocol} (pid ${lock.pid}), as its lock ${lockPath(lockHome)} records` : `on ${socketPath}, whose version is unknown because no lock sits beside it at ${lockPath(lockHome)}`;
    console.log(`drained the daemon ${described}; the next session call starts the daemon from that session's install`);
    return 0;
  }

  if (command === 'parents') {
    for (const parent of listParents()) console.log(`${parent.id}\t${parent.children.length} children\t${parent.updatedAt}\t${parent.cwd}`);
    return 0;
  }

  if (command === 'ancestry') return ancestryCommand(positional[0], flags);
  if (command === 'resume') return resumeCommand(positional[0], flags);
  if (command === 'report') return report(rest);
  if (command === HOOK_COMMAND) return claudeHook(rest);
  if (command === 'relay-register') return farEnd(command, () => relayRegister(rest));
  if (command === 'relay-cleanup') return farEnd(command, () => relayCleanup(rest));
  if (command === 'relay-bridge') return relayBridge(rest);
  if ((MOVE_VERBS as readonly string[]).includes(command)) return moveVerb(command as MoveVerb);

  const { id: parentId } = parentFor(flags);
  const parent = readParent(parentId);
  if (!parent) throw new Error(`no parent registry ${parentId} in ${path.join(bellwetherHome(), 'parents')}; bellwether parents lists the ones there`);
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
        provider: str(flags, 'provider'),
        machine: str(flags, 'machine'),
        focus: flags['focus'] === true,
        stuck_minutes: num(flags, 'stuck-minutes'),
        inactive_minutes: num(flags, 'inactive-minutes'),
        max_depth: num(flags, 'max-depth'),
        workspace: str(flags, 'workspace'),
        workspace_label: str(flags, 'workspace-label'),
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
      console.log(await daemon.tool('agent_move', { child, machine: str(flags, 'machine'), cwd: str(flags, 'cwd'), reason: str(flags, 'reason'), ...(flags['accept-loss'] === true ? { accept_loss: true } : {}) }));
    } else if (command === 'teleport') {
      const child = positional[0];
      if (!child) throw new Error('teleport needs a child');
      console.log(await daemon.tool('agent_teleport', { child, machine: str(flags, 'to') ?? str(flags, 'machine'), cwd: str(flags, 'cwd'), reason: str(flags, 'reason'), ...(flags['accept-loss'] === true ? { accept_loss: true } : {}) }));
    } else if (command === 'stop') {
      const child = positional[0];
      if (!child) throw new Error('stop needs a child');
      console.log(await daemon.tool('agent_stop', { child, force: flags['force'] === true }));
    } else {
      console.log('Usage: bellwether <daemon|drain|spawn|watch|list|read|send|stop|move|teleport|report|parents|doctor|version>');
      return 1;
    }
  } finally {
    await daemon.close();
  }
  return 0;
}

/**
 * The agent tree above one agent, from the daemon. It never starts a daemon:
 * when none answers, or the one that answers predates the request, it reads
 * the registry files and marks the answer stale, so the caller decides.
 */
async function ancestryCommand(agent: string | undefined, flags: Flags): Promise<number> {
  if (!agent) throw new Error('ancestry needs an agent, such as claude:<session> or pi:<session>');
  const socketPath = str(flags, 'socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(bellwetherHome(), 'daemon.sock');
  let answer: AncestryAnswer;
  if (!(await canConnect(socketPath))) {
    answer = ancestry(agent, listParents(), { stale: `no daemon answers on ${socketPath}` });
  } else {
    try {
      answer = await daemonAncestry(socketPath, agent, ANCESTRY_TIMEOUT_MS);
    } catch (error) {
      const message = (error as Error).message;
      const reason = message.startsWith('unknown_type') ? `the daemon on ${socketPath} predates the ancestry request, which needs Bellwether 0.1.6` : `the daemon on ${socketPath} did not answer: ${message}`;
      answer = ancestry(agent, listParents(), { stale: reason });
    }
  }
  if (flags['json'] === true) {
    console.log(JSON.stringify(answer, null, 2));
    return 0;
  }
  if (answer.stale) console.log(`stale: ${answer.staleReason ?? 'the daemon did not answer'}`);
  if (answer.status === 'unknown') {
    console.log(`unknown: no Bellwether record names ${agent}`);
    return 0;
  }
  const line = (level: AncestryLevel): string => `${level.agent ?? `child ${level.childId ?? '?'}`}${level.childName ? ` (${level.childName})` : ''} on ${level.host}: ${level.alive === null ? 'unknown' : level.alive ? 'alive' : 'not alive'}, ${level.evidence}${level.since ? ` since ${level.since}` : ''}`;
  if (answer.agent) console.log(`agent  ${line(answer.agent)}`);
  answer.chain.forEach((level, index) => console.log(`${index === answer.nearestAlive ? 'alive' : 'up   '}  ${line(level)}`));
  console.log(`top    ${answer.top}`);
  return 0;
}

/**
 * Bring back a session whose pane is gone, from its own record, through this
 * machine's daemon (issue #187). The daemon opens the tab and starts the
 * harness; this prints where the session landed, or why nothing opened.
 */
async function resumeCommand(target: string | undefined, flags: Flags): Promise<number> {
  if (!target) throw new Error('resume needs a session: its registry id, its session id or the pane it last ran in. `bellwether doctor` lists each session whose pane is gone.');
  try {
    console.log(await daemonResume({ target, herdrSocket: resolveSocketPath({ socketPath: str(flags, 'herdr-socket'), session: str(flags, 'session') }), label: str(flags, 'label') }, { log: (message) => console.error('[bellwether]', message) }));
    return 0;
  } catch (error) {
    console.error(`bellwether resume: ${(error as Error).message}`);
    return REFUSED_EXIT;
  }
}

/** How long `bellwether ancestry` waits for the daemon before it reads the files. */
const ANCESTRY_TIMEOUT_MS = 3_000;

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
    const posted = await postReport({ childId, status, text, via: 'shell', ...(values['parent'] ? { parentId: values['parent'] } : {}), ...(values['receipt'] ? { receipt: values['receipt'] } : {}) });
    console.log(posted.text);
    return 0;
  } catch (error) {
    console.error(`bellwether report: ${(error as Error).message}`);
    // A refusal is final; anything else is worth another try by the sender.
    return error instanceof ReportRefused ? REFUSED_EXIT : 1;
  }
}

/**
 * A Claude Code child's Notification hook, which its spawn wrote into the
 * child's own settings. It reads the hook input on standard input and, for a
 * notification that means a dialog waits on the person, tells this machine's
 * daemon, which records the dialog on the child's record as it does for a pi
 * child's ui_prompt_start. Claude Code ignores a Notification hook's exit
 * code, and a failure must never get in the child's way, so this always exits
 * 0 and says why on standard error.
 *
 * It writes nothing to standard output, ever. A decision hook reads its
 * decision from standard output, and approving a permission question is the
 * operator's decision, not Bellwether's: do not print one here.
 */
async function claudeHook(argv: string[]): Promise<number> {
  const quiet = (message: string): number => {
    console.error(`bellwether ${HOOK_COMMAND}: ${message}`);
    return 0;
  };
  let childId: string | undefined;
  try {
    childId = exactFlags(argv, ['child'])['child'] ?? process.env['BELLWETHER_CHILD'];
  } catch (error) {
    return quiet((error as Error).message);
  }
  if (!childId) return quiet('needs --child, or a BELLWETHER_CHILD in the environment');
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch (error) {
    return quiet(`could not read the hook input: ${(error as Error).message}`);
  }
  const dialog = dialogFromHook(input);
  if (!dialog) return 0;
  const payload = JSON.parse(input) as { session_id?: unknown; cwd?: unknown };
  let daemon: DaemonClient | undefined;
  try {
    // spawn: false, because a dialog is no reason to start a daemon: the
    // child's own MCP server already connected to the one it reports to.
    daemon = await DaemonClient.connect({
      harness: 'claude-code',
      session: typeof payload.session_id === 'string' ? payload.session_id : (process.env['CLAUDE_CODE_SESSION_ID'] ?? `pid-${process.ppid}`),
      cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      host: hostName(),
      paneId: process.env['HERDR_PANE_ID'],
      workspaceId: process.env['HERDR_WORKSPACE_ID'],
      depth: Number.parseInt(process.env['BELLWETHER_DEPTH'] ?? '0', 10) || 0,
      herdrSocket: resolveSocketPath(),
      childId,
    }, { spawn: false, timeoutMs: 5_000, ...(process.env['BELLWETHER_DAEMON_SOCKET'] ? { socketPath: process.env['BELLWETHER_DAEMON_SOCKET'] } : {}), log: (message) => console.error('[bellwether]', message) });
    await daemon.tool(PROMPT_NOTICE, { ...dialog, source: 'claude-code' });
    return 0;
  } catch (error) {
    // An older daemon refuses the source argument; the screen check stands in.
    return quiet((error as Error).message);
  } finally {
    await daemon?.close().catch(() => {});
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
 * extension it loads, as one JSON line. The same line carries the variables
 * the harness entry gives the child's tab here, less any that belong to one
 * machine, which it names in `envDropped`. The record holds none of them.
 */
function relayRegister(argv: string[]): number {
  const values = exactFlags(argv, ['child', 'name', 'kind', 'parent', 'cwd', 'reads', 'brief-stdin']);
  const childId = values['child'];
  const parentId = values['parent'];
  if (!childId || !parentId) throw new Error('relay-register needs --child and --parent');
  const cwd = values['cwd'];
  // The child's tools, as its harness's entry says: a Claude Code child's own
  // server, with whatever keeps this machine's other Bellwether servers from
  // adding a second set, or the extension a pi child loads, which fails here,
  // before anything else is written, when it is missing.
  // The paths the parent named for the child, checked again here against this machine's home.
  const reads = values['reads'] === undefined ? undefined : checkReads(JSON.parse(values['reads']));
  const { env, dropped, ...tools } = farChildFiles({ id: childId, kind: values['kind'] ?? 'other', ...(cwd ? { cwd } : {}), ...(reads ? { reads } : {}) });
  let brief: string | undefined;
  if (values['brief-stdin'] === 'yes') {
    const text = fs.readFileSync(0, 'utf8');
    brief = cwd ? writeBriefIn(cwd, childId, text) : writeBrief(childId, text);
  }
  saveRelayRecord({ schema: RELAY_SCHEMA, childId, name: values['name'] ?? childId, kind: values['kind'] ?? 'other', parentId, ...(cwd ? { cwd } : {}), ...(brief ? { brief } : {}), registeredAt: new Date().toISOString() });
  console.log(JSON.stringify({ record: relayChildPath(childId), version: BELLWETHER_VERSION, build: BELLWETHER_BUILD_ID, ...(brief ? { brief } : {}), ...(tools?.mcpConfigFile ? { mcpConfig: tools.mcpConfigFile, ...(tools.claudeSettingsFile ? { claudeSettings: tools.claudeSettingsFile } : {}), toolSource: tools.toolSource } : {}), ...(tools.piExtension ? { piExtension: tools.piExtension } : {}), env, ...(dropped.length ? { envDropped: dropped } : {}) }));
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
  const handedOver = await ensureDaemon(home, socketPath);
  // Run by hand, with no heartbeat, the bridge is the hand-over a person reads. Run by a parent's
  // daemon, its standard error explains a failed connection, so it stays clear of this sentence.
  if (handedOver.notice && !(heartbeatMs > 0)) console.error(`bellwether relay-bridge: ${handedOver.notice}`);
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
  if (state.status === 'connected') return { ok: true, label, detail: `connected since ${state.since}${as}, running ${runsOn({ version: state.farVersion, build: state.farBuild }).replace(/^bellwether /, '')}${drain}, ${children}${farPairing(state)}` };
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
          // A public-key refusal never says the daemon's ssh had no agent; this line does (issue #245).
          const agentLine = relayAgentLine(state);
          if (agentLine) console.log(`  info  ${agentLine}`);
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
  // Each retirement a child here asked for, which the parent's daemon that holds its record has not taken (issue #227).
  const retirements = retireWaitLines();
  for (const line of retirements) console.log(`  ${line}`);
  // Each teleport a child here asked for, which the parent's daemon that holds its record has not taken (issue #226).
  const teleports = teleportWaitLines();
  for (const line of teleports) console.log(`  ${line}`);
  return failures + [...retirements, ...teleports].filter((line) => line.startsWith('fail')).length;
}

/**
 * Why a stack trace is shown, or undefined when it is not: `--debug` anywhere
 * on the command line, or BELLWETHER_DEBUG=1 in the environment. The flag is
 * taken out before parsing, so it never takes the next word as its value.
 */
export function debugReason(argv: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (argv.includes('--debug')) return 'because of --debug';
  if (env['BELLWETHER_DEBUG'] === '1') return 'because BELLWETHER_DEBUG=1 is set';
  return undefined;
}

/**
 * Run a command, and print a failure as `bellwether <command>: <message>` on
 * standard error with a non-zero exit. The stack trace is for whoever asked
 * for it, and says how it was asked for.
 */
async function run(argv: string[]): Promise<number> {
  const debug = debugReason(argv);
  const args = argv.filter((word) => word !== '--debug');
  try {
    return await main(args);
  } catch (error) {
    const fault = error instanceof Error ? error : new Error(String(error));
    console.error(`bellwether ${args[0] ?? 'help'}: ${fault.message}`);
    if (debug) console.error(`${fault.stack ?? fault.message}\n(stack trace shown ${debug})`);
    else console.error('Run it again with --debug, or with BELLWETHER_DEBUG=1, for the stack trace.');
    return 1;
  }
}

process.exitCode = await run(process.argv.slice(2));
