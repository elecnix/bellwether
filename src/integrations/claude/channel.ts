// The Claude Code channel: an MCP server over stdio that gives the parent
// session the Bellwether tools, and pushes each child event into the session
// as a notifications/claude/channel event. A receipt id in the event text is
// what marks that event read once it reaches the session transcript, which is
// where Claude Code records what the model received.
//
// stdout carries the MCP protocol, so every log line goes to stderr.
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HerdrClient, type HerdrEvent, type Subscription } from '../../core/herdr-client.ts';
import { emptyParent, parentId, readParent, saveParent } from '../../core/registry.ts';
import { Watcher } from '../../core/watcher.ts';
import type { OutboxEntry } from '../../core/types.ts';
import { childTools, parentTools, runBellwetherTool, type ToolContext } from '../tools.ts';
import { ReceiptScan, claudeConfigDir } from './transcript.ts';

const log = (...args: unknown[]): void => console.error('[bellwether]', ...args);

/** How long a burst of events settles before it is pushed, so churn collapses. */
const SETTLE_MS = 200;
/** How often the transcript is read for receipts. */
const SCAN_MS = 500;
/** How long after a push the parent's own status is judged, before one resend. */
const RESEND_AFTER_MS = 20_000;

const session = process.env['CLAUDE_CODE_SESSION_ID'] ?? `pid-${process.ppid}`;
const pane = process.env['HERDR_PANE_ID'];
const workspace = process.env['HERDR_WORKSPACE_ID'];
const cwd = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
const depth = Number.parseInt(process.env['BELLWETHER_DEPTH'] ?? '0', 10) || 0;
const isChild = Boolean(process.env['BELLWETHER_PARENT']);

const existing = readParent(parentId('claude-code', session));
const parent = existing ?? emptyParent('claude-code', session, cwd, { host: os.hostname(), paneId: pane, workspaceId: workspace, depth });
saveParent(parent);

const client = new HerdrClient();
const watcher = new Watcher({
  client,
  parentId: parent.id,
  log,
  onEntries: (entries) => schedule(entries),
});
const context: ToolContext = { client, parentId: parent.id, watcher };

const tools = isChild ? [...parentTools, ...childTools] : parentTools;

const mcp = new Server(
  { name: 'bellwether', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      'Events from this channel are Bellwether child-agent changes: a child reported, went idle, blocked on a dialog, stalled, or exited.',
      'Each event names the child and carries its receipt. Read more with agent_read, and reply with agent_send.',
      'Start children with agent_spawn, and give each one a concrete deliverable that tells it to call parent_report when done.',
      'agent_list shows every child with its status and unread count.',
    ].join(' '),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = (body: unknown): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }],
  });
  try {
    return text(await runBellwetherTool(context, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>));
  } catch (error) {
    return { ...text((error as Error).message), isError: true };
  }
});

/** One channel event's text. The receipt rides in the text, not only in meta. */
function compose(entry: OutboxEntry): string {
  return `[bellwether] ${entry.name} (${entry.kind}, ${entry.paneId}) ${entry.event} — receipt ${entry.receipt}\n${entry.text}\n\nRead more with agent_read. Reply with agent_send.`;
}

async function push(entry: OutboxEntry): Promise<void> {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: compose(entry), meta: { child: entry.name, event: entry.event, receipt: entry.receipt } },
  });
}

/** A receipt has been pushed, so a resend knows this is not its first send. */
function markDelivered(receipt: string): void {
  watcher.markDelivered(receipt);
}

// Receipts sent once more because the parent went idle without reading them.
const resent = new Set<string>();
let parentIdle: boolean | undefined;

/**
 * A push that never reached the model leaves its receipt unread. If the parent
 * is idle while the notice should already have started a turn, send it once
 * more; after that, leave it for agent_list to show.
 */
async function resendOnce(entry: OutboxEntry): Promise<boolean> {
  if (!parentIdle || entry.read || resent.has(entry.receipt) || !entry.deliveredAt) return false;
  resent.add(entry.receipt);
  try {
    await push(entry);
    log('resent', entry.receipt, entry.name);
    return true;
  } catch (error) {
    log('resend failed:', (error as Error).message);
    return false;
  }
}

async function resendWhenIdle(): Promise<void> {
  if (!parentIdle) return;
  for (const entry of watcher.outboxEntries()) await resendOnce(entry);
}

let burst: NodeJS.Timeout | undefined;
const settleTimers = new Map<string, NodeJS.Timeout>();

function schedule(entries: OutboxEntry[]): void {
  if (!entries.some((entry) => !entry.deliveredAt)) return;
  if (burst) return;
  burst = setTimeout(() => void flush(), SETTLE_MS);
  burst.unref?.();
}

async function flush(): Promise<void> {
  burst = undefined;
  const fresh = watcher.outboxEntries().filter((entry) => !entry.read && !entry.deliveredAt);
  for (const entry of fresh) {
    try {
      await push(entry);
      markDelivered(entry.receipt);
      log('pushed', entry.receipt, entry.name, entry.event);
      armResendCheck(entry.receipt);
    } catch (error) {
      // A failed write leaves deliveredAt unset, so the next entry re-pushes it.
      log('push failed:', (error as Error).message);
    }
  }
}

/** Judge the parent's own status once, rather than polling it. */
function armResendCheck(receipt: string): void {
  if (settleTimers.has(receipt)) return;
  const timer = setTimeout(() => {
    settleTimers.delete(receipt);
    const entry = watcher.outboxEntries().find((candidate) => candidate.receipt === receipt);
    if (!entry) return;
    void resendOnce(entry);
  }, RESEND_AFTER_MS);
  timer.unref?.();
  settleTimers.set(receipt, timer);
}

// The parent's own pane is the one pane whose status this server needs: idle
// means a queued notice should have started a turn. It arrives on the same
// event stream as the children, so nothing polls herdr for status.
const controller = new AbortController();
let parentSubscription: Subscription | undefined;

function idleStatus(value: unknown): boolean {
  return value === 'idle' || value === 'done';
}

function onParentEvent(event: HerdrEvent): void {
  if (event.event !== 'pane.agent_status_changed' && event.event !== 'pane_agent_status_changed') return;
  const paneId = event.data['pane_id'];
  if (typeof paneId === 'string' && pane !== undefined && paneId !== pane) return;
  const status = event.data['agent_status'];
  if (typeof status !== 'string') return;
  const wasIdle = parentIdle;
  parentIdle = idleStatus(status);
  if (parentIdle && !wasIdle) void resendWhenIdle();
}

/** Subscribe first, then read the current status, so a turn in between is not missed. */
async function watchParentPane(): Promise<void> {
  if (!pane) return;
  parentSubscription = await client.subscribe([{ type: 'pane.agent_status_changed', pane_id: pane }], onParentEvent, controller.signal);
  void parentSubscription.closed.then(
    () => {
      if (stopping) return;
      log('parent pane subscription lost; resubscribing');
      retryWatch(250);
    },
    (error: unknown) => {
      if (stopping) return;
      log('parent pane subscription failed:', String(error));
      retryWatch(500);
    },
  );
  try {
    const panes = await client.paneList(controller.signal);
    parentIdle = idleStatus(panes.find((entry) => entry.paneId === pane)?.agentStatus);
  } catch (error) {
    log('parent pane status unknown:', (error as Error).message);
  }
}

/** A lost subscription only costs the second send, but it should not stay lost. */
function retryWatch(delay: number): void {
  const timer = setTimeout(() => {
    if (stopping) return;
    void watchParentPane().catch((error: unknown) => {
      log('parent pane watch failed:', String(error));
      retryWatch(Math.min(delay * 2, 10_000));
    });
  }, delay);
  timer.unref?.();
}

const scan = new ReceiptScan(session, cwd, claudeConfigDir());

/** Mark an entry read, and drop the bookkeeping for its resend. */
function readReceipt(receipt: string): void {
  watcher.markRead(receipt);
  resent.delete(receipt);
  const timer = settleTimers.get(receipt);
  if (timer) clearTimeout(timer);
  settleTimers.delete(receipt);
  log('read', receipt);
}

function scanReceipts(): void {
  const unread = watcher.outboxEntries().filter((entry) => !entry.read);
  if (!unread.length) return;
  for (const receipt of scan.scan(unread.map((entry) => entry.receipt))) readReceipt(receipt);
}

/**
 * Announce whatever the previous server left unread. A receipt already in the
 * transcript is marked read instead, so a restart does not repeat an event the
 * model has received.
 */
function announcePending(): void {
  const unread = watcher.outboxEntries().filter((entry) => !entry.read);
  for (const receipt of scan.search(unread.map((entry) => entry.receipt))) readReceipt(receipt);
  scan.start();
  void flush();
}

let stopping = false;
function quit(): void {
  if (stopping) return;
  stopping = true;
  if (burst) clearTimeout(burst);
  burst = undefined;
  for (const timer of settleTimers.values()) clearTimeout(timer);
  settleTimers.clear();
  parentSubscription?.close();
  parentSubscription = undefined;
  controller.abort();
  watcher.stop();
  process.exit(0);
}

// Exit with the session: a leftover server would show the session as listening.
process.stdin.on('end', quit);
process.stdin.on('close', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
mcp.onclose = quit;

await mcp.connect(new StdioServerTransport());
announcePending();
setInterval(scanReceipts, SCAN_MS).unref?.();
watcher.start();
if (pane) void watchParentPane().catch((error: unknown) => log('parent pane watch failed:', String(error)));
else log('no HERDR_PANE_ID: events still push, but an unread one is not sent twice');
log('channel ready for', parent.id, 'in pane', pane ?? 'unknown');
