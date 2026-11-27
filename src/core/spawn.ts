// Starting a child. The order follows the design: write the registry record
// first, then create the tab with the Bellwether environment, then ask herdr
// to start the harness in the tab's root pane, then watch the new pane.
import os from 'node:os';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { briefArgument, writeBrief } from './brief.ts';
import { resolveInactiveMs } from './inactivity.ts';
import { removeChildFiles, writeMcpConfig } from './mcp-config.ts';
import { removeChild, updateChild, upsertChild } from './registry.ts';
import { watchStartup, type StartupDialog, type StartupWatch } from './startup-dialogs.ts';
import { locateTranscript, sessionFrom } from './transcript.ts';
import type { RemoteRegistration } from './remote.ts';
import type { ChildRecord, Harness, ParentRecord } from './types.ts';

/** How deep a Bellwether child may spawn. The design starts at 2. */
export const DEFAULT_MAX_DEPTH = 2;

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
  /** The workspace to open the tab in. Defaults to the parent's own. */
  workspaceId?: string;
  /** How deep a child may itself spawn. */
  maxDepth?: number;
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

/**
 * The arguments a child harness starts with. The brief is never one of them:
 * `briefFile` names the private file that holds it, and the harness gets a
 * one-line pointer to that file. `mcpConfigFile` names a Claude Code child's
 * own Bellwether server.
 */
export function childArgs(kind: string, options: SpawnOptions, briefFile?: string, mcpConfigFile?: string): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  // --mcp-config is a list flag too, so it takes the equals form for the same reason.
  if (kind === 'claude' && mcpConfigFile) args.push(`--mcp-config=${mcpConfigFile}`);
  // Claude Code reads this flag as a list and keeps taking values until the
  // next flag, so the two-argument form swallowed the prompt that follows it.
  // The equals form pins the flag to one value.
  if (kind === 'claude') args.push('--dangerously-load-development-channels=server:bellwether');
  if (briefFile) args.push(briefArgument(kind, briefFile));
  if (options.args?.length) args.push(...options.args);
  return args;
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
}

/** The files a child starts with, wherever it runs, and what its spawn reply should warn about. */
export interface ChildStartFiles {
  /** The brief's path on the child's own machine. */
  briefFile?: string;
  /** The MCP config's path on the child's own machine. */
  mcpConfigFile?: string;
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
 * child, and the warning says why its reports cannot arrive.
 */
export async function childStartFiles(child: ChildRecord, prompt: string | undefined, register?: RegisterRemote): Promise<ChildStartFiles> {
  if ((child.host ?? LOCAL_HOST) === LOCAL_HOST) {
    return { briefFile: prompt !== undefined ? writeBrief(child.id, prompt) : undefined, mcpConfigFile: childMcpConfig(child), registered: false };
  }
  const reports = child.harness === 'claude-code' || child.harness === 'pi';
  if (!reports && prompt === undefined) return { registered: false };
  if (!register) {
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}: this session cannot register children there, so its brief cannot reach that machine.`);
    return { warning: `${child.name} runs on machine ${child.host}, and this session cannot register it there, so it cannot call parent_report.`, registered: false };
  }
  let registration: RemoteRegistration;
  try {
    registration = await register(child, prompt);
  } catch (error) {
    if (prompt !== undefined) throw new Error(`${child.name} was not started on machine ${child.host}, because its brief could not be copied there: ${(error as Error).message}`);
    return { warning: `${child.name} could not be registered on machine ${child.host}, so it cannot call parent_report: ${(error as Error).message}`, registered: false };
  }
  return {
    briefFile: registration.brief,
    mcpConfigFile: child.kind === 'claude' ? registration.mcpConfig : undefined,
    registered: true,
  };
}

export async function spawnChild(client: HerdrClient, parent: ParentRecord, options: SpawnOptions, signal?: AbortSignal, hooks: SpawnHooks = {}): Promise<SpawnResult> {
  const depth = parent.depth + 1;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth > maxDepth) throw new Error(`Bellwether is ${maxDepth} levels deep already, so ${options.name} would go one level too far. Raise max_depth on the spawn if that is what you want.`);

  const now = new Date().toISOString();
  const child: ChildRecord = {
    id: newChildId(),
    name: options.name,
    kind: options.kind,
    harness: harnessOf(options.kind),
    paneId: '',
    host: options.host ?? LOCAL_HOST,
    origin: 'spawn',
    cwd: options.cwd,
    startedAt: now,
    lastStatus: 'unknown',
    statusChangedAt: now,
    lastBusyAt: now,
    depth,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
    inactiveMs: resolveInactiveMs(options.inactiveMinutes),
  };
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, child);

  let tabId: string | undefined;
  let startup: StartupWatch | undefined;
  let reportWarning: string | undefined;
  let registered = false;
  try {
    const files = await childStartFiles(child, options.prompt || undefined, hooks.registerRemote);
    const { briefFile, mcpConfigFile } = files;
    registered = files.registered;
    reportWarning = files.warning;

    // 2. The tab carries the environment the child needs to find its parent.
    const env = childEnv(parent, child);
    // The parent's workspace id means nothing to another machine's herdr.
    const workspaceId = options.workspaceId ?? (child.host === LOCAL_HOST ? parent.workspaceId : undefined);
    const tab = await client.tabCreate({ workspaceId, cwd: options.cwd, label: child.name, env, focus: options.focus ?? false }, signal);
    tabId = tab.tabId ?? tab.paneId;
    if (!tab.paneId) throw new Error('herdr created no pane for the child tab');

    child.tabId = tab.tabId;
    child.paneId = tab.paneId;
    child.workspaceId = workspaceId;
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
    await startWithRetry(client, { name: child.name, kind: options.kind, paneId: tab.paneId, args: childArgs(options.kind, options, briefFile, mcpConfigFile) }, signal);
  } catch (error) {
    startup?.close();
    await abandon(client, parent.id, child, tabId, hooks, registered);
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
      await abandon(client, parent.id, child, tabId, hooks, registered);
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
      }
    }
    const status = pane['agent_status'];
    if (typeof status === 'string' && status) child.lastStatus = status as ChildRecord['lastStatus'];
  } catch {
    // A missed session id only costs the transcript-based summary until the
    // watcher reads it.
  }
  child.startingUntil = undefined;
  updateChild(parent.id, child.id, (entry) => {
    if (child.session) entry.session = child.session;
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

  return { child, link: herdrLink('pane', child.paneId), answered, ...(reportWarning ? { reportWarning } : {}) };
}

/**
 * Undo a spawn that never produced a running child. The record goes first, so
 * the watcher finds no child when the tab-closed event arrives and the parent
 * hears nothing about a child that never ran.
 */
async function abandon(client: HerdrClient, parentId: string, child: ChildRecord, tabId: string | undefined, hooks: SpawnHooks, registered: boolean): Promise<void> {
  removeChild(parentId, child.id);
  hooks.forget?.(child.id);
  removeChildFiles(child.id);
  if (tabId) await client.tabClose(tabId).catch(() => {});
  // The brief and config on the child's machine go too. A failed hop leaves
  // them for that machine's week-old prune, as nothing else can reach them.
  if (registered) await hooks.cleanupRemote?.(child).catch(() => {});
}

/**
 * Write a Claude Code child's MCP configuration on this machine. A server
 * talks to the daemon on its own machine, so a child on another machine gets
 * the config its own machine writes when the spawn registers it there.
 */
export function childMcpConfig(child: Pick<ChildRecord, 'id' | 'kind' | 'host'>): string | undefined {
  if (child.kind !== 'claude' || (child.host ?? LOCAL_HOST) !== LOCAL_HOST) return undefined;
  return writeMcpConfig(child.id);
}

/** The environment a child's tab carries, so the child can find its parent. */
export function childEnv(parent: ParentRecord, child: ChildRecord): Record<string, string> {
  return {
    BELLWETHER_PARENT: parent.id,
    BELLWETHER_CHILD: child.id,
    BELLWETHER_CHILD_NAME: child.name,
    BELLWETHER_DEPTH: String(child.depth),
    BELLWETHER_HARNESS: child.harness,
  };
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
