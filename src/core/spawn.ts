// Starting a child. The order follows the design: write the registry record
// first, then create the tab with the Bellwether environment, then ask herdr
// to start the harness in the tab's root pane, then watch the new pane.
import os from 'node:os';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { newChildId } from './outbox.ts';
import { briefArgument, removeBrief, writeBrief } from './brief.ts';
import { claudeTrustsRepository } from './claude-trust.ts';
import { removeChild, updateChild, upsertChild } from './registry.ts';
import { watchStartup, type StartupOutcome, type StartupWatch } from './startup-dialogs.ts';
import { resolveTranscript } from './transcript.ts';
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
  /** The workspace to open the tab in. Defaults to the parent's own. */
  workspaceId?: string;
  /** How deep a child may itself spawn. */
  maxDepth?: number;
}

export interface SpawnResult {
  child: ChildRecord;
  link: string;
  /** How the startup dialogs went, for a harness that shows them. */
  startup?: StartupOutcome;
}

/** How long the watcher holds a new Claude Code child's events. Longer than the dialog wait. */
const STARTUP_HOLD_MS = 45_000;

/**
 * The arguments a child harness starts with. The brief is never one of them:
 * `briefFile` names the private file that holds it, and the harness gets a
 * one-line pointer to that file.
 */
export function childArgs(kind: string, options: SpawnOptions, briefFile?: string): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  // Claude Code reads this flag as a list and keeps taking values until the
  // next flag, so the two-argument form swallowed the prompt that follows it.
  // The equals form pins the flag to one value.
  if (kind === 'claude') args.push('--dangerously-load-development-channels=server:bellwether');
  if (briefFile) args.push(briefArgument(kind, briefFile));
  if (options.args?.length) args.push(...options.args);
  return args;
}

export interface SpawnHooks {
  /** Drop whatever the watcher holds for a child whose spawn failed. */
  forget?: (childId: string) => void;
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
    cwd: options.cwd,
    startedAt: now,
    lastStatus: 'unknown',
    statusChangedAt: now,
    lastBusyAt: now,
    depth,
    stuckMs: options.stuckMinutes === undefined ? undefined : Math.max(1_000, Math.round(options.stuckMinutes * 60_000)),
  };
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, child);

  let tabId: string | undefined;
  let startup: StartupWatch | undefined;
  try {
    const briefFile = options.prompt ? writeBrief(child.id, options.prompt) : undefined;

    // 2. The tab carries the environment the child needs to find its parent.
    const env: Record<string, string> = {
      BELLWETHER_PARENT: parent.id,
      BELLWETHER_CHILD: child.id,
      BELLWETHER_CHILD_NAME: child.name,
      BELLWETHER_DEPTH: String(depth),
      BELLWETHER_HARNESS: child.harness,
    };
    const tab = await client.tabCreate({ workspaceId: options.workspaceId ?? parent.workspaceId, cwd: options.cwd, label: child.name, env, focus: options.focus ?? false }, signal);
    tabId = tab.tabId ?? tab.paneId;
    if (!tab.paneId) throw new Error('herdr created no pane for the child tab');

    child.tabId = tab.tabId;
    child.paneId = tab.paneId;
    child.workspaceId = options.workspaceId ?? parent.workspaceId;
    // Claude Code opens on dialogs the spawn answers, so the watcher holds the
    // child's events until then, and the status watch opens before the start.
    if (options.kind === 'claude') {
      child.startingUntil = new Date(Date.now() + STARTUP_HOLD_MS).toISOString();
      startup = await watchStartup(client, tab.paneId, signal);
    }
    upsertChild(parent.id, child);

    // 3. Start the harness in the tab's root pane. A tab answers tab.create
    // before its shell is at a prompt, so herdr refuses the start with
    // agent_pane_busy until the shell is ready.
    await startWithRetry(client, { name: child.name, kind: options.kind, paneId: tab.paneId, args: childArgs(options.kind, options, briefFile) }, signal);
  } catch (error) {
    startup?.close();
    await abandon(client, parent.id, child.id, tabId, hooks);
    throw error;
  }

  // 4. Answer the startup dialogs, then let the watcher read the child.
  let outcome: StartupOutcome | undefined;
  if (startup) {
    try {
      outcome = await startup.answer({ trusted: claudeTrustsRepository(options.cwd ?? parent.cwd) });
    } catch {
      outcome = 'timeout';
    } finally {
      startup.close();
      child.startingUntil = undefined;
      updateChild(parent.id, child.id, (entry) => {
        delete entry.startingUntil;
      });
    }
  }

  // 5. Resolve the transcript, then hand back the child and its herdr link.
  // The registry is re-read rather than written from the caller's copy, which
  // would erase the child record that upsertChild just added.
  await new Promise((resolve) => setTimeout(resolve, 750));
  try {
    const panes = await client.agentList(signal);
    const pane = panes.find((entry) => entry.paneId === child.paneId);
    if (pane) {
      child.transcript = resolveTranscript(child.harness, pane.agentSessionId, child.cwd);
      child.lastStatus = pane.agentStatus;
      updateChild(parent.id, child.id, (entry) => {
        entry.transcript = child.transcript;
        entry.lastStatus = child.lastStatus;
      });
    }
  } catch {
    // A missed session id only costs the transcript-based summary.
  }

  return { child, link: herdrLink('pane', child.paneId), startup: outcome };
}

/**
 * Undo a spawn that never produced a running child. The record goes first, so
 * the watcher finds no child when the tab-closed event arrives and the parent
 * hears nothing about a child that never ran.
 */
async function abandon(client: HerdrClient, parentId: string, childId: string, tabId: string | undefined, hooks: SpawnHooks): Promise<void> {
  removeChild(parentId, childId);
  hooks.forget?.(childId);
  removeBrief(childId);
  if (tabId) await client.tabClose(tabId).catch(() => {});
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
