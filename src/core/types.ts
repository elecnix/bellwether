/** The lifecycle states herdr reports for an agent in a pane. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** What the parent is told about a child. */
export type ChildEventKind = 'report' | 'idle' | 'blocked' | 'stuck' | 'exited';

/** The three things a child can report through parent_report. */
export type ReportStatus = 'done' | 'needs-input' | 'progress';

/** The harnesses Bellwether has an adapter for. */
export type Harness = 'pi' | 'claude-code';

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
  /** The child's transcript file, when its harness keeps one. */
  transcript?: string;
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
