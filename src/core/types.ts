import type { ToolSource } from './tool-source.ts';
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
 * A restart that closed the old pane and then failed to start the session
 * again, so the session is gone. It stays on the record until the session
 * returns, for `bellwether doctor` and, for a child, for its parent's event.
 */
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
  /** What held it: the live turn, the messages that reached the session, its working children. */
  reason: string;
}

/** What the parent is told about a child. */
export type ChildEventKind = 'report' | 'idle' | 'blocked' | 'stuck' | 'inactive' | 'exited';

/** The three things a child can report through parent_report. */
export type ReportStatus = 'done' | 'needs-input' | 'progress';

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
 * transport, and only a turn or a read receipt proves the reader.
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
  /** For the session path: when the model took it, by the first fact only the model produces. */
  takenAt?: string;
  /** For the session path: that fact, a turn herdr reported as `working` or a read receipt from the adapter. */
  takenBy?: 'turn' | 'read';
  /** The message that carried the first copy, when the model took no turn on it and the brief went again. */
  resentFrom?: string;
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
  model?: ModelPair & { source: 'caller' | 'parent' | 'session' };
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
  paneId: string;
  tabId?: string;
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
  host: string;
  /** How the child came under this parent. An older record means spawn. */
  origin?: 'spawn' | 'adopt' | 'resume';
  /** When the child was last brought back by a spawn with a resume target. */
  resumedAt?: string;
  cwd?: string;
  startedAt: string;
  /** The last status herdr reported for the pane. */
  lastStatus: AgentStatus;
  /** Set when the status last changed, for the settle time. */
  statusChangedAt: string;
  /** herdr's completion_seq for the last finished turn. */
  completionSeq?: number;
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
  session?: ChildSession;
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
  /** The last report the child sent, and when. */
  lastReport?: { status: ReportStatus; text: string; at: string; seq: number };
  /**
   * Set when a final report arrives while its turn still runs, and cleared
   * when that turn ends, so a child that reported does not also produce an
   * idle event for the same turn.
   */
  reportPending?: boolean;
  /**
   * The newest turn the parent heard about, by a report or an idle event, and
   * the pane that ran it. The watcher compares each finished turn against it
   * rather than against herdr's current answer, so a status herdr repeats, a
   * snapshot that reads the same turn again, or a watcher that starts again
   * raises no second event. `seq` is herdr's completion_seq, or the watcher's
   * own count of turns ends for a pane herdr does not number.
   */
  turnNotified?: { paneId: string; seq: number };
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
  startingUntil?: string;
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
  restartFailed?: RestartFailure;
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
  moving?: { from: string; to: string; since: string; until: string };
  /**
   * The machine the child last moved away from, and when. The parent's daemon
   * keeps collecting from that machine until it has drained it once since the
   * move, so a report the child left there still arrives.
   */
  movedFrom?: { host: string; at: string };
  /** Set once the child is gone, so its events stop. */
  exitedAt?: string;
  exitCode?: number;
  /**
   * When herdr first saw the harness run in the child's pane: a detected
   * agent, or a status other than unknown. A child without it after its start
   * window is checked once, to tell a harness that died at once from one that
   * is still loading.
   */
  harnessSeenAt?: string;
  /**
   * How the child's harness ended, when its pane outlived it: `before-start`
   * for one that ended before it reported anything, so it never ran its task,
   * and `in-pane` for one that ended later. Either way the tab stays open on
   * the shell that ran it.
   */
  harnessEnded?: 'before-start' | 'in-pane';
  /**
   * Set when herdr closed the tab of a child whose harness had already ended
   * in it. herdr can name one close twice, as `pane_closed` and `tab_closed`,
   * so the watcher releases the workspace and starts retirement for the first
   * and ignores the second. Cleared with `harnessEnded` when the child comes
   * back.
   */
  tabClosedAt?: string;
  /**
   * For an adopted child whose harness ended and left its pane open: when.
   * The watcher keeps watching that pane, and a harness that comes back there
   * under the same session is the same child again, under the same id (issue
   * #191). Cleared when it comes back, when the pane closes, or when another
   * session takes the pane.
   */
  awaitsResume?: string;
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
  retireOutcome?: 'removed' | 'refused';
  /** For a refusal: the condition that failed, and what a person would do about it. */
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

/** The worktree and branch a child asked to have removed once it is gone. */
export interface RetireIntent {
  /** The worktree root. */
  worktree: string;
  /** The repository's common git directory. */
  repo: string;
  branch: string;
  /** The commit the branch pointed at when the child asked. */
  head: string;
  /** The default branch the work must be merged into, as `origin/main`. */
  defaultBranch?: string;
  /** Why the child asked, in its own words. */
  reason?: string;
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
  /** That machine's daemon's package version, from its last relay-hello. */
  farVersion?: string;
  /** That daemon's build, its commit, from its last relay-hello. One version number covers many builds. */
  farBuild?: string;
  /** The newest protocol the daemon on that machine serves, from its last relay-hello. */
  farProtocol?: number;
}
