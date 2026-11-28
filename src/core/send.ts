// A parent's message to a live child. agent_send, a depth grant and a spawn
// that finds its resume target alive all go through messageChild, so each
// takes the same path and leaves the same record.
//
// The message goes into the child's session when its harness has a way in and
// its own Bellwether server or extension is connected to this daemon: a Claude
// Code child's channel, or a pi or omp child's extension. Anything else is
// typed into the child's pane through herdr's agent.prompt, as before. Either
// way the child record keeps which path carried it and why.
import { AuthorityRefused } from './authority.ts';
import crypto from 'node:crypto';
import { HerdrApiError, type HerdrClient } from './herdr-client.ts';
import { BLANK_SCREEN, shownScreen } from './screen.ts';
import { harnessFor } from './harnesses/index.ts';
import { updateChild } from './registry.ts';
import { messageDropped, messageHeld, messageNeverSent, messagePushed, messageSending, messageTyped, messageUnanswered, phaseOf, preview, relayAnswerLost, toReplay, type NewMessage, type Typing } from './delivery.ts';
import type { ChildMessage, ChildRecord } from './types.ts';
import type { InboxMessage } from '../daemon/protocol.ts';

export type { InboxMessage } from '../daemon/protocol.ts';

/**
 * What the child's session said to a message: it holds it, or why it could
 * not take it. `unanswered` is a push the session had not answered within the
 * bound, or whose connection closed first: it may still take it, so the
 * message must not be typed as well. `inDoubt` marks a message to another
 * machine whose relay answer was lost (issue #218): the far daemon may have
 * pushed it, so nothing is typed, and the parent's daemon asks again once the
 * relay is back. Its `via` is then empty, because no adapter is known. An
 * answer with `refused` comes from a child's machine that holds its pane for
 * someone else: authority refuses the message, and nothing is typed (issue #279).
 */
export type InboxAnswer = ({ delivered: true; via: string; unanswered?: string; inDoubt?: true } | { delivered: false; reason: string; refused?: string }) & {
  /** What the daemon repaired on the way, for the caller's reply, such as a claim restored on the child's machine (issue #219). */
  note?: string;
};

/** How a push into a child's session behaves. */
export interface InboxOptions {
  /**
   * Wait for the child's session to connect before giving up on it, as a
   * start's brief does: the harness has only just started, and its adapter
   * connects to its daemon a moment later. Without it, a session that is not
   * connected answers at once.
   */
  awaitSession?: boolean;
}

/**
 * The daemon's way into a child's own session, through the Bellwether adapter
 * connected for it: on this machine, or through the daemon on the child's
 * machine over the relay.
 */
export interface Inbox {
  (parentId: string, child: ChildRecord, message: InboxMessage, options?: InboxOptions): Promise<InboxAnswer>;
  /**
   * Resolve with the time the child's model read a message this daemon sent,
   * as its adapter reports it: at once when the record already has the read.
   * A receipt crosses back over the relay for a child on another machine.
   */
  read?: (parentId: string, childId: string, messageId: string, signal: AbortSignal) => Promise<string>;
  /** How long a start's brief waits for the child's model after its adapter received it, before it goes once more. */
  turnWaitMs?: number;
  /** The end of that wait, which a test holds and fires by hand so a read can land just before or just after it. Default a timer of `ms`. */
  deadline?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * How long a start's brief waits, after the child's adapter received it, for
 * the model behind that adapter to read it (issue #176). The
 * adapter connects while the harness is still starting, so its receipt says
 * nothing about the model. A brief that waits this long without a read goes
 * once more, and a second copy that waits as long fails the start. A copy
 * whose read came never goes again (issue #246).
 */
export const BRIEF_TURN_WAIT_MS = 20_000;

/**
 * How long a daemon waits for a just-started child's session to connect
 * before a brief is typed instead. Claude Code starts its channel server
 * after its startup dialogs, and pi and omp load the extension before they
 * draw, so either is connected within seconds of herdr detecting the harness.
 */
export const BRIEF_SESSION_WAIT_MS = 30_000;

/** What a message became, for the caller's reply. */
export interface MessageOutcome {
  message: ChildMessage;
  /** For the session path: why the session's answer is not known yet, when it had not answered within the bound. */
  unanswered?: string;
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
  /** For a start's brief: wait for the just-started child's session to connect, and mark the message with the brief's number. */
  brief?: { n: number };
  /**
   * Rejects when the child's harness exits while the message waits for its
   * session. The message then leaves the record, so nothing on it says the
   * text was delivered, and the rejection reaches the caller.
   */
  gone?: Promise<never>;
  /** Runs before the fallback types, and throws to stop it, as a start does when the harness has exited. */
  beforeTyping?: () => Promise<void>;
  /** Wait for a just-started child's session to connect, as a brief does, for a message that is not a brief. */
  awaitSession?: boolean;
  /**
   * False for a message that must never be typed, such as a teleport's notice
   * (issue #226). When the session does not take it, the message stays on the
   * record for its session's next hello, and the outcome says why.
   */
  typing?: boolean;
}

/** The message as the record holds it now, or as it was written when the record has lost it. */
function update(parentId: string, childId: string, fallback: ChildMessage, change: (entry: ChildRecord) => ChildMessage | undefined | void): ChildMessage {
  let now: ChildMessage | undefined;
  updateChild(parentId, childId, (entry) => {
    change(entry);
    now = entry.messages?.find((existing) => existing.id === fallback.id);
  });
  return now ?? fallback;
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
  const brief = input.brief ? { brief: input.brief.n } : {};
  let reason = refusal;
  const fresh: NewMessage = { id, at, text, from: input.from, ...(input.brief ? { brief: input.brief.n } : {}) };
  if (!refusal && input.inbox) {
    // Recorded before the push, so a read that comes back at once finds it.
    let sent!: ChildMessage;
    updateChild(parentId, child.id, (entry) => {
      sent = messageSending(entry, fresh);
    });
    const pushed = input.inbox(parentId, child, { id, from: input.from, text, at }, input.brief || input.awaitSession ? { awaitSession: true } : {}).catch((error: unknown): InboxAnswer => ({ delivered: false, reason: (error as Error).message }));
    let answer: InboxAnswer;
    try {
      answer = await (input.gone ? Promise.race([pushed, input.gone]) : pushed);
    } catch (error) {
      updateChild(parentId, child.id, (entry) => messageDropped(entry, id));
      throw error;
    }
    if (answer.delivered) {
      const lost = answer.inDoubt ? (answer.unanswered ?? 'the relay lost the answer') : undefined;
      // A read that crossed back before this answer has settled the message, and every transition below then leaves it as read.
      const message = update(parentId, child.id, { ...sent, ...(answer.via ? { via: answer.via } : {}) }, (entry) => (lost ? relayAnswerLost(entry, id, lost) : answer.unanswered ? messageUnanswered(entry, id, answer.via, answer.unanswered) : messagePushed(entry, id, answer.via)));
      if (lost && phaseOf(message) === 'relay-in-doubt') {
        return {
          message,
          unanswered: answer.unanswered,
          text: `Pushed to ${child.name}'s session as message ${id}, but ${lost.replace(/[.\s]+$/, '')}, so nothing was typed into its pane: its session may already hold it, and a typed copy would enter it twice. Bellwether asks that machine again once the relay is back, and its daemon pushes the message only if it never did. agent_list shows the answer.`,
        };
      }
      if (answer.unanswered && phaseOf(message) === 'unanswered') {
        return {
          message,
          unanswered: answer.unanswered,
          text: `Pushed to ${child.name}'s session as message ${id}, but ${answer.unanswered}, so nothing was typed into its pane: a session that takes it late would hold two copies. agent_list shows when its model has read it, and a session that reconnects is offered it again.`,
        };
      }
      const label = VIA_LABEL[answer.via] ?? (answer.via || 'adapter');
      return {
        message,
        text: `Delivered to ${child.name}'s session as message ${id}, through its ${label}; nothing was typed into its pane.${answer.note ? ` ${answer.note}` : ''} An idle ${child.name} starts a turn on it, and a busy one takes it after the tool calls in flight, before its next model call. agent_list shows when its model has read it, and if ${child.name} exits first, the exit event says it never did.`,
      };
    }
    // Another holder for the pane: nothing is typed into a pane this parent may not hold (issue #279).
    if (answer.refused) {
      const refused = answer.refused;
      updateChild(parentId, child.id, (entry) => {
        messageDropped(entry, id);
        messageNeverSent(entry, fresh, refused);
      });
      throw new AuthorityRefused(`${answer.refused} Message ${id} was not typed, and stays on the record as never delivered.`);
    }
    // A repair on the way, such as a claim restored on the child's machine, still goes in the reply (issue #219).
    reason = answer.note ? `${answer.reason.replace(/\.$/, '')}. ${answer.note}` : answer.reason;
    // A message that is never typed stays on the record, held for the
    // session's next hello, which offers it (issue #278).
    if (input.typing === false) {
      const why = reason;
      const message = update(parentId, child.id, sent, (entry) => messageHeld(entry, id, why));
      return { message, unanswered: why, text: `${child.name}'s session did not take message ${id}, because ${why.replace(/\.$/, '')}. It is never typed, and its session is offered it when it next connects.` };
    }
    // The fallback records a message of its own under the same id.
    updateChild(parentId, child.id, (entry) => messageDropped(entry, id));
  }
  if (input.typing === false) {
    const why = reason ?? 'the session path was not available';
    let kept!: ChildMessage;
    updateChild(parentId, child.id, (entry) => {
      kept = messageNeverSent(entry, fresh, why);
    });
    return { message: kept, unanswered: why, text: `${child.name}'s session cannot take message ${id}, because ${why.replace(/\.$/, '')}, and it is never typed.` };
  }
  await input.beforeTyping?.();
  return typeInto(input, id, at, reason ?? 'the session path was not available');
}

/**
 * The fallback: herdr types the message into the child's pane, where it
 * lands as if a person typed it, racing whatever draft sits there.
 */
async function typeInto(input: MessageInput, id: string, at: string, reason: string): Promise<MessageOutcome> {
  const { herdr, child, parentId, text } = input;
  const typed = (how: Typing): ChildMessage => {
    let kept!: ChildMessage;
    updateChild(parentId, child.id, (entry) => {
      kept = messageTyped(entry, { id, at, text, ...(input.brief ? { brief: input.brief.n } : {}) }, reason, how);
    });
    return kept ?? { id, at, path: 'keystrokes', reason, preview: preview(text) };
  };
  try {
    if (input.brief) {
      // Pane feature: the parent that spawned this child asked for the brief
      // to reach it, and the session path was not available, so herdr types
      // the brief itself into the pane Bellwether just started. The person
      // watching the pane reads the task rather than a path to a file.
      await herdr.agentPrompt(child.paneId, text);
    } else {
      // TODO(api): a harness inbound path retires this for the harnesses that
      // have none yet: a message request in Codex's and Cline's MCP clients, or
      // OpenCode's and Kilo's session message API reached from the daemon.
      await herdr.agentPrompt(child.paneId, text);
    }
    const message = typed({ typed: true });
    return { message, text: `Prompted ${child.name}: herdr typed message ${id} into its pane, because ${reason.replace(/\.$/, '')}.` };
  } catch (error) {
    if (error instanceof HerdrApiError && child.lastStatus === 'blocked') {
      const refused = typed({ refused: 'herdr refused the prompt, because the child is blocked on a dialog' });
      // Pane feature: herdr refused the parent's prompt, so the parent sees the
      // dialog that blocks the child and chooses the keys that answer it.
      const dialog = shownScreen(await herdr.paneRead({ paneId: child.paneId, source: 'detection', lines: 30 }).catch(() => BLANK_SCREEN));
      return { message: refused, text: `herdr refused the prompt because ${child.name} is blocked. The dialog:\n${dialog}\n\nReply with agent_send keys, for example ["enter"] or ["down","enter"].` };
    }
    throw promptFailed(child, id, error as Error, typed);
  }
}

/** Socket errors raised before a connection opens, so herdr never received the request. */
const NOT_REACHED = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES']);

/**
 * A failed agent.prompt, put on the record before the caller hears of it
 * (issue #234). An error never leaves the record silent: a request that never
 * reached herdr is recorded as undelivered, and one that left is recorded as
 * possibly typed, because herdr may have typed the text before the timeout
 * or the error came back. The error says which, so the caller knows whether
 * sending again could type the message twice.
 */
function promptFailed(child: ChildRecord, id: string, error: Error, typed: (how: Typing) => ChildMessage): Error {
  const why = error.message.replace(/[.\s]+$/, '');
  if (NOT_REACHED.has(String((error as NodeJS.ErrnoException).code))) {
    typed({ refused: `herdr was not reachable, so nothing was typed: ${why}` });
    return new Error(`herdr was not reachable, so nothing was typed into ${child.name}'s pane: ${why}. Message ${id} is on the record as undelivered, and sending it again enters it once.`);
  }
  typed({ inDoubt: why });
  return new Error(`herdr may have typed message ${id} into ${child.name}'s pane: its agent.prompt failed after the request left, with ${why}. The record keeps the message as in doubt, and agent_list shows it. Read the pane with agent_read before you send it again, because a second agent_send could type it into the pane twice.`);
}

/** The session messages a child never read, which a reconnected session takes again. */
export function unreadSessionMessages(child: Pick<ChildRecord, 'messages'>): ChildMessage[] {
  return toReplay(child);
}

/** What a message's phase says, in the words agent_list uses for every message. */
function stateLine(message: ChildMessage): string {
  switch (phaseOf(message)) {
    case 'sending':
      return 'sending: its session has not answered yet';
    case 'held':
      return `held: its session did not take it, because ${(message.held ?? '').replace(/[.\s]+$/, '')}; it is never typed, and its session is offered it when it next connects`;
    case 'pushed':
      return 'pushed; not read yet';
    case 'unanswered':
      return `in doubt: ${(message.unanswered ?? '').replace(/[.\s]+$/, '')}, so its session may hold it; nothing was typed, and its session is offered it again when it next connects`;
    case 'relay-in-doubt':
      return `in doubt: not known whether its machine pushed it, because ${(message.relayInDoubt ?? '').replace(/[.\s]+$/, '')}; Bellwether asks again once the relay is back`;
    case 'typed-in-doubt':
      return `in doubt: not known whether herdr typed it, because its agent.prompt failed with ${message.typedInDoubt}; read its pane with agent_read before you send it again`;
    case 'typed':
      return 'typed; Bellwether cannot tell when the model read it';
    case 'read':
      return `read at ${message.readAt}`;
    case 'undelivered':
      return `undelivered: ${message.undelivered}`;
  }
}

/** One line per recent message, for agent_list. */
export function describeMessages(child: Pick<ChildRecord, 'name' | 'messages'>): string[] {
  return (child.messages ?? []).slice(-3).map((message) => {
    const path = message.path === 'session' ? `into its session through ${VIA_LABEL[message.via ?? ''] ?? 'its adapter (waiting for it to take the message)'}` : `typed into its pane, because ${message.reason ?? 'no reason was recorded'}`;
    return `${child.name}: message ${message.id} at ${message.at}, ${path}; ${stateLine(message)}. "${message.preview}"`;
  });
}
