import type { ToolSource } from './tool-source.ts';
import type { TeleportEntry } from './teleport-plan.ts';
/** The lifecycle states herdr reports for an agent in a pane. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/**
 * Where Bellwether learned of a dialog: the harness whose adapter named it,
 * such as `pi` for a pi child's extension or `claude-code` for a Claude Code
 * child's Notification hook, or `screen` for the screen check before an idle
 * event.
 */
export type PromptSource = string;

/** A dialog a child waits on, named in one line, and where Bellwether learned of it. */
export interface ChildPrompt {
  line: string;
  source: PromptSource;
  /**
   * pi's prompt kind: select, confirm, input, editor or custom. For Claude
   * Code, the hook's notification type: permission_prompt,
   * elicitation_dialog or elicitation_url_dialog.
   */
  kind?: string;
  since: string;
}

/**
 * A dialog Bellwether answered for a child, and what the answer decided. The
 * spawn, a resume, a restart or the watcher writes one for each answer whose
 * dialog says what it decides (`KnownDialog.decides` in
 * src/core/startup-dialogs.ts). The parent hears of each one once: in the
 * spawn's reply, or in its next event about the child.
 */
export interface DialogDecision {
  /** The dialog's id in its harness's set, such as `outside-read`. */
  dialog: string;
  /** The dialog's name in a message. */
  name: string;
  /** The question as the screen asked it. */
  question: string;
  /** The option chosen. */
  answer: string;
  /** What the answer decided, in one clause. */
  decided: string;
  /** Every key sent to the pane for this answer, in order. */
  keys: string[];
  /** When the answer went in. */
  at: string;
  /** Which part of Bellwether answered. */
  by: 'spawn' | 'resume' | 'restart' | 'watcher';
  /**
   * `declined` when the answer refused what the child asked to do, such as a
   * read beyond its read set, and `accepted` otherwise. A parent that reads a
   * declined read widens the child's set with `reads`, rather than send the
   * same instruction again.
   */
  outcome: 'accepted' | 'declined';
  /** For a declined read, the path the child asked to read, as the dialog showed it. */
  path?: string;
  /** Set once the parent has been told. */
  told?: boolean;
}

/**
 * How an agent's last pane ended, as herdr told the watcher (issue #187):
 * - `exited`: herdr reported the pane's process exit, with its code when it gave one.
 * - `closed`: herdr closed the pane or its tab.
 * - `missing`: a reconcile found the pane no longer listed, so no event said how it went.
 * - `harness-ended`: the harness ended and the pane stayed open on its shell.
 * - `restart`: a restart closed the pane and then failed to start the session again.
 * - `session-changed`: herdr reported another session in an adopted child's pane, which `session` names (issue #211).
 * - `adopt-refused`: the far machine refused an adoption whose first answer was lost, for `reason` (issue #211).
 */
export interface PaneEnd {
  pane: string;
  /** The workspace the pane was in, which herdr may have removed with it. */
  workspaceId?: string;
  how: 'exited' | 'closed' | 'missing' | 'harness-ended' | 'restart' | 'session-changed' | 'adopt-refused';
  at: string;
  code?: number;
  /** For `session-changed`: the session herdr reported in the pane instead. */
  session?: string;
  /** For `adopt-refused`: why the far machine refused. */
  reason?: string;
}

/**
 * A restart that closed the old pane and then failed to start the session
 * again, so the session is gone. It stays on the record until the session
 * returns, for `bellwether doctor` and, for a child, for its parent's event.
 */
/** A restart on another machine whose answer was lost with its connection (issue #211). */
export interface RestartInDoubt {
  host: string;
  /** The id the request carried, which the far side's kept answer names. */
  requestId: string;
  at: string;
  /** The pane and tab the child ran in there before the restart. */
  oldPane: string;
  oldTab?: string;
  /** How the connection ended. */
  error: string;
  /** What the restart starts the child on, which the record takes once the answer says it came back. */
  launch: { route?: ChildRoute; harnessModel?: string; provider?: string };
}

/**
 * A move or a teleport under way, on the child record. Besides the window
 * that keeps the watcher, a restart and a resume off the child, it carries
 * what a daemon that starts after the crossing daemon stopped needs to finish
 * or undo it: which daemon runs it, how far it got, the files it wrote at the
 * destination, and where the child ran before.
 */
export interface Crossing {
  from: string;
  to: string;
  since: string;
  until: string;
  /** `move` or `teleport`. Absent on a mark written before 0.1.10. */
  verb?: 'move' | 'teleport';
  /** The daemon process that runs the crossing. Another daemon that finds the mark knows the crossing stopped with it. */
  daemon?: string;
  /** The last step the crossing finished. */
  stage?: 'checked' | 'copied' | 'verified' | 'stopped' | 'recopied' | 'launching' | 'started';
  /** Whether the child ran when the crossing began. */
  state?: 'live' | 'stopped';
  /** The files the copy wrote at the destination, and whether each was new there. */
  files?: { path: string; created: boolean }[];
  /** Where the child ran before, as its record said. */
  source?: { cwd?: string; paneId: string; tabId?: string; workspaceId?: string; session?: { kind: string; value: string }; transcript?: string; exitedAt?: string };
  /**
   * Where it resumes, and the session it resumes there once the copy names it.
   * From the step `launching` on, it also names the tab the crossing opened at
   * the destination, before the launch line goes into it, so a daemon that
   * finds the crossing interrupted can close a harness herdr has yet to report.
   */
  target?: { cwd: string; session?: { kind: string; value: string }; paneId?: string; tabId?: string };
  /** The session file on the source, which the crossing never changes. */
  sourceFile?: string;
  reason?: string;
  by?: string;
}

/** A teleport a child asked for itself, as the record keeps it while the child's turn ends. */
export interface TeleportRequestRecord {
  at: string;
  machine: string;
  cwd?: string;
  reason?: string;
  /** What the request waits for: the child's pane to end its turn, until a bound. */
  wait?: RestartWait;
}

/** A crossing that left the child running nowhere (issue #226). */
export interface CrossingFailure {
  at: string;
  verb: 'move' | 'teleport';
  from: string;
  to: string;
  /** The last step the crossing finished. */
  stage: string;
  error: string;
  /** The session file on the source, intact. */
  sourceFile?: string;
  /** How to bring the child back. */
  reopen: string;
  /** True when a daemon stopped in the middle of the crossing, rather than the crossing failing on its own. */
  interrupted?: boolean;
  /** Set once the parent has received the event about it. */
  told?: boolean;
}

export interface RestartFailure {
  at: string;
  /** The pane the session last ran in, now closed. */
  oldPane: string;
  /** The workspace that pane was in. */
  workspaceId?: string;
  session: string;
  error: string;
  /** How to bring the session back: the command and its directory for a session, the agent_spawn resume for a child. */
  reopen: string;
  /** Set once the parent has received the event about it. */
  told?: boolean;
}

/**
 * A self-restart waiting for its session's turn to end. A busy session may
 * never end one, so the wait gives up at `until` (issue #188).
 */
export interface RestartWait {
  /** When the wait gives up. */
  until: string;
  /** The pane whose turn it waits on. */
  paneId: string;
  /** The status herdr last reported for that pane, and since when. */
  status?: string;
  statusSince?: string;
}

/** A self-restart that gave up because its session never ended a turn in time. */
export interface RestartStall {
  at: string;
  /** When the request that gave up was made, and the pane it waited on (issue #220). */
  requestedAt?: string;
  paneId?: string;
  /** What held it: the live turn, the messages that reached the session, its working children. */
  reason: string;
}

/** What the parent is told about a child. */
export type ChildEventKind = 'report' | 'idle' | 'blocked' | 'stuck' | 'inactive' | 'exited';

/** The three things a child can report through parent_report. */
export type ReportStatus = 'done' | 'needs-input' | 'progress';

/**
 * Which path sent a report: the child's own `parent_report` tool, or the
 * `bellwether report` command from its shell. The two are separate
 * capabilities, so a parent can tell whether the tool reached the session.
 */
export type ReportVia = 'tool' | 'shell';

/** The harnesses a parent session runs in, which have a Bellwether adapter. A child's harness is any name in the harness registry. */
export type Harness = 'pi' | 'claude-code' | 'opencode';

/**
 * The harness session herdr reports for a pane: `kind` is `id` for Claude Code,
 * whose value `claude --resume` takes, and `path` for Pi, whose value is the
 * session file.
 */
/** One brief a child was started on. See `src/core/brief-history.ts`. */
export interface ChildBrief {
  /** 1 for the spawn's brief, then one more for each resume that brought a prompt. */
  n: number;
  /** The file on this machine that holds what the child was given at that start. */
  file: string;
  /** When the file was written. A report after this proves the child read it. */
  at: string;
  /** The pane that started on it. A finished turn in that pane proves the child read it. */
  paneId?: string;
  /** The earlier briefs this one repeats, because the record could not prove the child read them. */
  carries?: number[];
  /** How the brief reached the harness, once the start handed it over. A start that failed leaves it out. */
  delivery?: BriefDelivery;
}

/**
 * How a brief reached its child (issue #162). `session` is a message the
 * child's own Bellwether adapter received, the same path agent_send takes,
 * and that its model then took (issue #176): the adapter's receipt proves the
 * transport, and the reader is proven by the adapter's read receipt together
 * with a turn herdr reports.
 * `keystrokes` is the fallback, typed into the pane, with the reason the
 * session path was not taken. `launch` is the first prompt on the launch line
 * of a harness that takes no message in its session and whose own store
 * confirmed that prompt.
 */
export interface BriefDelivery {
  path: 'session' | 'keystrokes' | 'launch';
  /** For the session path: the adapter that received it, `claude-channel` or `pi-message`. */
  via?: string;
  /** For the session path: when the adapter received the message that carried it. Transport, not reading. */
  receivedAt?: string;
  /** For the session path: why the adapter's receipt is missing, when its session had not answered within the bound. Nothing was typed. */
  unanswered?: string;
  /** For the session path: when the adapter reported the model read it. */
  readAt?: string;
  /** For the session path: when the model took it, the later of its read receipt and its first turn. */
  takenAt?: string;
  /** For the session path: `turn` once the adapter's read receipt and a `working` status both came for one copy. Before 0.1.10, either fact alone settled it: `turn` for the status, `read` for the receipt. A read with no turn leaves it out and keeps `readAt` (issue #246). */
  takenBy?: 'turn' | 'read';
  /** The message that carried the first copy, when no read came for it and the brief went again. */
  resentFrom?: string;
  /** The message whose read settled the brief, when it is not `message`: the first copy's read arrived after the second copy went out (issue #246). */
  readFrom?: string;
  /** For keystrokes and launch: why the brief did not go into the session. */
  reason?: string;
  /** The message under `messages` that carried it, for the session path and keystrokes. */
  message?: string;
  at: string;
}

export interface ChildSession {
  kind: string;
  value: string;
}

/**
 * How a child was launched through a route: a launcher wrapper from this
 * machine's routes file. A child with no route started bare. The key file is
 * kept by path only, never by contents, so a person debugging routing can see
 * that two children ran under different keys.
 */
export interface ChildRoute {
  /** The route's name in the routes file. */
  name: string;
  /** The tier the launcher got. */
  tier?: string;
  /** The absolute path of the key file the launcher ran under. */
  keyFile?: string;
}

/**
 * One child of a parent session. The record is written before herdr creates
 * anything, so a crash still leaves a trace of what was asked for.
 */
export interface ChildRecord {
  id: string;
  /** The name the parent gave the child. Tools address the child by it. */
  name: string;
  /**
   * The name herdr reports for the agent, when the harness chose another one,
   * as a pi naming extension does. A tool call may use it too, unless two
   * children answer to it.
   */
  agentName?: string;
  /**
   * The provider and model a pi child runs on, and where the pair came from:
   * the spawn's caller, the parent session, or the child's own session file
   * when neither named one and pi chose its default.
   */
  /**
   * `saved` is pi's saved default, which the spawn passed as flags when the
   * parent's pair was unknown (issue #189). `setting` names the file it came
   * from, and `over` names what pi would have taken on its own, when that differs.
   */
  model?: ModelPair & { source: 'caller' | 'parent' | 'session' | 'saved'; setting?: string; over?: string };
  /** The route the child was launched through, or absent for a bare start. A restart or resume that changes route rewrites it. */
  route?: ChildRoute;
  /** The herdr agent kind, which names the child's entry in the harness registry. */
  kind: string;
  /** The harness's name from its registry entry, such as `claude-code`. A record written before the registry knew its kind says `other`. */
  harness: string;
  /**
   * The OpenCode store an OpenCode child's session lives in. The spawn passes
   * the same path to the child as OPENCODE_DB, so both sides read one file.
   */
  store?: string;
  readonly paneId: string;
  readonly tabId?: string;
  /** The herdr workspace that holds the child's tab, on the child's machine. */
  workspaceId?: string;
  /** That workspace's label, when the spawn knew it. */
  workspaceLabel?: string;
  /**
   * Set when Bellwether created the workspace for this child, with
   * `workspace: "new"`. Only such a workspace is ever closed, and only once
   * it holds no tab.
   */
  ownsWorkspace?: boolean;
  /**
   * The herdr server the child runs on: `local` for this machine's, or the
   * label of a saved herdr machine. Pane ids are scoped to one server, so
   * every herdr call for the child goes to this host, and a resume goes back
   * to it.
   */
  readonly host: string;
  /** How the child came under this parent. An older record means spawn. */
  origin?: 'spawn' | 'adopt' | 'resume';
  /** When the child was last brought back by a spawn with a resume target. */
  readonly resumedAt?: string;
  readonly cwd?: string;
  startedAt: string;
  /** The last status herdr reported for the pane. */
  readonly lastStatus: AgentStatus;
  /** Set when the status last changed, for the settle time. */
  statusChangedAt: string;
  /** herdr's completion_seq for the last finished turn. */
  completionSeq?: number;
  /**
   * The pane whose herdr gave `completionSeq`. herdr numbers each pane's turns
   * on its own, so a number from an earlier pane says nothing about the pane
   * the child runs in after a restart, resume, move or teleport (issue #271).
   * A record without it holds a number from the pane its `turnNotified` names.
   */
  completionPane?: string;
  /** The child's transcript file, when its harness keeps one. Kept after exit. */
  transcript?: string;
  /**
   * Why a child on this machine has no transcript yet, such as a Claude Code
   * session that has not had its first turn. Cleared once the file is found.
   */
  transcriptMissing?: string;
  /**
   * Which server gives a Claude Code child its Bellwether tools, and each
   * other Bellwether server its environment held that the spawn kept out.
   * Written at each start, so a resume or restart says what that start chose.
   */
  toolSource?: ToolSource;
  /**
   * The harness session, recorded as soon as herdr reports it and kept after
   * the child exits, so a retired child can still be resumed.
   */
  readonly session?: ChildSession;
  /** herdr's state_change_seq for the newest status Bellwether has read. */
  stateChangeSeq?: number;
  /** How many Bellwether generations deep this child is. */
  depth: number;
  /**
   * The child's ceiling: the deepest generation its own descendants may sit
   * at, so it spawns only while its depth plus one is at most this. Set by
   * the spawn and raised by a depth grant. A record from before ceilings
   * were kept has none, and counts as the default.
   */
  maxDepth?: number;
  /** Every depth request the child made, open or settled. */
  depthRequests?: DepthRequest[];
  /** Every raise of the ceiling: who granted it, when, how far and why. */
  depthGrants?: DepthGrant[];
  /**
   * Each brief the child was started on, oldest first: the spawn's prompt,
   * then each resume's. Every one has its own file on this machine, so no
   * resume writes over a brief the child may not have read. A record written
   * before this field has none, and its spawn's brief, if still on disk, is
   * `prompts/<child id>.md`. Added without a protocol bump: only the daemon
   * reads it.
   */
  briefs?: ChildBrief[];
  /** The newest messages a parent sent the child, with the path each took. */
  messages?: ChildMessage[];
  /** The last report the child sent, when, and the path it took. */
  lastReport?: { status: ReportStatus; text: string; at: string; seq: number; via?: ReportVia; toolOffered?: boolean };
  /**
   * Set when a final report arrives while its turn still runs, and cleared
   * when that turn ends, so a child that reported does not also produce an
   * idle event for the same turn.
   */
  readonly reportPending?: boolean;
  /**
   * The newest turn the parent heard about, by a report or an idle event, and
   * the pane that ran it. The watcher compares each finished turn against it
   * rather than against herdr's current answer, so a status herdr repeats, a
   * snapshot that reads the same turn again, or a watcher that starts again
   * raises no second event. `seq` is herdr's completion_seq, or the watcher's
   * own count of turns ends for a pane herdr does not number.
   */
  turnNotified?: { paneId: string; seq: number };
  /**
   * Set when the child runs in a pane where the parent has heard of no turn
   * yet, after a restart, resume, move or teleport gave it that pane (issue
   * #271). The parent heard every turn of the earlier panes, so the resumed
   * session's first settled screen is not a turn, and neither is a number
   * herdr shows there before the child works. `seq` is the number herdr showed
   * then, and `worked` says the child has since worked in this pane, so its
   * next ready status ends a turn. The field goes once a turn in this pane is
   * notified, which `turnNotified` then names. It never proves a brief read.
   */
  turnBaseline?: { paneId: string; seq?: number; worked?: true };
  /** The last time the child's transcript or screen moved. */
  lastBusyAt: string;
  /**
   * The dialog the child waits on while one is open, which herdr can report
   * as idle. `pi` comes from the child's own pi extension, on pi's
   * ui_prompt_start and ui_prompt_end events, `claude-code` from the
   * Notification hook in a Claude Code child's own settings, and `screen` from
   * the check the watcher makes before an idle event. A screen prompt clears on
   * herdr's next status, and a pi prompt clears when pi says it closed. Claude
   * Code sends no notice when a dialog closes, so a hook prompt clears when
   * herdr reports the child working, or leaving blocked.
   */
  prompt?: ChildPrompt;
  /**
   * Each dialog Bellwether answered for the child, oldest first. Only a child
   * Bellwether started gets an answer: an adopted child's dialogs reach the
   * parent as blocked.
   */
  decisions?: DialogDecision[];
  /**
   * The paths this child reads beside its working directory and the
   * Bellwether home, as its spawn or a restart named them in `reads`. Its
   * launch settings list them, and a resume or restart keeps them.
   */
  reads?: string[];
  /** This child's own stuck threshold, when its spawn set one. */
  stuckMs?: number;
  /**
   * Set while the spawn answers the harness's startup dialogs, so the watcher
   * does not report a blocked child the spawn is about to unblock. A time
   * rather than a flag, so a daemon that stops mid-spawn cannot silence the
   * child for good.
   */
  readonly startingUntil?: string;
  /**
   * Set while a restart closes the pane and tab the record still names, so the
   * watcher reads that close as part of the restart rather than as the child
   * exiting (issue #211). The record keeps naming the old pane until herdr
   * has closed it. A time rather than a flag: a daemon that stops mid-close
   * leaves a record the watcher checks against herdr once the time passes.
   */
  readonly closing?: { pane: string; tab?: string; until: string };
  /**
   * Set when a restart of a child on another machine sent its request and the
   * connection ended before the answer came back (issue #211). The far side
   * may have closed the old pane and started the session in a new one, so
   * the record claims neither. The far daemon keeps its answer in the relay
   * outbox, and this daemon takes it from there when the connection returns.
   */
  readonly restartInDoubt?: RestartInDoubt;
  /** This child's inactivity threshold in milliseconds. Set at spawn; the default when absent. */
  inactiveMs?: number;
  /** The quiet period whose inactive event already went out, as an ISO time. Survives a restart. */
  inactiveNotifiedFor?: string;
  /**
   * Set when the child asked to be restarted, and cleared once the daemon has
   * restarted it. The deferral is on the record, not in a timer, so a daemon
   * that stops mid-wait finishes it on its next start.
   */
  restartRequestedAt?: string;
  /**
   * What a requested restart changes about the route: `via` names a route, or
   * `none` to leave one, with the tier or model, key file and pi provider.
   * Absent, the restart keeps the route on the record. It sits on the record
   * with the request, so a daemon that stops mid-wait keeps it.
   */
  restartRoute?: { via?: string; model?: string; keyFile?: string; provider?: string; reads?: string[] };
  /** When the daemon last restarted the child in a new tab, on the same session. */
  restartedAt?: string;
  /** Set when a restart closed the child's pane and could not start it again (issue #185). A later restart or resume clears it. */
  readonly restartFailed?: RestartFailure;
  /** What a pending self-restart waits for, while `restartRequestedAt` is set (issue #188). */
  restartWait?: RestartWait;
  /** Why the last self-restart gave up without acting, until the next request (issue #188). */
  restartStalled?: RestartStall;
  /**
   * Set while agent_move carries the child to another machine. The watcher
   * ignores the close of the child's old pane while it is set, so the parent
   * hears no exit for a child that is only changing machines. A time rather
   * than a flag, so a daemon that stops mid-move cannot silence the child for
   * good.
   */
  moving?: Crossing;
  /**
   * Set when a move or a teleport stopped the child and could not start it on
   * either machine, or when a crossing that a stopped daemon left half done
   * could not be undone. A later resume clears it.
   */
  readonly crossingFailed?: CrossingFailure;
  /** A teleport this child asked for itself, which waits for its turn to end (issue #226). */
  teleportRequest?: TeleportRequestRecord;
  /** Why the last teleport the child asked for itself did not run, until its next request. */
  teleportStalled?: RestartStall & { machine?: string };
  /**
   * The place the child last moved away from: the newest entry of
   * `departures`. A daemon from before issue #241 reads only this field, so
   * every daemon that writes the list writes it too.
   */
  movedFrom?: Departure;
  /**
   * Every place the child left by a move or a teleport, oldest first, one
   * entry per place (issue #241). The parent's daemon drains each machine in
   * it once after the child left, and retires each worktree in it that sits on
   * its own machine. A retired worktree leaves the list, and so does a place
   * the child comes back to. Read it with `departuresOf`, which also counts a
   * `movedFrom` an older daemon wrote.
   */
  departures?: Departure[];
  /** Each teleport of this child, newest last (issue #226): where from and to, who asked, how the notice arrived, and the proof it runs. */
  teleports?: TeleportEntry[];
  /** Set once the child is gone, so its events stop. */
  readonly exitedAt?: string;
  readonly exitCode?: number;
  /** How the pane the child last ran in ended, for agent_list (issue #187). It counts only while `exitedAt` is set. */
  readonly paneEnd?: PaneEnd;
  /**
   * When herdr first saw the harness run in the child's pane: a detected
   * agent, or a status other than unknown. A child without it after its start
   * window is checked once, to tell a harness that died at once from one that
   * is still loading.
   */
  readonly harnessSeenAt?: string;
  /**
   * How the child's harness ended, when its pane outlived it: `before-start`
   * for one that ended before it reported anything, so it never ran its task,
   * and `in-pane` for one that ended later. Either way the tab stays open on
   * the shell that ran it.
   */
  readonly harnessEnded?: 'before-start' | 'in-pane';
  /**
   * Set when herdr closed the tab of a child whose harness had already ended
   * in it. herdr can name one close twice, as `pane_closed` and `tab_closed`,
   * so the watcher releases the workspace and starts retirement for the first
   * and ignores the second. Cleared with `harnessEnded` when the child comes
   * back.
   */
  readonly tabClosedAt?: string;
  /**
   * For an adopted child whose harness ended and left its pane open: when.
   * The watcher keeps watching that pane, and a harness that comes back there
   * under the same session is the same child again, under the same id (issue
   * #191). Cleared when it comes back, when the pane closes, or when another
   * session takes the pane.
   */
  readonly awaitsResume?: string;
  /**
   * The child's machine answered that it holds no record of this child, while
   * this registry still does, and the record could not be restored there
   * (issue #219). Messages to it are typed until then. Cleared once that
   * machine holds it again.
   */
  farRecordLost?: { at: string; host: string; reason: string };
  /**
   * An adoption on another machine whose answer the relay lost, so the parent
   * does not know whether that machine recorded the claim (issue #211, item 6).
   * The watcher holds the child's events and asks that machine again, and
   * clears this once it answers.
   */
  adoptInDoubt?: { at: string; host: string; reason: string };
  /**
   * For an adopted child that exited: the child id that now stands for its
   * session, because the machine that runs it holds the session under that id
   * rather than this one (issue #191).
   */
  replacedBy?: string;
  /**
   * Set when the child asked to be retired, or its parent stopped it. The daemon cleans up once herdr
   * reports the pane gone. Every retirement field is optional, so an older
   * record loads unchanged.
   */
  retireRequestedAt?: string;
  /** What the child asked to have removed, as the daemon read it while the child was alive. */
  retireIntent?: RetireIntent;
  /** How far the cleanup got, so a daemon restarted part of the way through skips what is done. */
  retireStage?: 'worktree-removed' | 'branch-deleted';
  /** When the cleanup finished, whichever way. */
  retiredAt?: string;
  /**
   * `removed` only when nothing the record knows of stays in place. `partial`
   * when a worktree was removed but another one stays: one the child left
   * here that failed its proofs, or one on another machine whose daemon
   * refused it or has not answered (issues #273, #242). `refused` when
   * nothing was removed.
   */
  retireOutcome?: 'removed' | 'partial' | 'refused';
  /** For a refusal: the condition that failed, and what a person would do about it. For a partial retirement: what stays. */
  retireReason?: string;
  /**
   * For a removal: the proof that the work exists elsewhere, such as the
   * default branch containing it. Optional and additive: an older record
   * loads unchanged, and an older daemon ignores it.
   */
  retireProof?: string;
}

/**
 * A child's request for a deeper ceiling, kept on its record in its parent's
 * registry. A request the parent could not grant from its own ceiling goes on
 * to the grandparent as a request of its own, which names this one in
 * `onBehalfOf`, so the answer settles both.
 */
export interface DepthRequest {
  id: string;
  /** How many generations below the child it asked for. */
  levels: number;
  /** The ceiling asked for: the child's depth plus levels. */
  ceiling: number;
  /** The child's sentence naming the work that needs the levels. */
  reason: string;
  at: string;
  state: 'pending' | 'forwarded' | 'granted' | 'refused';
  /** For a forwarded request, the id of the request it became upstream. */
  forwardedAs?: string;
  /** For a request made on a child's behalf: where that child's own request waits. */
  onBehalfOf?: { parentId: string; childId: string; requestId: string; name: string };
  decidedAt?: string;
  decidedBy?: string;
  /** For a refusal, what the child was told. */
  refusal?: string;
}

/**
 * One message a parent sent a child, and how it got there. `session` means
 * the child's own Bellwether server or extension put it in the session as a
 * message; `keystrokes` means herdr typed it into the child's pane.
 */
export interface ChildMessage {
  id: string;
  at: string;
  path: 'session' | 'keystrokes';
  /** For the session path: the adapter that carried it, `claude-channel` or `pi-message`. */
  via?: string;
  /** For keystrokes: why the session path was not taken. */
  reason?: string;
  /** For the session path: when the child's model received it. */
  readAt?: string;
  /** Why the message never reached the child's model. */
  undelivered?: string;
  /** The start of the text, for agent_list and the exit event. */
  preview: string;
  /** The whole text, kept only while a session message waits to be read, so a reconnected session can take it again. */
  text?: string;
  /** Who sent it, as the child reads it, kept with the text. */
  from?: string;
  /** The number of the brief this message carried, for a start's brief rather than a parent's message. */
  brief?: number;
  /**
   * For a child on another machine: why the far daemon's answer is not known,
   * after the relay connection ended or timed out while the message was out
   * (issue #218). The far session may hold it, so nothing is typed. The
   * parent's daemon asks the far daemon again once the connection is back,
   * and the field goes when that answer arrives.
   */
  relayInDoubt?: string;
  /**
   * For keystrokes: why it is not known whether herdr typed the message, after
   * herdr's agent.prompt failed once the request had left (issue #234). The
   * request may have typed the text before the failure, so the record keeps
   * the message and the caller's error says so.
   */
  typedInDoubt?: string;
}

/** One raise of a child's ceiling, for the audit trail agent_list shows. */
export interface DepthGrant {
  at: string;
  /** The session that granted it, by name. */
  by: string;
  requestId: string;
  /** Generations below the child that the new ceiling allows. */
  levels: number;
  from: number;
  to: number;
  /** The reason as given. */
  reason: string;
}

/** One place a child left by a move or a teleport (issues #227 and #241). */
export interface Departure {
  host: string;
  /** When the child finished leaving. */
  at: string;
  /** The directory the child ran in there, so a retirement can find the worktree it left. */
  cwd?: string;
  /** Which act took it away. A record from before issue #241 lacks it. */
  verb?: 'move' | 'teleport';
  /** Why, in the caller's words. */
  reason?: string;
}

/**
 * A worktree the child left on the parent's machine by an earlier move,
 * beside the one its retirement names first (issue #241). Each one goes
 * through the same checks, and keeps its own stage and outcome.
 */
export interface LeftWorktree {
  worktree: string;
  repo: string;
  branch: string;
  head: string;
  defaultBranch?: string;
  stage?: 'worktree-removed' | 'branch-deleted';
  outcome?: 'removed' | 'refused';
  /** Why the retirement left it in place. */
  refusal?: string;
  /** What showed its work safe, once removed. */
  proof?: string;
}

/**
 * A worktree a child has on another machine, which the daemon there retires
 * on the parent's request once the child's pane is gone (issue #242). The
 * parent's daemon names the directory its record holds; the daemon there
 * takes the proofs and answers with what it found.
 */
export interface FarWorktree {
  host: string;
  /** The directory the child ran in, or left by a move, on that machine. */
  worktree: string;
  /** Set for the worktree the child runs in there, rather than one it left. */
  runs?: true;
  /** The worktree root and branch the daemon there found, once it answered. */
  root?: string;
  branch?: string;
  /** `gone` when the directory no longer existed there, so nothing was left to retire. */
  outcome?: 'removed' | 'refused' | 'gone';
  /** Why the worktree stays, with its machine and directory. */
  refusal?: string;
  /** What showed its work safe, once removed. */
  proof?: string;
  /** The request sent to that machine whose answer has not come back. */
  requestId?: string;
}

/**
 * The worktree and branch a child asked to have removed once it is gone. The
 * worktree fields name one on the parent's machine; an intent for a child that
 * never ran there names none, and only `far` (issue #242).
 */
export interface RetireIntent {
  /** The worktree root. */
  worktree?: string;
  /** The repository's common git directory. */
  repo?: string;
  branch?: string;
  /** The commit the branch pointed at when the child asked. */
  head?: string;
  /** The default branch the work must be merged into, as `origin/main`. */
  defaultBranch?: string;
  /** Why the child asked, in its own words. */
  reason?: string;
  /**
   * Set when the child asked from the machine it moved to, with that
   * machine's name. The worktree is then the one the child left on the
   * parent's machine, the only one whose proofs the parent's daemon can take
   * (issue #227).
   */
  movedAway?: string;
  /** The other worktrees the child left on this machine by earlier moves, retired after this one (issue #241). */
  left?: LeftWorktree[];
  /** The worktrees the child has on other machines, which the daemon on each retires on this daemon's request (issue #242). */
  far?: FarWorktree[];
}

/** The registry layout this code writes. Version 2 added the child host. */
export const REGISTRY_SCHEMA = 2;

/** One parent session, and the children it started. */
export interface ParentRecord {
  /** The registry layout. A file without one predates version 2. */
  schema?: number;
  id: string;
  harness: Harness;
  session: string;
  host: string;
  cwd: string;
  paneId?: string;
  workspaceId?: string;
  depth: number;
  /**
   * For the depth-0 session, the tree's ceiling, raised by max_depth on its
   * spawns. For any other session, the ceiling its spawn put in its
   * environment, which counts only when its parent's registry is on another
   * machine.
   */
  maxDepth?: number;
  /** The child id this session has in its parent's registry, from its hello. */
  childId?: string;
  children: ChildRecord[];
  /** How far into the child spool this parent has read, so a restart resumes. */
  spoolOffset?: number;
  /** Set when the session asked to be restarted, and cleared once it was. */
  restartRequestedAt?: string;
  /** When the daemon last started a new pane for this session. */
  restartedAt?: string;
  /** Set when a restart closed this session's pane and could not start it again (issue #185). The session's return clears it. */
  restartFailed?: RestartFailure;
  /** What a pending self-restart waits for, while `restartRequestedAt` is set (issue #188). */
  restartWait?: RestartWait;
  /** Why the last self-restart gave up without acting, until the next request (issue #188). */
  restartStalled?: RestartStall;
  /** When the session's last connection to the daemon closed, cleared by its next hello (issue #187). */
  disconnectedAt?: string;
  /** The herdr tab label the session last ran under, which a restart or a resume gives its new tab. */
  label?: string;
  /** The roster line this parent last received with an alert, without its age, and when (issue #146). */
  rosterSent?: { at: string; line: string };
  updatedAt: string;
}

/** One pending message for the parent, keyed by child until it is delivered. */
export interface OutboxEntry {
  receipt: string;
  childId: string;
  name: string;
  kind: string;
  paneId: string;
  event: ChildEventKind;
  text: string;
  at: string;
  /** When a delivery reached the parent's model, set with `read`. */
  deliveredAt?: string;
  read: boolean;
  /** The herdr status this entry describes, for the state events. */
  status?: AgentStatus;
  /** herdr's state_change_seq for that status, when herdr reported one. */
  stateChangeSeq?: number;
  /** For a report: the path that sent it. Added without a protocol bump. */
  via?: ReportVia;
  /**
   * Set when a newer state made this entry stale before it was read. A
   * superseded entry counts as read and is never delivered again.
   */
  supersededBy?: string;
}

/** One report a child wrote to its parent's spool file. */
export interface SpoolReport {
  parentId: string;
  parentPaneId?: string;
  childId?: string;
  childName: string;
  paneId?: string;
  status: ReportStatus;
  text: string;
  at: string;
  seq: number;
  /** The path that sent this report: the child's tool, or the command in its shell. */
  via?: ReportVia;
  /**
   * For a shell report: whether a connected session of the child was offered
   * parent_report when the report arrived. The daemon on the child's machine
   * decides it, never the command.
   */
  toolOffered?: boolean;
  /**
   * Names this one report. A report carried from another machine keeps the
   * receipt its child's daemon gave it, so a forward that is retried after it
   * already landed is accepted once.
   */
  receipt?: string;
}

/**
 * Who made a daemon call: the herdr pane the calling session runs in, and the
 * child id its spawn handed it. The daemon checks both against the child
 * records it holds, so a call is routed by those records and never by the
 * environment of whichever process started the daemon.
 */
export interface CallerIdentity {
  paneId?: string;
  childId?: string;
  /** The provider and model the calling session runs on, when its harness says. */
  model?: ModelPair;
}

/** A pi provider and model. pi needs both, so Bellwether passes them as a pair. */
export interface ModelPair {
  provider: string;
  id: string;
}

/** How a parent's daemon stands with one remote host. */
export type RelayLinkStatus = 'connecting' | 'connected' | 'reconnecting';

export interface RelayHostState {
  /** The herdr machine the children run on, as their records name it. */
  host: string;
  /** The SSH target that machine resolved to, once it has. */
  target?: string;
  status: RelayLinkStatus;
  /** When the link entered its status. */
  since: string;
  /** Why the newest connection failed or ended. */
  lastError?: string;
  lastConnectedAt?: string;
  /** When the parent last held every report that waited on that machine. */
  lastDrainAt?: string;
  /** Failed attempts since the last connection. */
  attempts: number;
  /** When the next attempt starts, while reconnecting. */
  nextAttemptAt?: string;
  /** The children on that machine this daemon is waiting to hear from. */
  children: string[];
  /**
   * Whether the newest ssh attempt inherited an SSH agent: SSH_AUTH_SOCK set
   * to a path that exists in the daemon's environment. A daemon from before
   * 0.1.10 leaves it out (issue #245).
   */
  sshAgent?: boolean;
  /** That machine's daemon's package version, from its last relay-hello. */
  farVersion?: string;
  /** That daemon's build, its commit, from its last relay-hello. One version number covers many builds. */
  farBuild?: string;
  /** The newest protocol the daemon on that machine serves, from its last relay-hello. */
  farProtocol?: number;
}
