// What became of an agent's last pane, for agent_list and `bellwether doctor`
// (issue #187). A record keeps the pane an agent last ran in and, for a child,
// how herdr said it ended. One look at herdr adds what the record cannot know:
// whether the workspace went with the pane, and whether the session now runs
// somewhere else. The functions that word it are pure, so a test hands them
// a record and a view of herdr.
import path from 'node:path';
import type { HerdrClient, HerdrPane } from './herdr-client.ts';
import { parentId as registryIdOf } from './paths.ts';
import type { ChildRecord, PaneEnd, ParentRecord } from './types.ts';
import { parseWorkspaces } from './workspace.ts';

/** One look at a herdr server: its panes by id, and the workspaces it lists. */
export interface HerdrView {
  panes: Map<string, HerdrPane>;
  workspaces: Set<string>;
}

/** Read the panes, agents and workspaces of one herdr server, or undefined when it does not answer. */
export async function herdrView(client: HerdrClient, listed?: HerdrPane[]): Promise<HerdrView | undefined> {
  try {
    // A caller that already read the pane list passes it, so herdr is asked once.
    const [panes, agents, workspaces] = await Promise.all([listed ?? client.paneList(), client.agentList(), client.workspaceList()]);
    const byId = new Map(panes.map((pane) => [pane.paneId, pane]));
    // agent.list carries the session a pane holds; pane.list may not.
    for (const agent of agents) byId.set(agent.paneId, { ...byId.get(agent.paneId), ...agent });
    return { panes: byId, workspaces: new Set(parseWorkspaces(workspaces).map((entry) => entry.id)) };
  } catch {
    return undefined;
  }
}

/** Whether a session value herdr reports names the same session: an id, or a pi file whose name ends in it. */
export function sameSession(reported: string | undefined, wanted: string): boolean {
  if (!reported || !wanted) return false;
  if (reported === wanted) return true;
  const id = (value: string): string => path.basename(value, '.jsonl');
  return id(reported) === id(wanted) || id(reported).endsWith(`_${id(wanted)}`) || id(wanted).endsWith(`_${id(reported)}`);
}

/** The pane herdr shows holding a session, if any. */
export function paneHolding(view: HerdrView, session: string): HerdrPane | undefined {
  return [...view.panes.values()].find((pane) => sameSession(pane.agentSessionId, session));
}

function workspaceGone(workspaceId: string | undefined, view: HerdrView | undefined): string {
  return workspaceId && view && !view.workspaces.has(workspaceId) ? `, and herdr removed its workspace ${workspaceId}` : '';
}

/** One phrase for how a pane ended, with the workspace when herdr no longer lists it. */
export function describePaneEnd(end: PaneEnd, view?: HerdrView): string {
  const pane = end.pane || '(none)';
  const code = end.code === undefined ? '' : ` with code ${end.code}`;
  const how =
    end.how === 'exited' ? `pane ${pane} exited at ${end.at}${code}`
    : end.how === 'closed' ? `pane ${pane} closed at ${end.at}`
    : end.how === 'missing' ? `pane ${pane} gone by ${end.at}, with no event saying how`
    : end.how === 'harness-ended' ? `harness exited at ${end.at}, pane ${pane} left open on its shell`
    : end.how === 'adopt-refused' ? `adoption refused by the pane's machine at ${end.at}${end.reason ? `: ${end.reason}` : ''}`
    : end.how === 'session-changed' ? `pane ${pane} went to ${end.session ? `session ${end.session}` : 'another session'} at ${end.at}`
    : `pane ${pane} closed by a restart at ${end.at} that did not start the session again`;
  return `${how}${workspaceGone(end.workspaceId, view)}`;
}

/** How agent_list names an exited child's last pane, or undefined for a child still running. */
export function childPaneEnd(child: ChildRecord, view?: HerdrView): string | undefined {
  if (!child.exitedAt) return undefined;
  if (child.paneEnd) return describePaneEnd(child.paneEnd, view);
  // A child that exited before its record kept how.
  return `pane ${child.paneId || '(none)'}, exited at ${child.exitedAt}${workspaceGone(child.workspaceId, view)}`;
}

/** Where a session stands in herdr, read from its record and one look at herdr. */
export interface SessionPane {
  /** True when herdr shows a pane holding the session. */
  running: boolean;
  /** The pane that holds it, when one does. */
  pane?: HerdrPane;
  /** The pane the record names last, if any. */
  lastPane?: string;
  /** One phrase a person reads. */
  text: string;
}

/** Where a session's last pane stands, and whether the session runs anywhere. */
export function sessionPane(record: ParentRecord, view: HerdrView): SessionPane {
  const lastPane = record.paneId ?? record.restartFailed?.oldPane;
  const holder = paneHolding(view, record.session);
  if (holder) {
    const where = `runs in pane ${holder.paneId} (${holder.tabId ? `tab ${holder.tabId}, ` : ''}workspace ${holder.workspaceId})`;
    const moved = lastPane && lastPane !== holder.paneId ? `, not in pane ${lastPane} that its record names` : '';
    return { running: true, pane: holder, ...(lastPane ? { lastPane } : {}), text: `${where}${moved}` };
  }
  if (!lastPane) return { running: false, text: 'no pane on its record' };
  const left = record.disconnectedAt ? `; its Bellwether connection closed at ${record.disconnectedAt}` : '';
  const failed = record.restartFailed ? ` by a restart at ${record.restartFailed.at} that did not start it again` : '';
  const now = view.panes.get(lastPane);
  if (now) {
    const what = now.agent ? `${now.agent}${now.agentSessionId ? ` session ${now.agentSessionId}` : ''}` : 'a shell';
    return { running: false, lastPane, text: `last pane ${lastPane} now holds ${what}${left}` };
  }
  const workspace = record.restartFailed?.workspaceId ?? record.workspaceId;
  return { running: false, lastPane, text: `last pane ${lastPane} closed${failed}${workspaceGone(workspace, view)}${left}` };
}

/**
 * The parent whose registry lists a session as its child, with that child's
 * record. Such a session comes back through its parent's resume, which keeps
 * its child id and so its reports; a resume by its own record would not.
 */
export function childOwner(record: ParentRecord, parents: readonly ParentRecord[]): { parent: ParentRecord; child: ChildRecord } | undefined {
  if (!record.childId) return undefined;
  for (const parent of parents) {
    const child = parent.children.find((entry) => entry.id === record.childId);
    if (child) return { parent, child };
  }
  return undefined;
}

/** What brings a session back: its parent's resume for a child, `bellwether resume` otherwise. */
export function bringBack(record: ParentRecord, parents: readonly ParentRecord[]): string {
  const owner = childOwner(record, parents);
  if (owner) return `It is ${owner.child.name} (child ${owner.child.id}) of session ${owner.parent.id}, which brings it back with agent_spawn and resume ${owner.child.name}, keeping its child id.`;
  return `Resume it with \`bellwether resume ${record.id}\`.`;
}

/** How long doctor keeps naming a session that no longer runs. */
export const GONE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The doctor lines for each session on this machine whose pane is gone: one
 * per session, newest first, naming its folder, its last pane and what became
 * of it, and the command that resumes it. A session that runs, one connected
 * to the daemon, one quiet for longer than a day, and a record the command
 * line made for itself are left out. A restart that failed has its own line.
 */
export function goneSessionLines(parents: readonly ParentRecord[], view: HerdrView, options: { connected: ReadonlySet<string>; now: number; isLocal: (record: ParentRecord) => boolean }): string[] {
  const found: { at: string; line: string }[] = [];
  for (const record of parents) {
    // `bellwether` run from a shell keeps a record under an id of its own, for no harness session.
    if (record.id !== registryIdOf(record.harness, record.session)) continue;
    if (options.connected.has(record.id) || record.restartFailed || !options.isLocal(record)) continue;
    const at = record.disconnectedAt ?? record.updatedAt;
    if (options.now - Date.parse(at) > GONE_SESSION_WINDOW_MS) continue;
    const where = sessionPane(record, view);
    if (where.running || !where.lastPane) continue;
    const label = record.label ? `, tab ${record.label}` : '';
    found.push({ at, line: `info  session ${record.id} (${record.harness} session ${record.session}, folder ${record.cwd}${label}): ${where.text}. ${bringBack(record, parents)}` });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at)).map((entry) => entry.line);
}
