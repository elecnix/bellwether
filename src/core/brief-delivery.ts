// A start hands its child the brief as a message (issue #162). The harness
// starts with no brief on its launch line. Once herdr detects it and its
// startup dialogs are answered, the brief goes through the child's own
// Bellwether adapter, the same path agent_send takes.
//
// The adapter's receipt proves the transport, not the reader (issue #176).
// The Claude Code channel server and the pi extension connect while the
// model behind them has not taken a turn, and a message pushed in that window
// can be lost while the adapter still answers. So the start then waits for
// two facts on one copy: the adapter's read receipt, which names the message,
// and herdr reporting the harness `working`, which shows the model active.
// Neither alone is proof: a read says only that the message entered the
// session (issue #176), and a `working` names no message, so a redraw or a
// hook while the brief is in flight looks the same as a turn on it (issue
// #211). When the read doesn't come, the brief goes once more, and when the
// second copy fares no better, the start fails with BriefNotTaken. A copy
// whose read came never goes again, even without a turn, because a second
// copy would enter that session twice (issue #246): herdr can miss a turn
// shorter than its status cycle. The record checks for that read once more
// right before a resend, in the same turn of the event loop as the push. A
// copy the session never answered does not go again either, because the
// session may still take it.
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
import { readParent, updateChild } from './registry.ts';
import type { BriefDelivery, ChildBrief, ChildRecord } from './types.ts';

export interface BriefInput {
  herdr: HerdrClient;
  parentId: string;
  /** The child, with the pane its harness runs in. */
  child: ChildRecord;
  /** The record entry for the brief, which takes the delivery. A notice carries one only when an unread brief rides behind it. */
  brief?: Pick<ChildBrief, 'n' | 'file'>;
  /**
   * A teleport's notice (issue #226): never typed, and a model that does not
   * take it leaves the start standing, with the reason in `notTaken`, because
   * the session it started is intact and live.
   */
  notice?: true;
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
  /** For a notice: why Bellwether did not see the model read it and begin a turn on it. */
  notTaken?: string;
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

/** What a wait on one copy saw: the read receipt and which message it named, and a turn since the push. */
interface Signs {
  read?: { id: string; at: string };
  turn?: string;
}

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
  // Each copy needs two facts. herdr's "working" shows the model active, but
  // it names no message: a startup redraw or a hook reports the same status.
  // The adapter's read receipt names the message, but says only that it
  // entered the session (issue #176). Neither alone settles the brief. A
  // turn counts from the moment the copy's push starts, rather than from the
  // session's answer, because a turn on it can reach the daemon before that
  // answer does.
  let pushing = false;
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
        if (pushing && !turnAt && event.data['agent_status'] === 'working') {
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
  const send = (): Promise<MessageOutcome> => {
    // Each copy opens its own window for a turn.
    pushing = true;
    turnAt = undefined;
    return messageChild({
      herdr,
      parentId: input.parentId,
      from: input.from,
      child,
      text: input.text,
      inbox: input.inbox,
      ...(input.brief ? { brief: { n: input.brief.n } } : {}),
      awaitSession: true,
      ...(input.notice ? { typing: false } : {}),
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
  };
  const waitMs = input.inbox?.turnWaitMs ?? BRIEF_TURN_WAIT_MS;
  // Which sign the newest copy got, so a failure says what was missing.
  let readSeen = false;
  const signsSeen = (): string => (readSeen && turnAt ? 'both signs' : readSeen ? "its adapter's read receipt but no turn from herdr" : turnAt ? "a turn from herdr but no read receipt from its adapter, which a Claude Code channel sends only once it finds the session's transcript" : 'neither a read receipt nor a turn');
  // The read the record holds for a message. A read reaches the record in
  // the daemon's handler of the adapter's acknowledgement, so this sees one
  // that landed after the wait ran out.
  const recorded = (id: string): { id: string; at: string } | undefined => {
    const at = readParent(input.parentId)?.children.find((entry) => entry.id === child.id)?.messages?.find((entry) => entry.id === id)?.readAt;
    return at ? { id, at } : undefined;
  };
  const deadline = input.inbox?.deadline ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }));
  // Wait for both facts: a read receipt on one of `ids`, and a turn since the
  // newest push. It returns what came by the deadline, so the caller decides
  // on the read alone whether another copy may go.
  const watch = async (ids: string[]): Promise<Signs> => {
    readSeen = false;
    const seen: Signs = {};
    const read = input.inbox?.read;
    if (!read) return seen;
    const waiting = new AbortController();
    const stop = (): void => waiting.abort();
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const turn = turnAt
        ? Promise.resolve(turnAt)
        : new Promise<string>((resolve) => {
            onTurn = () => resolve(turnAt!);
          });
      const reads = Promise.race(ids.map((id) => read(input.parentId, child.id, id, waiting.signal).then((at) => ({ id, at })))).then((found) => {
        seen.read ??= found;
        readSeen = true;
      });
      await Promise.race([Promise.all([reads, turn]), deadline(waitMs, waiting.signal), gone]);
      // A read that landed after the deadline, before the caller decides.
      for (const id of ids) seen.read ??= recorded(id);
      if (turnAt) seen.turn = turnAt;
      return seen;
    } finally {
      onTurn = () => {};
      controller.signal.removeEventListener('abort', stop);
      waiting.abort();
    }
  };
  const what = input.notice ? 'its teleport notice' : 'its brief';
  let notTaken: string | undefined;
  try {
    let outcome = await send();
    let delivery = deliveryOf(outcome);
    if (outcome.message.path === 'session') {
      const first = outcome.message;
      let seen = await watch([first.id]);
      // A copy the session never answered may still enter it, so a second
      // copy could reach the model twice. Only a read could prove this one.
      if (!seen.read && outcome.unanswered) {
        const why = `${child.name}'s session was pushed ${what} as message ${first.id}, but ${outcome.unanswered.replace(/\.$/, '')}, and its model did not read it and begin a turn on it within ${seconds(waitMs)} s more. A second copy could enter its session twice, so none went`;
        if (!input.notice) throw new BriefNotTaken(`${why}, the spawn failed and its pane is closed.`);
        notTaken = `${why}. Its session is offered the notice again when it next connects.`;
      } else if (!seen.read) {
        // No read came for the first copy: it may have reached the adapter
        // before the session could take a message. The record's check at the
        // end of watch() and the push below are separated only by microtasks,
        // so for a child on this machine no read lands between them. The
        // first copy leaves the replay, so a reconnect does not hand it over
        // a third time.
        outcome = await send();
        markResent(input.parentId, child.id, first.id, `its model did not read it and begin a turn on it within ${seconds(waitMs)} s (Bellwether saw ${signsSeen()}), so ${input.brief && !input.notice ? `brief ${input.brief.n}` : 'the notice'} went again as message ${outcome.message.id}`);
        delivery = { ...deliveryOf(outcome), resentFrom: first.id };
        if (outcome.message.path === 'session') {
          // A read on the first copy can still come, from a child on another
          // machine whose receipt was on its way back: it settles the brief,
          // and no third copy goes.
          seen = await watch([outcome.message.id, first.id]);
          if (!seen.read && !input.notice) throw new BriefNotTaken(`${child.name}'s ${viaLabel(first.via)} received its brief twice, as messages ${first.id} and ${outcome.message.id}, but its model did not read and begin a turn on either within ${seconds(waitMs)} s of each, so the spawn failed and its pane is closed. Of the second copy, Bellwether saw ${signsSeen()}.`);
          if (!seen.read) notTaken = `${child.name}'s ${viaLabel(first.via)} received its teleport notice twice, as messages ${first.id} and ${outcome.message.id}, but its model did not read it and begin a turn on it within ${seconds(waitMs)} s of either. Of the second copy, Bellwether saw ${signsSeen()}.`;
        } else {
          seen = {};
          if (input.notice) notTaken = `${child.name}'s model did not read its teleport notice and begin a turn on it, and the second copy found no session: ${outcome.unanswered ?? 'the session path was not available'}.`;
        }
      }
      if (seen.read) {
        delivery = { ...delivery, readAt: seen.read.at, ...(seen.read.id !== delivery.message ? { readFrom: seen.read.id } : {}) };
        // Taken only on both facts (issue #211): a read with no turn keeps its read and no takenAt.
        if (seen.turn) delivery = { ...delivery, takenAt: Date.parse(seen.read.at) > Date.parse(seen.turn) ? seen.read.at : seen.turn, takenBy: 'turn' };
        else if (input.notice) notTaken = `${child.name}'s model read its teleport notice, but herdr reported no turn on it within ${seconds(waitMs)} s. It did not go again, because a second copy would enter its session twice.`;
      }
    }
    if (input.brief) recordDelivery(input.parentId, child.id, input.brief.n, delivery);
    const note = input.brief ? deliveryNote(child, input.brief, delivery, waitMs) : delivery.takenAt ? `${child.name}'s model read its teleport notice and began a turn on it; nothing was typed into its pane.` : (notTaken ?? `${child.name} did not take its teleport notice.`);
    return { delivery, note, ...(notTaken ? { notTaken } : {}) };
  } finally {
    ended = true;
    subscription.close();
    controller.abort();
  }
}

/** The delivery a message's outcome records, before the model's sign. */
function deliveryOf(outcome: MessageOutcome): BriefDelivery {
  const message = outcome.message;
  if (message.path === 'session' && outcome.unanswered) return { path: 'session', via: message.via ?? 'session', message: message.id, at: message.at, unanswered: outcome.unanswered };
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
 * adapter "received" a message; the model "read it and began a turn on it".
 * A parent tells transport from reading by those words. A delivery recorded
 * before 0.1.10 can say only one of the two.
 */
export function deliveryNote(child: Pick<ChildRecord, 'name'>, brief: Pick<ChildBrief, 'file'>, delivery: BriefDelivery, waitMs = BRIEF_TURN_WAIT_MS): string {
  const kept = `The brief stays at ${brief.file}.`;
  if (delivery.path === 'session') {
    const settled = delivery.takenAt ?? delivery.readAt;
    const lag = settled && delivery.receivedAt ? seconds(Math.max(0, Date.parse(settled) - Date.parse(delivery.receivedAt))) : undefined;
    if (delivery.unanswered) return `${child.name}'s session was pushed its brief as message ${delivery.message}, but ${delivery.unanswered}, and its model read it and began a turn on it${lag ? ` ${lag} s later` : ''}; nothing was typed into its pane. ${kept}`;
    const readOnly = !delivery.takenBy && delivery.readAt ? `its model read it${lag && !delivery.readFrom ? ` ${lag} s later` : ''}, but herdr reported no turn on it within ${seconds(waitMs)} s; Bellwether did not send it again, because a second copy would enter its session twice` : undefined;
    const sign = delivery.takenBy === 'read' ? `its model read it${lag ? ` ${lag} s later` : ''}` : delivery.takenBy === 'turn' ? `its model ${delivery.readAt ? 'read it and ' : ''}began a turn on it${lag && !delivery.readFrom ? ` ${lag} s later` : ''}` : (readOnly ?? 'Bellwether did not see its model take it');
    if (delivery.resentFrom && delivery.readFrom) return `${child.name}'s model did not read its brief within ${seconds(waitMs)} s of its ${viaLabel(delivery.via)} receiving it as message ${delivery.resentFrom}, so Bellwether sent the brief once more as message ${delivery.message}; the read receipt for message ${delivery.readFrom} arrived after message ${delivery.message} went out, so its session holds both copies, and ${delivery.takenBy ? `its model began a turn at ${delivery.takenAt}` : 'herdr reported no turn'}. Nothing was typed into its pane. ${kept}`;
    if (delivery.resentFrom) return `${child.name}'s model did not read its brief and begin a turn on it within ${seconds(waitMs)} s of its ${viaLabel(delivery.via)} receiving its brief as message ${delivery.resentFrom}, so Bellwether sent the brief once more as message ${delivery.message}, and ${sign}; nothing was typed into its pane. ${kept}`;
    return `${child.name}'s ${viaLabel(delivery.via)} received its brief as message ${delivery.message}, and ${sign}; nothing was typed into its pane. ${kept}`;
  }
  if (delivery.path === 'launch') return `${child.name} got its brief as the first prompt on its launch line, because ${delivery.reason}. ${kept}`;
  const resent = delivery.resentFrom ? `its model did not read it and begin a turn on it within ${seconds(waitMs)} s of its session receiving message ${delivery.resentFrom}, and then ` : '';
  return `herdr typed ${child.name}'s brief into its pane as message ${delivery.message}, because ${resent}${(delivery.reason ?? '').replace(/\.$/, '')}. Bellwether cannot tell when its model read it. ${kept}`;
}

/**
 * One line for agent_list about the newest brief a child started on, and how
 * it arrived. The record keeps a delivery on each brief rather than on the
 * child, because each resume that brings a prompt adds a brief with its own
 * path (issue #189), so this line is where a reader finds it.
 */
export function describeBrief(child: Pick<ChildRecord, 'name' | 'briefs'>): string[] {
  const brief = child.briefs?.at(-1);
  if (!brief) return [];
  const delivery = brief.delivery;
  const head = `${child.name}: brief ${brief.n} at ${brief.at}`;
  if (!delivery) return [`${head}, with no delivery recorded. A start that failed, or a daemon before 0.1.8, leaves it out. The brief stays at ${brief.file}.`];
  let how: string;
  if (delivery.path === 'session') {
    const twice = delivery.resentFrom ? `, sent twice because its model did not read message ${delivery.resentFrom} and begin a turn on it` : '';
    const taken = delivery.takenBy === 'read' ? `its model read it at ${delivery.takenAt}` : delivery.takenBy === 'turn' ? `its model ${delivery.readAt ? 'read it and ' : ''}began a turn on it at ${delivery.takenAt}` : delivery.readAt ? `its model read it at ${delivery.readAt}, and herdr reported no turn on it` : 'Bellwether did not see its model take it';
    const both = delivery.readFrom ? `, and the read receipt for message ${delivery.readFrom} arrived after this copy went out, so its session holds both` : '';
    how = `into its session through its ${viaLabel(delivery.via)} as message ${delivery.message}${twice}${both}; ${taken}`;
  } else if (delivery.path === 'launch') {
    how = `as the first prompt on its launch line, because ${(delivery.reason ?? 'no reason was recorded').replace(/\.$/, '')}`;
  } else {
    how = `typed into its pane as message ${delivery.message}, because ${(delivery.reason ?? 'no reason was recorded').replace(/\.$/, '')}; Bellwether cannot tell when its model read it`;
  }
  return [`${head}, ${how}. The brief stays at ${brief.file}.`];
}
