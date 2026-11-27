// The relay records: what a machine's daemon holds for a child whose parent
// runs on another machine. The parent's daemon stays the registry of record;
// this machine keeps only what it needs to hand a report over: the child id
// and the parent id. It holds no address for the parent's machine, because it
// never connects there: the parent's daemon connects to this one and collects
// each report. A report waits in its own file, named by its receipt, until the
// parent's daemon acknowledges it, so a daemon that stops loses nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { relayChildPath, relayChildrenDir, relayOutboxDir, relayOutboxPath } from './paths.ts';
import type { ReportStatus } from './types.ts';

export const RELAY_SCHEMA = 1;

/** A child of a parent on another machine, as this machine's daemon knows it. */
export interface RelayRecord {
  schema: number;
  childId: string;
  name: string;
  kind: string;
  /** The parent's id in its own daemon's registry. */
  parentId: string;
  cwd?: string;
  /** Where the child's brief was written on this machine, so the cleanup removes it there. */
  brief?: string;
  registeredAt: string;
  /**
   * Set when the child is gone but some of its reports still wait for the
   * parent's daemon. The record goes with the last of them.
   */
  retiredAt?: string;
  /** How many of this child's reports wait in the relay outbox. Absent or 0 when none do. */
  unforwarded?: number;
  /** When the parent's daemon last acknowledged one of its reports. */
  lastForwardedAt?: string;
  /** The pane the child runs in here, for a child a parent on another machine adopted, so this machine can say who watches it. */
  paneId?: string;
  /** Set for a child a parent on another machine adopted rather than spawned: it has no brief, MCP config or child id of its own here. */
  adopted?: boolean;
  /** The harness session herdr reported in the pane at the adoption, so a claim on a pane that now runs another session counts as stale. */
  session?: string;
  /**
   * Messages from the parent that the child's session took here and its
   * model has not read, with their text, so a session that reconnects to
   * this machine's daemon takes them again. Each goes once its read crosses
   * back to the parent's daemon.
   */
  messages?: { id: string; text: string; from: string; at: string }[];
}

/** One report waiting for the parent's daemon to collect it. */
export interface ForwardEntry {
  receipt: string;
  childId: string;
  parentId: string;
  status: ReportStatus;
  text: string;
  at: string;
  /** Set when the parent's daemon refused the report, which no resend can fix. */
  refused?: string;
  /** Set on an entry that carries no report but the read of a parent's message: its id. */
  messageRead?: string;
}

/** A receipt that names one report, so a retried forward is accepted once. */
export function newReportReceipt(): string {
  return `rp-${crypto.randomBytes(8).toString('hex')}`;
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readRelayRecord(childId: string): RelayRecord | undefined {
  return readJson<RelayRecord>(relayChildPath(childId));
}

/** Every relay record on this machine, retired ones included. */
export function listRelayRecords(): RelayRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(relayChildrenDir());
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson<RelayRecord>(path.join(relayChildrenDir(), file)))
    .filter((record): record is RelayRecord => record !== undefined && typeof record.childId === 'string');
}

export function saveRelayRecord(record: RelayRecord): RelayRecord {
  writePrivate(relayChildPath(record.childId), record);
  return record;
}

export function removeRelayRecord(childId: string): void {
  fs.rmSync(relayChildPath(childId), { force: true });
}

export function updateRelayRecord(childId: string, change: (record: RelayRecord) => void): RelayRecord | undefined {
  const record = readRelayRecord(childId);
  if (!record) return undefined;
  change(record);
  return saveRelayRecord(record);
}

export function saveForward(entry: ForwardEntry): void {
  writePrivate(relayOutboxPath(entry.receipt), entry);
}

export function removeForward(receipt: string): void {
  fs.rmSync(relayOutboxPath(receipt), { force: true });
}

/** Every report waiting to leave, oldest first. */
export function listForwards(): ForwardEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(relayOutboxDir());
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson<ForwardEntry>(path.join(relayOutboxDir(), file)))
    .filter((entry): entry is ForwardEntry => entry !== undefined && typeof entry.receipt === 'string')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.receipt.localeCompare(b.receipt));
}
