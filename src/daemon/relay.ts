// The relay: how a daemon carries a report to a parent on another machine. It
// is part of the daemon that already runs on the child's machine, not a
// process of its own. A report is written to the relay outbox first, then
// sent as one SSH command that runs `bellwether report` with flags on the
// parent's machine, which posts it to that machine's daemon. A hop that fails
// leaves the file in place and tries again with backoff; the receipt in the
// file makes a retry that already landed harmless.
import { relayOutboxPath } from '../core/paths.ts';
import { NO_BELLWETHER_EXIT, REFUSED_EXIT, describeFailure, runRemoteBellwether, type SshResult } from '../core/ssh.ts';
import { listForwards, newReportReceipt, removeForward, saveForward, updateRelayRecord, type ForwardEntry, type RelayRecord } from '../core/relay-records.ts';
import type { ReportStatus } from '../core/types.ts';

/** The longest report text a forward carries, since the whole report rides on one SSH command line. */
export const MAX_FORWARD_TEXT_BYTES = 100_000;

export interface RelayOptions {
  /** The ssh binary. Defaults to `ssh` on PATH. */
  ssh?: string;
  log?: (message: string) => void;
  now?: () => number;
  /** The first retry delay. Each failure doubles it, up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** How long one SSH hop may take. */
  hopTimeoutMs?: number;
}

/** The flags `bellwether report` takes on the parent's machine. */
export function reportFlags(entry: Pick<ForwardEntry, 'parentId' | 'childId' | 'receipt' | 'status' | 'text'>): string[] {
  return ['report', '--parent', entry.parentId, '--child', entry.childId, '--receipt', entry.receipt, '--status', entry.status, '--text', entry.text];
}

export class Relay {
  private readonly ssh: string | undefined;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly hopTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(options: RelayOptions = {}) {
    this.ssh = options.ssh;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.initialDelayMs = options.initialDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.hopTimeoutMs = options.hopTimeoutMs ?? 30_000;
  }

  /** Pick up the reports an earlier daemon left waiting. */
  start(): void {
    this.stopped = false;
    const waiting = this.waiting();
    if (waiting.length) this.log(`relay: ${waiting.length} report(s) wait to be forwarded`);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Reports still to forward. A refused report waits for a person and is not counted. */
  waiting(): ForwardEntry[] {
    return listForwards().filter((entry) => !entry.refused);
  }

  /** Whether the daemon must stay up to keep retrying. */
  busy(): boolean {
    return this.waiting().length > 0;
  }

  /**
   * Take a report for a relay child: spool it, then try the hop at once. The
   * answer says whether it reached the parent or waits in the outbox; either
   * way the report is on disk before this returns.
   */
  async report(record: RelayRecord, status: ReportStatus, text: string): Promise<string> {
    if (Buffer.byteLength(text, 'utf8') > MAX_FORWARD_TEXT_BYTES) {
      throw new Error(`parent_report text is ${Buffer.byteLength(text, 'utf8')} bytes, over the ${MAX_FORWARD_TEXT_BYTES} a report to machine ${record.parentHost} can carry on one SSH command line. Nothing was sent. Report a shorter summary, and leave the rest in a file the parent can read.`);
    }
    const at = new Date(this.now()).toISOString();
    const entry: ForwardEntry = { receipt: newReportReceipt(), childId: record.childId, parentId: record.parentId, parentHost: record.parentHost, status, text, at, attempts: 0, nextAttemptAt: at };
    saveForward(entry);
    this.log(`relay: queued report ${entry.receipt} from child ${entry.childId} for parent ${entry.parentId} on ${entry.parentHost}`);
    // A new report is a fresh reason to try the host now, and the older ones go first, in order.
    for (const waiting of this.waiting()) {
      if (waiting.parentHost === entry.parentHost && waiting.receipt !== entry.receipt) saveForward({ ...waiting, nextAttemptAt: at });
    }
    await this.flush();
    const left = this.waiting().find((waiting) => waiting.receipt === entry.receipt) ?? listForwards().find((waiting) => waiting.receipt === entry.receipt);
    if (!left) return `Reported ${status} to the parent on machine ${record.parentHost}, as ${record.name}.`;
    if (left.refused) return `The parent's machine ${record.parentHost} refused report ${left.receipt}: ${left.refused}. It stays in ${relayOutboxPath(left.receipt)} and is not retried.`;
    return `The report could not reach machine ${record.parentHost} yet (${left.lastError ?? 'unknown error'}). It is saved as ${left.receipt} in ${relayOutboxPath(left.receipt)}, and this machine's daemon retries it with backoff until it lands, so it is not lost. Do not report it again.`;
  }

  /** Forward every report that is due, oldest first, one host at a time. */
  flush(): Promise<void> {
    const run = this.queue.then(() => this.flushNow());
    this.queue = run.catch(() => {});
    return run;
  }

  private async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const blocked = new Set<string>();
    for (const entry of this.waiting()) {
      if (this.stopped) return;
      // Reports from one machine to another arrive in the order they were made.
      if (blocked.has(entry.parentHost)) continue;
      if (Date.parse(entry.nextAttemptAt) > this.now()) {
        blocked.add(entry.parentHost);
        continue;
      }
      const ok = await this.forward(entry);
      if (!ok) blocked.add(entry.parentHost);
    }
    this.schedule();
  }

  private async forward(entry: ForwardEntry): Promise<boolean> {
    this.log(`relay: forwarding report ${entry.receipt} from child ${entry.childId} to ${entry.parentHost}, attempt ${entry.attempts + 1}`);
    let result: SshResult;
    try {
      result = await runRemoteBellwether(entry.parentHost, reportFlags(entry), { ssh: this.ssh, timeoutMs: this.hopTimeoutMs });
    } catch (error) {
      result = { code: 1, stdout: '', stderr: (error as Error).message };
    }
    if (result.code === 0) {
      removeForward(entry.receipt);
      this.log(`relay: report ${entry.receipt} reached ${entry.parentHost}${result.stdout.trim() ? `: ${result.stdout.trim()}` : ''}`);
      this.settleRecord(entry.childId, undefined, true);
      return true;
    }
    const reason = describeFailure(entry.parentHost, result);
    const attempts = entry.attempts + 1;
    if (result.code === REFUSED_EXIT) {
      saveForward({ ...entry, attempts, lastError: reason, refused: reason });
      this.log(`relay: ${entry.parentHost} refused report ${entry.receipt}, kept in ${relayOutboxPath(entry.receipt)}: ${reason}`);
      this.settleRecord(entry.childId, reason);
      return true;
    }
    const delay = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.min(attempts - 1, 20));
    const hint = result.code === NO_BELLWETHER_EXIT ? ' Install @elecnix/bellwether on that machine.' : '';
    saveForward({ ...entry, attempts, lastError: `${reason}${hint}`, nextAttemptAt: new Date(this.now() + delay).toISOString() });
    this.log(`relay: forwarding report ${entry.receipt} to ${entry.parentHost} failed, retry in ${Math.round(delay / 1000)} s: ${reason}${hint}`);
    this.settleRecord(entry.childId, `${reason}${hint}`);
    return false;
  }

  /** Say on the child's relay record how many of its reports wait, and why. */
  private settleRecord(childId: string, error?: string, forwarded = false): void {
    const all = listForwards().filter((entry) => entry.childId === childId);
    updateRelayRecord(childId, (record) => {
      if (forwarded) record.lastForwardedAt = new Date(this.now()).toISOString();
      if (all.length === 0) {
        delete record.unforwarded;
        delete record.lastForwardError;
        return;
      }
      record.unforwarded = all.length;
      if (error) record.lastForwardError = error;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const waiting = this.waiting();
    if (!waiting.length) return;
    const next = Math.min(...waiting.map((entry) => Date.parse(entry.nextAttemptAt)));
    this.timer = setTimeout(() => void this.flush(), Math.max(0, next - this.now()));
    // The timer keeps the daemon process alive, which is the point: a report
    // that has not landed must not wait for the next client to come along.
  }
}
