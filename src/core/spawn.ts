// Starting a child. The order follows the design: write the registry record
// first, then create the tab with the Bellwether environment, then ask herdr
// to start the harness in the tab's root pane, then watch the new pane.
import os from 'node:os';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { BLANK_SCREEN } from './screen.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { PI_EXTENSION_ENV } from './pi-extension.ts';
import { writeBrief, writeBriefIn } from './brief.ts';
import { deliverBrief, deliveryNote } from './brief-delivery.ts';
import { BRIEF_SESSION_WAIT_MS, type Inbox } from './send.ts';
import { promptPath } from './paths.ts';
import { DEFAULT_MAX_DEPTH, tooDeep } from './depth.ts';
import { droppedNote, type DroppedVariable } from './relay-env.ts';
import { resolveInactiveMs } from './inactivity.ts';
import { removeChildFiles } from './mcp-config.ts';
import { argValue } from './args.ts';
import { requireHarness, spawnRefusal, type ChildFiles, type HarnessEntry, type HarnessHooks } from './harnesses/index.ts';
import { recordDecisions, removeChild, updateChild, upsertChild } from './registry.ts';
import { detectRefused, StartupDialogRefused, watchStartup, type StartupDialog, type StartupWatch } from './startup-dialogs.ts';
import { agentNameOf, sessionFrom } from './transcript.ts';
import { fatalLine, ForegroundTracker, HarnessStartFailed, processInfoOf, startupQuote, type StartOutcome } from './start-check.ts';
import type { RemoteRegistration } from './remote.ts';
import { BARE, RoutesFileError, bareLaunch, launchLine, readRoutes, resolveRoute, routeConfig, routeLaunch, type RouteConfig, type RouteLaunch, type RoutesFile } from './routes.ts';
import { openChildTab, parseWorkspaces, placeChild, undoChildTab, type ChildTab, type WorkspaceEntry } from './workspace.ts';
import type { ChildRecord, ChildRoute, DialogDecision, ModelPair, ParentRecord } from './types.ts';

/** How deep a Bellwether child may spawn. The design starts at 2. */
export { DEFAULT_MAX_DEPTH } from './depth.ts';

export { harnessOf } from './harnesses/index.ts';
export { argValue } from './args.ts';

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
  /** Paths the child reads beside its working directory and the Bellwether home, checked by `checkReads`. */
  reads?: string[];
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
  /** How long the start waits for the first status of a harness that can stop on a fatal error. Tests shorten it. */
  confirmMs?: number;
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
  /** What the child's harness entry says about how it was started, for the spawn reply. */
  harnessNote?: string;
  /** The variables the child's machine left out of its tab, by name and reason, for the spawn reply. */
  envNote?: string;
  link: string;
  /** The startup dialogs the spawn answered, in order. */
  answered?: StartupDialog[];
  /** The answers that decided something, which the reply gives the parent. They are on the record, marked told. */
  decisions?: DialogDecision[];
  /** Why the spawn could not confirm the child took its brief, for the spawn reply. */
  startNote?: string;
  /** Which path carried the brief, for the spawn reply. */
  briefNote?: string;
}

/** How long the watcher holds the events of a new child that shows startup dialogs. Longer than the dialog wait. */
export const STARTUP_HOLD_MS = 45_000;

/** How long the spawn waits for a child to get past its startup dialogs. */
export const STARTUP_TIMEOUT_MS = 30_000;

/**
 * The arguments a child harness starts with, from its registry entry. The
 * brief text is never one of them. A harness whose entry has a launch prompt
 * gets one line that points at the brief file; any other gets no brief on its
 * launch line, and the start sends the brief as a message once it runs.
 */
export function childArgs(kind: string, options: Pick<SpawnOptions, 'model' | 'provider' | 'args'>, files: ChildFiles = {}, extra: { session?: ChildRecord['session']; resume?: string[] } = {}): string[] {
  const entry = requireHarness(kind);
  const { briefFile: _brief, ...withoutBrief } = files;
  return entry.launchArgs({ model: options.model, provider: options.provider, extra: options.args, files: entry.brief.launch ? files : withoutBrief, ...extra });
}

/** How long the watcher holds a new child's events while its brief waits for the session, beyond the wait itself. */
const BRIEF_HOLD_MS = BRIEF_SESSION_WAIT_MS + 20_000;

/**
 * The provider and model a pi child starts with. A caller that names both
 * wins, in the spawn's fields or in its extra arguments. Half a pair is
 * refused, because pi would pair it with whatever provider it defaults to.
 * With neither named, the child inherits the parent's pair. With the parent's
 * pair unknown too, no flag is passed and pi picks its own default.
 */
export function chooseChildModel(options: Pick<SpawnOptions, 'kind' | 'name' | 'model' | 'provider' | 'args' | 'parentModel'>): (ModelPair & { source: 'caller' | 'parent' }) | undefined {
  if (requireHarness(options.kind).chosenBy !== 'pair') {
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

/** The line of a spawn reply that says which model the child runs on, when its harness has one to say. */
export function modelNote(child: Pick<ChildRecord, 'name' | 'kind' | 'model' | 'host' | 'cwd'>): string | undefined {
  return requireHarness(child.kind).modelNote?.(child);
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
  /** How a harness with a store of its own is checked and found. Tests point it at a fixture store and a scripted version. */
  harness?: HarnessHooks;
  /** The daemon's way into the child's session, which carries its brief. Without it, the brief is typed into the pane. */
  inbox?: Inbox;
  /** Who sends the brief, as the child reads it. */
  from?: string;
}

/** The files a child starts with, wherever it runs. */
export interface ChildStartFiles extends ChildFiles {
  /** Whether the child's machine holds files that must go with the child. */
  registered: boolean;
  /** The variables of the harness entry that the child's machine left out of its tab. */
  envDropped?: DroppedVariable[];
}

/**
 * Write the files a child starts with, on the machine it runs on, as its
 * harness's entry says. A child on this machine gets them here: its tool
 * files first, so a missing pi extension writes nothing, then its brief. A
 * child on another machine is registered there first, and that machine
 * writes them: its brief arrives over the SSH transport, on standard input,
 * so the harness is pointed at a file that exists where it runs. The
 * environment the entry gives the tab comes back from that machine in the same
 * registration, computed there. A child
 * whose brief or tools cannot be set up is not started, because it would run
 * with no task or no way to report: this throws.
 *
 * Every brief also lands in this machine's prompts directory under its number
 * (`promptPath(child.id, briefNumber)`), wherever the harness reads it, so a
 * person and a later resume find each one the child was given.
 */
export async function childStartFiles(parent: ParentRecord, child: ChildRecord, prompt: string | undefined, register?: RegisterRemote, piExtension?: () => string, model?: string, briefNumber = 1): Promise<ChildStartFiles> {
  const entry = requireHarness(child.kind);
  const reports = entry.reports;
  if (reports.via === 'none') throw new Error(spawnRefusal(entry, child.name));
  if ((child.host ?? LOCAL_HOST) === LOCAL_HOST) {
    const tools = reports.local(child, { env: childEnv(parent, child), model, piExtension });
    const history = prompt === undefined ? undefined : writeBrief(child.id, prompt, briefNumber);
    const briefFile = prompt === undefined ? undefined : entry.brief.where === 'workdir' && child.cwd ? writeBriefIn(child.cwd, child.id, prompt, briefNumber) : history;
    return { ...tools, ...(briefFile ? { briefFile } : {}), registered: false };
  }
  if (!reports.remote) throw new Error(`${child.name} was not started on machine ${child.host}: ${reports.remoteRefusal ?? `Bellwether cannot give a ${entry.kind} child on another machine its tools`}. Omit machine.`);
  const needsExtension = reports.remote === 'piExtension';
  if (!register) {
    if (needsExtension) throw new Error(`${child.name} was not started on machine ${child.host}: this session cannot register children there, so Bellwether cannot name the ${entry.label} extension it would load.`);
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}: this session cannot register children there, so its brief cannot reach that machine.`);
    throw new Error(withoutIdentity(child, 'this session cannot register children there'));
  }
  let registration: RemoteRegistration;
  try {
    registration = await register(child, prompt);
  } catch (error) {
    if (needsExtension) throw new Error(`${child.name} was not started on machine ${child.host}, because Bellwether could not register it there to name the ${entry.label} extension it would load: ${(error as Error).message}`);
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}, because its brief could not be copied there: ${(error as Error).message}`);
    throw new Error(withoutIdentity(child, `Bellwether could not register it there: ${(error as Error).message}`));
  }
  if (prompt !== undefined) writeBrief(child.id, prompt, briefNumber);
  return {
    ...(registration.brief ? { briefFile: registration.brief } : {}),
    ...(reports.remote === 'mcpConfig'
      ? {
          mcpConfigFile: registration.mcpConfig,
          ...(registration.claudeSettings ? { claudeSettingsFile: registration.claudeSettings } : {}),
          toolSource: registration.toolSource ?? { server: 'per-child' as const, suppressed: [], unchecked: `the Bellwether on machine ${child.host} predates this check, so a Bellwether plugin or server there may still add a second set of tools` },
        }
      : {}),
    ...(needsExtension && registration.piExtension ? { piExtension: registration.piExtension } : {}),
    ...(registration.env && Object.keys(registration.env).length ? { env: registration.env } : {}),
    ...(registration.envDropped?.length ? { envDropped: registration.envDropped } : {}),
    registered: true,
  };
}

/** Why a child of this harness cannot take `reads`. */
export function readsRefusal(entry: Pick<HarnessEntry, 'label'>, name: string): string {
  return `${name} was not started: reads lists paths for the child's launch settings, and a ${entry.label} child's launch takes no read set. Drop reads, or name the paths in the brief.`;
}

/**
 * Refuse a spawn of a kind whose child could not report, or whose harness
 * says it cannot work here, before anything is written.
 */
async function checkHarness(entry: HarnessEntry, options: SpawnOptions, model: string | undefined, hooks: HarnessHooks, herdr: HerdrClient): Promise<void> {
  const refused = spawnRefusal(entry, options.name);
  if (refused) throw new Error(refused);
  if (options.reads?.length && !entry.launchReads) throw new Error(readsRefusal(entry, options.name));
  await entry.preflight?.({ name: options.name, cwd: options.cwd, model, host: options.host ?? LOCAL_HOST, herdr, args: options.args ?? [] }, hooks);
}

export async function spawnChild(client: HerdrClient, parent: ParentRecord, options: SpawnOptions, signal?: AbortSignal, hooks: SpawnHooks = {}): Promise<SpawnResult> {
  const depth = parent.depth + 1;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const spawnerCeiling = options.spawnerCeiling ?? maxDepth;
  if (depth > spawnerCeiling) throw new Error(tooDeep(parent, spawnerCeiling, options.name));

  // Refused before the record, so a wrong route or half a pair leaves nothing behind.
  const entry = requireHarness(options.kind);
  const routes = routesFor(options.via);
  const resolved = resolveRoute({ name: options.name, kind: options.kind, via: options.via, model: options.model, keyFile: options.keyFile, host: options.host }, routes);
  if (resolved.route && options.provider) throw new Error(`${options.name} was not started: provider applies to a bare pi start, and on route ${resolved.route.name} the tier picks the model. Drop provider, or pass via ${BARE}.`);
  // On a route the tier goes to the launcher, so the harness gets no model of its own.
  const harnessOptions: SpawnOptions = { ...options, model: resolved.harnessModel };
  const chosen = resolved.route ? undefined : chooseChildModel(harnessOptions);
  const launchVia = resolved.route ? { route: resolved.route, config: routeConfig(routes, resolved.route, options.name) } : undefined;
  const harnessHooks = hooks.harness ?? {};
  const store = entry.session.from === 'store' ? entry.session : undefined;
  // On a route the tier picks the model, so the check sees the model the harness itself gets.
  await checkHarness(entry, options, harnessOptions.model, harnessHooks, client);
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
  const id = newChildId();
  const child: ChildRecord = {
    ...(chosen ? { model: chosen } : {}),
    ...(resolved.route ? { route: resolved.route } : {}),
    id,
    name: options.name,
    kind: options.kind,
    harness: entry.harness,
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
    ...(options.reads?.length ? { reads: options.reads } : {}),
    inactiveMs: resolveInactiveMs(options.inactiveMinutes),
    // The record names the brief's file, so a resume can tell whether the child read it.
    ...(options.prompt ? { briefs: [{ n: 1, file: promptPath(id), at: now }] } : {}),
    // herdr reports no session for a harness with a store of its own, so the spawn names it.
    // A harness that takes a session id on its launch line gets one minted here.
    ...(store ? { ...(store.mint ? { session: { kind: 'id' as const, value: store.mint() } } : {}), store: store.storePath(harnessHooks, { id }) } : {}),
  };
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, child);

  let opened: ChildTab | undefined;
  let startup: StartupWatch | undefined;
  let registered = false;
  let keptBrief: string | undefined;
  let envNote: string | undefined;
  let started: StartOutcome = { confirmed: true };
  let briefNote: string | undefined;
  try {
    const { registered: there, envDropped, ...files } = await childStartFiles(parent, child, options.prompt || undefined, hooks.registerRemote, hooks.piExtension, harnessOptions.model);
    const { briefFile } = files;
    registered = there;
    envNote = droppedNote(child.name, host, envDropped);
    if (files.toolSource) child.toolSource = files.toolSource;
    keptBrief = store ? briefFile : undefined;

    // 2. The tab carries the environment the child needs to find its parent,
    // and whatever its harness's tool files add.
    const env = { ...childEnv(parent, child, files.piExtension), ...files.env };
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
    for (const brief of child.briefs ?? []) brief.paneId = tab.paneId;
    // A harness that opens on dialogs the spawn answers, such as Claude Code,
    // has its events held until then, and the status watch opens before the start.
    if (entry.startup) {
      const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      child.startingUntil = new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString();
      startup = await watchStartup(client, tab.paneId, signal, { timeoutMs, redrawMs: options.redrawMs, dialogs: entry.startup });
    }
    // A harness that can stop on a fatal error is held the same way while the
    // start waits for its first status, so the parent hears no idle event
    // from a child whose spawn then fails.
    if (entry.startupFatal && !child.startingUntil) child.startingUntil = new Date(Date.now() + ROUTED_START_MS + START_CONFIRM_MS + 15_000).toISOString();
    upsertChild(parent.id, child);

    // 3. Start the harness in the tab's root pane. A tab answers tab.create
    // before its shell is at a prompt, so herdr refuses the start with
    // agent_pane_busy until the shell is ready.
    const args = childArgs(options.kind, { ...harnessOptions, ...(chosen ? { provider: chosen.provider, model: chosen.id } : {}) }, files, { session: child.session });
    started = await startHarness(client, { name: child.name, kind: options.kind, paneId: tab.paneId, args, ...(entry.startupFatal ? { fatal: entry.startupFatal, confirmMs: options.confirmMs } : {}), ...(launchVia ? { launch: routeLaunch(launchVia.config, launchVia.route, options.kind, args) } : {}) }, signal);

    // The harness's store is the only proof the brief arrived when herdr
    // reports no session for it. A harness that takes a session id was given
    // the minted one; any other gets the id the store found. A session that
    // never shows fails the spawn, which keeps the brief so a person can see
    // what the child was given.
    if (store && child.store && briefFile && child.cwd) {
      try {
        const found = await store.confirm({ store: child.store, ...(child.session ? { session: child.session.value } : {}), cwd: child.cwd, briefFile, since: child.startedAt }, harnessHooks);
        child.session = { kind: 'id', value: found };
        // The store showing the prompt is the acknowledgement for a harness
        // that takes no message in its session.
        const first = child.briefs?.find((brief) => brief.n === 1);
        if (first && entry.brief.launch) {
          first.delivery = { path: 'launch', reason: `${entry.inbox.via === 'none' ? entry.inbox.reason : `${entry.label} takes its first prompt on its launch line`}, and its own store showed the session with that prompt`, at: new Date().toISOString() };
          briefNote = deliveryNote(child, first, first.delivery);
        }
        upsertChild(parent.id, child);
      } catch (error) {
        // herdr can read a pane as idle while the harness waits on a dialog
        // its entry refuses, so no status says why the store stayed empty.
        // TODO(api): herdr's status does not name the dialog that holds a
        // pane, and a harness may record nothing of such a dialog. A status that
        // named the dialog, or a harness event for it, would retire this read.
        const screen = entry.startup?.refuse?.length ? (await client.paneRead({ paneId: tab.paneId, source: 'visible', lines: 40 }, signal).catch(() => BLANK_SCREEN)).plain : '';
        const refused = entry.startup && screen ? detectRefused(screen, entry.startup) : undefined;
        const tail = `The brief stays at ${briefFile} for inspection, and the pane is closed.`;
        if (refused) throw new StartupDialogRefused(`${child.name} was not started: ${entry.startup?.harness} stopped on ${refused.name}, which Bellwether never answers: ${refused.why} ${tail}`, refused.id);
        throw new Error(`${child.name} was not started: ${(error as Error).message} ${tail}`);
      }
    }
  } catch (error) {
    startup?.close();
    await abandon(client, parent.id, child, opened, hooks, registered, keptBrief);
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
      recordDecisions(parent.id, child.id, startup.decisions, true);
    } catch (error) {
      startup.close();
      await abandon(client, parent.id, child, opened, hooks, registered);
      throw error;
    }
    startup.close();
  }

  // 4b. Hand over the brief, now that the harness runs and no startup dialog
  // stands between it and a message: through the child's session, or typed
  // into its pane when that path is not available. A harness that exits
  // before it takes the brief fails the spawn. The watcher holds the child's
  // events meanwhile, so a child idle at its prompt is not reported as done.
  const first = child.briefs?.find((brief) => brief.n === 1);
  if (options.prompt && first && !entry.brief.launch) {
    child.startingUntil = new Date(Date.now() + BRIEF_HOLD_MS).toISOString();
    updateChild(parent.id, child.id, (record) => {
      record.startingUntil = child.startingUntil;
    });
    try {
      const handed = await deliverBrief({ herdr: client, parentId: parent.id, child, brief: first, text: options.prompt, from: hooks.from ?? parent.id, inbox: hooks.inbox, fatal: entry.startupFatal, signal });
      first.delivery = handed.delivery;
      briefNote = handed.note;
    } catch (error) {
      await abandon(client, parent.id, child, opened, hooks, registered);
      throw error;
    }
  }

  // 5. Record the session and transcript, then hand back the child and its
  // herdr link. The registry is re-read rather than written from the caller's
  // copy, which would erase the child record that upsertChild just added.
  if (!startup) await new Promise((resolve) => setTimeout(resolve, 750));
  try {
    const result = await client.request('agent.get', { target: child.paneId }, { signal });
    const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
    const pane = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>) : {};
    // A child whose session its store showed keeps that one, and its
    // transcript is looked up the same way as a session herdr reports.
    const session = child.session ?? sessionFrom(pane['agent_session']);
    if (session) {
      child.session = session;
      // A remote child's transcript sits on its own machine's disk.
      if (child.host === LOCAL_HOST) {
        // Claude Code writes its file at the first turn, which can come after
        // this look. The watcher looks again until the file appears.
        const found = entry.conversation.locate(session.value, child.cwd);
        child.transcript = found.path;
        child.transcriptMissing = found.missing;
        // With no pair passed, the session file says which default the harness chose.
        const fromSession = !child.model && found.path ? entry.conversation.modelOf?.(found.path) : undefined;
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
  const harnessNote = entry.spawnNote?.(child, options.args ?? []);
  const decisions = startup?.decisions.length ? startup.decisions : undefined;
  const startNote = started.confirmed ? undefined : unconfirmedNote(child, entry.label, started.waitedMs);
  return { child, link: herdrLink('pane', child.paneId), answered, ...(decisions ? { decisions } : {}), ...(note ? { modelNote: note } : {}), ...(harnessNote ? { harnessNote } : {}), ...(envNote ? { envNote } : {}), ...(startNote ? { startNote } : {}), ...(briefNote ? { briefNote } : {}) };
}

/** What a spawn says of a child that was running but had not shown herdr a status when the wait ended. */
export function unconfirmedNote(child: Pick<ChildRecord, 'name'>, label: string, waitedMs: number): string {
  return `${child.name}'s ${label} was running but had not started a turn or reached its prompt ${Math.round(waitedMs / 1000)} s after the start, so Bellwether could not confirm that it took its brief. It may be slow rather than stuck: an exit or an idle event reaches this session as soon as herdr reports one.`;
}

/**
 * Undo a spawn that never produced a running child. The record goes first, so
 * the watcher finds no child when the tab-closed event arrives and the parent
 * hears nothing about a child that never ran.
 */
async function abandon(client: HerdrClient, parentId: string, child: ChildRecord, opened: ChildTab | undefined, hooks: SpawnHooks, registered: boolean, keepBrief?: string): Promise<void> {
  removeChild(parentId, child.id);
  hooks.forget?.(child.id);
  // A brief kept for inspection stays, and everything else goes.
  removeChildFiles(child.id, keepBrief ? undefined : child.cwd);
  // A workspace the spawn created goes with the tab; any other keeps its tabs.
  await undoChildTab(client, opened);
  // The brief and config on the child's machine go too. A failed hop leaves
  // them for that machine's week-old prune, as nothing else can reach them.
  if (registered) await hooks.cleanupRemote?.(child).catch(() => {});
}

/**
 * Why a child on another machine is not started without its own server.
 * Only that server carries the child id. A Bellwether plugin or server
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
  /**
   * The child's read set beside its working directory and the Bellwether
   * home, replacing the one it had. An empty list clears it. Undefined keeps it.
   */
  reads?: string[];
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
  if (requireHarness(child.kind).chosenBy !== 'pair') return resolved.harnessModel ? { harnessModel: resolved.harnessModel } : {};
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

/** How long a start waits for herdr to detect the harness it typed. */
export const ROUTED_START_MS = 30_000;

export interface HarnessStart {
  name: string;
  kind: string;
  paneId: string;
  /** The harness's own arguments. */
  args: string[];
  /** The route's launch, when the child starts through one. Without it, the harness starts bare. */
  launch?: RouteLaunch;
  /** How long a start waits for herdr to detect the harness. Tests shorten it. */
  timeoutMs?: number;
  /**
   * The line a harness prints when it stops at startup on an error it cannot
   * recover from. With it, the start waits for the first status and fails on
   * this line. From the harness's entry.
   */
  fatal?: RegExp;
  /** How long to wait for that first status. Tests shorten it. */
  confirmMs?: number;
}

/**
 * Start a child's harness in a pane that sits at its shell prompt, by typing
 * its launch line there: the route's launcher, or for a bare child the
 * harness's executable behind `command`. Either way the line, and not the
 * shell's startup files, decides the arguments the harness gets.
 */
export async function startHarness(client: HerdrClient, params: HarnessStart, signal?: AbortSignal): Promise<StartOutcome> {
  const launch = params.launch ?? bareLaunch(params.kind, params.args);
  const through = params.launch ? `through ${launch.argv[0]}` : `as \`command ${params.kind}\``;
  const timeoutMs = params.timeoutMs ?? ROUTED_START_MS;
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let detected = false;
  let released = false;
  let status: string | undefined;
  let wake: (() => void) | undefined;
  // The watch opens before the line is typed, so neither the detection nor
  // the first status can slip past it.
  const subscription = await client.subscribe(
    [
      { type: 'pane.agent_detected', pane_id: params.paneId },
      { type: 'pane.agent_status_changed', pane_id: params.paneId },
    ],
    (event) => {
      if (event.data['pane_id'] !== params.paneId) return;
      const value = event.data['agent_status'];
      const agent = event.data['agent'];
      if (typeof value === 'string' && value) {
        status = value;
        // A status for the harness's own kind shows herdr has detected it.
        if (agent === params.kind) detected = true;
      } else if (event.data['released'] === true) released = true;
      else {
        if (agent === undefined || agent === null || agent === params.kind) detected = true;
      }
      wake?.();
    },
    controller.signal,
  );
  /** Wait for the next event, or `ms`, whichever comes first. */
  const next = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });
  // Pane feature: a start that failed quotes the harness's own lines to the
  // parent that asked for the spawn, so it reads why without opening the pane.
  const quote = async (): Promise<string | undefined> => startupQuote((await client.paneRead({ paneId: params.paneId, source: 'visible', lines: 40 }, signal).catch(() => BLANK_SCREEN)).content, params.kind, params.fatal);
  const exited = async (when: string): Promise<HarnessStartFailed> => {
    const said = await quote();
    return new HarnessStartFailed(`${params.kind} in pane ${params.paneId} exited ${when}${said ? `, and printed: ${said}` : ', and printed nothing Bellwether could read'}`);
  };
  try {
    // TODO(api): herdr's agent.start types the kind's bare name at the shell
    // prompt, where a shell function or alias of that name runs in its place
    // (issue #133), and it takes no launcher. So the launch line is typed here,
    // at the prompt of the pane this spawn just created. An agent.start that
    // executed the harness itself, with a launcher argv prefix and environment
    // read from files, would retire this input.
    await client.sendInput(params.paneId, launchLine(launch), ['Enter'], signal);

    // 1. Until herdr detects the harness, the pane's foreground says whether
    // it runs. herdr sends no event for a program that ends inside a pane
    // whose shell stays, so the start asks pane.process_info every half
    // second, and only until detection or the deadline.
    const foreground = new ForegroundTracker();
    const deadline = Date.now() + timeoutMs;
    while (!detected && !controller.signal.aborted) {
      if (Date.now() >= deadline) {
        const info = processInfoOf(await client.request('pane.process_info', { pane_id: params.paneId }, { signal }).catch(() => undefined));
        if (foreground.exited(info) || (info && info.foregroundGroup === info.shellPid)) throw await exited(`before herdr detected it, within ${Math.round(timeoutMs / 1000)} s of starting it ${through}`);
        const check = params.launch ? `Check that the launcher runs ${params.kind} on this machine.` : `Check that ${params.kind} is on the PATH of this machine's login shell.`;
        throw new Error(`herdr detected no ${params.kind} in pane ${params.paneId} within ${Math.round(timeoutMs / 1000)} s of starting it ${through}. ${check}`);
      }
      await next(Math.min(PROCESS_CHECK_MS, deadline - Date.now()));
      if (detected) break;
      const info = processInfoOf(await client.request('pane.process_info', { pane_id: params.paneId }, { signal }).catch(() => undefined));
      if (foreground.exited(info)) throw await exited(`at startup, before herdr detected it`);
    }
    if (controller.signal.aborted) throw new Error(`the spawn was cancelled while ${params.kind} in pane ${params.paneId} was starting`);

    // 2. A harness that can stay up on a fatal error is confirmed by its
    // first status: working means it took its prompt.
    let outcome: StartOutcome = { confirmed: true };
    if (params.fatal) {
      const waitMs = params.confirmMs ?? START_CONFIRM_MS;
      const until = Date.now() + waitMs;
      status ??= await agentStatus(client, params.paneId, signal);
      for (;;) {
        if (released) throw await exited('right after it started');
        if (status === 'working') break;
        if (status === 'idle' || status === 'done') {
          // TODO(api): pi reports no startup error through an API: it prints
          // the error, stays at its prompt, and herdr calls it idle. An
          // extension event for a model pi cannot authenticate, or an exit
          // status, would retire this read.
          const screen = (await client.paneRead({ paneId: params.paneId, source: 'visible', lines: 40 }, signal).catch(() => BLANK_SCREEN)).content;
          const line = fatalLine(screen, params.fatal);
          if (line) throw new HarnessStartFailed(`${params.kind} in pane ${params.paneId} stopped at startup without taking its prompt, and printed: ${line}`);
          break;
        }
        if (Date.now() >= until || controller.signal.aborted) {
          outcome = { confirmed: false, waitedMs: waitMs };
          break;
        }
        await next(until - Date.now());
      }
    }

    // herdr gives an agent it detected no name, so a typed start names it. A
    // harness that already named itself, as a pi naming extension does, keeps
    // its own name, and the record keeps both.
    const named = await client.request('agent.get', { target: params.paneId }, { signal }).then(
      (result) => {
        const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
        const name = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>)['name'] : undefined;
        return typeof name === 'string' && name !== '';
      },
      () => false,
    );
    if (!named) await client.agentRename(params.paneId, params.name, signal).catch(() => {});
    return outcome;
  } finally {
    subscription.close();
    controller.abort();
  }
}

/** How often a start checks the pane's foreground until herdr detects the harness. */
const PROCESS_CHECK_MS = 500;

/** How long a start waits for the first status of a harness that can stop on a fatal error. */
export const START_CONFIRM_MS = 20_000;

/** The status herdr reports for the agent in a pane, if any. */
async function agentStatus(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await client.request('agent.get', { target: paneId }, { signal }).catch(() => undefined);
  const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
  const value = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>)['agent_status'] : undefined;
  return typeof value === 'string' && value && value !== 'unknown' ? value : undefined;
}

/** herdr refuses a start until the new tab's shell reaches its prompt. */
const PANE_NOT_READY = new Set(['agent_pane_busy', 'agent_pane_not_ready', 'pane_busy']);

/**
 * Start a harness with herdr's agent.start, which types its bare name at the
 * shell prompt. Only a parent session's restart uses it: that session is the
 * operator's own, so their shell function for the harness, and the flags it
 * adds, apply to it as they do when they start it by hand. A child starts
 * with startHarness.
 */
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
