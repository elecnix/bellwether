// The child's side of the relay: the reports a child on this machine made for
// a parent on another machine. This daemon never connects to that machine. It
// writes each report to the relay outbox, and the parent's daemon, which
// connects here over SSH through `bellwether relay-bridge`, subscribes to the
// outbox and acknowledges each report it takes. A report stays on disk until
// that acknowledgement, so a dropped connection or a stopped daemon loses
// nothing, and the receipt in each report makes a second delivery harmless.
import { relayOutboxPath } from '../core/paths.ts';
import { listForwards, newReportReceipt, removeForward, saveForward, updateRelayRecord, type ForwardEntry, type RelayRecord } from '../core/relay-records.ts';
import type { ReportStatus } from '../core/types.ts';
import type { RelayReport } from './protocol.ts';

export interface RelayOutboxOptions {
  log?: (message: string) => void;
  now?: () => number;
  /** How long a child's report call waits for a connected parent's acknowledgement. */
  ackWaitMs?: number;
}

/** One parent daemon's connection, through a bridge, and the parents it collects for. */
export interface RelaySubscriber {
  parentIds: Set<string>;
  send(report: RelayReport): void;
}

type Outcome = { refused?: string };

export class RelayOutbox {
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly ackWaitMs: number;
  private readonly subscribers = new Set<RelaySubscriber>();
  private readonly acks = new Map<string, (outcome: Outcome) => void>();

  constructor(options: RelayOutboxOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.ackWaitMs = options.ackWaitMs ?? 5_000;
  }

  /** Reports still to collect. A refused report waits for a person and is not sent again. */
  waiting(parentIds?: Set<string>): ForwardEntry[] {
    return listForwards().filter((entry) => !entry.refused && (!parentIds || parentIds.has(entry.parentId)));
  }

  /**
   * A parent's daemon subscribed: send it every report that waits for its
   * parents, oldest first, and each new one from now on. Returns how many it
   * sent, and a function that ends the subscription.
   */
  subscribe(subscriber: RelaySubscriber): { sent: number; stop: () => void } {
    this.subscribers.add(subscriber);
    const waiting = this.waiting(subscriber.parentIds);
    for (const entry of waiting) subscriber.send(toReport(entry));
    if (waiting.length) this.log(`relay: sent ${waiting.length} waiting report(s) to a parent's daemon for ${[...subscriber.parentIds].join(', ')}`);
    return { sent: waiting.length, stop: () => this.subscribers.delete(subscriber) };
  }

  /** Whether a parent's daemon collects for this parent right now. */
  connected(parentId: string): boolean {
    for (const subscriber of this.subscribers) if (subscriber.parentIds.has(parentId)) return true;
    return false;
  }

  /** The parent's daemon took a report, or refused it. Either way it is not sent again. */
  ack(receipt: string, refused?: string): void {
    const entry = listForwards().find((candidate) => candidate.receipt === receipt);
    if (entry) {
      if (refused) {
        saveForward({ ...entry, refused });
        this.log(`relay: the parent's daemon refused report ${receipt}, kept in ${relayOutboxPath(receipt)}: ${refused}`);
      } else {
        removeForward(receipt);
        this.log(`relay: the parent's daemon took report ${receipt} from child ${entry.childId}`);
      }
      this.settleRecord(entry.childId, !refused);
    }
    this.acks.get(receipt)?.(refused ? { refused } : {});
    this.acks.delete(receipt);
  }

  /**
   * Take a report for a relay child: write it to disk, then hand it to every
   * connected daemon of its parent and wait a little for the acknowledgement.
   * The answer says whether it arrived or waits; either way it is on disk.
   */
  async report(record: RelayRecord, status: ReportStatus, text: string): Promise<string> {
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, status, text, at: new Date(this.now()).toISOString() };
    saveForward(entry);
    this.settleRecord(entry.childId, false);
    const listeners = [...this.subscribers].filter((subscriber) => subscriber.parentIds.has(entry.parentId));
    const saved = `saved as ${entry.receipt} in ${relayOutboxPath(entry.receipt)}`;
    if (!listeners.length) {
      this.log(`relay: kept report ${entry.receipt} from child ${entry.childId} for parent ${entry.parentId}, whose daemon is not connected`);
      return `The parent runs on another machine, and its daemon is not connected to this one now. The report is ${saved}, and the parent's daemon collects it when it connects. Do not report it again.`;
    }
    const outcome = new Promise<Outcome | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(entry.receipt);
        resolve(undefined);
      }, this.ackWaitMs);
      timer.unref?.();
      this.acks.set(entry.receipt, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    for (const listener of listeners) listener.send(toReport(entry));
    const result = await outcome;
    if (!result) return `The report went to the parent's daemon, which has not acknowledged it yet. It is ${saved}, and it is sent again whenever that daemon reconnects, until it does. Do not report it again.`;
    if (result.refused) return `The parent's daemon refused report ${entry.receipt}: ${result.refused}. It stays in ${relayOutboxPath(entry.receipt)} and is not sent again.`;
    return `Reported ${status} to the parent on another machine, as ${record.name}.`;
  }

  /** Say on the child's relay record how many of its reports wait. */
  private settleRecord(childId: string, forwarded: boolean): void {
    const waiting = this.waiting().filter((entry) => entry.childId === childId).length;
    updateRelayRecord(childId, (record) => {
      if (forwarded) record.lastForwardedAt = new Date(this.now()).toISOString();
      if (waiting === 0) delete record.unforwarded;
      else record.unforwarded = waiting;
    });
  }
}

function toReport(entry: ForwardEntry): RelayReport {
  return { receipt: entry.receipt, childId: entry.childId, parentId: entry.parentId, status: entry.status, text: entry.text, at: entry.at };
}
