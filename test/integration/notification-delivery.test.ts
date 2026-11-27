// Tier 2: when a child event reaches a pi parent, and what marks it read.
// The pi extension runs for real against a daemon on a socket of its own. A
// fake pi stands in for the harness, and a service backed by the real outbox
// stands in for herdr, so the read flag lives in a file on a scratch home
// exactly as it does for the live daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Outbox } from '../../src/core/outbox.ts';
import { outboxPath } from '../../src/core/paths.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import type { OutboxEntry } from '../../src/core/types.ts';
import type { RosterChild } from '../../src/core/roster.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Sent {
  content: string;
  details: unknown;
  options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

/** The parts of pi the extension touches, with a way to fire its events. */
function fakePi(): { sent: Sent[]; fire: (event: string, payload: unknown, ctx: unknown) => Promise<void> } & Record<string, unknown> {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = [];
  return {
    sent,
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: () => {},
    sendMessage: (message: { content: string; details?: unknown }, options?: Sent['options']) => sent.push({ content: message.content, details: message.details, options }),
    fire: async (event, payload, ctx) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

/** A pi session context. The parent is busy: a run is streaming. */
function context(session: string, entries: unknown[] = []): unknown {
  return { isIdle: () => false, sessionManager: { getSessionId: () => session, getCwd: () => '/tmp', getEntries: () => entries } };
}

interface OutboxService extends ParentService {
  offer(entry: Omit<OutboxEntry, 'receipt' | 'read'>): OutboxEntry;
  /** The parent's children as the registry holds them, which the daemon sends with each push. */
  children: RosterChild[];
}

/** One service per parent, keeping its events in the real outbox file. */
function outboxFactory(): { factory: ServiceFactory; services: OutboxService[] } {
  const services: OutboxService[] = [];
  const factory: ServiceFactory = (_parent, id) => {
    const outbox = Outbox.load(id);
    let handler: ((entries: OutboxEntry[]) => void) | undefined;
    const service: OutboxService = {
      children: [],
      roster: () => service.children,
      offer(entry) {
        const offered = outbox.offer(entry);
        outbox.save(id);
        handler?.(outbox.pending());
        return offered;
      },
      pending: () => outbox.pending(),
      markRead(receipts) {
        let changed = false;
        for (const receipt of receipts) changed = outbox.markRead(receipt) || changed;
        if (changed) outbox.save(id);
      },
      onEvents: (next) => {
        handler = next;
      },
      tool: async () => '',
      watchPane: () => () => {},
      stop: () => {},
    };
    services.push(service);
    return service;
  };
  return { factory, services };
}

/** A Bellwether home of the case's own, which the extension's client finds through the environment. */
function home(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-delivery-'));
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = root;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(root, 'daemon.sock');
  t.after(() => {
    process.env['BELLWETHER_HOME'] = saved.home;
    process.env['BELLWETHER_DAEMON_SOCKET'] = saved.socket;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function loadExtension(): Promise<(pi: unknown) => void> {
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  return bellwether;
}

function onDisk(parentId: string, receipt: string): OutboxEntry | undefined {
  const entries = JSON.parse(fs.readFileSync(outboxPath(parentId), 'utf8')) as OutboxEntry[];
  return entries.find((entry) => entry.receipt === receipt);
}

function event(childId: string, kind: OutboxEntry['event'], at: string, text = 'text'): Omit<OutboxEntry, 'receipt' | 'read'> {
  return { childId, name: childId, kind: 'pi', paneId: 'w1:p1', event: kind, text, at };
}

/** The message pi records when a steered message enters the conversation. */
function delivered(sent: Sent): unknown {
  return { message: { role: 'custom', customType: 'bellwether', content: sent.content, display: true, details: sent.details } };
}

test('an event that arrives while the parent is busy goes to its next turn, without a reconnect', async (t) => {
  const root = home(t);
  const { factory, services } = outboxFactory();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory });
  t.after(() => daemon.close());
  const pi = fakePi();
  (await loadExtension())(pi);
  const ctx = context('busy-parent');
  await pi.fire('session_start', {}, ctx);
  t.after(() => pi.fire('session_shutdown', {}, ctx));
  await until(() => services.length === 1 && daemon.connections() === 1);

  const offered = services[0]!.offer(event('c1', 'report', new Date().toISOString(), 'c1 reported needs input'));
  await until(() => pi.sent.length === 1);
  const sent = pi.sent[0]!;
  // steer enters the conversation after the tool calls in flight, before the
  // next model call. followUp would hold it until the whole run ends.
  assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(sent.content, new RegExp(offered.receipt));
  assert.doesNotMatch(sent.content, /late by/);
  assert.equal(daemon.connections(), 1, 'the same connection carried it');

  // Handing the message to pi is not a delivery: nothing is read yet.
  await settle(100);
  assert.equal(onDisk(daemon.parents()[0]!, offered.receipt)?.read, false);

  // The parent cats its outbox file: the receipt reaches the model as tool output.
  const shell = { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: fs.readFileSync(outboxPath(daemon.parents()[0]!), 'utf8') }] };
  await pi.fire('context', { messages: [shell] }, ctx);
  await pi.fire('message_end', { message: shell }, ctx);
  await settle(150);
  assert.equal(onDisk(daemon.parents()[0]!, offered.receipt)?.read, false, 'reading the outbox from a shell does not consume the notification');

  // pi puts the steered message in front of the model: that is the delivery.
  await pi.fire('message_end', delivered(sent), ctx);
  await until(() => onDisk(daemon.parents()[0]!, offered.receipt)?.read === true);
  assert.ok(onDisk(daemon.parents()[0]!, offered.receipt)?.deliveredAt);
});

test('a read event is not replayed after a daemon restart, and an unread one is, oldest first and marked late', async (t) => {
  const root = home(t);
  const socketPath = path.join(root, 'daemon.sock');
  const now = Date.now();

  // The first daemon delivers one event, and pi confirms it.
  const first = outboxFactory();
  const before = await startDaemon({ socketPath, home: root, factory: first.factory });
  const pi = fakePi();
  (await loadExtension())(pi);
  const ctx = context('restarted-parent');
  await pi.fire('session_start', {}, ctx);
  await until(() => first.services.length === 1);
  const read = first.services[0]!.offer(event('c0', 'report', new Date(now).toISOString(), 'already delivered'));
  await until(() => pi.sent.length === 1);
  await pi.fire('message_end', delivered(pi.sent[0]!), ctx);
  const parentId = before.parents()[0]!;
  await until(() => onDisk(parentId, read.receipt)?.read === true);
  await pi.fire('session_shutdown', {}, ctx);
  await before.close();

  // While no daemon runs, two more events wait on disk, written out of order.
  const outbox = Outbox.load(parentId);
  const later: OutboxEntry = { ...event('c1', 'report', new Date(now - 214_000).toISOString(), 'later'), receipt: 'bw-later000000', read: false };
  const earlier: OutboxEntry = { ...event('c2', 'exited', new Date(now - 274_000).toISOString(), 'earlier'), receipt: 'bw-earlier0000', read: false };
  outbox.add(later);
  outbox.add(earlier);
  outbox.save(parentId);

  // A new daemon, and a new pi process for the same session.
  const second = outboxFactory();
  const after = await startDaemon({ socketPath, home: root, factory: second.factory });
  t.after(() => after.close());
  const resumed = fakePi();
  (await loadExtension())(resumed);
  await resumed.fire('session_start', {}, ctx);
  t.after(() => resumed.fire('session_shutdown', {}, ctx));
  await until(() => resumed.sent.length === 1);
  await settle(300);
  assert.equal(resumed.sent.length, 1, 'one message for the backlog');
  const text = resumed.sent[0]!.content;
  assert.doesNotMatch(text, new RegExp(read.receipt), 'the event read before the restart is not replayed');
  assert.ok(text.indexOf(earlier.receipt) >= 0 && text.indexOf(earlier.receipt) < text.indexOf(later.receipt), 'the backlog comes oldest first');
  assert.match(text, /bw-earlier0000 \(late by 4m3\ds: it happened at/);
  assert.match(text, /bw-later000000 \(late by 3m3\ds: it happened at/);
});

test('a resumed pi session does not repeat an event its own history shows delivered', async (t) => {
  const root = home(t);
  const { factory, services } = outboxFactory();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory });
  t.after(() => daemon.close());

  // The previous pi process put this event in front of the model, then died
  // before its receipt reached the daemon.
  const pi = fakePi();
  (await loadExtension())(pi);
  const history: unknown[] = [];
  const ctx = context('resumed-parent', history);
  await pi.fire('session_start', {}, ctx);
  await until(() => services.length === 1);
  const offered = services[0]!.offer(event('c1', 'idle', new Date().toISOString()));
  await until(() => pi.sent.length === 1);
  await pi.fire('session_shutdown', {}, ctx);
  history.push({ type: 'custom_message', customType: 'bellwether', content: pi.sent[0]!.content, display: true, details: pi.sent[0]!.details });
  // A shell read in the same history quotes the receipt too, and proves nothing.
  history.push({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: `receipt ${offered.receipt}` }] } });

  const resumed = fakePi();
  (await loadExtension())(resumed);
  await resumed.fire('session_start', {}, ctx);
  t.after(() => resumed.fire('session_shutdown', {}, ctx));
  await until(() => onDisk(daemon.parents()[0]!, offered.receipt)?.read === true);
  await settle(300);
  assert.equal(resumed.sent.length, 0);
});

// Issue #146: an alert carries one line about the parent's other children.
test("a parent with two children hears, in the one alert, that the other exists and what it is doing", async (t) => {
  const root = home(t);
  const { factory, services } = outboxFactory();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory });
  t.after(() => daemon.close());
  const pi = fakePi();
  (await loadExtension())(pi);
  const ctx = context('two-children');
  await pi.fire('session_start', {}, ctx);
  t.after(() => pi.fire('session_shutdown', {}, ctx));
  await until(() => services.length === 1 && daemon.connections() === 1);

  const quiet = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
  services[0]!.children = [
    { childId: 'c1', state: 'idle', since: new Date().toISOString() },
    { childId: 'c2', state: 'blocked', since: quiet },
  ];
  services[0]!.offer(event('c1', 'idle', new Date().toISOString(), 'c1 finished its turn.'));
  await until(() => pi.sent.length === 1);
  const lines = pi.sent[0]!.content.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('children ')).length, 1, 'one roster line');
  assert.ok(lines.includes('children 2: 1 blocked 12m'), pi.sent[0]!.content);
});

test('a parent with one child receives the same text as before the roster', async (t) => {
  const root = home(t);
  const { factory, services } = outboxFactory();
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory });
  t.after(() => daemon.close());
  const pi = fakePi();
  (await loadExtension())(pi);
  const ctx = context('one-child');
  await pi.fire('session_start', {}, ctx);
  t.after(() => pi.fire('session_shutdown', {}, ctx));
  await until(() => services.length === 1 && daemon.connections() === 1);

  services[0]!.children = [{ childId: 'solo', state: 'idle', since: new Date().toISOString() }];
  const offered = services[0]!.offer(event('solo', 'idle', new Date().toISOString(), 'solo finished its turn.'));
  await until(() => pi.sent.length === 1);
  assert.equal(pi.sent[0]!.content, `[bellwether]\nsolo (w1:p1) idle, a pi agent — receipt ${offered.receipt}\nsolo finished its turn.\n\nRead more with agent_read. Reply with agent_send.`);
});
