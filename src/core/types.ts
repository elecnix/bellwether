/** The lifecycle states herdr reports for an agent in a pane. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** A dialog a child waits on, named in one line, and where Bellwether learned of it. */
export interface ChildPrompt {
  line: string;
  source: 'pi' | 'screen';
  /** pi's prompt kind: select, confirm, input, editor or custom. */
  kind?: string;
  since: string;
}

/** What the parent is told about a child. */
export type ChildEventKind = 'report' | 'idle' | 'blocked' | 'stuck' | 'inactive' | 'exited';

/** The three things a child can report through parent_report. */
export type ReportStatus = 'done' | 'needs-input' | 'progress';

/** The harnesses Bellwether has an adapter for. */
export type Harness = 'pi' | 'claude-code';

/**
 * The harness session herdr reports for a pane: `kind` is `id` for Claude Code,
 * whose value `claude --resume` takes, and `path` for Pi, whose value is the
 * session file.
 */
export interface ChildSession {
  kind: string;
  value: string;
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
  /** The herdr agent kind: pi, claude, codex, opencode or cline. */
  kind: string;
  harness: Harness | 'other';
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
   * The harness session, recorded as soon as herdr reports it and kept after
   * the child exits, so a retired child can still be resumed.
   */
  session?: ChildSession;
  /** herdr's state_change_seq for the newest status Bellwether has read. */
  stateChangeSeq?: number;
  /** How many Bellwether generations deep this child is. */
  depth: number;
  /** The last report the child sent, and when. */
  lastReport?: { status: ReportStatus; text: string; at: string; seq: number };
  /**
   * Set when a report arrives and cleared when the turn it covered ends, so a
   * child that reported does not also produce an idle event for the same turn.
   */
  reportPending?: boolean;
  /** The last time the child's transcript or screen moved. */
  lastBusyAt: string;
  /**
   * The dialog the child waits on while one is open, which herdr can report
   * as idle. `pi` comes from the child's own pi extension, on pi's
   * ui_prompt_start and ui_prompt_end events, and `screen` from the check the
   * watcher makes before an idle event. A screen prompt clears on herdr's next
   * status, and a pi prompt clears when pi says it closed.
   */
  prompt?: ChildPrompt;
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
  /** When the daemon last restarted the child in a new tab, on the same session. */
  restartedAt?: string;
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
   * Set when the child asked to be retired. The daemon cleans up once herdr
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
  children: ChildRecord[];
  /** How far into the child spool this parent has read, so a restart resumes. */
  spoolOffset?: number;
  /** Set when the session asked to be restarted, and cleared once it was. */
  restartRequestedAt?: string;
  /** When the daemon last started a new pane for this session. */
  restartedAt?: string;
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
}
