// Bringing a child back. A child that exited keeps its record, so a spawn with
// a resume target (see spawn-resume.ts) opens a new tab on the host the child ran on, starts the harness with its
// session's resume flag, and puts the new pane under the same child id. The
// child's outbox entries and receipts are keyed by that id, so they continue.
import { briefAdded, briefDelivered, briefsCarried, briefsRestored, type NoticeOutcome } from './delivery.ts';
import { acquired } from './authority.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { HerdrClient, HerdrPane } from './herdr-client.ts';
import { briefsOf, nextBrief, type NextBrief } from './brief-history.ts';
import { withSessionCause } from './herdr-integration.ts';
import { removeChildFiles } from './mcp-config.ts';
import { LOCAL_HOST } from './machine.ts';
import { newChildId } from './outbox.ts';
import { readParent, recordDecisions, removeChild, updateChild, upsertChild } from './registry.ts';
import { clearRetirement, retiredItsWorktree } from './retire.ts';
import { keepCrossing } from './requests.ts';
import { firstRun, holdEvents, releaseEvents, restoreRun, runAwaitsPane, runOpens, sessionSeen, snapshotRun, statusSeen } from './incarnation.ts';
import { openReturnTab, returnPlacement, undoChildTab, type ChildTab } from './workspace.ts';
import { STARTUP_HOLD_MS, STARTUP_TIMEOUT_MS, childArgs, childEnv, childStartFiles, herdrLink, nextLaunch, startHarness, type RegisterRemote } from './spawn.ts';
import { agentKinds, harnessFor, harnessNamed, requireHarness, type HarnessSession } from './harnesses/index.ts';
import { routeLaunch } from './routes.ts';
import { watchStartup, type StartupDialog, type StartupWatch } from './startup-dialogs.ts';
import { sessionFrom } from './transcript.ts';
import { briefHoldMs, deliverBrief } from './brief-delivery.ts';
import type { Inbox } from './send.ts';
import type { BriefDelivery, ChildRecord, ParentRecord } from './types.ts';
import { resolveInactiveMs } from './inactivity.ts';

export type { HarnessSession } from './harnesses/index.ts';

/**
 * The session a child record names: the one herdr reported, kept after exit.
 * A record written before Bellwether kept it still has the transcript, which
 * names the session too: Claude Code names the file after the session id, and
 * Pi takes the file itself.
 */
export function sessionOf(child: Pick<ChildRecord, 'harness' | 'transcript' | 'session'>): HarnessSession | undefined {
  if (child.session?.value) return { value: child.session.value, kind: child.session.kind === 'path' ? 'path' : 'id' };
  if (!child.transcript) return undefined;
  return harnessNamed(child.harness)?.resume?.fromTranscript?.(child.transcript);
}

/** The arguments that make a harness reopen a session, or an error for one that cannot. */
export function resumeArgs(kind: string, session: HarnessSession): string[] {
  const resume = harnessFor(kind)?.resume;
  if (resume) return resume.args(session);
  const known = agentKinds().filter((name) => harnessFor(name)?.resume);
  throw new Error(`Bellwether cannot resume a ${kind} agent: only ${known.join(' and ')} have a resume flag it knows. Call agent_spawn without resume to start a fresh ${kind} child.`);
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
  /** The daemon's way into the child's session, which carries the brief. Without it, the brief is typed into the pane. */
  inbox?: Inbox;
  /** Who sends the brief, as the child reads it. */
  from?: string;
  /**
   * Called once the new tab exists and before the launch line goes into it.
   * A crossing records the tab here, so a daemon that stops between the
   * keystroke and herdr's report leaves the next one a tab it can close.
   */
  onTab?: (tab: { paneId: string; tabId?: string }) => void;
  /**
   * A teleport's notice (issue #226). It is the resumed session's first
   * input: an unread brief rides behind it in the same message. It goes only
   * through the session, never typed, and a model that does not take it
   * leaves the resume standing, with the reason on the result.
   */
  notice?: string;
}

/** How a teleport's notice reached the resumed session. */
export type { NoticeOutcome } from './delivery.ts';

export interface ResumeResult {
  child: ChildRecord;
  session: HarnessSession;
  link: string;
  /** The startup dialogs the resume answered, in order. */
  answered?: StartupDialog[];
  /** The brief the child started on, and the unread one it repeats, when there was one. */
  brief?: NextBrief;
  /** Which path carried the brief, for the reply. */
  briefNote?: string;
  /** For a resume that carried a teleport's notice: how it arrived. */
  notice?: NoticeOutcome;
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
  if (!kind) throw new Error(`A session no child of this parent ran needs a kind, ${agentKinds().filter((name) => harnessFor(name)?.resume).join(' or ')}, to resume it.`);
  // A harness with no resume flag fails here, before anything is written.
  resumeArgs(kind, { value: '', kind: 'id' });
  const session = target.session ?? (existing ? sessionOf(existing) : undefined);
  if (!session) {
    throw new Error(existing ? await withSessionCause(`${existing.name} has no recorded session, so there is nothing to resume. Pass resume with the session id and kind to reopen it as a new child.`, client, harnessFor(kind), existing) : 'A resume needs a child of this session or a session id.');
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
  // Retirement removed the worktree this child ran in, and a harness started
  // there would fail every command it runs (issue #143).
  const removedDir = existing && retiredItsWorktree(existing) ? (existing.cwd ?? existing.retireIntent?.worktree) : undefined;
  if (existing && removedDir && !fs.existsSync(removedDir)) {
    throw new Error(`${existing.name}'s working directory ${removedDir} no longer exists: retirement removed it at ${existing.retiredAt}, so Bellwether refused to resume the child there. Create it again, such as a worktree of the same branch, then resume.`);
  }
  const holder = panes.find((pane) => holdsSession(pane, session));
  if (holder) throw new Error(`Session ${session.value} is still alive in pane ${holder.paneId}${holder.name ? ` (${holder.name})` : ''}, so Bellwether refused to start a second copy.`);

  const child: ChildRecord = existing
    ? { ...existing }
    : {
        id: newChildId(),
        name: target.name ?? `resumed-${path.basename(session.value, '.jsonl').slice(-8)}`,
        kind,
        harness: requireHarness(kind).harness,
        ...firstRun({ paneId: '', host: target.host ?? LOCAL_HOST, cwd: target.cwd }),
        ...acquired('resume'),
        startedAt: now,
        statusChangedAt: now,
        lastBusyAt: now,
        depth: parent.depth + 1,
        inactiveMs: resolveInactiveMs(undefined),
      };
  // The prompt gets a file of its own. A brief nothing shows the child read
  // goes ahead of it, so a child whose harness exited before reading its task
  // still gets it (issue #132).
  const next = nextBrief(child, options.prompt || undefined, now);
  const previousBriefs = child.briefs?.map((brief) => ({ ...brief }));
  const knownBriefs = briefsOf(child).map((brief) => ({ ...brief }));
  const previous = existing ? { workspaceId: existing.workspaceId, workspaceLabel: existing.workspaceLabel, route: existing.route, model: existing.model } : undefined;
  // A resume that fails puts the run before it back, field for field, as an exited one.
  const previousRun = existing ? snapshotRun(existing, { exitedAt: existing.exitedAt ?? now }) : undefined;
  // The record says how this run starts, so a later resume or restart replays it.
  if (launch.route) {
    child.route = launch.route;
    delete child.model;
  } else {
    delete child.route;
    if (requireHarness(kind).chosenBy === 'pair' && launch.provider && launch.harnessModel) child.model = { provider: launch.provider, id: launch.harnessModel, source: 'caller' };
  }

  // 1. The record lands first, with no pane, so a crash still says what was
  // asked. Until the new tab names a pane, the run before stays ended, with
  // any failed restart or crossing it carries: a daemon that stops here leaves
  // a record the watcher and doctor read as exited, never one with no pane
  // and no exit that nothing repairs. The new harness has yet to show herdr it
  // runs, and the watcher checks it once after its start window.
  // Bellwether starts this harness, so the parent holds the child as one it
  // started from now on, whether it first came by adoption or not (issue #256).
  runAwaitsPane(child, { tabId: undefined, resumedAt: now, launchedAt: now, at: now });
  // A child brought back did not ask for this run to end its worktree.
  clearRetirement(child);
  child.statusChangedAt = now;
  child.lastBusyAt = now;
  // The brief this start hands over carries an unread one. A session message
  // that carried that one is not offered again when the session reconnects,
  // so the child takes the task once.
  if (next?.repeats) {
    briefsCarried(child, new Set([...(next.repeats.carries ?? []), next.repeats.n]), `brief ${next.brief.n} carries it into the resumed session`);
  }
  upsertChild(parent.id, child);

  let registered = false;
  const restore = (): void => {
    // A failed resume removes only the brief it wrote: the earlier ones stay
    // for the next resume and for a person, and a record it made takes all.
    removeChildFiles(child.id, undefined, { briefs: !previous });
    if (previous && next && !next.reused) fs.rmSync(next.brief.file, { force: true });
    // The files on the child's machine go too; a failed hop leaves them to that machine's prune.
    if (registered) void options.cleanupRemote?.(child).catch(() => {});
    // A resume of a session no child ran made the record, so a failure drops
    // it, as a failed spawn does: the parent hears nothing of a child that never ran.
    if (!previous) {
      removeChild(parent.id, child.id);
      return;
    }
    updateChild(parent.id, child.id, (entry) => {
      if (previousRun) restoreRun(entry, previousRun);
      entry.workspaceId = previous.workspaceId;
      entry.workspaceLabel = previous.workspaceLabel;
      if (previous.route) entry.route = previous.route;
      else delete entry.route;
      if (previous.model) entry.model = previous.model;
      else delete entry.model;
      briefsRestored(entry, previousBriefs);
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
  try {
    // The same child id as before, so the server resolves to the same record.
    // A child on another machine gets its brief there, or the resume fails.
    const { registered: there, ...files } = await childStartFiles(parent, { ...child, kind }, next?.text, options.registerRemote, options.piExtension, launch.harnessModel, next?.brief.n);
    registered = there;
    if (files.toolSource) child.toolSource = files.toolSource;
    const placement = await returnPlacement(client, child, fallback, signal);
    const tab = await openReturnTab(client, placement, { cwd: child.cwd, label: child.name, env: { ...childEnv(parent, child, files.piExtension), ...files.env }, focus: options.focus ?? false }, child.workspaceLabel || child.name, signal);
    opened = tab;
    tabId = tab.tabId ?? tab.paneId;
    if (!tab.paneId) throw new Error('herdr created no pane for the resumed tab');
    if (options.onTab) {
      options.onTab({ paneId: tab.paneId, ...(tab.tabId ? { tabId: tab.tabId } : {}) });
      // The hook wrote the crossing's mark to the record, and the writes below must keep it.
      const marked = readParent(parent.id)?.children.find((entry) => entry.id === child.id)?.moving;
      keepCrossing(child, marked);
    }
    runOpens(child, { paneId: tab.paneId, tabId: tab.tabId });
    child.workspaceId = tab.workspaceId;
    if (tab.workspaceLabel) child.workspaceLabel = tab.workspaceLabel;
    if (next) {
      next.brief.paneId = tab.paneId;
      briefAdded(child, knownBriefs, next.brief);
    }
    // A resumed Claude Code child paints the same development-channel dialog
    // as a new one, so the watcher holds its events while the resume answers.
    const dialogs = requireHarness(kind).startup;
    if (dialogs) {
      const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      holdEvents(child, new Date(Date.now() + Math.max(STARTUP_HOLD_MS, timeoutMs + 15_000)).toISOString());
      startup = await watchStartup(client, tab.paneId, signal, { timeoutMs, redrawMs: options.redrawMs, dialogs, by: 'resume' });
    }
    upsertChild(parent.id, child);

    // 3. Start the harness on the session.
    const harnessArgs = childArgs(kind, { model: launch.harnessModel, provider: launch.provider, args: options.args }, files, { resume: args });
    await startHarness(client, { name: child.name, kind, paneId: tab.paneId, args: harnessArgs, ...(launch.route && launch.config ? { launch: routeLaunch(launch.config, launch.route, kind, harnessArgs) } : {}) }, signal);
  } catch (error) {
    startup?.close();
    await undoChildTab(client, opened);
    releaseEvents(child);
    restore();
    throw error;
  }

  // 3b. Answer the startup dialogs. A child still on one when the wait runs
  // out is undone, as a spawn's is, and the error names the dialog.
  let answered: StartupDialog[] | undefined;
  if (startup) {
    try {
      answered = await startup.answer();
      recordDecisions(parent.id, child.id, startup.decisions);
    } catch (error) {
      startup.close();
      await undoChildTab(client, opened ?? { tabId: tabId ?? child.paneId });
      restore();
      throw error;
    }
    startup.close();
  }

  // 3c. Hand over the brief, as a spawn does: through the session once the
  // harness runs, or typed when that path is not available. A harness that
  // exits first fails the resume.
  let briefNote: string | undefined;
  let notice: NoticeOutcome | undefined;
  if (options.notice !== undefined || (next && !requireHarness(kind).brief.launch)) {
    const held = new Date(Date.now() + briefHoldMs(options.inbox)).toISOString();
    updateChild(parent.id, child.id, (entry) => {
      holdEvents(entry, held);
    });
    try {
      // A notice comes first, so the session reads where it is before the
      // task it did not take; both go as one message, so nothing lands between.
      const text = options.notice === undefined ? (next?.text ?? '') : next ? `${options.notice}\n\n---\n\n${next.text}` : options.notice;
      const handed = await deliverBrief({ herdr: client, parentId: parent.id, child, ...(next ? { brief: next.brief } : {}), text, from: options.from ?? parent.id, inbox: options.inbox, fatal: requireHarness(kind).startupFatal, signal, ...(options.notice === undefined ? {} : { notice: true as const }) });
      if (next) {
        briefDelivered(next.brief, handed.delivery);
        briefNote = handed.note;
      }
      if (options.notice !== undefined) notice = { delivery: handed.delivery, ...(handed.notTaken ? { notTaken: handed.notTaken } : {}) };
    } catch (error) {
      await undoChildTab(client, opened ?? { tabId: tabId ?? child.paneId });
      restore();
      throw error;
    }
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
    sessionSeen(entry, kept);
    if (child.host === LOCAL_HOST) {
      // The same session in the same directory is the same file, so a resumed
      // child keeps the path it had.
      const found = requireHarness(kind).conversation.locate(kept.value, child.cwd);
      entry.transcript = found.path ?? entry.transcript;
      if (entry.transcript) delete entry.transcriptMissing;
      else entry.transcriptMissing = found.missing;
    }
    if (status && statusSeen(entry, status)) entry.statusChangedAt = new Date().toISOString();
    releaseEvents(entry);
  });

  const saved = readParent(parent.id)?.children.find((entry) => entry.id === child.id) ?? child;
  return { child: saved, session, link: herdrLink('pane', child.paneId), answered, ...(next ? { brief: next } : {}), ...(briefNote ? { briefNote } : {}), ...(notice ? { notice } : {}) };
}
