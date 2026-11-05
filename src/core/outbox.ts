// The outbox: one pending entry per child, where a newer state replaces an
// older one, and an entry counts as read once its receipt id reaches the
// parent's model context. It survives a restart on disk, because a parent
// session that resumes still owes its children an answer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { outboxPath } from './paths.ts';
import type { ChildEventKind, OutboxEntry } from './types.ts';

export function newReceipt(): string {
  return `bw-${crypto.randomBytes(6).toString('hex')}`;
}

export function newChildId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export class Outbox {
  private entries: OutboxEntry[] = [];

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
   * a child that goes quiet then blocked produces one message, not two.
   */
  offer(entry: Omit<OutboxEntry, 'receipt' | 'read'>): OutboxEntry {
    const existing = this.entries.find((candidate) => candidate.childId === entry.childId && !candidate.read);
    const next: OutboxEntry = { ...entry, receipt: newReceipt(), read: false };
    if (existing) Object.assign(existing, next);
    else this.entries.push(next);
    return existing ?? next;
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
