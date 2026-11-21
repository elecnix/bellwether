// The Claude Code channel: an MCP server over stdio that gives the parent
// session the Bellwether tools, and pushes each child event into the session
// as a notifications/claude/channel event. The core runs in the daemon; this
// server is one client of it. A receipt id in the event text marks that event
// read once it reaches the session transcript, which is where Claude Code
// records what the model received.
//
// stdout carries the MCP protocol, so every log line goes to stderr.
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../../daemon/client.ts';
import { resolveSocketPath } from '../../core/herdr-client.ts';
import { hostName } from '../../core/spawn.ts';
import type { OutboxEntry } from '../../core/types.ts';
import { childTools, parentTools } from '../tools.ts';
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

let daemon: DaemonClient | undefined;
let connectFailure = 'Bellwether is not running: the daemon did not start for this session.';
/** The first connection attempt, awaited by any tool call that arrives early. */
let ready: Promise<void> = Promise.resolve();

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = (body: unknown): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }],
  });
  await ready;
  if (!daemon) return { ...text(connectFailure), isError: true };
  try {
    return text(await daemon.tool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>));
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

// Receipts this server has already pushed, and those sent once more after the
// parent went idle without reading them.
const sent = new Set<string>();
const resent = new Set<string>();
const settleTimers = new Map<string, NodeJS.Timeout>();
let parentIdle: boolean | undefined;
let burst: NodeJS.Timeout | undefined;

/**
 * A push that never reached the model leaves its receipt unread. If the parent
 * is idle while the notice should already have started a turn, send it once
 * more; after that, leave it for agent_list to show.
 */
async function resendOnce(entry: OutboxEntry): Promise<boolean> {
  if (!parentIdle || entry.read || resent.has(entry.receipt) || !sent.has(entry.receipt)) return false;
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
  if (!parentIdle || !daemon) return;
  for (const entry of daemon.unread()) await resendOnce(entry);
}

function schedule(entries: OutboxEntry[]): void {
  if (!entries.some((entry) => !entry.read && !sent.has(entry.receipt))) return;
  if (burst) return;
  burst = setTimeout(() => void flush(), SETTLE_MS);
  burst.unref?.();
}

async function flush(): Promise<void> {
  burst = undefined;
  if (!daemon) return;
  const fresh = daemon.unread().filter((entry) => !entry.read && !sent.has(entry.receipt));
  for (const entry of fresh) {
    try {
      await push(entry);
      sent.add(entry.receipt);
      log('pushed', entry.receipt, entry.name, entry.event);
      armResendCheck(entry.receipt);
    } catch (error) {
      // A failed write leaves the receipt unsent, so the next event re-pushes it.
      log('push failed:', (error as Error).message);
    }
  }
}

/** Judge the parent's own status once, rather than polling it. */
function armResendCheck(receipt: string): void {
  if (settleTimers.has(receipt)) return;
  const timer = setTimeout(() => {
    settleTimers.delete(receipt);
    const entry = daemon?.unread().find((candidate) => candidate.receipt === receipt);
    if (!entry) return;
    void resendOnce(entry);
  }, RESEND_AFTER_MS);
  timer.unref?.();
  settleTimers.set(receipt, timer);
}

const scan = new ReceiptScan(session, cwd, claudeConfigDir());

/** Mark an entry read, and drop the bookkeeping for its resend. */
function readReceipt(receipt: string): void {
  daemon?.receipts([receipt]);
  resent.delete(receipt);
  const timer = settleTimers.get(receipt);
  if (timer) clearTimeout(timer);
  settleTimers.delete(receipt);
  log('read', receipt);
}

function scanReceipts(): void {
  if (!daemon) return;
  const unread = daemon.unread().filter((entry) => !entry.read);
  if (!unread.length) return;
  for (const receipt of scan.scan(unread.map((entry) => entry.receipt))) readReceipt(receipt);
}

/**
 * Announce whatever the previous server left unread. A receipt already in the
 * transcript is marked read instead, so a restart does not repeat an event the
 * model has received.
 */
function announcePending(): void {
  if (!daemon) return;
  const unread = daemon.unread().filter((entry) => !entry.read);
  for (const receipt of scan.search(unread.map((entry) => entry.receipt))) readReceipt(receipt);
  scan.start();
  void flush();
}

/** The parent's own pane, watched through the daemon: idle means a queued notice should have started a turn. */
function watchParentPane(attempt = 0): void {
  if (!pane || !daemon) return;
  daemon.watchPane(pane, (status) => {
    if (status.startsWith('unavailable:')) {
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      const timer = setTimeout(() => {
        if (stopping) return;
        watchParentPane(attempt + 1);
      }, delay);
      timer.unref?.();
      return;
    }
    const wasIdle = parentIdle;
    parentIdle = status === 'idle' || status === 'done';
    if (parentIdle && !wasIdle) void resendWhenIdle();
  });
}

let stopping = false;
function quit(): void {
  if (stopping) return;
  stopping = true;
  if (burst) clearTimeout(burst);
  burst = undefined;
  for (const timer of settleTimers.values()) clearTimeout(timer);
  settleTimers.clear();
  void daemon?.close();
  daemon = undefined;
  process.exit(0);
}

// Exit with the session: a leftover server would show the session as listening.
process.stdin.on('end', quit);
process.stdin.on('close', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
mcp.onclose = quit;

await mcp.connect(new StdioServerTransport());
ready = (async () => {
  try {
    daemon = await DaemonClient.connect({
      harness: 'claude-code',
      session,
      cwd,
      host: hostName() || os.hostname(),
      paneId: pane,
      workspaceId: workspace,
      depth,
      herdrSocket: resolveSocketPath(),
    }, { log });
    daemon.onEvents((entries) => schedule(entries));
  } catch (error) {
    connectFailure = `Bellwether could not reach its daemon: ${(error as Error).message}`;
    log(connectFailure);
  }
})();
await ready;
announcePending();
setInterval(scanReceipts, SCAN_MS).unref?.();
watchParentPane();
log('channel ready for', daemon?.parentId ?? 'no parent', 'in pane', pane ?? 'unknown');
