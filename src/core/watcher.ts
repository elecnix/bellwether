// The watcher: subscribe to the child panes, reconcile against a snapshot,
// turn herdr states into events, and hand new events to the parent's adapter.
//
// The order matters and comes from herdr-lantern: subscribe first, then take a
// snapshot on a second connection, then reconcile. herdr does not replay
// events, so a subscription opened after the snapshot would miss whatever
// happened in between. After a disconnect the watcher takes a fresh snapshot
// for the same reason.
import fs from 'node:fs';
import type { HerdrClient, HerdrEvent, Subscription } from './herdr-client.ts';
import { DEFAULT_LIMITS, advance, initialState, markReported, type ClassifierState, type SettleLimits } from './classifier.ts';
import { Outbox } from './outbox.ts';
import { readParent, updateChild } from './registry.ts';
import { spoolPath } from './paths.ts';
import type { AgentStatus, ChildEventKind, ChildRecord, OutboxEntry, SpoolReport } from './types.ts';

/** herdr's status for a pane, or the child's last known status. */
function statusOf(pane: Record<string, unknown> | undefined, fallback: AgentStatus): AgentStatus {
  const value = pane?.['agent_status'];
  return typeof value === 'string' && ['idle', 'working', 'blocked', 'done', 'unknown'].includes(value) ? (value as AgentStatus) : fallback;
}

export interface WatcherOptions {
  client: HerdrClient;
  parentId: string;
  limits?: SettleLimits;
  /** Called with every unread entry once new events appear. */
  onEntries: (entries: OutboxEntry[]) => void;
  now?: () => number;
  /** How often the local clock is checked for the stuck threshold. */
  tickMs?: number;
  /** How often a child with no transcript has its screen read. 0 turns it off. */
  screenPollMs?: number;
  log?: (message: string) => void;
}

export class Watcher {
  private readonly client: HerdrClient;
  private readonly parentId: string;
  private readonly limits: SettleLimits;
  private readonly onEntries: (entries: OutboxEntry[]) => void;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly screenPollMs: number;
  private readonly log: (message: string) => void;
  private readonly outbox: Outbox;
  private readonly states = new Map<string, ClassifierState>();
  private readonly screenReadAt = new Map<string, number>();
  private readonly transcriptSizes = new Map<string, number>();

  private controller: AbortController | undefined;
  private subscription: Subscription | undefined;
  private subscribedKey = '';
  private ticker: NodeJS.Timeout | undefined;
  private reconnecting = false;
  private spoolOffset = 0;
  private stopped = true;

  constructor(options: WatcherOptions) {
    this.client = options.client;
    this.parentId = options.parentId;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.onEntries = options.onEntries;
    this.now = options.now ?? (() => Date.now());
    this.tickMs = options.tickMs ?? 5_000;
    this.screenPollMs = options.screenPollMs ?? 30_000;
    this.log = options.log ?? (() => {});
    this.outbox = Outbox.load(this.parentId);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    this.ticker = setInterval(() => void this.tick(), this.tickMs);
    this.ticker.unref?.();
    void this.reconcileAndSubscribe();
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.subscription?.close();
    this.subscription = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  outboxEntries(): OutboxEntry[] {
    return this.outbox.all();
  }

  markRead(receipt: string): void {
    if (!this.outbox.markRead(receipt)) return;
    this.outbox.save(this.parentId);
  }

  /** Record that a receipt has been sent to the parent, so a burst is sent once. */
  markDelivered(receipt: string): void {
    this.outbox.markDelivered(receipt);
    this.outbox.save(this.parentId);
  }

  /** Subscribe to the current child panes, then reconcile against a snapshot. */
  private async reconcileAndSubscribe(): Promise<void> {
    if (this.stopped) return;
    const signal = this.controller?.signal;
    if (!signal) return;
    try {
      const record = readParent(this.parentId);
      const children = record?.children ?? [];
      await this.ensureSubscription(children, signal);
      await this.reconcile(children, signal);
      this.publish();
    } catch (error) {
      this.log(`reconcile failed: ${String(error)}`);
      this.scheduleReconnect();
    }
  }

  /**
   * herdr's status subscriptions are per pane, so the subscription is rebuilt
   * whenever the set of child panes changes.
   */
  private async ensureSubscription(children: ChildRecord[], signal: AbortSignal): Promise<void> {
    const key = children
      .filter((child) => !child.exitedAt)
      .map((child) => `${child.paneId}:${child.harness === 'other' ? 'raw' : 'agent'}`)
      .sort()
      .join(',');
    if (key === this.subscribedKey && this.subscription) return;
    this.subscription?.close();
    this.subscription = undefined;
    const subscriptions: Record<string, unknown>[] = [
      { type: 'pane.exited' },
      { type: 'pane.closed' },
      { type: 'pane.agent_detected' },
      ...children.filter((child) => !child.exitedAt).map((child) => ({ type: 'pane.agent_status_changed', pane_id: child.paneId })),
    ];
    this.subscription = await this.client.subscribe(subscriptions, (event) => void this.onHerdrEvent(event), signal);
    this.subscribedKey = key;
    this.log(`subscribed to ${children.length} child pane(s)`);
    void this.subscription.closed.catch((error: unknown) => {
      this.log(`subscription lost: ${String(error)}`);
      this.subscribedKey = '';
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    let delay = 250;
    const attempt = (): void => {
      if (this.stopped) return;
      void this.reconcileAndSubscribe()
        .then(() => {
          this.reconnecting = false;
        })
        .catch(() => {
          delay = Math.min(delay * 2, 10_000);
          setTimeout(attempt, delay).unref?.();
        });
    };
    setTimeout(attempt, delay).unref?.();
  }

  private async onHerdrEvent(event: HerdrEvent): Promise<void> {
    const paneId = typeof event.data['pane_id'] === 'string' ? event.data['pane_id'] : undefined;
    if (!paneId) {
      if (event.event === 'events.lost' || event.event === 'events_lost') {
        this.log('herdr reported lost events; resubscribing');
        this.subscribedKey = '';
        void this.reconcileAndSubscribe();
      }
      return;
    }
    const record = readParent(this.parentId);
    const child = record?.children.find((entry) => entry.paneId === paneId);
    if (!child) return;
    if (event.event === 'pane.exited' || event.event === 'pane.closed') {
      const code = typeof event.data['exit_code'] === 'number' ? (event.data['exit_code'] as number) : undefined;
      updateChild(this.parentId, child.id, (entry) => {
        entry.exitedAt = new Date().toISOString();
        entry.exitCode = code;
        entry.lastStatus = 'unknown';
      });
      this.offer(child, 'exited', this.describeExit(child.name, code));
      return;
    }
    if (event.event === 'pane.agent_status_changed' || event.event === 'pane_agent_status_changed') {
      const status = statusOf(event.data, child.lastStatus);
      updateChild(this.parentId, child.id, (entry) => {
        if (entry.lastStatus !== status) entry.statusChangedAt = new Date().toISOString();
        entry.lastStatus = status;
      });
      await this.evaluate(record);
      return;
    }
    if (event.event === 'pane.agent_detected') {
      await this.reconcile(record?.children ?? [], this.controller!.signal);
    }
  }

  /** Read the live status of every child and fold it into the classifier. */
  private async reconcile(children: ChildRecord[], signal: AbortSignal): Promise<void> {
    if (!children.length) return;
    let panes: Record<string, unknown>[];
    try {
      const snapshot = await this.client.snapshot(signal);
      const list = snapshot['panes'] ?? snapshot['pane_list'] ?? [];
      panes = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
    } catch (error) {
      this.log(`snapshot failed: ${String(error)}`);
      return;
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const pane of panes) {
      const paneId = pane['pane_id'];
      if (typeof paneId === 'string') byId.set(paneId, pane);
    }
    for (const child of children) {
      const pane = byId.get(child.paneId);
      if (!pane) continue;
      const status = statusOf(pane, child.lastStatus);
      const seq = typeof pane['completion_seq'] === 'number' ? (pane['completion_seq'] as number) : undefined;
      if (status !== child.lastStatus || (seq !== undefined && seq !== child.completionSeq)) {
        updateChild(this.parentId, child.id, (entry) => {
          if (entry.lastStatus !== status) entry.statusChangedAt = new Date().toISOString();
          entry.lastStatus = status;
          if (seq !== undefined) entry.completionSeq = seq;
        });
      }
    }
    await this.evaluate(readParent(this.parentId));
  }

  /** One classifier pass over every child. */
  private async evaluate(record: { children: ChildRecord[] } | undefined): Promise<void> {
    if (!record) return;
    const now = this.now();
    for (const child of record.children) {
      if (child.exitedAt) continue;
      const state = this.states.get(child.id) ?? initialState(child.lastStatus, now);
      const busy = await this.childIsBusy(child, now);
      const { state: next, event } = advance(state, { status: child.lastStatus, completionSeq: child.completionSeq, busy }, now, this.limits);
      this.states.set(child.id, next);
      if (!event) continue;
      if (event === 'idle' && child.lastReport && Date.parse(child.lastReport.at) >= Date.parse(child.statusChangedAt)) {
        this.states.set(child.id, markReported(next, now));
        continue;
      }
      this.offer(child, event, await this.describe(child, event));
    }
    this.publish();
  }

  /** Whether the child moved since the last look. Transcript growth, then screen. */
  private async childIsBusy(child: ChildRecord, now: number): Promise<boolean> {
    if (child.transcript) {
      try {
        const size = fs.statSync(child.transcript).size;
        const previous = this.transcriptSizes.get(child.id);
        this.transcriptSizes.set(child.id, size);
        if (previous !== undefined && size > previous) {
          updateChild(this.parentId, child.id, (entry) => {
            entry.lastBusyAt = new Date().toISOString();
          });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    // A harness with no transcript moves only its screen, which costs a read.
    if (this.screenPollMs <= 0) return false;
    const last = this.screenReadAt.get(child.id) ?? 0;
    if (now - last < this.screenPollMs) return false;
    this.screenReadAt.set(child.id, now);
    try {
      const screen = await this.client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 });
      const lines = screen.split('\n').filter((line) => line.trim().length > 0 && !/⏱|\[\d+% ·/.test(line));
      const previous = this.lastScreen.get(child.id);
      this.lastScreen.set(child.id, lines.join('\n'));
      if (previous !== undefined && previous !== lines.join('\n')) {
        updateChild(this.parentId, child.id, (entry) => {
          entry.lastBusyAt = new Date().toISOString();
        });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private readonly lastScreen = new Map<string, string>();

  /** What the parent is told about a child event. */
  private async describe(child: ChildRecord, event: ChildEventKind): Promise<string> {
    const age = this.age(Date.parse(child.startedAt));
    if (event === 'exited') return this.describeExit(child.name, child.exitCode);
    if (event === 'blocked') {
      const dialog = await this.client.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }).catch(() => '');
      return `${child.name} is blocked on a dialog after ${age}. The dialog:\n${trim(dialog)}\n\nAnswer it with agent_send keys, or answer the card your-attention posted.`;
    }
    if (event === 'stuck') return `${child.name} has been quiet for ${this.age(Date.parse(child.lastBusyAt || child.startedAt))}. Last screen lines:\n${trim(await this.screenTail(child))}`;
    const text = child.lastReport?.text?.trim() || (await this.lastMessage(child)) || trim(await this.screenTail(child));
    return `${child.name} went idle after ${age}:\n${text}`;
  }

  private describeExit(name: string, code: number | undefined): string {
    return `${name} exited${code === undefined ? '' : ` with code ${code}`}.`;
  }

  private async screenTail(child: ChildRecord, lines = 40): Promise<string> {
    return this.client.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines }).catch(() => '');
  }

  /** The child's last assistant message, read from its transcript. */
  private async lastMessage(child: ChildRecord): Promise<string | undefined> {
    if (!child.transcript) return undefined;
    try {
      const content = fs.readFileSync(child.transcript, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry: unknown = JSON.parse(lines[index] ?? 'null');
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const message = record['message'];
        const role = record['type'] === 'assistant' ? 'assistant' : typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['role'] : undefined;
        if (role !== 'assistant') continue;
        const body = typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['content'] : record['content'];
        const text = flatten(body);
        if (text) return text;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private offer(child: ChildRecord, event: ChildEventKind, text: string): void {
    // A newer event replaces an older unread one for the same child, so the
    // entry only becomes a fresh notification when its text actually changes.
    const before = this.outbox.unreadFor(child.id)[0];
    const same = before !== undefined && before.event === event && before.text === text;
    const entry = this.outbox.offer({ childId: child.id, name: child.name, kind: child.kind, paneId: child.paneId, event, text, at: new Date().toISOString() });
    if (!same) entry.deliveredAt = undefined;
    this.outbox.prune();
    this.outbox.save(this.parentId);
  }

  private publish(): void {
    const pending = this.outbox.pending();
    if (!pending.length) return;
    this.onEntries(pending);
  }

  /** Read parent_report lines the children appended to the spool. */
  private tailSpool(): void {
    const file = spoolPath(this.parentId);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (content.length <= this.spoolOffset) return;
    const fresh = content.slice(this.spoolOffset);
    this.spoolOffset = content.length;
    for (const line of fresh.split('\n')) {
      if (!line.trim()) continue;
      try {
        const report = JSON.parse(line) as SpoolReport;
        this.acceptReport(report);
      } catch {
        this.log('ignored an unreadable spool line');
      }
    }
  }

  private acceptReport(report: SpoolReport): void {
    const record = readParent(this.parentId);
    const child = record?.children.find((entry) => entry.id === report.childId || entry.name === report.childName);
    if (!child) return;
    updateChild(this.parentId, child.id, (entry) => {
      entry.lastReport = { status: report.status, text: report.text, at: report.at, seq: report.seq };
      entry.lastBusyAt = report.at;
    });
    const state = this.states.get(child.id);
    if (state) this.states.set(child.id, markReported(state, this.now()));
    const label = report.status === 'needs-input' ? 'needs input' : report.status;
    this.offer(child, 'report', `${child.name} reported ${label}:\n${report.text}`);
    this.publish();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.tailSpool();
    await this.evaluate(readParent(this.parentId));
    if (!this.subscription) this.scheduleReconnect();
  }

  private age(since: number): string {
    const seconds = Math.max(0, Math.round((this.now() - since) / 1000));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    return `${Math.round(minutes / 60)} h`;
  }
}

function flatten(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['text'] === 'string' ? String((entry as Record<string, unknown>)['text']) : '')).filter(Boolean);
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

function trim(value: string, limit = 3000): string {
  return value.trim().slice(-limit);
}
