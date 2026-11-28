// What happened to a message or a brief on its way into a child's session
// (issue #278). This module is the only writer of those fields. Every other
// module reads them through the states below and changes them only through
// the transitions, so a field's meaning no longer depends on which code path
// wrote it last. `test/unit/delivery-owner.test.ts` fails on a write anywhere
// else, and `ChildMessage`, `BriefDelivery` and `TeleportNoticeRecord` declare
// each owned field `readonly`, so the typecheck fails on a write through any
// alias too.
//
// The fields stay flat where they have always been. The registry files, and
// every daemon from an older release that takes over the same registry, read
// them there, so a nested state object would need a registry migration. The
// state is a pure function of the stored fields instead, in `phaseOf`, and
// the transitions refuse any move the table does not allow.
//
// A message on a child record is in one phase:
//
//   phase           word         means
//   sending         sending      Recorded before the push. Nobody has answered yet.
//   held            held         Never typed. Its session did not take it, and the session's next hello offers it.
//   pushed          pushed       An adapter took it into the session. Its model has not read it yet.
//   unanswered      in doubt     Pushed, and the session did not answer within the bound. It may hold it, so nothing is typed, and its next hello offers it again.
//   relay-in-doubt  in doubt     Sent to another machine, whose answer was lost. Its daemon is asked again once the relay is back.
//   typed-in-doubt  in doubt     herdr's agent.prompt failed after the request left. herdr may have typed it.
//   typed           typed        herdr typed it into the pane. Bellwether cannot tell when the model read it.
//   read            read         The adapter reported that it entered the model's conversation.
//   undelivered     undelivered  Nothing reached the model, and nothing will try again.
//
// A person reads seven words: sending, held, pushed, in doubt, typed, read and
// undelivered. "In doubt" always means "maybe it was delivered", whichever
// of the three causes, and "undelivered" always means "nothing was".
//
// Which field holds each phase, and who writes it:
//
//   field          phase            written by
//   via            pushed           messagePushed, relayAnswered
//   held           held             messageHeld                          cleared by messagePushed, messageRead
//   unanswered     unanswered       messageUnanswered                    cleared by messagePushed, messageRead
//   relayInDoubt   relay-in-doubt   relayAnswerLost, relayAnswered when the far machine forgot the child
//                                                                        cleared by relayAnswered, messageRead
//   typedInDoubt   typed-in-doubt   messageTyped with a doubt
//   readAt         read             messageRead
//   undelivered    undelivered      messageRefused, messageResent, briefsCarried, childExited,
//                                   relayAnswered, messageTyped with a refusal         cleared by messageRead
//   text, from     kept while the session may take it again; every move out of sending,
//                  held, pushed and unanswered drops them
//
// A brief's delivery, on its entry under `briefs`, and a teleport's notice,
// under `teleports`, keep the facts its start saw. The message that carried
// it stays on the record, and a read that lands after the start counts: the
// brief's state reads both, in `briefState`.
import { updateChild } from './registry.ts';
import type { MessageOutcome } from './send.ts';
import type { BriefDelivery, ChildBrief, ChildMessage, ChildRecord } from './types.ts';
import type { TeleportNoticeRecord } from './teleport-plan.ts';

export type MessagePhase = 'sending' | 'held' | 'pushed' | 'unanswered' | 'relay-in-doubt' | 'typed-in-doubt' | 'typed' | 'read' | 'undelivered';

/** The words a person reads for a phase, one per meaning. */
export type DeliveryWord = 'sending' | 'held' | 'pushed' | 'in doubt' | 'typed' | 'read' | 'undelivered';

/** Each phase, the word a person reads for it, and what it means in one sentence. */
export const PHASES: Record<MessagePhase, { word: DeliveryWord; means: string }> = {
  sending: { word: 'sending', means: 'Recorded before the push. Nobody has answered yet.' },
  held: { word: 'held', means: "Never typed. Its session did not take it, and the session's next hello offers it." },
  pushed: { word: 'pushed', means: 'An adapter took it into the session. Its model has not read it yet.' },
  unanswered: { word: 'in doubt', means: 'Pushed, and the session did not answer within the bound. It may hold it, so nothing is typed, and its next hello offers it again.' },
  'relay-in-doubt': { word: 'in doubt', means: "Sent to another machine, whose answer was lost. Its daemon is asked again once the relay is back." },
  'typed-in-doubt': { word: 'in doubt', means: "herdr's agent.prompt failed after the request left. herdr may have typed it." },
  typed: { word: 'typed', means: 'herdr typed it into the pane. Bellwether cannot tell when the model read it.' },
  read: { word: 'read', means: "The adapter reported that it entered the model's conversation." },
  undelivered: { word: 'undelivered', means: 'Nothing reached the model, and nothing will try again.' },
};

/** The phase of a message, from its stored fields. A read wins over every other mark, because the model has it. */
export function phaseOf(message: ChildMessage): MessagePhase {
  if (message.readAt) return 'read';
  if (message.undelivered) return 'undelivered';
  if (message.typedInDoubt) return 'typed-in-doubt';
  if (message.relayInDoubt) return 'relay-in-doubt';
  if (message.unanswered) return 'unanswered';
  if (message.path === 'keystrokes') return 'typed';
  if (message.held) return 'held';
  if (message.via) return 'pushed';
  return 'sending';
}

export function wordOf(message: ChildMessage): DeliveryWord {
  return PHASES[phaseOf(message)].word;
}

/** What can happen to a message already on the record. */
export type MessageEvent = 'pushed' | 'unanswered' | 'relay-lost' | 'relay-refused' | 'relay-unknowable' | 'held' | 'refused' | 'read' | 'resent' | 'carried' | 'exited';

/**
 * Every move the machine allows, from each phase on each event. A pair left
 * out is refused, and the record stays as it was. Each row says why.
 */
export const TRANSITIONS: Record<MessagePhase, Partial<Record<MessageEvent, MessagePhase>>> = {
  sending: {
    pushed: 'pushed',
    unanswered: 'unanswered',
    'relay-lost': 'relay-in-doubt',
    held: 'held',
    read: 'read',
    resent: 'undelivered',
    carried: 'undelivered',
  },
  held: {
    // The session's next hello offered it, and its adapter took it.
    pushed: 'pushed',
    read: 'read',
    resent: 'undelivered',
    carried: 'undelivered',
    exited: 'undelivered',
  },
  pushed: {
    // A later answer names the adapter again, or a far daemon's answer after a lost one.
    pushed: 'pushed',
    refused: 'undelivered',
    read: 'read',
    resent: 'undelivered',
    carried: 'undelivered',
    exited: 'undelivered',
  },
  unanswered: {
    // The ack that arrives after the timeout.
    pushed: 'pushed',
    refused: 'undelivered',
    read: 'read',
    resent: 'undelivered',
    carried: 'undelivered',
    exited: 'undelivered',
  },
  'relay-in-doubt': {
    // The far daemon answers the second ask: it pushed the message, or it never did.
    pushed: 'pushed',
    'relay-refused': 'undelivered',
    // The far machine no longer holds the child, so its answer will never be known. It stays in doubt, and nobody asks again.
    'relay-unknowable': 'relay-in-doubt',
    read: 'read',
  },
  // A resume's brief that carries a typed brief stands in for it: nothing proved the model read the typed copy.
  'typed-in-doubt': { carried: 'undelivered' },
  typed: { carried: 'undelivered' },
  read: {
    // A late answer may still name the adapter, and changes nothing else.
    pushed: 'read',
  },
  undelivered: {
    // A copy marked undelivered when the brief went again, read after all (issue #246).
    read: 'read',
    // A late answer for a copy that went again names its adapter, and the copy stays undelivered.
    pushed: 'undelivered',
  },
};

/** The phase a message moves to on an event, or undefined when the machine refuses the move. */
export function next(phase: MessagePhase, event: MessageEvent): MessagePhase | undefined {
  return TRANSITIONS[phase][event];
}

/** The record as this module alone may write it. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };
function writable<T>(value: T): Writable<T> {
  return value as Writable<T>;
}

/** Fields that only one phase carries. A move out of that phase drops them. */
const MARKS = ['held', 'unanswered', 'relayInDoubt', 'undelivered'] as const;

/** Move one message on an event, by the table. Returns the message when it moved. */
function move(child: ChildRecord, id: string, event: MessageEvent, apply: (message: Writable<ChildMessage>, to: MessagePhase) => void): ChildMessage | undefined {
  const message = child.messages?.find((entry) => entry.id === id);
  if (!message) return undefined;
  const to = next(phaseOf(message), event);
  if (!to) return undefined;
  const entry = writable(message);
  const from = phaseOf(message);
  if (to !== from) for (const mark of MARKS) delete entry[mark];
  if (to === 'read' || to === 'undelivered' || to === 'relay-in-doubt') {
    // The text goes once nothing will offer it again. A message in doubt over
    // the relay keeps it, because the far daemon is asked again with it.
    if (to !== 'relay-in-doubt') {
      delete entry.text;
      delete entry.from;
    }
  }
  apply(entry, to);
  return message;
}

/** How many messages a child record keeps. */
export const KEPT_MESSAGES = 20;
const PREVIEW = 80;

export function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
}

function keep(child: ChildRecord, message: ChildMessage): void {
  const kept = (child.messages ?? []).filter((existing) => existing.id !== message.id);
  kept.push(message);
  writable(child).messages = kept.slice(-KEPT_MESSAGES);
}

export interface NewMessage {
  id: string;
  at: string;
  text: string;
  from: string;
  /** For a start's brief: the brief's number. */
  brief?: number;
}

function base(message: NewMessage): Pick<ChildMessage, 'id' | 'at' | 'preview' | 'brief'> {
  return { id: message.id, at: message.at, preview: preview(message.text), ...(message.brief === undefined ? {} : { brief: message.brief }) };
}

/** A session message, recorded before the push so a read that comes back at once finds it. */
export function messageSending(child: ChildRecord, message: NewMessage): ChildMessage {
  const entry: ChildMessage = { ...base(message), path: 'session', text: message.text, from: message.from };
  keep(child, entry);
  return entry;
}

/** A message that left the record before anything was delivered: the harness exited first, or the fallback records its own. */
export function messageDropped(child: ChildRecord, id: string): void {
  const kept = (child.messages ?? []).filter((existing) => existing.id !== id);
  if (kept.length) writable(child).messages = kept;
  else delete writable(child).messages;
}

/** An adapter took the message into the session. A `via` of '' or 'session' names no adapter and keeps the one on the record. */
export function messagePushed(child: ChildRecord, id: string, via: string | undefined): ChildMessage | undefined {
  return move(child, id, 'pushed', (entry) => {
    if (via && via !== 'session') entry.via = via;
    else entry.via ??= 'session';
  });
}

/** The push left, and the session did not answer within the bound, or its connection closed first. */
export function messageUnanswered(child: ChildRecord, id: string, via: string | undefined, reason: string): ChildMessage | undefined {
  return move(child, id, 'unanswered', (entry) => {
    entry.via = via || 'session';
    entry.unanswered = reason;
  });
}

/** The relay to the child's machine lost the far daemon's answer (issue #218). Refused once the model has read it. */
export function relayAnswerLost(child: ChildRecord, id: string, reason: string): ChildMessage | undefined {
  return move(child, id, 'relay-lost', (entry) => {
    entry.relayInDoubt = reason;
  });
}

/**
 * The far daemon answered the second ask, once the relay was back: it pushed
 * the message, it never did, or it holds no record of the child, so nobody
 * can say. The last keeps the message in doubt and drops its text, so the
 * relay never asks about it again.
 */
export function relayAnswered(child: ChildRecord, id: string, answer: { delivered: true; via: string } | { delivered: false; why: string; unknowable?: boolean }): ChildMessage | undefined {
  if (answer.delivered) return messagePushed(child, id, answer.via);
  if (answer.unknowable) {
    return move(child, id, 'relay-unknowable', (entry) => {
      entry.relayInDoubt = answer.why;
      delete entry.text;
      delete entry.from;
    });
  }
  return move(child, id, 'relay-refused', (entry) => {
    entry.undelivered = answer.why;
  });
}

/** Its session did not take a message that is never typed. The session's next hello offers it. */
export function messageHeld(child: ChildRecord, id: string, reason: string): ChildMessage | undefined {
  return move(child, id, 'held', (entry) => {
    entry.held = reason;
  });
}

/** The session refused the message after its wait ran out. */
export function messageRefused(child: ChildRecord, id: string, why: string): ChildMessage | undefined {
  return move(child, id, 'refused', (entry) => {
    entry.undelivered = why;
  });
}

/**
 * The adapter reported that the message entered the model's conversation, at
 * `at`. Returns the read when it is new, and undefined for a second read of
 * the same message, which changes nothing.
 */
export function messageRead(child: ChildRecord, id: string, at: string, via?: string): string | undefined {
  const moved = move(child, id, 'read', (entry) => {
    entry.readAt = at;
    if (via) entry.via ??= via;
  });
  return moved ? at : undefined;
}

/** A start's brief went again, and this first copy leaves the replay. */
export function messageResent(child: ChildRecord, id: string, why: string): ChildMessage | undefined {
  return move(child, id, 'resent', (entry) => {
    entry.undelivered = why;
  });
}

/** A resume's brief carries these earlier briefs, so the messages that carried them leave the replay. */
export function briefsCarried(child: ChildRecord, carried: ReadonlySet<number>, why: string): void {
  for (const message of child.messages ?? []) {
    if (message.brief === undefined || !carried.has(message.brief)) continue;
    move(child, message.id, 'carried', (entry) => {
      entry.undelivered = why;
    });
  }
}

/** The child exited: each message its session might still have taken is undelivered. Returns those messages, for the exit event. */
export function childExited(child: ChildRecord, why: string): ChildMessage[] {
  const unread = toReplay(child);
  for (const message of unread) {
    move(child, message.id, 'exited', (entry) => {
      entry.undelivered = why;
    });
  }
  return unread;
}

/** How a typed message ended. */
export type Typing = { typed: true } | { refused: string } | { inDoubt: string };

/** herdr was asked to type the message into the pane, for the reason the session path was not taken. */
export function messageTyped(child: ChildRecord, message: Omit<NewMessage, 'from'>, reason: string, how: Typing): ChildMessage {
  const entry: ChildMessage = {
    ...base({ ...message, from: '' }),
    path: 'keystrokes',
    reason,
    ...('refused' in how ? { undelivered: how.refused } : {}),
    ...('inDoubt' in how ? { typedInDoubt: how.inDoubt } : {}),
  };
  keep(child, entry);
  return entry;
}

/** A message that is never typed, for a child whose session path is not available. Nothing will try again. */
export function messageNeverSent(child: ChildRecord, message: NewMessage, why: string): ChildMessage {
  const entry: ChildMessage = { ...base(message), path: 'session', undelivered: why };
  keep(child, entry);
  return entry;
}

/**
 * The session messages a reconnecting session takes again: held, pushed or
 * unanswered, with the text kept. A message still being sent is left out,
 * because its push is on the way.
 */
export function toReplay(child: Pick<ChildRecord, 'messages'>): ChildMessage[] {
  return (child.messages ?? []).filter((message) => message.path === 'session' && message.text !== undefined && ['held', 'pushed', 'unanswered'].includes(phaseOf(message)));
}

/** The messages a relay reconnection asks the far daemon about again. */
export function inRelayDoubt(child: Pick<ChildRecord, 'messages'>): ChildMessage[] {
  return (child.messages ?? []).filter((message) => phaseOf(message) === 'relay-in-doubt' && message.text !== undefined);
}

/** Whether a message reached the model's conversation, by either path: read, or typed. */
export function reachedModel(message: ChildMessage): boolean {
  const phase = phaseOf(message);
  return phase === 'read' || phase === 'typed';
}

/** The record a carry puts back on failure: the record before it, with the messages sent since. */
export function withMessagesOf(record: ChildRecord, current: Pick<ChildRecord, 'messages'> | undefined): ChildRecord {
  const copy = { ...record };
  if (current?.messages) writable(copy).messages = current.messages;
  return copy;
}

// Briefs.
//
// A brief has its own record of delivery, `ChildBrief.delivery`, because each
// resume that brings a prompt adds a brief of its own (issue #189). Its
// states, and what each means:
//
//   state        means
//   unrecorded   The start failed, or a daemon before 0.1.8 wrote it.
//   launch       The first prompt on the launch line, and the harness's own store showed that prompt.
//   typed        herdr typed it into the pane. Bellwether cannot tell when the model read it.
//   in doubt     Pushed, and the session never answered. Nothing was typed, and no second copy went.
//   pushed       The adapter received it. The model has not read it.
//   read         The adapter reported the model read it, and herdr reported no turn on it.
//   taken        The model read it and began a turn on it: both signs, on one copy (issue #211).
//
// A delivery written before 0.1.10 can carry `takenBy: 'read'`, which then
// meant a read receipt alone. It reads as `read` here, which is what a read
// receipt alone means now.

export type BriefState = 'unrecorded' | 'launch' | 'typed' | 'in doubt' | 'pushed' | 'read' | 'taken';

/** The state of a delivery as its start recorded it. */
export function deliveryState(delivery: BriefDelivery | undefined): BriefState {
  if (!delivery) return 'unrecorded';
  if (delivery.path === 'launch') return 'launch';
  if (delivery.path === 'keystrokes') return 'typed';
  if (delivery.takenAt && delivery.takenBy !== 'read') return 'taken';
  if (delivery.readAt || delivery.takenBy === 'read') return 'read';
  if (delivery.unanswered) return 'in doubt';
  return 'pushed';
}

/**
 * The state of a brief on a record: its delivery, and a read of the message
 * that carried it that landed after the start recorded the delivery.
 */
export function briefState(child: Pick<ChildRecord, 'messages'>, brief: Pick<ChildBrief, 'delivery'>): BriefState {
  const state = deliveryState(brief.delivery);
  if (state !== 'pushed' && state !== 'in doubt') return state;
  const ids = [brief.delivery?.message, brief.delivery?.resentFrom].filter((id): id is string => Boolean(id));
  return child.messages?.some((message) => ids.includes(message.id) && message.readAt) ? 'read' : state;
}

/** The delivery a message's outcome records, before the model's sign. */
export function briefPushed(outcome: Pick<MessageOutcome, 'message' | 'unanswered'>, at: string): BriefDelivery {
  const message = outcome.message;
  if (message.path === 'session' && outcome.unanswered) return { path: 'session', via: message.via ?? 'session', message: message.id, at: message.at, unanswered: outcome.unanswered };
  return message.path === 'session'
    ? { path: 'session', via: message.via ?? 'session', message: message.id, at: message.at, receivedAt: at }
    : { path: 'keystrokes', reason: message.reason ?? 'the session path was not available', message: message.id, at: message.at };
}

/** The delivery of a second copy, which names the first. */
export function briefResent(delivery: BriefDelivery, first: string): BriefDelivery {
  return { ...delivery, resentFrom: first };
}

/** The signs a wait on a copy saw: a read receipt naming one message, and a turn since the push. */
export function briefSettled(delivery: BriefDelivery, read: { id: string; at: string }, turn: string | undefined): BriefDelivery {
  const withRead: BriefDelivery = { ...delivery, readAt: read.at, ...(read.id !== delivery.message ? { readFrom: read.id } : {}) };
  // Taken only on both facts (issue #211): a read with no turn keeps its read and no takenAt.
  if (!turn) return withRead;
  return { ...withRead, takenAt: Date.parse(read.at) > Date.parse(turn) ? read.at : turn, takenBy: 'turn' };
}

/** A brief on the launch line, which the harness's own store confirmed. */
export function briefOnLaunch(brief: ChildBrief, reason: string, at: string): BriefDelivery {
  const delivery: BriefDelivery = { path: 'launch', reason, at };
  writable(brief).delivery = delivery;
  return delivery;
}

/** Put a start's delivery on its brief entry, on the record in hand. */
export function briefDelivered(brief: ChildBrief, delivery: BriefDelivery): void {
  writable(brief).delivery = delivery;
}

/** Put a start's delivery on its brief entry, in the registry. */
export function recordBriefDelivery(parentId: string, childId: string, n: number, delivery: BriefDelivery): void {
  updateChild(parentId, childId, (entry) => {
    const found = entry.briefs?.find((brief) => brief.n === n);
    if (found) briefDelivered(found, delivery);
  });
}

/** The spawn's brief list: one brief, number 1. */
export function firstBriefs(file: string, at: string): Pick<ChildRecord, 'briefs'> {
  return { briefs: [{ n: 1, file, at }] };
}

/** A resume's brief joins the briefs the record knew, in place of an entry with its number. */
export function briefAdded(child: ChildRecord, known: readonly ChildBrief[], brief: ChildBrief): void {
  writable(child).briefs = [...known.filter((entry) => entry.n !== brief.n), brief];
}

/** A resume that failed puts back the brief list it found. */
export function briefsRestored(child: ChildRecord, briefs: ChildBrief[] | undefined): void {
  if (briefs) writable(child).briefs = briefs;
  else delete writable(child).briefs;
}

// Teleport notices.
//
// A notice (issue #226) is a message that is never typed. Its record on the
// teleport keeps what the start saw, and `noticeState` adds a read that
// landed after it.

/** What a start saw of the notice it handed over. */
export interface NoticeOutcome {
  delivery: BriefDelivery;
  /** Why Bellwether did not see the model read it and begin a turn on it. */
  notTaken?: string;
}

/** The notice as the record keeps it: how it arrived, or why Bellwether did not see the model take it. */
export function noticeOf(outcome: NoticeOutcome | undefined): TeleportNoticeRecord {
  const delivery = outcome?.delivery;
  if (!delivery) return { undelivered: 'the resume carried no notice' };
  const taken = deliveryState(delivery) === 'taken';
  return {
    ...(delivery.message ? { message: delivery.message } : {}),
    ...(delivery.via ? { via: delivery.via } : {}),
    ...(delivery.receivedAt ? { receivedAt: delivery.receivedAt } : {}),
    ...(delivery.readAt ? { readAt: delivery.readAt } : {}),
    ...(taken && delivery.takenAt ? { takenAt: delivery.takenAt } : {}),
    ...(taken ? {} : { undelivered: outcome?.notTaken ?? delivery.unanswered ?? 'Bellwether did not see its model read it and begin a turn on it' }),
  };
}

/** Whether the model took a notice: read it and began a turn on it. */
export function noticeTaken(outcome: NoticeOutcome | undefined): boolean {
  return deliveryState(outcome?.delivery) === 'taken';
}

/** A notice on a record: taken, read (by the start, or by a read that landed since), or not seen. */
export function noticeState(child: Pick<ChildRecord, 'messages'>, notice: TeleportNoticeRecord): { state: 'taken' | 'read' | 'not seen'; at?: string } {
  if (notice.takenAt) return { state: 'taken', at: notice.takenAt };
  const late = notice.message ? child.messages?.find((message) => message.id === notice.message)?.readAt : undefined;
  const read = notice.readAt ?? late;
  return read ? { state: 'read', at: read } : { state: 'not seen' };
}

/**
 * The fields this module owns, on a message, on a brief's delivery, on a
 * teleport's notice, and the two lists on the child record. The ownership
 * gate reads this list. `text` and `from` count, because a move that ends the
 * replay drops them.
 */
export const DELIVERY_FIELDS = ['messages', 'briefs', 'delivery', 'via', 'readAt', 'undelivered', 'relayInDoubt', 'typedInDoubt', 'unanswered', 'held', 'text', 'from', 'receivedAt', 'takenAt', 'takenBy', 'readFrom', 'resentFrom'] as const;
