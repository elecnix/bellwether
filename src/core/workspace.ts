// Which herdr workspace a child's tab opens in. A spawn may name one, by id
// or label, or ask for a new one with "new". A workspace Bellwether created
// is marked on the child's record, so the cleanup closes only those, and
// never one a person made.
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { LOCAL_HOST } from './machine.ts';

/** The value of `workspace` that asks for a workspace of the child's own. */
export const NEW_WORKSPACE = 'new';

/** One workspace herdr lists. */
export interface WorkspaceEntry {
  id: string;
  label: string;
  tabCount?: number;
}

/** Where a child's tab opens, decided before anything is written. */
export type WorkspacePlacement =
  /** Today's behavior: the parent's workspace, or herdr's choice on another machine. */
  | { mode: 'default'; workspaceId?: string }
  /** An existing workspace on the child's machine. */
  | { mode: 'existing'; workspaceId: string; label?: string }
  /** A workspace Bellwether creates for the child, on the child's machine. */
  | { mode: 'new'; label: string };

/** The tab a child runs in, and the workspace that holds it. */
export interface ChildTab {
  tabId?: string;
  paneId?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  /** Set when Bellwether created the workspace for this child. */
  ownsWorkspace?: boolean;
}

export function parseWorkspaces(list: Record<string, unknown>[]): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  for (const item of list) {
    const id = item['workspace_id'];
    if (typeof id !== 'string' || !id) continue;
    const label = typeof item['label'] === 'string' ? item['label'] : '';
    const tabs = item['tab_count'];
    entries.push({ id, label, ...(typeof tabs === 'number' ? { tabCount: tabs } : {}) });
  }
  return entries;
}

function where(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

function named(entries: WorkspaceEntry[]): string {
  if (!entries.length) return 'it has none';
  return `its workspaces are ${entries.map((entry) => (entry.label ? `${entry.label} (${entry.id})` : entry.id)).join(', ')}`;
}

export interface PlacementRequest {
  /** What the caller passed: "new", a workspace id or label, or nothing. */
  workspace?: string;
  /** The label for a new workspace. Defaults to the child's name. */
  label?: string;
  childName: string;
  host: string;
  /** The parent's own workspace, which a child on this machine opens in by default. */
  parentWorkspaceId?: string;
  /** The workspaces on the child's machine. */
  childWorkspaces: () => Promise<WorkspaceEntry[]>;
  /** The workspaces on the parent's machine, to name a local id passed to a remote spawn. */
  localWorkspaces?: () => Promise<WorkspaceEntry[]>;
}

/**
 * Decide where a child's tab opens. With no workspace named, nothing changes:
 * the parent's workspace for a child on this machine, and herdr's own choice
 * on another. "new" asks for a workspace of the child's own, on the child's
 * machine. Any other value names an existing workspace there, by id first,
 * then by label, and one that matches nothing, or matches two by label, is
 * refused. A workspace id from this machine, passed for a child on another,
 * is refused with the reason, since it means nothing to that machine's herdr.
 */
export async function placeChild(request: PlacementRequest): Promise<WorkspacePlacement> {
  const { childName, host } = request;
  const wanted = request.workspace?.trim();
  if (request.label !== undefined && wanted !== NEW_WORKSPACE) {
    throw new Error(`${childName} was not started: workspace_label names a new workspace, so it goes with workspace "new".`);
  }
  if (!wanted) return { mode: 'default', workspaceId: host === LOCAL_HOST ? request.parentWorkspaceId : undefined };
  if (wanted === NEW_WORKSPACE) {
    const label = request.label?.trim() || childName;
    return { mode: 'new', label };
  }
  const there = await request.childWorkspaces();
  const byId = there.find((entry) => entry.id === wanted);
  if (host !== LOCAL_HOST && request.localWorkspaces) {
    const here = await request.localWorkspaces().catch(() => [] as WorkspaceEntry[]);
    const local = here.find((entry) => entry.id === wanted);
    if (local && !byId) {
      throw new Error(`${childName} was not started: ${wanted} is a workspace on this machine${local.label ? ` (${local.label})` : ''}, and a workspace id from this machine means nothing to the herdr on machine ${host}, where the child runs. Pass workspace "new" to give the child a workspace of its own on ${host}, or name a workspace there: ${named(there)}.`);
    }
    if (local && byId) {
      throw new Error(`${childName} was not started: ${wanted} is a workspace id on this machine and on machine ${host}, so Bellwether cannot tell which one you mean. Name the workspace on ${host} by its label${byId.label ? `, ${byId.label}` : ''}, or pass workspace "new".`);
    }
  }
  if (byId) return { mode: 'existing', workspaceId: byId.id, ...(byId.label ? { label: byId.label } : {}) };
  const byLabel = there.filter((entry) => entry.label === wanted);
  if (byLabel.length === 1) {
    const only = byLabel[0] as WorkspaceEntry;
    return { mode: 'existing', workspaceId: only.id, label: only.label };
  }
  if (byLabel.length > 1) {
    throw new Error(`${childName} was not started: ${byLabel.length} workspaces on ${where(host)} are labelled ${wanted} (${byLabel.map((entry) => entry.id).join(', ')}). Name one by its id.`);
  }
  throw new Error(`${childName} was not started: no workspace on ${where(host)} answers to ${wanted}, by id or by label, and ${named(there)}. Pass workspace "new" to create one for the child.`);
}

export interface TabRequest {
  cwd?: string;
  label: string;
  env: Record<string, string>;
  focus: boolean;
}

/**
 * Open the tab a child runs in. A new workspace comes with a tab and a root
 * pane of its own, so the child runs in that pane, and the workspace holds
 * nothing else: herdr closes a workspace when its last tab closes. The tab is
 * renamed after the child, as a tab Bellwether opens always is.
 */
export async function openChildTab(client: HerdrClient, placement: WorkspacePlacement, tab: TabRequest, signal?: AbortSignal): Promise<ChildTab> {
  if (placement.mode !== 'new') {
    const opened = await client.tabCreate({ workspaceId: placement.workspaceId, cwd: tab.cwd, label: tab.label, env: tab.env, focus: tab.focus }, signal);
    const label = placement.mode === 'existing' ? placement.label : undefined;
    return { ...opened, workspaceId: placement.workspaceId, ...(label ? { workspaceLabel: label } : {}) };
  }
  const created = await client.workspaceCreate({ label: placement.label, cwd: tab.cwd, env: tab.env, focus: tab.focus }, signal);
  if (!created.workspaceId) throw new Error('herdr created no workspace for the child');
  const result: ChildTab = { tabId: created.tabId, paneId: created.paneId, workspaceId: created.workspaceId, workspaceLabel: created.label ?? placement.label, ownsWorkspace: true };
  if (created.tabId) await client.tabRename(created.tabId, tab.label, signal).catch(() => {});
  return result;
}

/**
 * Close a child's tab, or the workspace Bellwether created for it when the
 * spawn never got a child running. Used to undo a failed start.
 */
export async function undoChildTab(client: HerdrClient, opened: ChildTab | undefined): Promise<void> {
  if (!opened) return;
  if (opened.ownsWorkspace && opened.workspaceId) {
    await client.workspaceClose(opened.workspaceId).catch(() => {});
    return;
  }
  const target = opened.tabId ?? opened.paneId;
  if (target) await client.tabClose(target).catch(() => {});
}

/**
 * Where a returning child opens its tab: a resume, a restart or a move. A
 * child in a workspace Bellwether created goes back to it while herdr still
 * lists it on the child's machine, and gets a new one with the same label
 * once herdr has closed it, since herdr closes a workspace with its last tab.
 * Any other child keeps the workspace the caller chose for it.
 */
export async function returnPlacement(client: HerdrClient, child: { name: string; workspaceId?: string; workspaceLabel?: string; ownsWorkspace?: boolean }, fallback: string | undefined, signal?: AbortSignal): Promise<WorkspacePlacement> {
  if (!child.ownsWorkspace) return { mode: 'default', workspaceId: fallback };
  const live = parseWorkspaces(await client.workspaceList(signal));
  const still = child.workspaceId ? live.find((entry) => entry.id === child.workspaceId) : undefined;
  if (still) return { mode: 'existing', workspaceId: still.id, ...(still.label ? { label: still.label } : {}) };
  return { mode: 'new', label: child.workspaceLabel || child.name };
}

/** What became of a child's workspace once the child left it. */
export type WorkspaceRelease = 'closed' | 'kept' | 'gone' | 'not-ours';

/**
 * Close the workspace Bellwether created for a child, once the child has left
 * it and it holds no tab at all. A workspace a person created, or the parent's
 * own, is never touched, and neither is one that still holds a tab: another
 * child, a person's shell, or the child's own tab kept open on its last
 * screen. herdr closes a workspace with its last tab, so most of the time the
 * workspace is gone already, and this only confirms it.
 */
export async function releaseWorkspace(client: HerdrClient, child: { workspaceId?: string; ownsWorkspace?: boolean }, signal?: AbortSignal): Promise<WorkspaceRelease> {
  if (!child.ownsWorkspace || !child.workspaceId) return 'not-ours';
  let tabs: Record<string, unknown>[];
  try {
    tabs = await client.tabList(child.workspaceId, signal);
  } catch (error) {
    if (error instanceof HerdrApiError && error.code === 'workspace_not_found') return 'gone';
    throw error;
  }
  if (tabs.length) return 'kept';
  try {
    await client.workspaceClose(child.workspaceId, signal);
  } catch (error) {
    if (error instanceof HerdrApiError && error.code === 'workspace_not_found') return 'gone';
    throw error;
  }
  return 'closed';
}

/** A workspace's id with its label, when known. */
export function workspaceName(child: { workspaceId?: string; workspaceLabel?: string }): string {
  return `${child.workspaceId ?? '-'}${child.workspaceLabel ? ` (${child.workspaceLabel})` : ''}`;
}

/** How agent_list and doctor name a child's workspace, and whether Bellwether made it. */
export function workspaceColumn(child: { workspaceId?: string; workspaceLabel?: string; ownsWorkspace?: boolean }): string {
  if (!child.workspaceId) return '-';
  return `${workspaceName(child)}${child.ownsWorkspace ? ' [made for it]' : ''}`;
}
