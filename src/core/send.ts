// A parent's message to a live child. agent_send, a depth grant and a spawn
// that finds its resume target alive all go through messageChild, so each
// takes the same path and leaves the same record.
//
// The message goes into the child's session when its harness has a way in and
// its own Bellwether server or extension is connected to this daemon: a Claude
// Code child's channel, or a pi or omp child's extension. Anything else is
// typed into the child's pane through herdr's agent.prompt, as before. Either
// way the child record keeps which path carried it and why.
import crypto from 'node:crypto';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { BLANK_SCREEN, shownScreen } from './screen.ts';
import { harnessFor } from './harnesses/index.ts';
import { updateChild } from './registry.ts';
import type { ChildMessage, ChildRecord } from './types.ts';
import type { InboxMessage } from '../daemon/protocol.ts';

export type { InboxMessage } from '../daemon/protocol.ts';

/** What the child's session said to a message: it holds it, or why it could not take it. */
export type InboxAnswer = { delivered: true; via: string } | { delivered: false; reason: string };

/**
 * The daemon's way into a child's own session, through the Bellwether adapter
 * connected for it: on this machine, or through the daemon on the child's
 * machine over the relay.
 */
export type Inbox = (parentId: string, child: ChildRecord, message: InboxMessage) => Promise<InboxAnswer>;

/** How many messages a child record keeps. */
const KEPT = 20;
const PREVIEW = 80;

/** What a message became, for the caller's reply. */
export interface MessageOutcome {
  message: ChildMessage;
  /** The reply for the caller. */
  text: string;
}

export interface MessageInput {
  herdr: HerdrClient;
  parentId: string;
  /** Who sends it, as the child reads it. */
  from: string;
  child: ChildRecord;
  text: string;
  /** The daemon's door into the child's session. Absent outside a daemon, which leaves typing. */
  inbox?: Inbox;
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
}

function remember(parentId: string, childId: string, message: ChildMessage): void {
  updateChild(parentId, childId, (entry) => {
    const kept = (entry.messages ?? []).filter((existing) => existing.id !== message.id);
    kept.push(message);
    entry.messages = kept.slice(-KEPT);
  });
}

/**
 * Why a message to this child cannot go into its session, or undefined when
 * the session path may be tried.
 */
export function sessionPathRefusal(child: Pick<ChildRecord, 'kind' | 'host' | 'lastStatus'>, inbox: Inbox | undefined): string | undefined {
  const entry = harnessFor(child.kind);
  if (!entry) return `Bellwether has no harness entry for kind ${child.kind}`;
  if (entry.inbox.via === 'none') return entry.inbox.reason;
  // herdr refuses a prompt to a blocked child, and the parent then sees the
  // dialog and answers it with keys. A session message would wait behind the
  // dialog without saying so.
  if (child.lastStatus === 'blocked') return 'it is blocked on a dialog, and herdr shows that dialog in place of the message';
  if (!inbox) return 'no Bellwether daemon carries this call, so no session connection is at hand';
  return undefined;
}

const VIA_LABEL: Record<string, string> = {
  'claude-channel': 'Bellwether channel',
  'pi-message': 'Bellwether pi extension',
};

/** Send a parent's message to a live child, by its session where it can, and record the path. */
export async function messageChild(input: MessageInput): Promise<MessageOutcome> {
  const { child, parentId, text } = input;
  const id = `m-${crypto.randomBytes(4).toString('hex')}`;
  const at = new Date().toISOString();
  const refusal = sessionPathRefusal(child, input.inbox);
  let reason = refusal;
  if (!refusal && input.inbox) {
    // Recorded before the push, so a read that comes back at once finds it.
    remember(parentId, child.id, { id, at, path: 'session', preview: preview(text), text, from: input.from });
    const answer = await input.inbox(parentId, child, { id, from: input.from, text, at }).catch((error: unknown): InboxAnswer => ({ delivered: false, reason: (error as Error).message }));
    if (answer.delivered) {
      const message: ChildMessage = { id, at, path: 'session', via: answer.via, preview: preview(text), text, from: input.from };
      updateChild(parentId, child.id, (entry) => {
        const found = entry.messages?.find((existing) => existing.id === id);
        if (found) found.via = answer.via;
      });
      const label = VIA_LABEL[answer.via] ?? answer.via;
      return {
        message,
        text: `Delivered to ${child.name}'s session as message ${id}, through its ${label}; nothing was typed into its pane. An idle ${child.name} starts a turn on it, and a busy one takes it after the tool calls in flight, before its next model call. agent_list shows when its model has read it, and if ${child.name} exits first, the exit event says it never did.`,
      };
    }
    reason = answer.reason;
  }
  return typeInto(input, id, at, reason ?? 'the session path was not available');
}

/**
 * The fallback: herdr types the message into the child's pane, where it
 * lands as if a person typed it, racing whatever draft sits there.
 */
async function typeInto(input: MessageInput, id: string, at: string, reason: string): Promise<MessageOutcome> {
  const { herdr, child, parentId, text } = input;
  const message: ChildMessage = { id, at, path: 'keystrokes', reason, preview: preview(text) };
  try {
    // TODO(api): a harness inbound path retires this for the harnesses that
    // have none yet: a message request in Codex's and Cline's MCP clients, or
    // OpenCode's and Kilo's session message API reached from the daemon.
    await herdr.agentPrompt(child.paneId, text);
    remember(parentId, child.id, message);
    return { message, text: `Prompted ${child.name}: herdr typed message ${id} into its pane, because ${reason.replace(/\.$/, '')}.` };
  } catch (error) {
    if (error instanceof HerdrApiError && child.lastStatus === 'blocked') {
      const refused: ChildMessage = { ...message, undelivered: 'herdr refused the prompt, because the child is blocked on a dialog' };
      remember(parentId, child.id, refused);
      // Pane feature: herdr refused the parent's prompt, so the parent sees the
      // dialog that blocks the child and chooses the keys that answer it.
      const dialog = shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }).catch(() => BLANK_SCREEN));
      return { message: refused, text: `herdr refused the prompt because ${child.name} is blocked. The dialog:\n${dialog}\n\nReply with agent_send keys, for example ["enter"] or ["down","enter"].` };
    }
    throw error;
  }
}

/** The session messages a child never read, which a reconnected session takes again. */
export function unreadSessionMessages(child: Pick<ChildRecord, 'messages'>): ChildMessage[] {
  return (child.messages ?? []).filter((message) => message.path === 'session' && message.via && !message.readAt && !message.undelivered && message.text !== undefined);
}

/** One line per recent message, for agent_list. */
export function describeMessages(child: Pick<ChildRecord, 'name' | 'messages'>): string[] {
  return (child.messages ?? []).slice(-3).map((message) => {
    const path = message.path === 'session' ? `into its session through ${VIA_LABEL[message.via ?? ''] ?? 'its adapter (waiting for it to take the message)'}` : `typed into its pane, because ${message.reason ?? 'no reason was recorded'}`;
    const state = message.undelivered ? `never delivered: ${message.undelivered}` : message.path === 'keystrokes' ? 'typed; Bellwether cannot tell when the model read it' : message.readAt ? `read at ${message.readAt}` : 'not read yet';
    return `${child.name}: message ${message.id} at ${message.at}, ${path}; ${state}. "${message.preview}"`;
  });
}
