// The relay records: what a machine's daemon holds for a child whose parent
// runs on another machine. The parent's daemon stays the registry of record;
// this machine keeps only what it needs to carry a report there: the child id,
// the parent id, and the SSH target of the parent's machine. A report waiting
// for that machine sits in its own file, named by its receipt, until the hop
// succeeds, so a daemon that stops mid-retry loses nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, relayChildPath, relayOutboxDir, relayOutboxPath } from './paths.ts';
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
  /** The SSH target of the parent's machine, as the operator's SSH configuration resolves it. */
  parentHost: string;
  cwd?: string;
  registeredAt: string;
  /** How many of this child's reports wait in the relay outbox. Absent or 0 when none do. */
  unforwarded?: number;
  /** Why the newest attempt failed, while any report waits. */
  lastForwardError?: string;
  /** When a report last reached the parent. */
  lastForwardedAt?: string;
}

/** One report waiting to reach the parent's machine. */
export interface ForwardEntry {
  receipt: string;
  childId: string;
  parentId: string;
  parentHost: string;
  status: ReportStatus;
  text: string;
  at: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  /** Set when the receiving daemon refused the report, which no retry can fix. */
  refused?: string;
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

export function saveRelayRecord(record: RelayRecord): RelayRecord {
  writePrivate(relayChildPath(record.childId), record);
  return record;
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

/**
 * The SSH target another machine uses to reach this one. The operator sets
 * `sshTarget` in ~/.bellwether/config.json when the host name is not what
 * their SSH configuration resolves; otherwise it is the host name.
 */
export function returnTarget(): string {
  const config = readJson<{ sshTarget?: unknown }>(configPath());
  const target = typeof config?.sshTarget === 'string' ? config.sshTarget.trim() : '';
  return target || os.hostname();
}
