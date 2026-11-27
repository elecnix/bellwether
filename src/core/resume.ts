// Bringing a child back. A child that exited keeps its record, so a spawn with
// a resume target (see spawn-resume.ts) opens a new tab on the host the child ran on, starts the harness with its
// session's resume flag, and puts the new pane under the same child id. The
// child's outbox entries and receipts are keyed by that id, so they continue.
import path from 'node:path';
import type { HerdrClient, HerdrPane } from './herdr-client.ts';
import { removeChildFiles } from './mcp-config.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { readParent, removeChild, updateChild, upsertChild } from './registry.ts';
import { clearRetirement } from './retire.ts';
import { openChildTab, returnPlacement, undoChildTab, type ChildTab } from './workspace.ts';
import { STARTUP_HOLD_MS, STARTUP_TIMEOUT_MS, childArgs, childEnv, childStartFiles, harnessOf, herdrLink, nextLaunch, startHarness, type RegisterRemote } from './spawn.ts';
import { routeLaunch } from './routes.ts';
import { watchStartup, type StartupDialog, type StartupWatch } from './startup-dialogs.ts';
import { locateTranscript, sessionFrom } from './transcript.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import { resolveInactiveMs } from './inactivity.ts';

/** A harness session, as herdr names it: an id, or the path of its file. */
export interface HarnessSession {
  value: string;
  kind: 'id' | 'path';
}

/**
 * The session a child record names: the one herdr reported, kept after exit.
 * A record written before Bellwether kept it still has the transcript, which
 * names the session too: Claude Code names the file after the session id, and
 * Pi takes the file itself.
 */
export function sessionOf(child: Pick<ChildRecord, 'harness' | 'transcript' | 'session'>): HarnessSession | undefined {
  if (child.session?.value) return { value: child.session.value, kind: child.session.kind === 'path' ? 'path' : 'id' };
  if (!child.transcript) return undefined;
  if (child.harness === 'claude-code') return { value: path.basename(child.transcript, '.jsonl'), kind: 'id' };
  if (child.harness === 'pi') return { value: child.transcript, kind: 'path' };
  return undefined;
}

/** The arguments that make a harness reopen a session, or an error for one that cannot. */
export function resumeArgs(kind: string, session: HarnessSession): string[] {
  if (kind === 'claude') return ['--resume', session.kind === 'path' ? path.basename(session.value, '.jsonl') : session.value];
  if (kind === 'pi') return ['--session', session.value];
  throw new Error(`Bellwether cannot resume a ${kind} agent: only claude and pi have a resume flag it knows. Call agent_spawn without resume to start a fresh ${kind} child.`);
}

/** Whether a live pane holds this session. Pi may report the path where a caller gave the id. */
export function holdsSession(pane: HerdrPane, session: HarnessSession): boolean {
  const live = pane.agentSessionId;
  if (!live) return false;
  if (live === session.value) return true;
  const id = (value: string): string => path.basename(value, '.jsonl');
  return id(live) === id(session.value) || id(live).endsWith(`_${id(session.value)}`) || id(session.value).endsWith(`_${id(live)}`);
}

export interface ResumeTarget {
  /** A child of this parent, found by id, name, pane or session. */
  child?: ChildRecord;
  /** A session to resume. Required when no child record names one. */
  session?: HarnessSession;
  /** For a session no child record names: the kind, name, cwd and host. */
  kind?: string;
  name?: string;
  cwd?: string;
  host?: string;
}

export interface ResumeOptions {
  prompt?: string;
  model?: string;
  /** A route to resume on, `none` to leave the child's route, or undefined to keep it. */
  via?: string;
  /** A key file for the route. */
  keyFile?: string;
  /** The pi provider for a bare pi resume. */
  provider?: string;
  args?: string[];
  focus?: boolean;
  workspaceId?: string;
  /** How long the startup dialogs may take. Tests shorten it. */
  startupTimeoutMs?: number;
  /** How long a screen takes to redraw after a key. Tests shorten it. */
  redrawMs?: number;
  /** Register a child on another machine again, so its reports still come back. */
  registerRemote?: RegisterRemote;
  /** Remove what the registration wrote on the child's machine, for a resume that failed after it. */
  cleanupRemote?: (child: ChildRecord) => Promise<void>;
  /** Where this package's pi extension is. Tests point it at a missing file. */
  piExtension?: () => string;
}

export interface ResumeResult {
  child: ChildRecord;
  session: HarnessSession;
  link: string;
  /** Why a child on another machine cannot call parent_report, when its registration there failed. */
  reportWarning?: string;
  /** The startup dialogs the resume answered, in order. */
  answered?: StartupDialog[];
}

/** Find the child a resume names: by id, name or pane, then by the session it ran. */
export function findResumable(record: ParentRecord, target: string): ChildRecord | undefined {
  const direct = record.children.find((child) => child.id === target || child.name === target || child.paneId === target);
  if (direct) return direct;
  return record.children.find((child) => {
    const session = sessionOf(child);
    return session !== undefined && (session.value === target || path.basename(session.value, '.jsonl') === target || session.value.endsWith(`_${target}.jsonl`));
  });
}

export async function resumeChild(client: HerdrClient, parent: ParentRecord, target: ResumeTarget, options: ResumeOptions = {}, signal?: AbortSignal): Promise<ResumeResult> {
  const now = new Date().toISOString();
  const existing = target.child;
  const kind = existing?.kind ?? target.kind;
  if (!kind) throw new Error('A session no child of this parent ran needs a kind, claude or pi, to resume it.');
  // A harness with no resume flag fails here, before anything is written.
  resumeArgs(kind, { value: '', kind: 'id' });
  const session = target.session ?? (existing ? sessionOf(existing) : undefined);
  if (!session) {
    throw new Error(existing ? `${existing.name} has no recorded session, so there is nothing to resume. Pass resume with the session id and kind to reopen it as a new child.` : 'A resume needs a child of this session or a session id.');
  }
  const args = resumeArgs(kind, session);
  // The route is decided before anything is written, so a refusal leaves the record as it was.
  const launch = nextLaunch({ name: existing?.name ?? target.name ?? 'The session', kind, host: existing?.host ?? target.host ?? LOCAL_HOST, route: existing?.route, model: existing?.model }, { via: options.via, model: options.model, keyFile: options.keyFile, provider: options.provider }, 'resumed');

  // Refuse a second copy of a session that still runs, here or in any pane.
  const panes = await client.agentList(signal);
  if (existing && !existing.exitedAt) {
    const pane = panes.find((entry) => entry.paneId === existing.paneId);
    if (pane?.agent) throw new Error(`${existing.name} is still alive in pane ${existing.paneId}, so Bellwether refused to start a second copy. Talk to it with agent_send.`);
  }
  const holder = panes.find((pane) => holdsSession(pane, session));
  if (holder) throw new Error(`Session ${session.value} is still alive in pane ${holder.paneId}${holder.name ? ` (${holder.name})` : ''}, so Bellwether refused to start a second copy.`);

  const child: ChildRecord = existing
    ? { ...existing }
    : {
        id: newChildId(),
        name: target.name ?? `resumed-${path.basename(session.value, '.jsonl').slice(-8)}`,
        kind,
        harness: harnessOf(kind),
        paneId: '',
        host: target.host ?? LOCAL_HOST,
        origin: 'resume',
        cwd: target.cwd,
        startedAt: now,
        lastStatus: 'unknown',
        statusChangedAt: now,
        lastBusyAt: now,
        depth: parent.depth + 1,
        inactiveMs: resolveInactiveMs(undefined),
      };
  const previous = existing ? { paneId: existing.paneId, tabId: existing.tabId, workspaceId: existing.workspaceId, workspaceLabel: existing.workspaceLabel, exitedAt: existing.exitedAt ?? now, exitCode: existing.exitCode, route: existing.route, model: existing.model } : undefined;
  // The record says how this run starts, so a later resume or restart replays it.
  if (launch.route) {
    child.route = launch.route;
    delete child.model;
  } else {
    delete child.route;
    if (kind === 'pi' && launch.provider && launch.harnessModel) child.model = { provider: launch.provider, id: launch.harnessModel, source: 'caller' };
  }

  // 1. The record lands first, with no pane, so a crash still says what was asked.
  child.paneId = '';
  delete child.tabId;
  delete child.exitedAt;
  delete child.exitCode;
  delete child.reportPending;
  // The new harness has yet to show herdr it runs, and the watcher checks it once after its start window.
  delete child.harnessSeenAt;
  delete child.harnessEnded;
  // A child brought back did not ask for this run to end its worktree.
  clearRetirement(child);
  child.lastStatus = 'unknown';
  child.statusChangedAt = now;
  child.lastBusyAt = now;
  child.resumedAt = now;
  upsertChild(parent.id, child);

  let registered = false;
  const restore = (): void => {
    removeChildFiles(child.id);
    // The files on the child's machine go too; a failed hop leaves them to that machine's prune.
    if (registered) void options.cleanupRemote?.(child).catch(() => {});
    // A resume of a session no child ran made the record, so a failure drops
    // it, as a failed spawn does: the parent hears nothing of a child that never ran.
    if (!previous) {
      removeChild(parent.id, child.id);
      return;
    }
    updateChild(parent.id, child.id, (entry) => {
      delete entry.startingUntil;
      entry.paneId = previous.paneId;
      entry.tabId = previous.tabId;
      entry.workspaceId = previous.workspaceId;
      entry.workspaceLabel = previous.workspaceLabel;
      entry.exitedAt = previous.exitedAt;
      entry.exitCode = previous.exitCode;
      if (previous.route) entry.route = previous.route;
      else delete entry.route;
      if (previous.model) entry.model = previous.model;
      else delete entry.model;
    });
  };

  // 2. A new tab, with the same environment the child first started with.
  // The prompt goes to a private file, like a spawn's brief, never into argv.
  // A child in a workspace Bellwether made for it goes back to that
  // workspace, or to a new one of its own once herdr has closed it.
  const fallback = options.workspaceId ?? (child.host === LOCAL_HOST ? parent.workspaceId : undefined);
  let tabId: string | undefined;
  let opened: ChildTab | undefined;
  let startup: StartupWatch | undefined;
  let reportWarning: string | undefined;
  try {
    // The same child id as before, so the server resolves to the same record.
    // A child on another machine gets its brief there, or the resume fails.
    const files = await childStartFiles({ ...child, kind }, options.prompt || undefined, options.registerRemote, options.piExtension);
    const { briefFile, mcpConfigFile, claudeSettingsFile, piExtension } = files;
    registered = files.registered;
    reportWarning = files.warning;
    const placement = await returnPlacement(client, child, fallback, signal);
    const tab = await openChildTab(client, placement, { cwd: child.cwd, label: child.name, env: childEnv(parent, child, piExtension), focus: options.focus ?? false }, signal);
    opened = tab;
    tabId = tab.tabId ?? tab.paneId;
    if (!tab.paneId) throw new Error('herdr created no pane for the resumed tab');
    child.tabId = tab.tabId;
    child.paneId = tab.paneId;
    child.workspaceId = tab.workspaceId;
    if (tab.workspaceLabel) child.workspaceLabel = tab.workspaceLabel;
    // A resumed Claude Code child paints the same development-channel dialog
    // as a new one, so the watcher holds its events while the resume answers.
    if (kind === 'claude') {
      const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      child.startingUntil = new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString();
      startup = await watchStartup(client, tab.paneId, signal, { timeoutMs, redrawMs: options.redrawMs });
    }
    upsertChild(parent.id, child);

    // 3. Start the harness on the session.
    const harnessArgs = childArgs(kind, { kind, name: child.name, model: launch.harnessModel, provider: launch.provider, args: [...args, ...(options.args ?? [])] }, { briefFile, mcpConfigFile, claudeSettingsFile, piExtension });
    await startHarness(client, { name: child.name, kind, paneId: tab.paneId, args: harnessArgs, ...(launch.route && launch.config ? { launch: routeLaunch(launch.config, launch.route, kind, harnessArgs) } : {}) }, signal);
  } catch (error) {
    startup?.close();
    await undoChildTab(client, opened);
    delete child.startingUntil;
    restore();
    throw error;
  }

  // 3b. Answer the startup dialogs. A child still on one when the wait runs
  // out is undone, as a spawn's is, and the error names the dialog.
  let answered: StartupDialog[] | undefined;
  if (startup) {
    try {
      answered = await startup.answer();
    } catch (error) {
      startup.close();
      await undoChildTab(client, opened ?? { tabId: tabId ?? child.paneId });
      restore();
      throw error;
    }
    startup.close();
  }

  // 4. Record the session herdr reports, the transcript on this machine, and
  // the live status, and lift the hold.
  let reported = undefined as ReturnType<typeof sessionFrom>;
  let status: ChildRecord['lastStatus'] | undefined;
  try {
    const result = await client.request('agent.get', { target: child.paneId }, { signal });
    const agent = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['agent'] : undefined;
    const pane = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>) : {};
    reported = sessionFrom(pane['agent_session']);
    if (typeof pane['agent_status'] === 'string' && pane['agent_status']) status = pane['agent_status'] as ChildRecord['lastStatus'];
  } catch {
    // The watcher reads the status and session on its next pass.
  }
  const kept = reported ?? { kind: session.kind, value: session.value };
  updateChild(parent.id, child.id, (entry) => {
    entry.session = kept;
    if (child.host === LOCAL_HOST) {
      // The same session in the same directory is the same file, so a resumed
      // child keeps the path it had.
      const found = locateTranscript(child.harness, kept.value, child.cwd);
      entry.transcript = found.path ?? entry.transcript;
      if (entry.transcript) delete entry.transcriptMissing;
      else entry.transcriptMissing = found.missing;
    }
    if (status && entry.lastStatus !== status) {
      entry.statusChangedAt = new Date().toISOString();
      entry.lastStatus = status;
    }
    delete entry.startingUntil;
  });

  const saved = readParent(parent.id)?.children.find((entry) => entry.id === child.id) ?? child;
  return { child: saved, session, link: herdrLink('pane', child.paneId), answered, ...(reportWarning ? { reportWarning } : {}) };
}
