// Starting a child. The order follows the design: write the registry record
// first, then create the tab with the Bellwether environment, then ask herdr
// to start the harness in the tab's root pane, then watch the new pane.
import os from 'node:os';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { newChildId } from './outbox.ts';
import { updateChild, upsertChild } from './registry.ts';
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
}

/** The extra arguments a child harness needs to load Bellwether itself. */
export function childArgs(kind: string, options: SpawnOptions, maxDepth: number): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  if (kind === 'claude') args.push('--dangerously-load-development-channels', 'server:bellwether');
  if (options.prompt) args.push(options.prompt);
  if (options.args?.length) args.push(...options.args);
  return args;
}

export async function spawnChild(client: HerdrClient, parent: ParentRecord, options: SpawnOptions, signal?: AbortSignal): Promise<SpawnResult> {
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
  };
  // 1. The record lands before herdr is asked for anything.
  upsertChild(parent.id, child);

  // 2. The tab carries the environment the child needs to find its parent.
  const env: Record<string, string> = {
    BELLWETHER_PARENT: parent.id,
    BELLWETHER_CHILD: child.id,
    BELLWETHER_CHILD_NAME: child.name,
    BELLWETHER_DEPTH: String(depth),
    BELLWETHER_HARNESS: child.harness,
  };
  const tab = await client.tabCreate({ workspaceId: options.workspaceId ?? parent.workspaceId, cwd: options.cwd, label: child.name, env, focus: options.focus ?? false }, signal);
  if (!tab.paneId) throw new Error('herdr created no pane for the child tab');

  child.tabId = tab.tabId;
  child.paneId = tab.paneId;
  child.workspaceId = options.workspaceId ?? parent.workspaceId;
  upsertChild(parent.id, child);

  // 3. Start the harness in the tab's root pane. A tab answers tab.create
  // before its shell is at a prompt, so herdr refuses the start with
  // agent_pane_busy until the shell is ready.
  try {
    await startWithRetry(client, { name: child.name, kind: options.kind, paneId: tab.paneId, args: childArgs(options.kind, options, maxDepth) }, signal);
  } catch (error) {
    await client.tabClose(tab.tabId ?? tab.paneId).catch(() => {});
    throw error;
  }

  // 4. Resolve the transcript, then hand back the child and its herdr link.
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

  return { child, link: herdrLink('pane', child.paneId) };
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
