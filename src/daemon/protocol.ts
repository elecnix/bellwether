// The daemon protocol: one request per line, JSON, on a local socket. The
// version travels in every hello, so a client newer than a running daemon can
// ask it to drain and start the new one.
import type { CallerIdentity, Harness, OutboxEntry, ReportStatus } from '../core/types.ts';

// 2: a call carries the caller identity, and parent_report routes by it.
// 3: a report request, which needs no hello, so `bellwether report` can post
//    a report carried from another machine.
export const DAEMON_PROTOCOL = 3;

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
 * into a parent it holds, or on to the parent's machine for a relay child.
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

export type DaemonRequest = HelloRequest | CallRequest | ReceiptRequest | ByeRequest | DrainRequest | WatchRequest | ReportRequest;

export interface HelloReply {
  type: 'hello';
  protocol: number;
  parentId: string;
  pid: number;
  pending: OutboxEntry[];
}

export interface ResultReply {
  type: 'result';
  id: string;
  text?: string;
  error?: string;
  /** For a report request: whether the receipt had already been accepted. */
  duplicate?: boolean;
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

export type DaemonReply = HelloReply | ResultReply | EventsPush | ErrorReply | ClosedReply | StatusPush;

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
      if (typeof protocol !== 'number' || protocol !== DAEMON_PROTOCOL) throw new ProtocolError('protocol_mismatch', `the report spoke protocol ${String(protocol)}`);
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
