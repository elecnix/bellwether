// The outbox: one pending entry per child, where a newer state replaces an
// older one, and an entry counts as read once its receipt id reaches the
// parent's model context. It survives a restart on disk, because a parent
// session that resumes still owes its children an answer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { outboxPath } from './paths.ts';
import type { ChildRecord, OutboxEntry } from './types.ts';

export function newReceipt(): string {
  return `bw-${crypto.randomBytes(6).toString('hex')}`;
}

export function newChildId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Whether a newer state has made an unread entry stale. A blocked entry is
 * stale once the child has left the blocked state, which is how a dialog that
 * someone already answered stopped being reported minutes later. A stuck entry
 * is stale once the child moves. When herdr reported a state_change_seq for
 * both, the child's must also be the newer one. A report, an idle event and an
 * exit carry what the child said or did, so they are never dropped.
 */
export function isSuperseded(entry: OutboxEntry, child: ChildRecord | undefined): boolean {
  if (!child || entry.read) return false;
  const newer = entry.stateChangeSeq === undefined || child.stateChangeSeq === undefined || child.stateChangeSeq > entry.stateChangeSeq;
  if (entry.event === 'blocked') return Boolean(child.exitedAt) || (child.lastStatus !== 'blocked' && newer);
  if (entry.event === 'stuck') {
    if (child.exitedAt) return true;
    const moved = Date.parse(child.lastBusyAt) > Date.parse(entry.at);
    return moved || (child.lastStatus !== 'working' && child.lastStatus !== 'unknown' && newer);
  }
  return false;
}

export class Outbox {
  private entries: OutboxEntry[] = [];
  /** Entries settled without a receipt since the last takeSettled. */
  private settled: OutboxEntry[] = [];

  private constructor(entries: OutboxEntry[]) {
    this.entries = entries;
  }

  static load(id: string): Outbox {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(outboxPath(id), 'utf8'));
      return new Outbox(Array.isArray(parsed) ? (parsed as OutboxEntry[]) : []);
    } catch {
      return new Outbox([]);
    }
  }

  save(id: string): void {
    const target = outboxPath(id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.entries, null, 2)}\n`);
    fs.renameSync(temp, target);
  }

  /**
   * Offer an event for a child. A newer event replaces an older unread one, so
   * a child that goes quiet then blocked produces one message, not two. The
   * older entry keeps its receipt and is settled as superseded, so a client
   * that already holds it learns to drop it rather than send it again.
   */
  offer(entry: Omit<OutboxEntry, 'receipt' | 'read'>): OutboxEntry {
    const next: OutboxEntry = { ...entry, receipt: newReceipt(), read: false };
    for (const existing of this.entries) {
      if (existing.childId !== entry.childId || existing.read) continue;
      this.settle(existing, next.receipt);
    }
    this.entries.push(next);
    return next;
  }

  /**
   * Settle every unread entry a newer child state has made stale. Called at
   * delivery, so a queued entry is checked against the child as it is now.
   */
  settleSuperseded(children: readonly ChildRecord[]): OutboxEntry[] {
    const settled: OutboxEntry[] = [];
    for (const entry of this.entries) {
      const child = children.find((candidate) => candidate.id === entry.childId);
      if (!isSuperseded(entry, child)) continue;
      this.settle(entry, `state:${child?.exitedAt ? 'exited' : child?.lastStatus ?? 'unknown'}`);
      settled.push(entry);
    }
    return settled;
  }

  /** The entries settled without a receipt since the last call, once each. */
  takeSettled(): OutboxEntry[] {
    return this.settled.splice(0);
  }

  private settle(entry: OutboxEntry, by: string): void {
    entry.read = true;
    entry.supersededBy = by;
    this.settled.push(entry);
  }

  add(entry: OutboxEntry): void {
    if (this.entries.some((candidate) => candidate.receipt === entry.receipt)) return;
    this.entries.push(entry);
  }

  /** Mark an entry read. A repeated receipt is not an error; it returns false. */
  markRead(receipt: string): boolean {
    const entry = this.entries.find((candidate) => candidate.receipt === receipt);
    if (!entry || entry.read) return false;
    entry.read = true;
    return true;
  }

  markDelivered(receipt: string, at = new Date().toISOString()): void {
    const entry = this.entries.find((candidate) => candidate.receipt === receipt);
    if (entry) entry.deliveredAt = at;
  }

  /** Drop every entry for a child, for one whose spawn failed. */
  drop(childId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.childId !== childId);
    this.settled = this.settled.filter((entry) => entry.childId !== childId);
    return this.entries.length !== before;
  }

  pending(): OutboxEntry[] {
    return this.entries.filter((entry) => !entry.read);
  }

  unreadFor(childId: string): OutboxEntry[] {
    return this.entries.filter((entry) => !entry.read && entry.childId === childId);
  }

  all(): OutboxEntry[] {
    return [...this.entries];
  }

  /** Drop read entries older than a day, so the file does not grow forever. */
  prune(now = Date.now(), maxAgeMs = 24 * 60 * 60_000): void {
    this.entries = this.entries.filter((entry) => !entry.read || now - Date.parse(entry.at) < maxAgeMs);
  }
}
