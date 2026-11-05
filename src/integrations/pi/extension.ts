// The Pi extension: the Bellwether tools for the parent, and a new turn when
// a child changes state. It never types into the parent's pane; it wakes the
// session through pi.sendMessage, and the receipt id in the message is what
// marks the event read once the model context contains it.
import os from 'node:os';
import { HerdrClient } from '../../core/herdr-client.ts';
import { Watcher } from '../../core/watcher.ts';
import { emptyParent, readParent, saveParent } from '../../core/registry.ts';
import type { OutboxEntry } from '../../core/types.ts';
import { childTools, parentTools, runBellwetherTool, type ToolContext } from '../tools.ts';

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

/** One message for a burst of events, so three children changing at once read once. */
function compose(entries: OutboxEntry[]): string {
  const fresh = entries.filter((entry) => !entry.deliveredAt);
  if (!fresh.length) return '';
  const head = fresh.length === 1 ? '[bellwether]' : `[bellwether] ${fresh.length} children changed`;
  const body = fresh
    .map((entry) => `${entry.name} (${entry.kind}, ${entry.paneId}) ${entry.event} — receipt ${entry.receipt}\n${entry.text}`)
    .join('\n\n');
  return `${head}\n${body}\n\nRead more with agent_read. Reply with agent_send.`;
}

export default function bellwether(pi: PiApi): void {
  let watcher: Watcher | undefined;
  let context: ToolContext | undefined;
  let burst: NodeJS.Timeout | undefined;
  let pending: OutboxEntry[] = [];

  const flush = (): void => {
    burst = undefined;
    if (!context || !watcher || !pending.length) return;
    const batch = pending;
    pending = [];
    const text = compose(batch);
    if (!text) return;
    // The message waits until the agent has no tool calls left, then starts the turn.
    pi.sendMessage({ customType: 'bellwether', content: text, display: true, details: { digest: 'child events' } }, { triggerTurn: true, deliverAs: 'followUp' });
    for (const entry of batch) if (!entry.deliveredAt) watcher.markDelivered(entry.receipt);
  };

  const onEntries = (entries: OutboxEntry[]): void => {
    const fresh = entries.filter((entry) => !entry.deliveredAt);
    if (!fresh.length) return;
    pending = fresh;
    if (burst) return;
    burst = setTimeout(flush, 250);
    burst.unref?.();
  };

  pi.on('session_start', (_event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    const existing = readParent(`pi-${session}`);
    const parent = existing ?? emptyParent('pi', session, cwd, { host: os.hostname(), paneId: process.env['HERDR_PANE_ID'], workspaceId: process.env['HERDR_WORKSPACE_ID'], depth: Number.parseInt(process.env['BELLWETHER_DEPTH'] ?? '0', 10) || 0 });
    saveParent(parent);

    const client = new HerdrClient();
    watcher = new Watcher({ client, parentId: parent.id, onEntries });
    context = { client, parentId: parent.id, watcher };
    watcher.start();
  });

  pi.on('session_shutdown', () => {
    if (burst) clearTimeout(burst);
    burst = undefined;
    watcher?.stop();
    watcher = undefined;
    context = undefined;
  });

  // A receipt that reaches the model context marks its event read.
  pi.on('context', (event) => {
    if (!context || !watcher) return;
    const seen = JSON.stringify(event.messages);
    for (const entry of context.watcher.outboxEntries()) {
      if (entry.read || !seen.includes(entry.receipt)) continue;
      watcher.markRead(entry.receipt);
    }
  });

  const tools = process.env['BELLWETHER_PARENT'] ? [...parentTools, ...childTools] : parentTools;
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/_/g, ' '),
      description: tool.description,
      parameters: tool.schema,
      async execute(_id, args, signal) {
        if (!context) return result('Bellwether is not ready: this session has not started yet.');
        if (signal?.aborted) return result('Cancelled.');
        return result(await runBellwetherTool(context, tool.name, args));
      },
    });
  }
}
