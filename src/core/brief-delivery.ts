// A start hands its child the brief as a message (issue #162). The harness
// starts with no brief on its launch line. Once herdr detects it and its
// startup dialogs are answered, the brief goes through the child's own
// Bellwether adapter, the same path agent_send takes.
//
// The adapter's receipt proves the transport, not the reader (issue #176).
// The Claude Code channel server and the pi extension connect while the
// model behind them has not taken a turn, and a message pushed in that window
// can be lost while the adapter still answers. So the start then waits for a
// fact only the model produces: herdr reporting the harness `working`, or the
// adapter's read receipt. When neither comes, the brief goes once more, and
// when the second copy fares no better, the start fails with BriefNotTaken.
//
// When the session path is not available, herdr types the brief into the pane
// instead: a harness with no adapter, a session that never connects, or one
// that does not take the message in time. A harness that exits while the
// brief waits fails the start, quoting what it printed, and the record keeps
// no message that looks delivered.
//
// The brief file stays on disk as the record a parent can read again.
import type { HerdrClient } from './herdr-client.ts';
import { BLANK_SCREEN } from './screen.ts';
import { BRIEF_SESSION_WAIT_MS, BRIEF_TURN_WAIT_MS, messageChild, type Inbox, type MessageOutcome } from './send.ts';
import { HarnessStartFailed, processInfoOf, startupQuote } from './start-check.ts';
import { updateChild } from './registry.ts';
import type { BriefDelivery, ChildBrief, ChildRecord } from './types.ts';

export interface BriefInput {
  herdr: HerdrClient;
  parentId: string;
  /** The child, with the pane its harness runs in. */
  child: ChildRecord;
  /** The record entry for the brief, which takes the delivery. */
  brief: Pick<ChildBrief, 'n' | 'file'>;
  /** The brief's text, as the child reads it. */
  text: string;
  /** Who sends it, as the child reads it. */
  from: string;
  /** The daemon's way into the child's session. Without it, the brief is typed. */
  inbox?: Inbox;
  /** The line the harness prints on a fatal error, for the quote when it exits. */
  fatal?: RegExp;
  signal?: AbortSignal;
}

export interface BriefOutcome {
  delivery: BriefDelivery;
  /** A line for the reply of the start that handed the brief over. */
  note: string;
}

/** A start whose child's adapter received the brief, twice, while its model took neither copy. */
export class BriefNotTaken extends Error {
  constructor(message: string) {
    super(`BriefNotTaken: ${message}`);
    this.name = 'BriefNotTaken';
  }
}

/**
 * How long the watcher holds a new child's events while its brief waits: for
 * the session to connect, then for the model on each of two copies, with room
 * for the answers in between.
 */
export function briefHoldMs(inbox: Inbox | undefined): number {
  return BRIEF_SESSION_WAIT_MS + 2 * (inbox?.turnWaitMs ?? BRIEF_TURN_WAIT_MS) + 20_000;
}

const STATUS_EVENTS = new Set(['pane.agent_status_changed', 'pane_agent_status_changed']);

/** The model's first sign of a message, or nothing when the wait ran out. */
type Taken = { by: 'turn' | 'read'; at: string } | undefined;

/** Hand a just-started child its brief, by its session where it can, and record which path carried it. */
export async function deliverBrief(input: BriefInput): Promise<BriefOutcome> {
  const { herdr, child } = input;
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  // Pane feature: a start that failed quotes the harness's own lines to the
  // parent that asked for it, so it reads why without opening the pane.
  const quote = async (): Promise<string | undefined> => startupQuote((await herdr.paneRead({ paneId: child.paneId, source: 'visible', lines: 40 }, input.signal).catch(() => BLANK_SCREEN)).content, child.kind, input.fatal);
  const failed = async (when: string): Promise<HarnessStartFailed> => {
    const said = await quote();
    return new HarnessStartFailed(`${child.kind} in pane ${child.paneId} exited ${when}${said ? `, and printed: ${said}` : ', and printed nothing Bellwether could read'}`);
  };
  // herdr releases the agent when the harness ends in a pane whose shell
  // stays, and reports the pane's exit when the shell ends too.
  let rejectGone: (error: Error) => void = () => {};
  const gone = new Promise<never>((_resolve, reject) => {
    rejectGone = reject;
  });
  gone.catch(() => {});
  let ended = false;
  // The first turn herdr reports after the brief left. The subscription opens
  // before the push, so a turn that starts at once is not missed.
  let sending = false;
  let turnAt: string | undefined;
  let onTurn: () => void = () => {};
  const subscription = await herdr.subscribe(
    [
      { type: 'pane.agent_detected', pane_id: child.paneId },
      { type: 'pane.exited', pane_id: child.paneId },
      { type: 'pane.agent_status_changed', pane_id: child.paneId },
    ],
    (event) => {
      if (ended || event.data['pane_id'] !== child.paneId) return;
      if (STATUS_EVENTS.has(event.event)) {
        if (sending && !turnAt && event.data['agent_status'] === 'working') {
          turnAt = new Date().toISOString();
          onTurn();
        }
        return;
      }
      if (event.event === 'pane_exited' || event.event === 'pane.exited' || event.data['released'] === true) {
        ended = true;
        void failed('before its session took the brief').then(rejectGone);
      }
    },
    controller.signal,
  );
  const send = (): Promise<MessageOutcome> =>
    messageChild({
      herdr,
      parentId: input.parentId,
      from: input.from,
      child,
      text: input.text,
      inbox: input.inbox,
      brief: { n: input.brief.n },
      gone,
      // The brief is never typed at a shell: the harness must still hold the
      // pane's foreground. herdr sends no event for a program that ends while
      // its shell stays, and this one check covers the moment before typing.
      beforeTyping: async () => {
        if (ended) await gone;
        const info = processInfoOf(await herdr.request('pane.process_info', { pane_id: child.paneId }, { signal: input.signal }).catch(() => undefined));
        if (info && info.foregroundGroup === info.shellPid) throw await failed('before it took the brief');
      },
    });
  const waitMs = input.inbox?.turnWaitMs ?? BRIEF_TURN_WAIT_MS;
  // Wait for the model behind the adapter to begin a turn or read the message.
  const taken = async (messageId: string): Promise<Taken> => {
    if (turnAt) return { by: 'turn', at: turnAt };
    const waiting = new AbortController();
    const stop = (): void => waiting.abort();
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const signs: Promise<Taken>[] = [
        new Promise<Taken>((resolve) => {
          onTurn = () => resolve({ by: 'turn', at: turnAt! });
        }),
        new Promise<Taken>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), waitMs);
          waiting.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        }),
        gone,
      ];
      if (input.inbox?.read) signs.push(input.inbox.read(input.parentId, child.id, messageId, waiting.signal).then((at): Taken => ({ by: 'read', at })));
      return await Promise.race(signs);
    } finally {
      onTurn = () => {};
      controller.signal.removeEventListener('abort', stop);
      waiting.abort();
    }
  };
  try {
    sending = true;
    let outcome = await send();
    let delivery = deliveryOf(outcome);
    if (outcome.message.path === 'session') {
      const first = outcome.message;
      let sign = await taken(first.id);
      if (!sign) {
        // The model took no turn on the first copy: it may have reached the
        // adapter before the session could take a message. The first copy
        // leaves the replay, so a reconnect does not hand it over a third time.
        outcome = await send();
        markResent(input.parentId, child.id, first.id, `its model began no turn on it within ${seconds(waitMs)} s, so brief ${input.brief.n} went again as message ${outcome.message.id}`);
        delivery = { ...deliveryOf(outcome), resentFrom: first.id };
        if (outcome.message.path === 'session') {
          sign = await taken(outcome.message.id);
          if (!sign) throw new BriefNotTaken(`${child.name}'s ${viaLabel(first.via)} received its brief twice, as messages ${first.id} and ${outcome.message.id}, but its model began no turn and read neither within ${seconds(waitMs)} s of each, so the spawn failed and its pane is closed.`);
        }
      }
      if (sign) delivery = { ...delivery, takenAt: sign.at, takenBy: sign.by };
    }
    recordDelivery(input.parentId, child.id, input.brief.n, delivery);
    return { delivery, note: deliveryNote(child, input.brief, delivery, waitMs) };
  } finally {
    ended = true;
    subscription.close();
    controller.abort();
  }
}

/** The delivery a message's outcome records, before the model's sign. */
function deliveryOf(outcome: MessageOutcome): BriefDelivery {
  const message = outcome.message;
  return message.path === 'session'
    ? { path: 'session', via: message.via ?? 'session', message: message.id, at: message.at, receivedAt: new Date().toISOString() }
    : { path: 'keystrokes', reason: message.reason ?? 'the session path was not available', message: message.id, at: message.at };
}

/** Take a first copy that went again out of the replay, with the reason. */
function markResent(parentId: string, childId: string, messageId: string, why: string): void {
  updateChild(parentId, childId, (entry) => {
    const found = entry.messages?.find((message) => message.id === messageId);
    if (!found || found.readAt) return;
    found.undelivered = why;
    delete found.text;
    delete found.from;
  });
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/** Put a brief's delivery on its entry in the child record. */
export function recordDelivery(parentId: string, childId: string, n: number, delivery: BriefDelivery): void {
  updateChild(parentId, childId, (entry) => {
    const found = entry.briefs?.find((brief) => brief.n === n);
    if (found) found.delivery = delivery;
  });
}

const VIA_LABEL: Record<string, string> = {
  'claude-channel': 'Bellwether channel',
  'pi-message': 'Bellwether pi extension',
};

function viaLabel(via: string | undefined): string {
  return VIA_LABEL[via ?? ''] ?? `${via ?? 'session'} adapter`;
}

/**
 * What a start's reply says about how the brief reached the child. The
 * adapter "received" a message; the model "began a turn on it" or "read it".
 * A parent tells transport from reading by those words.
 */
export function deliveryNote(child: Pick<ChildRecord, 'name'>, brief: Pick<ChildBrief, 'file'>, delivery: BriefDelivery, waitMs = BRIEF_TURN_WAIT_MS): string {
  const kept = `The brief stays at ${brief.file}.`;
  if (delivery.path === 'session') {
    const lag = delivery.takenAt && delivery.receivedAt ? seconds(Math.max(0, Date.parse(delivery.takenAt) - Date.parse(delivery.receivedAt))) : undefined;
    const sign = delivery.takenBy === 'read' ? `its model read it${lag ? ` ${lag} s later` : ''}` : delivery.takenBy === 'turn' ? `its model began a turn on it${lag ? ` ${lag} s later` : ''}` : 'Bellwether did not see its model take it';
    if (delivery.resentFrom) return `${child.name}'s model began no turn within ${seconds(waitMs)} s of its ${viaLabel(delivery.via)} receiving its brief as message ${delivery.resentFrom}, so Bellwether sent the brief once more as message ${delivery.message}, and ${sign}; nothing was typed into its pane. ${kept}`;
    return `${child.name}'s ${viaLabel(delivery.via)} received its brief as message ${delivery.message}, and ${sign}; nothing was typed into its pane. ${kept}`;
  }
  if (delivery.path === 'launch') return `${child.name} got its brief as the first prompt on its launch line, because ${delivery.reason}. ${kept}`;
  const resent = delivery.resentFrom ? `its model began no turn within ${seconds(waitMs)} s of its session receiving message ${delivery.resentFrom}, and then ` : '';
  return `herdr typed ${child.name}'s brief into its pane as message ${delivery.message}, because ${resent}${(delivery.reason ?? '').replace(/\.$/, '')}. Bellwether cannot tell when its model read it. ${kept}`;
}
