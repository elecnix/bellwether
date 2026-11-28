// `bellwether resume`: bring back a session whose pane is gone, from its own
// record (issue #187). A failed self-restart, a closed tab or a removed
// workspace can leave a session with no pane, and `agent_spawn` with `resume`
// reopens only a session's own children. The record holds what a person would
// type by hand: the session, its folder, its workspace and its tab label. This
// opens a tab there and starts the harness on the session, the way
// `herdr tab create --cwd … --label …` and then `pi --session <file>` would,
// and says where it landed.
//
// It refuses before anything opens: a target no record names, or that names
// more than one; a session on another machine; a folder that is gone; a
// session file that is gone; a session that is a child of a parent here, which
// that parent's resume brings back under its child id; and a session that
// already runs in a pane, which agent_restart restarts in place instead. The
// start itself is a parent restart with no pane to close, so it holds the same
// lock and leaves the same `restartFailed` line when the harness does not come up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HerdrClient } from './herdr-client.ts';
import { childOwner, herdrView, paneHolding, sameSession } from './pane-fate.ts';
import { parentId as registryIdOf } from './paths.ts';
import { listParents } from './registry.ts';
import { restartParent, type RestartHooks } from './restart.ts';
import { hostName, herdrLink } from './spawn.ts';
import { kindOfHarness, requireHarness } from './harnesses/index.ts';
import { LOCAL_HOST } from './machine.ts';
import type { ParentRecord } from './types.ts';

/** A resume refused before anything opened, with what to do instead. */
export class ResumeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefused';
  }
}

/** The records a target names: a registry id, a session id or pi file, or the pane a session last ran in. */
export function recordsNaming(target: string, parents: readonly ParentRecord[] = listParents()): ParentRecord[] {
  // A record the command line made for itself names no harness session.
  const sessions = parents.filter((record) => record.id === registryIdOf(record.harness, record.session));
  const byId = sessions.filter((record) => record.id === target);
  if (byId.length) return byId;
  const bySession = sessions.filter((record) => sameSession(record.session, target) || sameSession(target, record.session));
  if (bySession.length) return bySession;
  return sessions.filter((record) => record.paneId === target || record.restartFailed?.oldPane === target);
}

/** The session file a harness reopens from, or the refusal that names what is missing. */
function sessionFile(record: ParentRecord): string {
  const found = requireHarness(kindOfHarness(record.harness)).conversation.locate(record.session, record.cwd);
  if (found.path && fs.existsSync(found.path)) return found.path;
  throw new ResumeRefused(`session ${record.id} names ${record.harness} session ${record.session}, and its session file is gone (${found.missing ?? `${found.path} does not exist`}), so there is nothing to resume. Start a new session in ${record.cwd} instead.`);
}

function shortLabel(record: ParentRecord): string {
  // Two sessions started a second apart share the front of a time-ordered id, so the label takes its end.
  const id = path.basename(record.session, '.jsonl');
  return `${path.basename(record.cwd) || record.harness}-${id.slice(-6)}`;
}

export interface ResumeOptions {
  /** The tab label, when the record keeps none. */
  label?: string;
}

/**
 * Resume the session a record names in a new tab, and answer with where it
 * landed. Throws ResumeRefused, or a RestartRefused from the start itself.
 */
export async function resumeSession(client: HerdrClient, target: string, hooks: RestartHooks = {}, options: ResumeOptions = {}): Promise<string> {
  const named = recordsNaming(target);
  if (!named.length) throw new ResumeRefused(`No Bellwether record names "${target}". Pass a registry id, a session id or the pane a session last ran in; \`bellwether doctor\` lists each session whose pane is gone, and \`bellwether parents\` lists every record.`);
  if (named.length > 1) throw new ResumeRefused(`"${target}" names ${named.length} sessions: ${named.map((record) => `${record.id} (folder ${record.cwd}, last pane ${record.paneId ?? 'none'})`).join('; ')}. Pass one registry id.`);
  const record = named[0] as ParentRecord;
  const here = hostName() || os.hostname();
  if (record.host !== here && record.host !== LOCAL_HOST) throw new ResumeRefused(`session ${record.id} ran on ${record.host}, and this machine's daemon resumes only its own sessions. Run \`bellwether resume ${record.id}\` there.`);
  if (!fs.existsSync(record.cwd) || !fs.statSync(record.cwd).isDirectory()) throw new ResumeRefused(`session ${record.id} ran in folder ${record.cwd}, which is gone, so its harness has nowhere to start. Restore the folder, then resume it.`);
  sessionFile(record);
  // A child that came back without its child id would report to nobody.
  const owner = childOwner(record, listParents());
  if (owner) throw new ResumeRefused(`session ${record.id} is ${owner.child.name} (child ${owner.child.id}) of session ${owner.parent.id}, so a resume by its own record would bring it back without its child id, and its reports would reach nobody. Its parent brings it back with agent_spawn and resume ${owner.child.name}; resume session ${owner.parent.id} first if its pane is gone too.`);

  const view = await herdrView(client);
  if (!view) throw new ResumeRefused(`herdr did not list its panes, so Bellwether cannot tell whether session ${record.id} already runs, and opened nothing.`);
  const holder = paneHolding(view, record.session);
  if (holder) throw new ResumeRefused(`session ${record.id} already runs in pane ${holder.paneId} (workspace ${holder.workspaceId}), so Bellwether opened nothing: a second copy would share its session. Restart it there with agent_restart, or close that pane first.\nherdr link: ${herdrLink('pane', holder.paneId)}`);

  // The pane the record names no longer holds the session. herdr reuses pane
  // ids, so whatever runs there now is someone else's, and the start leaves it be.
  const lastPane = record.paneId ?? record.restartFailed?.oldPane;
  const outcome = await restartParent(client, record.id, hooks, { paneGone: true, label: options.label ?? record.label ?? shortLabel(record) });
  const workspace = outcome.workspaceId;
  const moved = workspace && record.workspaceId && workspace !== record.workspaceId ? `, a new workspace, because herdr removed workspace ${record.workspaceId}` : '';
  const before = lastPane ? ` Its last pane was ${lastPane}.` : '';
  const matched = outcome.sessionMatched ? 'herdr reports the same session in the new pane.' : 'herdr reports another session in the new pane, so read it before trusting it.';
  return `Resumed session ${record.id} in folder ${record.cwd}: started ${outcome.kind} in pane ${outcome.newPane}${outcome.newTab ? `, tab ${outcome.newTab} (${outcome.name})` : ''}${workspace ? `, workspace ${workspace}${moved}` : ''}, with ${outcome.command}.${before} ${matched}\nherdr link: ${herdrLink('pane', outcome.newPane)}`;
}

