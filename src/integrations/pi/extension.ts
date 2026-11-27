// The Pi extension: the Bellwether tools for the parent, and a new turn when
// a child changes state. The core runs in the daemon; this extension is one
// client of it. It never types into the parent's pane: it wakes the session
// through pi.sendMessage. An event counts as read once pi puts this
// extension's own message, carrying the receipts in its details, in front of
// the model. A receipt that reaches the model any other way, such as the
// output of a shell that read the outbox file, is not a delivery.
//
// For a child, the extension also takes its parent's messages: the daemon
// pushes one, and the extension hands it to pi.sendMessage as a steered
// message, so nothing is typed into the child's pane. It tells the daemon
// once pi holds it, and again at message_end, when the model has it.
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../daemon/client.ts';
import { resolveSocketPath } from '../../core/herdr-client.ts';
import { standDown } from '../../core/pi-extension.ts';
import { hostName } from '../../core/spawn.ts';
import { PROMPT_NOTICE, maxDepthFromEnv } from '../../core/report.ts';
import type { OutboxEntry } from '../../core/types.ts';
import { fallbackTools } from '../tools.ts';
import { composeBurst } from '../alert.ts';
import type { InboxMessage, ServedTool } from '../../daemon/protocol.ts';

// The parts of pi's ExtensionAPI this extension uses.
interface PiContext {
  isIdle(): boolean;
  /** The model the session runs on now. It changes with /model, so it is read at each call. */
  model?: { provider: string; id: string };
  sessionManager: { getSessionId(): string; getCwd(): string; getSessionName?(): string | undefined; getEntries?(): unknown[] };
}
/** A message as pi records it: a custom one carries the extension's customType and details. */
interface PiMessage {
  role?: string;
  customType?: string;
  details?: unknown;
}
/** pi's ui_prompt_start and ui_prompt_end payload. */
interface PiPromptEvent {
  kind?: string;
  title?: string;
}
interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: unknown;
}
interface PiApi {
  on(event: 'session_start' | 'session_shutdown', handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: 'message_end', handler: (event: { message: PiMessage }, ctx: PiContext) => void | Promise<void>): void;
  /** pi 0.84.4 and later: a blocking ctx.ui dialog opened or closed. Older pi never fires them. */
  on(event: 'ui_prompt_start' | 'ui_prompt_end', handler: (event: PiPromptEvent) => void | Promise<void>): void;
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

const CUSTOM_TYPE = 'bellwether';
/** A parent's message to this session, which pi records under its own type. */
const MESSAGE_TYPE = 'bellwether-message';
/** The extension's path's name, which the daemon records as how a message reached the session. */
const VIA = 'pi-message';

/** The message id one of this extension's parent messages carries, or none for any other message. */
function messageIdOf(message: { customType?: string; details?: unknown } | undefined): string | undefined {
  if (!message || message.customType !== MESSAGE_TYPE) return undefined;
  const id = (message.details as { message?: unknown } | undefined)?.message;
  return typeof id === 'string' ? id : undefined;
}

/** Parent messages already in the session's history, from this or a previous pi process. */
function messagesInHistory(ctx: PiContext | undefined): Set<string> {
  const entries = ctx?.sessionManager.getEntries?.() ?? [];
  const found = new Set<string>();
  for (const entry of entries) {
    const record = entry as { type?: string; customType?: string; details?: unknown };
    const id = record.type === 'custom_message' ? messageIdOf(record) : undefined;
    if (id) found.add(id);
  }
  return found;
}

/** The receipts one of this extension's own messages carries, or none for any other message. */
function receiptsOf(message: PiMessage | undefined): string[] {
  if (!message || message.customType !== CUSTOM_TYPE) return [];
  const receipts = (message.details as { receipts?: unknown } | undefined)?.receipts;
  return Array.isArray(receipts) ? receipts.filter((receipt): receipt is string => typeof receipt === 'string') : [];
}

/** Receipts of this extension's messages already in the session's history, from a previous pi process. */
function deliveredInHistory(ctx: PiContext): string[] {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  return entries.flatMap((entry) => {
    const record = entry as { type?: string; customType?: string; details?: unknown };
    return record.type === 'custom_message' ? receiptsOf(record) : [];
  });
}

export default function bellwether(pi: PiApi): void {
  // A spawn starts a pi child with -e naming one copy of this extension. A
  // host that also installed Bellwether as a pi package loads a second copy,
  // which registers nothing, so each tool and handler exists once.
  if (standDown(fileURLToPath(import.meta.url))) return;
  let daemon: DaemonClient | undefined;
  let session: PiContext | undefined;
  let burst: NodeJS.Timeout | undefined;
  // Parent messages this process handed to pi.
  const tookMessages = new Set<string>();

  /**
   * Hand a parent's message to pi. The steer has the same effect as typing
   * into a busy pi: the message lands after the tool calls in flight, before
   * the next model call, and an idle session starts a turn on it. A replay
   * after a reconnect is looked for in the session's history first.
   */
  const takeMessage = (message: InboxMessage, replay: boolean): void => {
    if (!daemon) return;
    if (replay && messagesInHistory(session).has(message.id)) {
      daemon.messageAck(message.id, 'read', { via: VIA });
      return;
    }
    if (tookMessages.has(message.id)) {
      daemon.messageAck(message.id, 'queued', { via: VIA });
      return;
    }
    try {
      pi.sendMessage(
        { customType: MESSAGE_TYPE, content: `[bellwether] Message ${message.id} from ${message.from}, sent at ${message.at}:\n${message.text}`, display: true, details: { message: message.id } },
        { triggerTurn: true, deliverAs: 'steer' },
      );
      tookMessages.add(message.id);
      daemon.messageAck(message.id, 'queued', { via: VIA });
    } catch (error) {
      daemon.messageAck(message.id, 'refused', { reason: `pi.sendMessage failed: ${(error as Error).message}` });
    }
  };
  const pending = new Map<string, OutboxEntry>();
  // Receipts this process has handed to pi, so a replay does not send them twice.
  const sent = new Set<string>();

  const flush = (): void => {
    burst = undefined;
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    // The roster line leaves out every child this burst names. It is absent when no other child is live, or when the daemon sent none.
    const text = composeBurst(batch, Date.now(), daemon?.takeRoster());
    if (!text) return;
    for (const entry of batch) sent.add(entry.receipt);
    // An idle session starts a turn now. A busy one takes the message after
    // the tool calls in flight, before its next model call. followUp would
    // hold it until the whole run ends, which left events minutes late.
    pi.sendMessage(
      { customType: CUSTOM_TYPE, content: text, display: true, details: { digest: 'child events', receipts: batch.map((entry) => entry.receipt) } },
      { triggerTurn: true, deliverAs: 'steer' },
    );
  };

  const onEntries = (entries: OutboxEntry[]): void => {
    for (const entry of entries) {
      // An entry the daemon settled drops out of a burst not yet sent.
      if (entry.read) pending.delete(entry.receipt);
      else if (!sent.has(entry.receipt)) pending.set(entry.receipt, entry);
    }
    if (!pending.size || burst) return;
    burst = setTimeout(flush, 250);
    burst.unref?.();
  };

  // A child tells the daemon when pi waits on a dialog, because herdr reports
  // a pi session on an extension's dialog as idle, and its parent would read a
  // finished turn. pi coalesces nested dialogs into one span, so the state is
  // one open prompt or none. A notice from before the daemon connected goes
  // out once it does, which clears whatever an earlier process left open.
  let prompt: { open: boolean; title?: string; kind?: string } = { open: false };
  const sendPrompt = (): void => {
    if (!daemon || !process.env['BELLWETHER_CHILD']) return;
    // An older daemon does not know the notice, and the screen check stands in.
    void daemon.tool(PROMPT_NOTICE, { ...prompt }).catch(() => {});
  };
  pi.on('ui_prompt_start', (event) => {
    prompt = { open: true, title: event?.title, kind: event?.kind };
    sendPrompt();
  });
  pi.on('ui_prompt_end', () => {
    prompt = { open: false };
    sendPrompt();
  });

  pi.on('session_start', async (_event, ctx) => {
    session = ctx;
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
        childId: process.env['BELLWETHER_CHILD'],
        ...(maxDepthFromEnv() === undefined ? {} : { maxDepth: maxDepthFromEnv() }),
        ...(process.env['BELLWETHER_PARENT'] ? { reportsTo: process.env['BELLWETHER_PARENT'] } : {}),
        // A child takes its parent's messages through this extension, and any
        // session takes a new tool list, such as parent_report once a parent adopts it.
        accepts: process.env['BELLWETHER_CHILD'] ? ['message', 'tools'] : ['tools'],
      }, { log: (message) => console.error('[bellwether]', message) });
      daemon.onMessage(takeMessage);
      register(daemon.tools());
      daemon.onTools(register);
      // A previous pi process for this session may have delivered an event
      // and died before its receipt reached the daemon.
      const delivered = deliveredInHistory(ctx);
      for (const receipt of delivered) sent.add(receipt);
      daemon.receipts(delivered.filter((receipt) => daemon?.unread().some((entry) => entry.receipt === receipt)));
      daemon.onEvents(onEntries);
      sendPrompt();
      const missed = await daemon.pending();
      if (missed.length) onEntries(missed);
    } catch (error) {
      console.error('[bellwether] the daemon did not start:', (error as Error).message);
      daemon = undefined;
      // The tools still appear, and each call says the daemon is not running.
      register(fallbackTools({ reportsTo: process.env['BELLWETHER_PARENT'] || undefined, childId: process.env['BELLWETHER_CHILD'] || undefined }, undefined));
    }
  });

  pi.on('session_shutdown', () => {
    if (burst) clearTimeout(burst);
    burst = undefined;
    pending.clear();
    void daemon?.close();
    daemon = undefined;
  });

  // pi records a steered message once it enters the conversation, ahead of
  // the next model call. That, and only that, marks its events read.
  pi.on('message_end', (event) => {
    const receipts = receiptsOf(event.message);
    if (receipts.length) daemon?.receipts(receipts);
    // A parent's message is read once pi puts it in front of the model.
    const id = messageIdOf(event.message);
    if (id) daemon?.messageAck(id, 'read', { via: VIA });
  });

  // The daemon decides the tools, from its feature table, and sends them in
  // its hello. pi takes a tool registered after startup into the running
  // session, so a reconnect to a newer daemon adds its tools without a
  // restart. A name registered once is not registered again.
  const registered = new Set<string>();
  function register(tools: ServedTool[]): void {
    for (const tool of tools) {
      if (registered.has(tool.name)) continue;
      registered.add(tool.name);
      registerTool(tool);
    }
  }
  function registerTool(tool: ServedTool): void {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/_/g, ' '),
      description: tool.description,
      parameters: tool.schema,
      async execute(_id, args, signal, _onUpdate, ctx) {
        if (!daemon) return result('Bellwether is not running: the daemon did not start for this session.');
        if (signal?.aborted) return result('Cancelled.');
        try {
          const model = ctx?.model?.provider && ctx.model.id ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
          return result(await daemon.tool(tool.name, args, model));
        } catch (error) {
          return result((error as Error).message);
        }
      },
    });
  }
}
