// The child's side of the relay: the reports a child on this machine made for
// a parent on another machine. This daemon never connects to that machine. It
// writes each report to the relay outbox, and the parent's daemon, which
// connects here over SSH through `bellwether relay-bridge`, subscribes to the
// outbox and acknowledges each report it takes. A report stays on disk until
// that acknowledgement, so a dropped connection or a stopped daemon loses
// nothing, and the receipt in each report makes a second delivery harmless.
import { relayOutboxPath } from '../core/paths.ts';
import { listForwards, newReportReceipt, readRelayRecord, removeForward, removeRelayRecord, saveForward, updateRelayRecord, type ForwardEntry, type RelayRecord } from '../core/relay-records.ts';
import type { RelayRestartAnswer } from '../core/restart.ts';
import type { ReportStatus } from '../core/types.ts';
import { MAX_DAEMON_FRAME_BYTES, formatReply, type RelayReport } from './protocol.ts';

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

type Outcome = { refused?: string; answer?: string };

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
    const waiting = this.waiting(subscriber.parentIds).filter((entry) => {
      // One already on disk, from an older Bellwether or a hand, would cut this connection and every one after it.
      const tooLong = overLong(entry);
      if (!tooLong) return true;
      saveForward({ ...entry, refused: `the report ${tooLong}` });
      this.log(`relay: set aside report ${entry.receipt} from child ${entry.childId}, kept in ${relayOutboxPath(entry.receipt)} as refused: it ${tooLong}`);
      this.settleRecord(entry.childId, false);
      return false;
    });
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
  ack(receipt: string, refused?: string, answer?: string): void {
    const entry = listForwards().find((candidate) => candidate.receipt === receipt);
    if (entry) {
      if (entry.retire) {
        // The relay record says whether a retirement still waits, for doctor.
        updateRelayRecord(entry.childId, (record) => {
          if (record.retireRequest?.receipt !== receipt) return;
          if (refused) record.retireRequest.refused = refused;
          else delete record.retireRequest;
        });
      }
      if (refused) {
        saveForward({ ...entry, refused });
        this.log(`relay: the parent's daemon refused report ${receipt}, kept in ${relayOutboxPath(receipt)}: ${refused}`);
      } else {
        removeForward(receipt);
        this.log(`relay: the parent's daemon took report ${receipt} from child ${entry.childId}`);
      }
      this.settleRecord(entry.childId, !refused);
    }
    this.acks.get(receipt)?.({ ...(refused ? { refused } : {}), ...(answer ? { answer } : {}) });
    this.acks.delete(receipt);
  }

  /**
   * Take a report for a relay child: write it to disk, then hand it to every
   * connected daemon of its parent and wait a little for the acknowledgement.
   * The answer says whether it arrived or waits; either way it is on disk.
   */
  async report(record: RelayRecord, status: ReportStatus, text: string): Promise<string> {
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, status, text, at: new Date(this.now()).toISOString() };
    // A report kept here past one relay line would cut every connection it was sent on, so it is refused before it is kept.
    const tooLong = overLong(entry);
    if (tooLong) throw new Error(`parent_report ${tooLong} Nothing was saved. Report a shorter summary, and leave the rest in a file the parent can read with agent_read or over SSH.`);
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

  /**
   * A child on this machine asked to be retired, and this daemon holds no
   * registry for it: its record belongs to a parent on another machine
   * (issue #227). The request waits in the outbox as a report does, the
   * relay record says so, and it goes to each connected daemon of that
   * parent, whose acknowledgement carries its answer for the child. The
   * child may close its tab either way, because the request is on disk.
   */
  async retire(record: RelayRecord, reason?: string): Promise<string> {
    const at = new Date(this.now()).toISOString();
    const why = reason ? ` (${reason})` : '';
    // A parent's daemon that predates `retire` takes this as a report, so its text says what the child asked.
    const text = `${record.name} asked to be retired${why} from the machine it runs on, which does not hold its record. The parent's Bellwether predates a retirement request from another machine, so nothing was retired. Close the child with agent_stop, and remove its worktree by hand once its work is safe.`;
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, status: 'needs-input', text, at, retire: reason ? { reason } : {} };
    const tooLong = overLong(entry);
    if (tooLong) throw new Error(`request_retirement's reason is too long to cross to the parent's machine: as one relay line the request takes more than the ${MAX_DAEMON_FRAME_BYTES} characters a line may carry. Nothing was saved. Give a shorter reason.`);
    saveForward(entry);
    updateRelayRecord(record.childId, (kept) => {
      kept.retireRequest = { at, receipt: entry.receipt };
    });
    this.settleRecord(entry.childId, false);
    const lead = `Not this machine's child: the daemon here holds no registry for ${record.name} (child ${record.childId}). Its record belongs to parent ${record.parentId}, whose daemon runs on another machine, so the request goes there, the way a report does.`;
    const saved = `saved as ${entry.receipt} in ${relayOutboxPath(entry.receipt)}`;
    const close = 'You may close your tab now: the daemon that holds your record retires you once it takes the request, and `bellwether doctor` on this machine shows the request until then. Do not ask again.';
    const listeners = [...this.subscribers].filter((subscriber) => subscriber.parentIds.has(entry.parentId));
    if (!listeners.length) {
      this.log(`relay: kept the retirement request ${entry.receipt} of child ${entry.childId} for parent ${entry.parentId}, whose daemon is not connected`);
      return `${lead} That daemon is not connected to this machine now. The request is ${saved}, and it collects the request when it connects. ${close}`;
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
    this.log(`relay: sent the retirement request ${entry.receipt} of child ${entry.childId} to the daemon of parent ${entry.parentId}`);
    const result = await outcome;
    if (!result) return `${lead} That daemon has not acknowledged it yet. The request is ${saved}, and it goes again whenever that daemon reconnects, until it does. ${close}`;
    if (result.refused) return `${lead} That daemon refused it: ${result.refused}. It stays in ${relayOutboxPath(entry.receipt)} and does not go again. Ask your parent to close you with agent_stop.`;
    if (!result.answer) return `${lead} That daemon took the request without an answer, because it predates a retirement request from another machine: it showed your parent a request for input and retires nothing. Tell your parent with parent_report that your work is done, and ask it to close you with agent_stop.`;
    return `${lead}\n${result.answer}`;
  }

  /**
   * The child's model read a parent's message that crossed from the parent's
   * machine. The read waits in the outbox as any report does, until the
   * parent's daemon acknowledges it, and goes to each connected one now.
   */
  messageRead(record: RelayRecord, messageId: string): void {
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, status: 'progress', text: '', at: new Date(this.now()).toISOString(), messageRead: messageId };
    saveForward(entry);
    this.settleRecord(entry.childId, false);
    const listeners = [...this.subscribers].filter((subscriber) => subscriber.parentIds.has(entry.parentId));
    for (const listener of listeners) listener.send(toReport(entry));
    this.log(`relay: kept the read of message ${messageId} by child ${record.childId} for parent ${record.parentId}${listeners.length ? ', and sent it' : ', whose daemon is not connected'}`);
  }

  /**
   * A restart this daemon did for a parent's daemon on another machine
   * finished. Its answer also went to the request, but a connection that
   * ended before then lost it, so the answer waits here as a report does,
   * until that daemon acknowledges it (issue #211).
   */
  restartAnswer(record: RelayRecord, requestId: string, answer: RelayRestartAnswer): void {
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, status: 'progress', text: '', at: new Date(this.now()).toISOString(), restartAnswer: { requestId, answer } };
    saveForward(entry);
    this.settleRecord(entry.childId, false);
    const listeners = [...this.subscribers].filter((subscriber) => subscriber.parentIds.has(entry.parentId));
    for (const listener of listeners) listener.send(toReport(entry));
    this.log(`relay: kept the answer of restart ${requestId} of child ${record.childId} for parent ${record.parentId}${listeners.length ? ', and sent it' : ', whose daemon is not connected'}`);
  }

  /** Say on the child's relay record how many of its reports wait, and remove the record of a gone child once none does. */
  private settleRecord(childId: string, forwarded: boolean): void {
    const pending = this.waiting().filter((entry) => entry.childId === childId);
    // A read, a restart answer or a retirement request waits like a report, but it is not one, so the count a person sees leaves it out.
    const waiting = pending.filter((entry) => !entry.messageRead && !entry.restartAnswer && !entry.retire).length;
    if (pending.length === 0 && readRelayRecord(childId)?.retiredAt) {
      removeRelayRecord(childId);
      this.log(`relay: removed the record of child ${childId}, which is gone and has no report left to collect`);
      return;
    }
    updateRelayRecord(childId, (record) => {
      if (forwarded) record.lastForwardedAt = new Date(this.now()).toISOString();
      if (waiting === 0) delete record.unforwarded;
      else record.unforwarded = waiting;
    });
  }
}

/**
 * Why a report cannot cross to the parent's machine, or undefined when it can.
 * It crosses as one protocol line, and the parent's daemon cuts a connection
 * that sends a line longer than a frame.
 */
function overLong(entry: ForwardEntry): string | undefined {
  const line = formatReply({ type: 'relay-report', report: toReport(entry) }).length;
  if (line <= MAX_DAEMON_FRAME_BYTES) return undefined;
  return `text is too long to cross to the parent's machine: as one relay line it takes ${line} characters, over the ${MAX_DAEMON_FRAME_BYTES} a line may carry.`;
}

function toReport(entry: ForwardEntry): RelayReport {
  return { receipt: entry.receipt, childId: entry.childId, parentId: entry.parentId, status: entry.status, text: entry.text, at: entry.at, ...(entry.messageRead ? { messageRead: entry.messageRead } : {}), ...(entry.restartAnswer ? { restartAnswer: entry.restartAnswer } : {}), ...(entry.retire ? { retire: entry.retire } : {}) };
}
