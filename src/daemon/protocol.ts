// The daemon protocol: one request per line, JSON, on a local socket. The
// version travels in every hello, so a client newer than a running daemon can
// ask it to drain and start the new one.
import type { CallerIdentity, Harness, OutboxEntry, RelayHostState, ReportStatus } from '../core/types.ts';

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
//
// Change the wire additively: a new request type, or a new optional field,
// needs no bump, because a daemon answers a request it does not know with
// unknown_type and a client ignores a field it does not read. Bump only for a
// change an older peer would misread. Each bump costs a hand-over on every
// machine (docs/upgrading.md), and the daemon then still serves the previous
// protocol, so the sessions already running keep working.
export const DAEMON_PROTOCOL = 4;

/**
 * The oldest client protocol a daemon serves. It is always the protocol
 * before DAEMON_PROTOCOL, so the sessions that predate a hand-over keep
 * working until they end on their own. Raising DAEMON_PROTOCOL raises this
 * with it, which drops support for the protocol two back: a session that old
 * gets an error asking for its install to be updated.
 */
export const MIN_CLIENT_PROTOCOL = DAEMON_PROTOCOL - 1;

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
}

export interface HelloRequest {
  type: 'hello';
  protocol: number;
  client: string;
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
}

/** Read a harness session's last assistant message from this machine's transcript. */
export interface RelayReadRequest {
  type: 'relay-read';
  id: string;
  harness: string;
  session: string;
  cwd?: string;
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

export type DaemonRequest = HelloRequest | CallRequest | ReceiptRequest | ByeRequest | DrainRequest | WatchRequest | ReportRequest | RelaySubscribeRequest | RelayAckRequest | RelayReadRequest | RelayStatusRequest | SessionsRequest;

export interface HelloReply {
  type: 'hello';
  protocol: number;
  parentId: string;
  pid: number;
  pending: OutboxEntry[];
  /** The daemon's package version. A daemon before 0.1.5 leaves it out, and the client reads the lock instead. */
  version?: string;
}

export interface ResultReply {
  type: 'result';
  id: string;
  text?: string;
  error?: string;
  /** For a report request: whether the receipt had already been accepted. */
  duplicate?: boolean;
  /**
   * The call never ran, because the daemon is handing over to a newer one.
   * A client that reads this field sends the call again once it reconnects.
   */
  retry?: boolean;
}

export interface EventsPush {
  type: 'events';
  entries: OutboxEntry[];
}

export interface ErrorReply {
  type: 'error';
  id?: string;
  code: string;
  message: string;
  protocol?: number;
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
    protocol: number;
    minClientProtocol: number;
    startedAt: string;
    draining: boolean;
  };
  sessions: SessionInfo[];
  /** Connections from parents' daemons on other machines, through relay-bridge. */
  relaySubscribers: number;
}

export type DaemonReply = HelloReply | ResultReply | EventsPush | ErrorReply | ClosedReply | StatusPush | RelayHelloReply | RelayReportPush | RelayDrainedPush | RelayStatusReply | SessionsReply;

/** A report as it crosses from a child's machine to its parent's. The receipt makes it unique. */
export interface RelayReport {
  receipt: string;
  childId: string;
  parentId: string;
  status: ReportStatus;
  text: string;
  at: string;
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
      return { type: 'report', id, protocol, report: { childId, status, text: body, ...(parentId ? { parentId } : {}), ...(receipt ? { receipt } : {}) } };
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
      return refused ? { type: 'relay-ack', receipt, refused } : { type: 'relay-ack', receipt };
    }
    case 'relay-read': {
      const id = text(value['id']);
      const harness = text(value['harness']);
      const session = text(value['session']);
      if (!id || !harness || !session) throw new ProtocolError('invalid_read', 'a relay read needs an id, a harness and a session');
      const cwd = text(value['cwd']);
      return cwd ? { type: 'relay-read', id, harness, session, cwd } : { type: 'relay-read', id, harness, session };
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
  return {
    type: 'hello',
    protocol,
    client: text(value['client']) || 'unknown',
    parent: { harness, session, cwd, host, depth, herdrSocket, paneId: optional('paneId'), workspaceId: optional('workspaceId'), childId: optional('childId') },
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
