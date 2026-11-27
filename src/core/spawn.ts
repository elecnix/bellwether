// Starting a child. The order follows the design: write the registry record
// first, then create the tab with the Bellwether environment, then ask herdr
// to start the harness in the tab's root pane, then watch the new pane.
import os from 'node:os';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { PI_EXTENSION_ENV, piExtensionEntry, piFallback, resolvePiExtension } from './pi-extension.ts';
import { briefArgument, writeBrief } from './brief.ts';
import { DEFAULT_MAX_DEPTH, tooDeep } from './depth.ts';
import { resolveInactiveMs } from './inactivity.ts';
import { removeChildFiles, writeChildToolFiles, type ChildToolFiles } from './mcp-config.ts';
import type { ToolSource } from './tool-source.ts';
import { removeChild, updateChild, upsertChild } from './registry.ts';
import { watchStartup, type StartupDialog, type StartupWatch } from './startup-dialogs.ts';
import { agentNameOf, locateTranscript, piSessionModel, sessionFrom } from './transcript.ts';
import type { RemoteRegistration } from './remote.ts';
import { BARE, RoutesFileError, launchLine, readRoutes, resolveRoute, routeConfig, routeLaunch, type RouteConfig, type RouteLaunch, type RoutesFile } from './routes.ts';
import { openChildTab, parseWorkspaces, placeChild, undoChildTab, type ChildTab, type WorkspaceEntry } from './workspace.ts';
import type { ChildRecord, ChildRoute, Harness, ModelPair, ParentRecord } from './types.ts';

/** How deep a Bellwether child may spawn. The design starts at 2. */
export { DEFAULT_MAX_DEPTH } from './depth.ts';

export const AGENT_KINDS = ['pi', 'claude', 'codex', 'opencode', 'cline'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function harnessOf(kind: string): Harness | 'other' {
  if (kind === 'pi') return 'pi';
  if (kind === 'claude') return 'claude-code';
  return 'other';
}

export interface SpawnOptions {
  kind: string;
  name: string;
  cwd?: string;
  prompt?: string;
  model?: string;
  /**
   * The route to launch through: a name from this machine's routes file, or
   * `none` for a bare start. On a route, model names the route's tier.
   */
  via?: string;
  /** A file holding the key the route's launcher runs under. Its path travels, never its contents. */
  keyFile?: string;
  /** The pi provider for the model. pi needs both, so one without the other is refused. */
  provider?: string;
  /** The provider and model the parent runs on, which a pi child inherits when the caller names neither. */
  parentModel?: ModelPair;
  args?: string[];
  focus?: boolean;
  /** Minutes of quiet before the child counts as stuck. */
  stuckMinutes?: number;
  /**
   * Minutes of no observable activity before the parent is told. Defaults to
   * five and is clamped to one minute through twenty-four hours. It cannot
   * switch the notification off.
   */
  inactiveMinutes?: number;
  /**
   * The workspace to open the tab in: "new" for one of the child's own, or an
   * existing workspace's id or label on the child's machine. Omitted, a child
   * on this machine opens in the parent's workspace, as before.
   */
  workspace?: string;
  /** The label of a new workspace. Defaults to the child's name. Only with workspace "new". */
  workspaceLabel?: string;
  /** The new child's ceiling: the deepest generation its own descendants may reach. */
  maxDepth?: number;
  /** The spawning session's own ceiling, which the new child's depth may not pass. Defaults to maxDepth. */
  spawnerCeiling?: number;
  /** How long the startup dialogs may take. Tests shorten it. */
  startupTimeoutMs?: number;
  /** How long a screen takes to redraw after a key. Tests shorten it. */
  redrawMs?: number;
  /**
   * The herdr host to start the child on: `local`, or a saved herdr machine.
   * The caller passes the client for that host.
   */
  host?: string;
}

export interface SpawnResult {
  child: ChildRecord;
  /** Which provider and model a pi child runs on, and why, for the spawn reply. */
  modelNote?: string;
  link: string;
  /** Why a child on another machine cannot call parent_report, when its registration there failed. */
  reportWarning?: string;
  /** The startup dialogs the spawn answered, in order. */
  answered?: StartupDialog[];
}

/** How long the watcher holds a new Claude Code child's events. Longer than the dialog wait. */
export const STARTUP_HOLD_MS = 45_000;

/** How long the spawn waits for a Claude Code child to get past its dialogs. */
export const STARTUP_TIMEOUT_MS = 30_000;

/** The files a child starts with, each written or resolved before its tab opens. */
export interface ChildLaunch {
  /** The private file that holds the brief. */
  briefFile?: string;
  /** A Claude Code child's own Bellwether server. */
  mcpConfigFile?: string;
  /** A Claude Code child's own settings: the hook that reports its dialogs, and a Bellwether plugin turned off so it has one set of tools. */
  claudeSettingsFile?: string;
  /** The Bellwether extension a pi child loads, on the machine it runs on. */
  piExtension?: string;
}

/**
 * The arguments a child harness starts with. The brief is never one of them:
 * the harness gets a one-line pointer to the file that holds it.
 */
export function childArgs(kind: string, options: SpawnOptions, launch: ChildLaunch = {}): string[] {
  const { briefFile, mcpConfigFile, claudeSettingsFile, piExtension } = launch;
  const args: string[] = [];
  // pi needs both flags. A flag the caller already put in args is not repeated.
  if (options.provider && kind === 'pi' && argValue(options.args, '--provider') === undefined) args.push('--provider', options.provider);
  if (options.model && argValue(options.args, '--model') === undefined) args.push('--model', options.model);
  // A pi child loads the extension it is given, whatever the host's pi settings hold.
  if (kind === 'pi' && piExtension) args.push('-e', piExtension);
  // --mcp-config is a list flag too, so it takes the equals form for the same reason.
  if (kind === 'claude' && mcpConfigFile) args.push(`--mcp-config=${mcpConfigFile}`);
  // Claude Code merges these settings with every other source, so the child
  // gains its Notification hook, loses a duplicate Bellwether plugin, and
  // keeps the rest of the operator's own settings.
  if (kind === 'claude' && claudeSettingsFile) args.push(`--settings=${claudeSettingsFile}`);
  // Claude Code reads this flag as a list and keeps taking values until the
  // next flag, so the two-argument form swallowed the prompt that follows it.
  // The equals form pins the flag to one value.
  if (kind === 'claude') args.push('--dangerously-load-development-channels=server:bellwether');
  if (briefFile) args.push(briefArgument(kind, briefFile));
  if (options.args?.length) args.push(...options.args);
  return args;
}

/** The value of `--flag value` or `--flag=value` in a list of arguments. */
export function argValue(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === flag) return args[index + 1] ?? '';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * The provider and model a pi child starts with. A caller that names both
 * wins, in the spawn's fields or in its extra arguments. Half a pair is
 * refused, because pi would pair it with whatever provider it defaults to.
 * With neither named, the child inherits the parent's pair. With the parent's
 * pair unknown too, no flag is passed and pi picks its own default.
 */
export function chooseChildModel(options: Pick<SpawnOptions, 'kind' | 'name' | 'model' | 'provider' | 'args' | 'parentModel'>): (ModelPair & { source: 'caller' | 'parent' }) | undefined {
  if (options.kind !== 'pi') {
    if (options.provider) throw new Error(`${options.name} was not started: provider applies to a pi child, and this is a ${options.kind} child. Put the provider in model if the harness takes one.`);
    return undefined;
  }
  const provider = options.provider ?? argValue(options.args, '--provider');
  const model = options.model ?? argValue(options.args, '--model');
  const parent = options.parentModel;
  const instead = parent ? `or neither to run on this session's ${parent.provider} / ${parent.id}` : `or neither to run on pi's own default`;
  if (provider && model) return { provider, id: model, source: 'caller' };
  if (model) throw new Error(`${options.name} was not started: pi needs a provider with the model ${model}, and Bellwether does not guess one. Pass provider too, ${instead}.`);
  if (provider) throw new Error(`${options.name} was not started: pi needs a model with the provider ${provider}, and Bellwether does not guess one. Pass model too, ${instead}.`);
  return parent ? { ...parent, source: 'parent' } : undefined;
}

/**
 * The line of a spawn reply that says which provider account and model a pi
 * child runs on, since the account is what pays. With no pair passed and no
 * session file yet, it names the default pi's settings point to, where they
 * set it, and that the pair is unverified.
 */
export function modelNote(child: Pick<ChildRecord, 'name' | 'kind' | 'model' | 'host' | 'cwd'>): string | undefined {
  if (child.kind !== 'pi') return undefined;
  const model = child.model;
  const on = (pair: ModelPair): string => `provider account ${pair.provider}, model ${pair.id}`;
  if (model?.source === 'caller') return `${child.name} runs on ${on(model)}, as the spawn named.`;
  if (model?.source === 'parent') return `${child.name} runs on ${on(model)}, the same account and model as this session.`;
  const head = 'This session did not say which provider and model it runs on, so Bellwether passed none.';
  if (model) return `${head} ${child.name} runs on ${on(model)}, pi's own default, read from its session file.`;
  const tail = 'This is unverified until pi writes its session file, and agent_list shows the pair pi chose once it does.';
  if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST) return `${head} ${child.name} starts on pi's own default on machine ${child.host}, set in that machine's ~/.pi/agent/settings.json, which Bellwether cannot read from here. The pair is unverified, and its session file stays on that machine.`;
  const fallback = piFallback(child.cwd);
  const target = fallback.provider && fallback.id ? on({ provider: fallback.provider, id: fallback.id }) : undefined;
  return `${head} ${child.name} starts on pi's own default${target ? `, ${target}` : ''}: ${fallback.reason}. ${tail}`;
}

/**
 * Record a child on the machine it runs on, so that machine's daemon carries
 * its reports back here, and copy its brief there when it has one.
 */
export type RegisterRemote = (child: ChildRecord, brief?: string) => Promise<RemoteRegistration>;

export interface SpawnHooks {
  /** Drop whatever the watcher holds for a child whose spawn failed. */
  forget?: (childId: string) => void;
  /** Register a child on another machine. Without it, such a child cannot report or get a brief. */
  registerRemote?: RegisterRemote;
  /** Remove what the registration wrote on the child's machine, for a spawn that failed after it. */
  cleanupRemote?: (child: ChildRecord) => Promise<void>;
  /** Where this package's pi extension is. Tests point it at a missing file. */
  piExtension?: () => string;
  /** The workspaces on the parent's machine, so a local id passed for a remote child is refused by name. */
  localWorkspaces?: () => Promise<WorkspaceEntry[]>;
}

/** The files a child starts with, wherever it runs, and what its spawn reply should warn about. */
export interface ChildStartFiles {
  /** The brief's path on the child's own machine. */
  briefFile?: string;
  /** The MCP config's path on the child's own machine. */
  mcpConfigFile?: string;
  /** The Claude Code settings' path on the child's own machine, when the child needs any: the dialog hook, and a duplicate plugin turned off. */
  claudeSettingsFile?: string;
  /** Which server gives a Claude Code child its Bellwether tools, for its record. */
  toolSource?: ToolSource;
  /** The Bellwether extension a pi child loads, on its own machine. */
  piExtension?: string;
  /** Why the child's reports cannot reach this machine, when they cannot. */
  warning?: string;
  /** Whether the child's machine holds files that must go with the child. */
  registered: boolean;
}

/**
 * Write the files a child starts with, on the machine it runs on. A child on
 * this machine gets them here. A child on another machine is registered there
 * first, and that machine writes them: its brief arrives over the SSH
 * transport, on standard input, so the harness is pointed at a file that
 * exists where it runs. A child with a brief that cannot be delivered is not
 * started, because it would run with no task: this throws. Without a brief, a
 * failed registration does not stop the spawn: herdr status still follows the
 * child, and the warning says why its reports cannot arrive. A pi child
 * starts with the Bellwether extension of the package on its own machine, and
 * one whose extension cannot be found is not started either, because it would
 * have no tools.
 */
export async function childStartFiles(child: ChildRecord, prompt: string | undefined, register?: RegisterRemote, piExtension: () => string = piExtensionEntry): Promise<ChildStartFiles> {
  const pi = child.kind === 'pi';
  if ((child.host ?? LOCAL_HOST) === LOCAL_HOST) {
    // Resolved first, so a missing extension writes nothing.
    const extension = pi ? resolvePiExtension(piExtension()) : undefined;
    const tools = childToolFiles(child);
    return { briefFile: prompt !== undefined ? writeBrief(child.id, prompt) : undefined, ...toolLaunch(tools), ...(extension ? { piExtension: extension } : {}), registered: false };
  }
  const reports = child.harness === 'claude-code' || child.harness === 'pi';
  if (!reports && prompt === undefined) return { registered: false };
  if (!register) {
    if (pi) throw new Error(`${child.name} was not started on machine ${child.host}: this session cannot register children there, so Bellwether cannot name the pi extension it would load.`);
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}: this session cannot register children there, so its brief cannot reach that machine.`);
    if (child.kind === 'claude') throw new Error(withoutIdentity(child, 'this session cannot register children there'));
    return { warning: `${child.name} runs on machine ${child.host}, and this session cannot register it there, so it cannot call parent_report.`, registered: false };
  }
  let registration: RemoteRegistration;
  try {
    registration = await register(child, prompt);
  } catch (error) {
    if (pi) throw new Error(`${child.name} was not started on machine ${child.host}, because Bellwether could not register it there to name the pi extension it would load: ${(error as Error).message}`);
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}, because its brief could not be copied there: ${(error as Error).message}`);
    if (child.kind === 'claude') throw new Error(withoutIdentity(child, `Bellwether could not register it there: ${(error as Error).message}`));
    return { warning: `${child.name} could not be registered on machine ${child.host}, so it cannot call parent_report: ${(error as Error).message}`, registered: false };
  }
  return {
    briefFile: registration.brief,
    ...(child.kind === 'claude'
      ? {
          mcpConfigFile: registration.mcpConfig,
          ...(registration.claudeSettings ? { claudeSettingsFile: registration.claudeSettings } : {}),
          toolSource: registration.toolSource ?? { server: 'per-child' as const, suppressed: [], unchecked: `the Bellwether on machine ${child.host} predates this check, so a Bellwether plugin or server there may still add a second set of tools` },
        }
      : {}),
    ...(pi ? { piExtension: registration.piExtension } : {}),
    registered: true,
  };
}

export async function spawnChild(client: HerdrClient, parent: ParentRecord, options: SpawnOptions, signal?: AbortSignal, hooks: SpawnHooks = {}): Promise<SpawnResult> {
  const depth = parent.depth + 1;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const spawnerCeiling = options.spawnerCeiling ?? maxDepth;
  if (depth > spawnerCeiling) throw new Error(tooDeep(parent, spawnerCeiling, options.name));

  // Refused before the record, so a wrong route or half a pair leaves nothing behind.
  const routes = routesFor(options.via);
  const resolved = resolveRoute({ name: options.name, kind: options.kind, via: options.via, model: options.model, keyFile: options.keyFile, host: options.host }, routes);
  if (resolved.route && options.provider) throw new Error(`${options.name} was not started: provider applies to a bare pi start, and on route ${resolved.route.name} the tier picks the model. Drop provider, or pass via ${BARE}.`);
  // On a route the tier goes to the launcher, so the harness gets no model of its own.
  const harnessOptions: SpawnOptions = { ...options, model: resolved.harnessModel };
  const chosen = resolved.route ? undefined : chooseChildModel(harnessOptions);
  const launchVia = resolved.route ? { route: resolved.route, config: routeConfig(routes, resolved.route, options.name) } : undefined;
  // The workspace is settled before the record too, so a name that matches
  // nothing leaves nothing behind. Nothing is created yet.
  const host = options.host ?? LOCAL_HOST;
  const placement = await placeChild({
    workspace: options.workspace,
    label: options.workspaceLabel,
    childName: options.name,
    host,
    parentWorkspaceId: parent.workspaceId,
    childWorkspaces: async () => parseWorkspaces(await client.workspaceList(signal)),
    localWorkspaces: hooks.localWorkspaces,
  });
  const now = new Date().toISOString();
  const child: ChildRecord = {
    ...(chosen ? { model: chosen } : {}),
    ...(resolved.route ? { route: resolved.route } : {}),
    id: newChildId(),
    name: options.name,
    kind: options.kind,
    harness: harnessOf(options.kind),
    paneId: '',
    host,
    origin: 'spawn',
    cwd: options.cwd,
    startedAt: now,
    lastStatus: 'unknown',
    statusChangedAt: now,
    lastBusyAt: now,
    depth,
    maxDepth,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
    inactiveMs: resolveInactiveMs(options.inactiveMinutes),
  };
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, child);

  let opened: ChildTab | undefined;
  let startup: StartupWatch | undefined;
  let reportWarning: string | undefined;
  let registered = false;
  try {
    const files = await childStartFiles(child, options.prompt || undefined, hooks.registerRemote, hooks.piExtension);
    const { briefFile, mcpConfigFile, claudeSettingsFile, piExtension } = files;
    registered = files.registered;
    reportWarning = files.warning;
    if (files.toolSource) child.toolSource = files.toolSource;

    // 2. The tab carries the environment the child needs to find its parent.
    const env = childEnv(parent, child, piExtension);
    // A new workspace is made on the child's machine, through that machine's
    // herdr, and the child runs in its root pane, so it holds no empty shell.
    const tab = await openChildTab(client, placement, { cwd: options.cwd, label: child.name, env, focus: options.focus ?? false }, signal);
    opened = tab;
    if (!tab.paneId) throw new Error('herdr created no pane for the child tab');

    child.tabId = tab.tabId;
    child.paneId = tab.paneId;
    child.workspaceId = tab.workspaceId;
    if (tab.workspaceLabel) child.workspaceLabel = tab.workspaceLabel;
    if (tab.ownsWorkspace) child.ownsWorkspace = true;
    // Claude Code opens on dialogs the spawn answers, so the watcher holds the
    // child's events until then, and the status watch opens before the start.
    if (options.kind === 'claude') {
      const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      child.startingUntil = new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString();
      startup = await watchStartup(client, tab.paneId, signal, { timeoutMs, redrawMs: options.redrawMs });
    }
    upsertChild(parent.id, child);

    // 3. Start the harness in the tab's root pane. A tab answers tab.create
    // before its shell is at a prompt, so herdr refuses the start with
    // agent_pane_busy until the shell is ready.
    const args = childArgs(options.kind, { ...harnessOptions, ...(chosen ? { provider: chosen.provider, model: chosen.id } : {}) }, { briefFile, mcpConfigFile, claudeSettingsFile, piExtension });
    await startHarness(client, { name: child.name, kind: options.kind, paneId: tab.paneId, args, ...(launchVia ? { launch: routeLaunch(launchVia.config, launchVia.route, options.kind, args) } : {}) }, signal);
  } catch (error) {
    startup?.close();
    await abandon(client, parent.id, child, opened, hooks, registered);
    throw error;
  }

  // 4. Answer the startup dialogs, then let the watcher read the child. The
  // spawn answers yes to the folder-trust question for any folder, because
  // the operator approves every spawn by default. A child still on a dialog
  // when the wait runs out is undone, and the error names the dialog.
  let answered: StartupDialog[] | undefined;
  if (startup) {
    try {
      answered = await startup.answer();
    } catch (error) {
      startup.close();
      await abandon(client, parent.id, child, opened, hooks, registered);
      throw error;
    }
    startup.close();
  }

  // 5. Record the session and transcript, then hand back the child and its
  // herdr link. The registry is re-read rather than written from the caller's
  // copy, which would erase the child record that upsertChild just added.
  if (!startup) await new Promise((resolve) => setTimeout(resolve, 750));
  try {
    const result = await client.request('agent.get', { target: child.paneId }, { signal });
    const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
    const pane = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>) : {};
    const session = sessionFrom(pane['agent_session']);
    if (session) {
      child.session = session;
      // A remote child's transcript sits on its own machine's disk.
      if (child.host === LOCAL_HOST) {
        // Claude Code writes its file at the first turn, which can come after
        // this look. The watcher looks again until the file appears.
        const found = locateTranscript(child.harness, session.value, child.cwd);
        child.transcript = found.path;
        child.transcriptMissing = found.missing;
        // With no pair passed, the session file says which default pi chose.
        const fromSession = !child.model && child.kind === 'pi' && found.path ? piSessionModel(found.path) : undefined;
        if (fromSession) child.model = { ...fromSession, source: 'session' };
      }
    }
    const status = pane['agent_status'];
    if (typeof status === 'string' && status) child.lastStatus = status as ChildRecord['lastStatus'];
    child.agentName = agentNameOf(pane, child.name);
  } catch {
    // A missed session id only costs the transcript-based summary until the
    // watcher reads it.
  }
  child.startingUntil = undefined;
  updateChild(parent.id, child.id, (entry) => {
    if (child.session) entry.session = child.session;
    if (child.agentName) entry.agentName = child.agentName;
    if (child.model && !entry.model) entry.model = child.model;
    if (child.transcript) {
      entry.transcript = child.transcript;
      delete entry.transcriptMissing;
    } else if (child.transcriptMissing) entry.transcriptMissing = child.transcriptMissing;
    if (entry.lastStatus !== child.lastStatus) entry.statusChangedAt = new Date().toISOString();
    entry.lastStatus = child.lastStatus;
    // The hold ends with the answers, which are activity. The inactivity clock
    // starts here, not at spawn time, so a long dialog does not eat the window.
    if (startup) entry.lastBusyAt = new Date().toISOString();
    delete entry.startingUntil;
  });

  const note = modelNote(child);
  return { child, link: herdrLink('pane', child.paneId), answered, ...(note ? { modelNote: note } : {}), ...(reportWarning ? { reportWarning } : {}) };
}

/**
 * Undo a spawn that never produced a running child. The record goes first, so
 * the watcher finds no child when the tab-closed event arrives and the parent
 * hears nothing about a child that never ran.
 */
async function abandon(client: HerdrClient, parentId: string, child: ChildRecord, opened: ChildTab | undefined, hooks: SpawnHooks, registered: boolean): Promise<void> {
  removeChild(parentId, child.id);
  hooks.forget?.(child.id);
  removeChildFiles(child.id);
  // A workspace the spawn created goes with the tab; any other keeps its tabs.
  await undoChildTab(client, opened);
  // The brief and config on the child's machine go too. A failed hop leaves
  // them for that machine's week-old prune, as nothing else can reach them.
  if (registered) await hooks.cleanupRemote?.(child).catch(() => {});
}

/**
 * Write a Claude Code child's start files on this machine: its MCP
 * configuration, and its settings, with the Notification hook that reports
 * its dialogs and whatever keeps another Bellwether server in its environment
 * from adding a second set of tools. A server and the hook talk to the daemon
 * on their own machine, so a child on another machine gets the files its own
 * machine writes when the spawn registers it there, without the hook: only a
 * local child's record lives in this daemon, and a remote child's dialogs are
 * read off the screen.
 */
export function childToolFiles(child: Pick<ChildRecord, 'id' | 'kind' | 'host' | 'cwd'>): ChildToolFiles | undefined {
  if (child.kind !== 'claude' || (child.host ?? LOCAL_HOST) !== LOCAL_HOST) return undefined;
  return writeChildToolFiles(child.id, child.cwd, { hook: true });
}

/** The launch fields for a child's tool files. */
function toolLaunch(tools: ChildToolFiles | undefined): Pick<ChildStartFiles, 'mcpConfigFile' | 'claudeSettingsFile' | 'toolSource'> {
  if (!tools) return {};
  return { mcpConfigFile: tools.mcpConfig, ...(tools.claudeSettings ? { claudeSettingsFile: tools.claudeSettings } : {}), toolSource: tools.toolSource };
}

/**
 * Why a Claude Code child on another machine is not started without its own
 * server. Only that server carries the child id. A Bellwether plugin or server
 * that the machine loads on its own has no id, so the child's parent_report
 * would reach no parent, and a child that cannot report is not started.
 */
function withoutIdentity(child: Pick<ChildRecord, 'name' | 'host'>, cause: string): string {
  return `${child.name} was not started on machine ${child.host}: ${cause}, so it would have no Bellwether server that carries its child id. Any other Bellwether server there lacks that id, and the child's parent_report would reach no parent. Fix the registration (\`bellwether doctor\` on that machine) and spawn again.`;
}

/**
 * The environment a child's tab carries, so the child can find its parent. A
 * pi child's tab also names the extension it starts with, so another copy of
 * the extension in the same session stands down.
 */
export function childEnv(parent: ParentRecord, child: ChildRecord, piExtension?: string): Record<string, string> {
  return {
    BELLWETHER_PARENT: parent.id,
    BELLWETHER_CHILD: child.id,
    BELLWETHER_CHILD_NAME: child.name,
    BELLWETHER_DEPTH: String(child.depth),
    ...(child.maxDepth === undefined ? {} : { BELLWETHER_MAX_DEPTH: String(child.maxDepth) }),
    BELLWETHER_HARNESS: child.harness,
    ...(piExtension ? { [PI_EXTENSION_ENV]: piExtension } : {}),
  };
}

/**
 * This machine's routes, for a request. A broken routes file stops a start
 * that names a route, and the error names the file. A bare start goes on
 * without it, because it needs the file only to catch a tier passed without via.
 */
export function routesFor(via: string | undefined): RoutesFile {
  try {
    return readRoutes();
  } catch (error) {
    if (via && via !== BARE) throw error;
    if (error instanceof RoutesFileError) return { file: '', routes: {} };
    throw error;
  }
}

/** What a resume or restart asks to change about how a child starts. */
export interface RouteChange {
  /** A route name, `none` to leave a route, or undefined to keep the child's. */
  via?: string;
  /** The tier on a route, or the harness's model on a bare start. */
  model?: string;
  /** A key file for the route. Without one, a child that stays on its route keeps the key file it had. */
  keyFile?: string;
  /** The pi provider for a bare pi start. */
  provider?: string;
}

/** How a resumed or restarted child starts. */
export interface NextLaunch {
  /** The route it starts on, or undefined for a bare start. */
  route?: ChildRoute;
  config?: RouteConfig;
  /** The harness's own model on a bare start. */
  harnessModel?: string;
  /** The pi provider on a bare start. */
  provider?: string;
}

/**
 * Decide the route a resume or restart starts a child on. A call that names
 * no route keeps the child's, with its tier and key file, so a resume never
 * drops a route without being asked. `via: none` leaves the route, and a route
 * name moves the child onto that route. The session stays the same either way:
 * only the launcher in front of the harness changes.
 */
export function nextLaunch(child: Pick<ChildRecord, 'name' | 'kind' | 'host' | 'route' | 'model'>, change: RouteChange, verb: string): NextLaunch {
  const via = change.via?.trim() || child.route?.name;
  const staying = via !== undefined && via === child.route?.name;
  const routes = routesFor(via);
  const resolved = resolveRoute(
    {
      name: child.name,
      kind: child.kind,
      via,
      model: change.model ?? (staying ? child.route?.tier : undefined),
      keyFile: change.keyFile ?? (staying ? child.route?.keyFile : undefined),
      host: child.host,
      verb,
    },
    routes,
  );
  if (resolved.route) {
    if (change.provider) throw new Error(`${child.name} was not ${verb}: provider applies to a bare pi start, and on route ${resolved.route.name} the tier picks the model. Drop provider, or pass via ${BARE}.`);
    return { route: resolved.route, config: routeConfig(routes, resolved.route, child.name) };
  }
  if (child.kind !== 'pi') return resolved.harnessModel ? { harnessModel: resolved.harnessModel } : {};
  // A pi session records its provider, so a pi child that leaves a route needs
  // a provider the bare pi can reach, and Bellwether does not guess one.
  const provider = change.provider ?? (change.model ? undefined : child.model?.provider);
  const model = resolved.harnessModel ?? (change.provider ? undefined : child.model?.id);
  if (child.route && !(provider && model)) {
    throw new Error(`${child.name} was not ${verb}: it ran on route ${child.route.name}, and its pi session names that route's provider, which a bare pi cannot reach. Pass model and provider for the bare start, or keep the route.`);
  }
  if (provider && !model) throw new Error(`${child.name} was not ${verb}: pi needs a model with the provider ${provider}. Pass model too.`);
  if (model && !provider) throw new Error(`${child.name} was not ${verb}: pi needs a provider with the model ${model}. Pass provider too.`);
  return model && provider ? { harnessModel: model, provider } : {};
}

/** How long a routed start waits for herdr to detect the harness behind the launcher. */
export const ROUTED_START_MS = 30_000;

export interface HarnessStart {
  name: string;
  kind: string;
  paneId: string;
  /** The harness's own arguments. */
  args: string[];
  /** The route's launch, when the child starts through one. Without it, herdr starts the harness bare. */
  launch?: RouteLaunch;
  /** How long a routed start waits for the harness. Tests shorten it. */
  timeoutMs?: number;
}

/**
 * Start a child's harness in a pane that sits at its shell prompt: bare with
 * herdr's agent.start, or through a route's launcher.
 */
export async function startHarness(client: HerdrClient, params: HarnessStart, signal?: AbortSignal): Promise<void> {
  if (!params.launch) {
    await startWithRetry(client, { name: params.name, kind: params.kind, paneId: params.paneId, args: params.args }, signal);
    return;
  }
  const launch = params.launch;
  const timeoutMs = params.timeoutMs ?? ROUTED_START_MS;
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let detected!: () => void;
  const seen = new Promise<void>((resolve) => {
    detected = resolve;
  });
  // The watch opens before the line is typed, so the detection cannot slip past it.
  const subscription = await client.subscribe(
    [{ type: 'pane.agent_detected', pane_id: params.paneId }],
    (event) => {
      if (event.data['pane_id'] !== params.paneId) return;
      const agent = event.data['agent'];
      if (agent === undefined || agent === null || agent === params.kind) detected();
    },
    controller.signal,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    // TODO(api): herdr's agent.start runs only a kind's own executable, so a
    // launcher in front of the harness has to be typed at the shell prompt of
    // the pane this spawn just created. An agent.start that took a launcher
    // argv prefix and environment read from files would retire this input.
    await client.sendInput(params.paneId, launchLine(launch), ['Enter'], signal);
    await Promise.race([
      seen,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`herdr detected no ${params.kind} in pane ${params.paneId} within ${Math.round(timeoutMs / 1000)} s of starting it through ${launch.argv[0]}. Check that the launcher runs ${params.kind} on this machine.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    subscription.close();
    controller.abort();
  }
  // agent.start names the agent; a typed start has to name it after herdr finds it.
  await client.agentRename(params.paneId, params.name, signal).catch(() => {});
}

/** herdr refuses a start until the new tab's shell reaches its prompt. */
const PANE_NOT_READY = new Set(['agent_pane_busy', 'agent_pane_not_ready', 'pane_busy']);

export async function startWithRetry(
  client: HerdrClient,
  params: { name: string; kind: string; paneId: string; args: string[]; timeoutMs?: number },
  signal?: AbortSignal,
  totalMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + totalMs;
  let delay = 400;
  for (;;) {
    try {
      await client.agentStart(params, signal);
      return;
    } catch (error) {
      const code = error instanceof HerdrApiError ? error.code : undefined;
      if (!code || !PANE_NOT_READY.has(code) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 4_000);
    }
  }
}

export function herdrLink(kind: 'pane' | 'tab' | 'workspace' | 'agent', id: string): string {
  const fingerprint = process.env['HERDR_ENV'] === '1' ? '' : '';
  return `https://herdr.invalid/v1/${fingerprint}${kind}/${id}`;
}

export function hostName(): string {
  return os.hostname();
}
