/** The lifecycle states herdr reports for an agent in a pane. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** What the parent is told about a child. */
export type ChildEventKind = 'report' | 'idle' | 'blocked' | 'stuck' | 'exited';

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
  name: string;
  /** The herdr agent kind: pi, claude, codex, opencode or cline. */
  kind: string;
  harness: Harness | 'other';
  paneId: string;
  tabId?: string;
  workspaceId?: string;
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
  /** This child's own stuck threshold, when its spawn set one. */
  stuckMs?: number;
  /**
   * Set while the spawn answers the harness's startup dialogs, so the watcher
   * does not report a blocked child the spawn is about to unblock. A time
   * rather than a flag, so a daemon that stops mid-spawn cannot silence the
   * child for good.
   */
  startingUntil?: string;
  /** Set once the child is gone, so its events stop. */
  exitedAt?: string;
  exitCode?: number;
}

/** One parent session, and the children it started. */
export interface ParentRecord {
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
}
