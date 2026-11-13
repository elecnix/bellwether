// The Pi extension: the Bellwether tools for the parent, and a new turn when
// a child changes state. The core runs in the daemon; this extension is one
// client of it. It never types into the parent's pane: it wakes the session
// through pi.sendMessage, and the receipt id in the message marks the event
// read once the model context contains it.
import os from 'node:os';
import { DaemonClient } from '../../daemon/client.ts';
import { resolveSocketPath } from '../../core/herdr-client.ts';
import { hostName } from '../../core/spawn.ts';
import type { OutboxEntry } from '../../core/types.ts';
import { childTools, parentTools } from '../tools.ts';

// The parts of pi's ExtensionAPI this extension uses.
interface PiContext {
  isIdle(): boolean;
  sessionManager: { getSessionId(): string; getCwd(): string; getSessionName?(): string | undefined };
}
interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: unknown;
}
interface PiApi {
  on(event: 'session_start' | 'session_shutdown', handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: 'context', handler: (event: { messages: unknown[] }, ctx: PiContext) => void | Promise<void>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<ToolResult>;
  }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void;
}

const result = (text: string): ToolResult => ({ content: [{ type: 'text', text }], details: undefined });

/** How many Bellwether generations deep this session sits. */
function depthFromEnv(): number {
  const value = Number.parseInt(process.env['BELLWETHER_DEPTH'] ?? '0', 10);
  return Number.isFinite(value) ? value : 0;
}

/** One message for a burst of events, so three children changing at once read once. */
function compose(entries: OutboxEntry[]): string {
  if (!entries.length) return '';
  const head = entries.length === 1 ? '[bellwether]' : `[bellwether] ${entries.length} children changed`;
  const body = entries
    .map((entry) => `${entry.name} (${entry.kind}, ${entry.paneId}) ${entry.event} — receipt ${entry.receipt}\n${entry.text}`)
    .join('\n\n');
  return `${head}\n${body}\n\nRead more with agent_read. Reply with agent_send.`;
}

export default function bellwether(pi: PiApi): void {
  let daemon: DaemonClient | undefined;
  let burst: NodeJS.Timeout | undefined;
  let pending: OutboxEntry[] = [];
  // Receipts this session has already put in front of the model.
  const sent = new Set<string>();

  const flush = (): void => {
    burst = undefined;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const text = compose(batch);
    if (!text) return;
    for (const entry of batch) sent.add(entry.receipt);
    // The message waits until the agent has no tool calls left, then starts the turn.
    pi.sendMessage({ customType: 'bellwether', content: text, display: true, details: { digest: 'child events' } }, { triggerTurn: true, deliverAs: 'followUp' });
  };

  const onEntries = (entries: OutboxEntry[]): void => {
    const fresh = entries.filter((entry) => !sent.has(entry.receipt) && !entry.read);
    if (!fresh.length) return;
    pending = fresh;
    if (burst) return;
    burst = setTimeout(flush, 250);
    burst.unref?.();
  };

  pi.on('session_start', async (_event, ctx) => {
    try {
      daemon = await DaemonClient.connect({
        harness: 'pi',
        session: ctx.sessionManager.getSessionId(),
        cwd: ctx.sessionManager.getCwd(),
        host: hostName() || os.hostname(),
        paneId: process.env['HERDR_PANE_ID'],
        workspaceId: process.env['HERDR_WORKSPACE_ID'],
        depth: depthFromEnv(),
        herdrSocket: resolveSocketPath(),
      }, { log: (message) => console.error('[bellwether]', message) });
      daemon.onEvents(onEntries);
      const missed = await daemon.pending();
      if (missed.length) onEntries(missed);
    } catch (error) {
      console.error('[bellwether] the daemon did not start:', (error as Error).message);
      daemon = undefined;
    }
  });

  pi.on('session_shutdown', () => {
    if (burst) clearTimeout(burst);
    burst = undefined;
    pending = [];
    void daemon?.close();
    daemon = undefined;
  });

  // A receipt that reaches the model context marks its event read.
  pi.on('context', (event) => {
    if (!daemon) return;
    const seen = JSON.stringify(event.messages);
    const receipts = daemon.unread().filter((entry) => seen.includes(entry.receipt)).map((entry) => entry.receipt);
    if (receipts.length) daemon.receipts(receipts);
  });

  const tools = process.env['BELLWETHER_PARENT'] ? [...parentTools, ...childTools] : parentTools;
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/_/g, ' '),
      description: tool.description,
      parameters: tool.schema,
      async execute(_id, args, signal) {
        if (!daemon) return result('Bellwether is not running: the daemon did not start for this session.');
        if (signal?.aborted) return result('Cancelled.');
        try {
          return result(await daemon.tool(tool.name, args));
        } catch (error) {
          return result((error as Error).message);
        }
      },
    });
  }
}
