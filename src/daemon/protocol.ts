// The daemon protocol: one request per line, JSON, on a local socket. The
// version travels in every hello, so a client newer than a running daemon can
// ask it to drain and start the new one.
import type { HerdrLocation } from '../core/herdr-bin.ts';
import type { CallerIdentity, Harness, OutboxEntry, RelayHostState, ReportStatus, ReportVia } from '../core/types.ts';
import type { AncestryAnswer } from '../core/ancestry.ts';
import type { RosterChild } from '../core/roster.ts';
import type { SessionReach } from '../core/adopted-session.ts';
import type { RelayRestartAnswer, RelayRestartChild } from '../core/restart.ts';

export type { RelayHostState, RelayLinkStatus } from '../core/types.ts';

// 2: a call carries the caller identity, and parent_report routes by it.
// 3: a report request, which needs no hello, so `bellwether report` can post
//    a report from a shell.
// 4: the relay turns round. A parent's daemon connects to a child machine's
//    daemon over SSH, through `bellwether relay-bridge`, and subscribes to the
//    reports that wait there for its parents (relay-subscribe). It
//    acknowledges each one (relay-ack), reads a transcript over the same
//    connection (relay-read), and `bellwether doctor` asks it for the state of
//    every connection (relay-status). A child's machine never connects out.
//    Later, without a bump: a parent's daemon adopts a pane there and asks
//    that machine who watches it (relay-adopt).
//    Later, without a bump: a session that names `accepts: ["message"]` in its
//    hello takes a parent's message as a `message` push and answers it with
//    message-ack, so the message enters the child's session rather than its
//    pane. A daemon that predates it never pushes one, and an adapter that
//    predates it never names it, so either side falls back to typing.
//    Later, without a bump: a parent's daemon hands a message for a child on
//    another machine to that machine's daemon (relay-message), and the read
//    crosses back in the relay outbox as a relay report that names
//    `messageRead`. A far daemon that predates it answers unknown_type, and
//    the parent types the message instead.
//    Later, without a bump: a parent's daemon asks the daemon on a child's
//    machine to restart that child there (relay-restart), which closes the
//    child's pane, opens a new tab and resumes the same session under the same
//    child id. A far daemon that predates it answers unknown_type, and the
//    parent refuses the restart by name, with the release that brings it.
//    Later, without a bump: a relay-restart that names a requestId has its
//    answer kept in the relay outbox too, as a relay report that names
//    `restartAnswer`, so a parent's daemon whose connection ended before the
//    answer learns the outcome when it reconnects. A parent's daemon that
//    sends no requestId gets no such report.
//    Later, without a bump: a child on another machine asks to be retired,
//    and its request waits in that machine's relay outbox as a relay report
//    that names `retire`, for the parent's daemon that holds the record. That
//    daemon's relay-ack carries its `answer` for the child. A parent's daemon
//    that predates it takes the entry as a needs-input report, whose text
//    says so, and acknowledges it without an answer.
//    Later still, without a bump: a child on another machine asks to be
//    teleported, and its request travels the same way as a relay report that
//    names `teleport` (issue #226). The parent's daemon writes the request on
//    the child's record and answers it in the relay-ack; one that predates the
//    field takes it as a needs-input report.
//
// Change the wire additively: a new request type, or a new optional field,
// needs no bump, because a daemon answers a request it does not know with
// unknown_type and a client ignores a field it does not read. List a new
// request or tool in src/daemon/features.ts with the release that brings it,
// so a client can name it when an older daemon refuses it. Bump only for a
// change an older peer would misread, and record in PROTOCOL_HISTORY whether
// the bump breaks the protocol before it. Each bump costs a hand-over on every
// machine (docs/upgrading.md), and the daemon still serves every protocol back
// to the last breaking bump, so the sessions already running keep working.
export const DAEMON_PROTOCOL = 4;

/**
 * Each protocol bump, and whether it breaks a peer on the protocol before it.
 * A bump breaks when it removes a request or changes what one means, so that
 * a daemon could not serve a client that still sends it. A bump that only adds
 * breaks nothing: an older client never sends what it does not know.
 */
export const PROTOCOL_HISTORY: readonly { protocol: number; breaks: boolean; change: string }[] = [
  // A protocol 1 call carries no caller identity, and from 2 on the daemon
  // routes parent_report by that identity alone, so a protocol 1 child's
  // report would reach no parent.
  { protocol: 2, breaks: true, change: 'a call carries the caller identity' },
  { protocol: 3, breaks: false, change: 'the report request' },
  // The relay requests between daemons are new; nothing a session sends changed.
  { protocol: 4, breaks: false, change: 'the relay turns round' },
  // Added on protocol 4 without a bump, because each is additive: an adapter
  // that accepts `tools` gets a `tools` push when an adoption gives its
  // session parent_report, a session with no child id that calls
  // parent_report from a pane a parent on another machine adopted is routed
  // to that parent's relay outbox, and a relay-adopt answer says whether the
  // adopted session can report. An older peer never asks for the first, and
  // leaves out or ignores the others. A relay-message may also carry
  // `awaitSession`, which asks the daemon on the child's machine to wait for
  // the child's session before it answers (issue #162). A far daemon that
  // predates the field answers at once that no session is connected, and the
  // parent types the brief into the far pane, as for any message it refuses.
  // A relay-restart asks the daemon on a child's machine to restart that
  // child there (issue #190). A far daemon that predates it answers
  // unknown_type, and the parent refuses the restart by name and changes
  // nothing.
];

/**
 * The oldest client protocol a daemon serves: the newest bump that breaks.
 *
 * The floor is not zero, because a bump that removes or redefines a request
 * cannot be served to a client that still sends it. It is not simply the
 * protocol before DAEMON_PROTOCOL either: a client that never calls anything a
 * bump removed loses nothing by talking to a newer daemon. So a daemon serves
 * every protocol back to the last breaking bump, and a bump marked
 * `breaks: false` leaves the floor where it is.
 */
export const MIN_CLIENT_PROTOCOL = Math.max(1, ...PROTOCOL_HISTORY.filter((entry) => entry.breaks).map((entry) => entry.protocol));

/**
 * The oldest daemon protocol a client speaks down to, when it finds an older
 * daemon it does not replace. The same rule binds both ends: below the last
 * breaking bump, the two would read the same request differently.
 */
export const MIN_DAEMON_PROTOCOL = MIN_CLIENT_PROTOCOL;

/** Whether this daemon serves a client that speaks `protocol`. */
export function acceptsClientProtocol(protocol: unknown): protocol is number {
  return typeof protocol === 'number' && Number.isInteger(protocol) && protocol >= MIN_CLIENT_PROTOCOL && protocol <= DAEMON_PROTOCOL;
}

/** The largest line a daemon or client will read, matching the herdr client. */
export const MAX_DAEMON_FRAME_BYTES = 4 * 1024 * 1024;

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** What a client tells the daemon about the session it speaks for. */
export interface ParentHello {
  harness: Harness;
  session: string;
  cwd: string;
  host: string;
  paneId?: string;
  workspaceId?: string;
  depth: number;
  /** The herdr socket this session watches, so a daemon can serve several. */
  herdrSocket: string;
  /** The child id a spawn handed this session, when it is a Bellwether child. */
  childId?: string;
  /** The ceiling the spawn put in the session's environment. Added without a protocol bump. */
  maxDepth?: number;
  /** The parent id the session's environment names, BELLWETHER_PARENT, which gives it parent_report. Added without a protocol bump. */
  reportsTo?: string;
  /**
   * What the adapter takes from the daemon beyond events: `message`, a
   * parent's message to put in this session, and `tools`, a new tool list
   * for a session whose tools changed while it stayed connected, such as a
   * session a parent adopted. Each was added without a protocol bump; a
   * daemon that predates one ignores it and never pushes it.
   */
  accepts?: string[];
}

/** One tool as a session offers it to its model: the daemon's definition, which the adapter passes on unchanged. */
export interface ServedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface HelloRequest {
  type: 'hello';
  protocol: number;
  client: string;
  /** The client's build, its commit, because one version number covers many builds. Added without a protocol bump. */
  build?: string;
  parent: ParentHello;
}

export interface CallRequest {
  type: 'call';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Who is calling, so the daemon routes by its own records, whichever client asked. */
  caller?: CallerIdentity;
}

export interface ReceiptRequest {
  type: 'receipt';
  receipts: string[];
}

export interface ByeRequest {
  type: 'bye';
}

export interface DrainRequest {
  type: 'drain';
}

/** Ask the daemon to report one pane's status, used for the parent's own pane. */
export interface WatchRequest {
  type: 'watch';
  paneId: string;
}

/**
 * Post one report without a session. The daemon routes it by its own records:
 * into a parent it holds, or into the relay outbox for a parent on another
 * machine, whose daemon collects it.
 */
export interface ReportRequest {
  type: 'report';
  id: string;
  protocol: number;
  report: {
    parentId?: string;
    childId: string;
    receipt?: string;
    status: ReportStatus;
    text: string;
    /** The path that sent it: the child's tool, or the shell command. Added without a protocol bump. */
    via?: ReportVia;
  };
}

/**
 * From a parent's daemon on another machine: send every report that waits
 * here for these parents, then each new one as it is written. A second
 * subscribe on the same connection replaces the list and sends the waiting
 * reports again, which is how the parent asks for a fresh drain.
 */
export interface RelaySubscribeRequest {
  type: 'relay-subscribe';
  protocol: number;
  parentIds: string[];
}

/** The parent's daemon took a report, or refused it for good. Either way it is not sent again. */
export interface RelayAckRequest {
  type: 'relay-ack';
  receipt: string;
  refused?: string;
  /** What the parent's daemon answered a request it took, such as a retirement (issue #227), for the child that asked. */
  answer?: string;
}

/** Read a harness session's last assistant message from this machine's transcript. */
export interface RelayReadRequest {
  type: 'relay-read';
  id: string;
  harness: string;
  session: string;
  cwd?: string;
}

/**
 * From a parent's daemon on another machine that adopts a pane here: record
 * the claim, or answer who already watches the pane. The answer is a result
 * whose text is the JSON of `RelayAdoptAnswer`, or whose error names the
 * holder. Added without a protocol bump: a daemon that predates it answers
 * unknown_type, and the parent names the release that brings it.
 */
export interface RelayAdoptRequest {
  type: 'relay-adopt';
  id: string;
  parentId: string;
  childId: string;
  name: string;
  kind: string;
  paneId: string;
  session?: string;
}

/**
 * From a parent's daemon on another machine: put a parent's message in the
 * session of a child this machine holds a relay record for. The answer is a
 * result whose text is the JSON of `RelayMessageAnswer`. Added without a
 * protocol bump: a daemon that predates it answers unknown_type, and the
 * parent types the message into the pane instead.
 */
export interface RelayMessageRequest {
  /**
   * `relay-message-again` asks about a message whose first answer the parent's
   * daemon lost to a dropped connection or a timeout (issue #218). The daemon
   * here answers from its own record when it already pushed that message id,
   * and pushes it only when it never did, so a message enters the session
   * once. A daemon that predates it answers unknown_type, and the parent keeps
   * the message in doubt rather than type a second copy.
   */
  type: 'relay-message' | 'relay-message-again';
  id: string;
  parentId: string;
  childId: string;
  message: InboxMessage;
  /**
   * Set for a start's brief (issue #162): the daemon on the child's machine
   * waits for the child's session to connect before it pushes the message,
   * because the harness has only just started. A daemon that predates the
   * field answers at once that no session is connected, and the brief is typed.
   */
  awaitSession?: boolean;
  /**
   * Set for a message to a freed child (issue #262): the sender's address and
   * the pair's token. The daemon here takes a message for a freed child only
   * when the token matches the one that child's record keeps for the sender.
   */
  peer?: { from: string; token: string };
}

/**
 * From a parent's daemon on another machine, at a freeing (issue #262):
 * write the freed child's own record here, with its former parent as a peer
 * and the pair's token, and mark its relay record freed, so its reports go
 * nowhere. The answer is a result whose text is `freed`. Added without a
 * protocol bump: a daemon that predates it answers unknown_type, and the
 * parent refuses the freeing by name, with nothing changed.
 */
export interface RelayFreeRequest {
  type: 'relay-free';
  id: string;
  parentId: string;
  childId: string;
  token: string;
  by: string;
  byName: string;
  at: string;
  reason?: string;
}

/**
 * From a parent's daemon on another machine: restart a child this machine
 * holds a relay record for, as a restart on its own machine would. The daemon
 * here closes the child's pane, opens a new tab and resumes the same session
 * under the same child id. The answer is a result whose text is the JSON of
 * `RelayRestartAnswer`. Added without a protocol bump: a daemon that predates
 * it answers unknown_type, and the parent refuses the restart by name.
 */
export interface RelayRestartRequest {
  type: 'relay-restart';
  id: string;
  parentId: string;
  childId: string;
  /** What the parent's registry holds about the child, which the restart here needs. */
  child: RelayRestartChild;
  /** The herdr session the parent reaches this machine through, from its saved machine profile. */
  herdrSession?: string;
  /** How long to wait for a turn under way to end before refusing, in milliseconds. */
  waitTimeoutMs?: number;
  /**
   * Names the request, so the daemon here also keeps its answer in the relay
   * outbox, where the parent's daemon collects it after a lost connection
   * (issue #211). Without it, the answer goes only to the request.
   */
  requestId?: string;
}

/**
 * The text of a relay-message result: the child's session took it, through
 * which adapter, or why not. `unanswered` marks a push the session had not
 * answered in time, which the parent's daemon must not type a second time.
 * `unheld` says this machine holds no record of the child (issue #219).
 */
export type RelayMessageAnswer = { delivered: true; via: string; unanswered?: string } | { delivered: false; reason: string; unheld?: true };

/** The text of a relay-adopt result: the child id the claim stands under, and whether this parent already held it. */
export interface RelayAdoptAnswer {
  childId: string;
  held: boolean;
  /**
   * Whether the adopted session can report, from the sessions connected to
   * the daemon that answers: `tools` when one from that pane takes a new
   * tool list and now offers parent_report, `older` when one is connected
   * whose adapter predates the tool push and gains parent_report at its next
   * hello, `none` when no Bellwether adapter from that pane is connected.
   * Added without a protocol bump: a daemon that predates it leaves it out.
   */
  session?: SessionReach;
  /**
   * Whether the adapter connected from that pane takes a parent's message,
   * absent when none is connected. Added in 0.1.8 without a protocol bump: a
   * daemon that predates it leaves it out, and the parent then promises
   * nothing about messages.
   */
  messages?: boolean;
}

export type { SessionReach };

/**
 * The tools a session offers now, pushed when they change while the session
 * stays connected: a parent adopted the session's pane, so it gains
 * parent_report. Sent only to a session whose hello accepts `tools`. Added
 * without a protocol bump: an older adapter never asks for it, and gets the
 * same list in the hello of its next connection.
 */
export interface ToolsPush {
  type: 'tools';
  tools: ServedTool[];
}

/**
 * From a child's adapter, about one `message` push: `queued` once the harness
 * holds it, `read` once its model received it, `refused` when the adapter
 * could not hand it over. Added without a protocol bump: only a daemon that
 * pushes messages receives it.
 */
export interface MessageAckRequest {
  type: 'message-ack';
  id: string;
  outcome: 'queued' | 'read' | 'refused';
  /** For queued: the adapter's path, `claude-channel` or `pi-message`. */
  via?: string;
  /** For refused: why. */
  reason?: string;
}

/** The state of every connection this daemon holds to another machine. */
export interface RelayStatusRequest {
  type: 'relay-status';
  id: string;
}

/** Who is connected and on which code, for `bellwether doctor`. Added without a protocol bump. */
export interface SessionsRequest {
  type: 'sessions';
  id: string;
}

/**
 * The agent tree above one agent, for `bellwether ancestry`. Needs no hello,
 * and changes nothing. Added without a protocol bump.
 */
export interface AncestryRequest {
  type: 'ancestry';
  id: string;
  /** The agent as another program holds it: `<harness>:<session>`, or a bare child id or session. */
  agent: string;
}

/**
 * Resume a session whose pane is gone, from its own record, for `bellwether
 * resume` (issue #187). Needs no hello. Added without a protocol bump: a daemon
 * that predates it answers unknown_type.
 */
export interface ResumeRequest {
  type: 'resume';
  id: string;
  /** A registry id, a session id or pi file, or the pane the session last ran in. */
  target: string;
  /** The herdr socket of the caller's server. The daemon's default when left out. */
  herdrSocket?: string;
  /** The tab label, when the record keeps none. */
  label?: string;
}

export type DaemonRequest = HelloRequest | CallRequest | ReceiptRequest | ByeRequest | DrainRequest | WatchRequest | ReportRequest | RelaySubscribeRequest | RelayAckRequest | RelayReadRequest | RelayAdoptRequest | RelayStatusRequest | SessionsRequest | AncestryRequest | MessageAckRequest | RelayMessageRequest | RelayRestartRequest | ResumeRequest | RelayFreeRequest;

export interface HelloReply {
  type: 'hello';
  protocol: number;
  parentId: string;
  pid: number;
  pending: OutboxEntry[];
  /** The parent's live children, for the roster line on the pending entries. A daemon before issue #146 leaves it out. */
  roster?: RosterChild[];
  /** The daemon's package version. A daemon before 0.1.5 leaves it out, and the client reads the lock instead. */
  version?: string;
  /** The daemon's build, its commit. A daemon from before builds were named leaves it out. */
  build?: string;
  /** The oldest client protocol the daemon serves. A daemon before 0.1.5 leaves it out. */
  minProtocol?: number;
  /** The requests and tools the daemon serves, by name. A daemon before 0.1.5 leaves it out. */
  features?: string[];
  /**
   * The tools this session offers its model, with their definitions, from the
   * daemon's feature table, so a newer daemon gives an older adapter its new
   * tools. A daemon from before the list leaves it out, and the adapter falls
   * back on its own list, less what the daemon does not serve.
   */
  tools?: ServedTool[];
}

export interface ResultReply {
  type: 'result';
  id: string;
  text?: string;
  error?: string;
  /** For a report request: whether the receipt had already been accepted. */
  duplicate?: boolean;
  /** Why the call failed, when the daemon can name it: unknown_tool for a tool it does not serve. */
  code?: string;
  /**
   * The call never ran, because the daemon is handing over to a newer one.
   * A client that reads this field sends the call again once it reconnects.
   */
  retry?: boolean;
}

export interface EventsPush {
  type: 'events';
  entries: OutboxEntry[];
  /**
   * The parent's live children as the registry holds them at the push, for
   * the roster line an alert carries (issue #146). Additive: a daemon before
   * it leaves the field out, and the adapter then adds no line.
   */
  roster?: RosterChild[];
}

/** A parent's message, which the child's adapter puts in its session. */
export interface InboxMessage {
  id: string;
  /** Who sent it: the parent's child name, or its session. */
  from: string;
  text: string;
  at: string;
}

/** A parent's message for the session on this connection. Sent only to a session whose hello accepts `message`. */
export interface MessagePush {
  type: 'message';
  message: InboxMessage;
  /** Sent again after the session reconnected, so the adapter first checks whether the harness already has it. */
  replay?: boolean;
}

export interface ErrorReply {
  type: 'error';
  id?: string;
  code: string;
  message: string;
  /** For protocol_mismatch: the newest protocol the daemon serves. */
  protocol?: number;
  /** For protocol_mismatch: the oldest protocol the daemon serves, from 0.1.5 on. */
  minProtocol?: number;
  /** For protocol_mismatch: the daemon's package version, from 0.1.5 on. */
  version?: string;
}

export interface ClosedReply {
  type: 'closed';
}

export interface StatusPush {
  type: 'status';
  paneId: string;
  status: string;
}

/** The answer to a relay-subscribe: the waiting reports follow, then relay-drained. */
export interface RelayHelloReply {
  type: 'relay-hello';
  protocol: number;
  pid: number;
  /** How many reports wait for the subscribed parents. */
  waiting: number;
  /** The package version of the child machine's daemon. An older one leaves it out. */
  version?: string;
  /** The build of the child machine's daemon, its commit. An older one leaves it out. */
  build?: string;
}

/** One report for a subscribed parent. */
export interface RelayReportPush {
  type: 'relay-report';
  report: RelayReport;
}

/** Every report that waited when the subscribe arrived has been sent. */
export interface RelayDrainedPush {
  type: 'relay-drained';
  sent: number;
}

/** The answer to relay-status. */
export interface RelayStatusReply {
  type: 'relay-status';
  id: string;
  hosts: RelayHostState[];
}

/** One session connected to the daemon, and the code its adapter runs. */
export interface SessionInfo {
  parentId: string;
  harness: Harness;
  session: string;
  /** The package version the session's adapter runs, as its hello said. */
  client: string;
  /** The build the session's adapter runs, as its hello said, when it said. */
  build?: string;
  protocol: number;
  connectedAt: string;
  childId?: string;
  paneId?: string;
  /** Children of this parent that have not exited. */
  liveChildren: number;
  /** Events that wait for this parent to read them. */
  unread: number;
}

/** The answer to a sessions request. */
export interface SessionsReply {
  type: 'sessions';
  id: string;
  daemon: {
    pid: number;
    version: string;
    /** The daemon's build, its commit. A daemon from before builds were named leaves it out. */
    build?: string;
    protocol: number;
    minClientProtocol: number;
    startedAt: string;
    draining: boolean;
    /** The requests and tools it serves, by name. */
    features?: string[];
    /** The herdr binary the daemon runs, and where it found it, or why it found none. A daemon from before 0.1.9 leaves it out. */
    herdr?: HerdrLocation;
  };
  sessions: SessionInfo[];
  /** Connections from parents' daemons on other machines, through relay-bridge. */
  relaySubscribers: number;
}

/** The answer to an ancestry request, computed by the daemon from what it holds. */
export interface AncestryReply {
  type: 'ancestry';
  id: string;
  answer: AncestryAnswer;
}

export type DaemonReply = HelloReply | ResultReply | EventsPush | ErrorReply | ClosedReply | StatusPush | RelayHelloReply | RelayReportPush | RelayDrainedPush | RelayStatusReply | SessionsReply | AncestryReply | MessagePush | ToolsPush;

/** A report as it crosses from a child's machine to its parent's. The receipt makes it unique. */
export interface RelayReport {
  receipt: string;
  childId: string;
  parentId: string;
  status: ReportStatus;
  text: string;
  at: string;
  /** The path that sent the report: the child's tool, or the shell command. Added without a protocol bump. */
  via?: ReportVia;
  /** For a shell report: whether a connected session of the child was offered parent_report. Added without a protocol bump. */
  toolOffered?: boolean;
  /**
   * Set on an entry that carries no report but the read of a parent's
   * message: its id. Only a parent's daemon that sent relay-message gets one.
   */
  messageRead?: string;
  /**
   * Set on an entry that carries no report but the answer of a relay restart
   * whose request named a `requestId`. The parent's daemon takes it when the
   * answer to the request itself was lost with the connection (issue #211).
   */
  restartAnswer?: { requestId: string; answer: RelayRestartAnswer };
  /**
   * Set on an entry that asks the parent's daemon to retire the child, which
   * runs on the machine the entry comes from (issue #227). Its status and
   * text read as a request for input, so a parent's daemon that predates the
   * field shows the parent what the child asked for.
   */
  retire?: { reason?: string };
  /**
   * Set on an entry that asks the parent's daemon to teleport the child, which
   * runs on the machine the entry comes from, once its turn ends (issue #226).
   * Its status and text read as a request for input, for a parent's daemon
   * that predates the field.
   */
  teleport?: { machine?: string; cwd?: string; reason?: string };
  /**
   * Set on an entry that carries no report but a freed child's message to its
   * former parent (issue #262): the parent's address, the pair's token, and
   * the message id. The parent's daemon checks the token against the record
   * it keeps for the child before the message reaches the session.
   */
  peer?: { to: string; token: string; id: string; name: string; kind: string };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse one request line, or throw a ProtocolError that names the fault. */
export function parseRequest(line: string): DaemonRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError('invalid_json', 'the line is not JSON');
  }
  if (!isRecord(value)) throw new ProtocolError('invalid_request', 'the line is not an object');
  switch (value['type']) {
    case 'hello':
      return parseHello(value);
    case 'call': {
      const id = text(value['id']);
      const tool = text(value['tool']);
      if (!id || !tool) throw new ProtocolError('invalid_call', 'a call needs an id and a tool');
      const args = isRecord(value['args']) ? value['args'] : {};
      const caller = parseCaller(value['caller']);
      return caller ? { type: 'call', id, tool, args, caller } : { type: 'call', id, tool, args };
    }
    case 'receipt': {
      const receipts = Array.isArray(value['receipts']) ? value['receipts'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
      return { type: 'receipt', receipts };
    }
    case 'bye':
      return { type: 'bye' };
    case 'drain':
      return { type: 'drain' };
    case 'report': {
      const id = text(value['id']);
      const protocol = value['protocol'];
      const report = value['report'];
      if (!id) throw new ProtocolError('invalid_report', 'a report needs an id');
      if (!acceptsClientProtocol(protocol)) throw new ProtocolError('protocol_mismatch', `the report spoke protocol ${String(protocol)}`);
      if (!isRecord(report)) throw new ProtocolError('invalid_report', 'a report needs a report object');
      const childId = text(report['childId']);
      const status = report['status'];
      const body = typeof report['text'] === 'string' ? report['text'] : '';
      if (!childId) throw new ProtocolError('invalid_report', 'a report needs a child id');
      if (status !== 'done' && status !== 'needs-input' && status !== 'progress') throw new ProtocolError('invalid_report', 'a report status must be done, needs-input or progress');
      if (!body.trim()) throw new ProtocolError('invalid_report', 'a report needs text');
      const parentId = text(report['parentId']);
      const receipt = text(report['receipt']);
      const via = report['via'];
      return { type: 'report', id, protocol, report: { childId, status, text: body, ...(parentId ? { parentId } : {}), ...(receipt ? { receipt } : {}), ...(via === 'tool' || via === 'shell' ? { via } : {}) } };
    }
    case 'relay-subscribe': {
      const protocol = value['protocol'];
      if (!acceptsClientProtocol(protocol)) throw new ProtocolError('protocol_mismatch', `the relay subscribe spoke protocol ${String(protocol)}`);
      const parentIds = Array.isArray(value['parentIds']) ? value['parentIds'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
      return { type: 'relay-subscribe', protocol, parentIds };
    }
    case 'relay-ack': {
      const receipt = text(value['receipt']);
      if (!receipt) throw new ProtocolError('invalid_ack', 'a relay acknowledgement needs a receipt');
      const refused = text(value['refused']);
      const answer = text(value['answer']);
      return { type: 'relay-ack', receipt, ...(refused ? { refused } : {}), ...(answer ? { answer } : {}) };
    }
    case 'relay-read': {
      const id = text(value['id']);
      const harness = text(value['harness']);
      const session = text(value['session']);
      if (!id || !harness || !session) throw new ProtocolError('invalid_read', 'a relay read needs an id, a harness and a session');
      const cwd = text(value['cwd']);
      return cwd ? { type: 'relay-read', id, harness, session, cwd } : { type: 'relay-read', id, harness, session };
    }
    case 'relay-adopt': {
      const id = text(value['id']);
      const parentId = text(value['parentId']);
      const childId = text(value['childId']);
      const paneId = text(value['paneId']);
      const kind = text(value['kind']);
      if (!id || !parentId || !childId || !paneId || !kind) throw new ProtocolError('invalid_adopt', 'a relay adopt needs an id, a parent id, a child id, a pane and a kind');
      const name = text(value['name']) || paneId;
      const session = text(value['session']);
      return { type: 'relay-adopt', id, parentId, childId, name, kind, paneId, ...(session ? { session } : {}) };
    }
    case 'relay-message':
    case 'relay-message-again': {
      const id = text(value['id']);
      const parentId = text(value['parentId']);
      const childId = text(value['childId']);
      const message = value['message'];
      if (!id || !parentId || !childId || !isRecord(message)) throw new ProtocolError('invalid_message', 'a relay message needs an id, a parent id, a child id and a message');
      const messageId = text(message['id']);
      const body = typeof message['text'] === 'string' ? message['text'] : '';
      if (!messageId || !body.trim()) throw new ProtocolError('invalid_message', 'a relay message needs a message id and text');
      const peer = isRecord(value['peer']) && text(value['peer']['from']) && text(value['peer']['token']) ? { peer: { from: text(value['peer']['from']), token: text(value['peer']['token']) } } : {};
      return { type: value['type'] === 'relay-message-again' ? 'relay-message-again' : 'relay-message', id, parentId, childId, message: { id: messageId, text: body, from: text(message['from']) || 'your parent', at: text(message['at']) || new Date().toISOString() }, ...(value['awaitSession'] === true ? { awaitSession: true } : {}), ...peer };
    }
    case 'relay-free': {
      const id = text(value['id']);
      const parentId = text(value['parentId']);
      const childId = text(value['childId']);
      const token = text(value['token']);
      const by = text(value['by']);
      const at = text(value['at']);
      if (!id || !parentId || !childId || !token || !by || !at) throw new ProtocolError('invalid_free', 'a relay free needs an id, a parent id, a child id, a token, the former parent and a time');
      const reason = text(value['reason']);
      return { type: 'relay-free', id, parentId, childId, token, by, byName: text(value['byName']) || by, at, ...(reason ? { reason } : {}) };
    }
    case 'relay-restart': {
      const id = text(value['id']);
      const parentId = text(value['parentId']);
      const childId = text(value['childId']);
      const child = value['child'];
      if (!id || !parentId || !childId || !isRecord(child)) throw new ProtocolError('invalid_restart', 'a relay restart needs an id, a parent id, a child id and the child');
      const session = child['session'];
      const name = text(child['name']);
      const kind = text(child['kind']);
      const harness = text(child['harness']);
      const paneId = typeof child['paneId'] === 'string' ? child['paneId'] : '';
      if (!name || !kind || !harness || !isRecord(session) || !text(session['value'])) throw new ProtocolError('invalid_restart', 'a relay restart needs the child\'s name, kind, harness and session');
      const sessionKind = text(session['kind']) || 'id';
      const optional = (key: string): Record<string, string> => (text(child[key]) ? { [key]: text(child[key]) } : {});
      const depth = typeof child['depth'] === 'number' && Number.isInteger(child['depth']) ? child['depth'] : 1;
      const maxDepth = typeof child['maxDepth'] === 'number' && Number.isInteger(child['maxDepth']) ? { maxDepth: child['maxDepth'] } : {};
      const reads = Array.isArray(child['reads']) && child['reads'].every((entry) => typeof entry === 'string') ? { reads: child['reads'] as string[] } : {};
      const launch = isRecord(child['launch']) ? { launch: { ...(text(child['launch']['harnessModel']) ? { harnessModel: text(child['launch']['harnessModel']) } : {}), ...(text(child['launch']['provider']) ? { provider: text(child['launch']['provider']) } : {}) } } : {};
      const parsed: RelayRestartChild = { name, kind, harness, paneId, depth, session: { kind: sessionKind, value: text(session['value']) }, ...optional('tabId'), ...optional('workspaceId'), ...optional('workspaceLabel'), ...optional('cwd'), ...(child['ownsWorkspace'] === true ? { ownsWorkspace: true } : {}), ...maxDepth, ...reads, ...launch };
      const herdrSession = text(value['herdrSession']);
      const waitTimeoutMs = typeof value['waitTimeoutMs'] === 'number' && value['waitTimeoutMs'] > 0 ? { waitTimeoutMs: value['waitTimeoutMs'] } : {};
      const requestId = text(value['requestId']);
      return { type: 'relay-restart', id, parentId, childId, child: parsed, ...(herdrSession ? { herdrSession } : {}), ...waitTimeoutMs, ...(requestId ? { requestId } : {}) };
    }
    case 'relay-status': {
      const id = text(value['id']);
      if (!id) throw new ProtocolError('invalid_status', 'a relay status request needs an id');
      return { type: 'relay-status', id };
    }
    case 'sessions': {
      const id = text(value['id']);
      if (!id) throw new ProtocolError('invalid_sessions', 'a sessions request needs an id');
      return { type: 'sessions', id };
    }
    case 'ancestry': {
      const id = text(value['id']);
      const agent = text(value['agent']);
      if (!id || !agent) throw new ProtocolError('invalid_ancestry', 'an ancestry request needs an id and an agent');
      return { type: 'ancestry', id, agent };
    }
    case 'resume': {
      const id = text(value['id']);
      const target = text(value['target']);
      if (!id || !target) throw new ProtocolError('invalid_resume', 'a resume request needs an id and a target');
      const herdrSocket = text(value['herdrSocket']);
      const label = text(value['label']);
      return { type: 'resume', id, target, ...(herdrSocket ? { herdrSocket } : {}), ...(label ? { label } : {}) };
    }
    case 'message-ack': {
      const id = text(value['id']);
      const outcome = value['outcome'];
      if (!id || (outcome !== 'queued' && outcome !== 'read' && outcome !== 'refused')) throw new ProtocolError('invalid_ack', 'a message acknowledgement needs an id and an outcome of queued, read or refused');
      const via = text(value['via']);
      const reason = text(value['reason']);
      return { type: 'message-ack', id, outcome, ...(via ? { via } : {}), ...(reason ? { reason } : {}) };
    }
    case 'watch': {
      const paneId = text(value['paneId']);
      if (!paneId) throw new ProtocolError('invalid_watch', 'a watch needs a pane id');
      return { type: 'watch', paneId };
    }
    default:
      throw new ProtocolError('unknown_type', `unknown request type ${JSON.stringify(value['type'])}`);
  }
}

function parseCaller(value: unknown): CallerIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const caller: CallerIdentity = {};
  const childId = text(value['childId']);
  const paneId = text(value['paneId']);
  if (childId) caller.childId = childId;
  if (paneId) caller.paneId = paneId;
  // Half a pair would launch a child on a mismatched provider, so it is dropped.
  const model = isRecord(value['model']) ? value['model'] : undefined;
  const provider = text(model?.['provider']);
  const id = text(model?.['id']);
  if (provider && id) caller.model = { provider, id };
  return caller;
}

function parseHello(value: Record<string, unknown>): HelloRequest {
  const protocol = value['protocol'];
  const parent = value['parent'];
  if (typeof protocol !== 'number' || !Number.isInteger(protocol)) throw new ProtocolError('invalid_hello', 'a hello needs an integer protocol');
  if (!isRecord(parent)) throw new ProtocolError('invalid_hello', 'a hello needs a parent');
  const harness = parent['harness'];
  const session = text(parent['session']);
  const cwd = text(parent['cwd']);
  const host = text(parent['host']);
  const herdrSocket = text(parent['herdrSocket']);
  if (harness !== 'pi' && harness !== 'claude-code') throw new ProtocolError('invalid_hello', 'the parent harness must be pi or claude-code');
  if (!session || !cwd || !host || !herdrSocket) throw new ProtocolError('invalid_hello', 'the parent needs a session, cwd, host and herdr socket');
  const depth = typeof parent['depth'] === 'number' && Number.isFinite(parent['depth']) ? parent['depth'] : 0;
  const optional = (key: string): string | undefined => (typeof parent[key] === 'string' && parent[key] ? (parent[key] as string) : undefined);
  const maxDepth = typeof parent['maxDepth'] === 'number' && Number.isInteger(parent['maxDepth']) ? parent['maxDepth'] : undefined;
  const accepts = Array.isArray(parent['accepts']) ? parent['accepts'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
  return {
    type: 'hello',
    protocol,
    client: text(value['client']) || 'unknown',
    ...(text(value['build']) ? { build: text(value['build']) } : {}),
    parent: { harness, session, cwd, host, depth, herdrSocket, paneId: optional('paneId'), workspaceId: optional('workspaceId'), childId: optional('childId'), ...(maxDepth === undefined ? {} : { maxDepth }), ...(optional('reportsTo') ? { reportsTo: optional('reportsTo') } : {}), ...(accepts.length ? { accepts } : {}) },
  };
}

/** One reply line, without its newline. */
export function formatReply(reply: DaemonReply): string {
  return `${JSON.stringify(reply)}\n`;
}

/** One request line, without its newline. */
export function formatRequest(request: DaemonRequest): string {
  return `${JSON.stringify(request)}\n`;
}
