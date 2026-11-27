// A start hands its child the brief as a message (issue #162). The harness
// starts with no brief on its launch line. Once herdr detects it and its
// startup dialogs are answered, the brief goes through the child's own
// Bellwether adapter, the same path agent_send takes, and the start waits for
// that adapter to acknowledge it. The acknowledgement is the proof that the
// child is alive and holds its task.
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
import { messageChild, type Inbox } from './send.ts';
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
  const subscription = await herdr.subscribe(
    [
      { type: 'pane.agent_detected', pane_id: child.paneId },
      { type: 'pane.exited', pane_id: child.paneId },
    ],
    (event) => {
      if (ended || event.data['pane_id'] !== child.paneId) return;
      if (event.event === 'pane_exited' || event.event === 'pane.exited' || event.data['released'] === true) {
        ended = true;
        void failed('before its session took the brief').then(rejectGone);
      }
    },
    controller.signal,
  );
  try {
    const outcome = await messageChild({
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
    const message = outcome.message;
    const delivery: BriefDelivery =
      message.path === 'session'
        ? { path: 'session', via: message.via ?? 'session', message: message.id, at: message.at }
        : { path: 'keystrokes', reason: message.reason ?? 'the session path was not available', message: message.id, at: message.at };
    recordDelivery(input.parentId, child.id, input.brief.n, delivery);
    return { delivery, note: deliveryNote(child, input.brief, delivery) };
  } finally {
    ended = true;
    subscription.close();
    controller.abort();
  }
}

/** Put a brief's delivery on its entry in the child record. */
export function recordDelivery(parentId: string, childId: string, n: number, delivery: BriefDelivery): void {
  updateChild(parentId, childId, (entry) => {
    const found = entry.briefs?.find((brief) => brief.n === n);
    if (found) found.delivery = delivery;
  });
}

const VIA_LABEL: Record<string, string> = {
  'claude-channel': 'its Bellwether channel',
  'pi-message': 'its Bellwether pi extension',
};

/** What a start's reply says about how the brief reached the child. */
export function deliveryNote(child: Pick<ChildRecord, 'name'>, brief: Pick<ChildBrief, 'file'>, delivery: BriefDelivery): string {
  if (delivery.path === 'session') return `${child.name}'s session took its brief as message ${delivery.message}, through ${VIA_LABEL[delivery.via ?? ''] ?? delivery.via}; nothing was typed into its pane. The brief stays at ${brief.file}.`;
  if (delivery.path === 'launch') return `${child.name} got its brief as the first prompt on its launch line, because ${delivery.reason}. The brief stays at ${brief.file}.`;
  return `herdr typed ${child.name}'s brief into its pane as message ${delivery.message}, because ${(delivery.reason ?? '').replace(/\.$/, '')}. Bellwether cannot tell when its model read it. The brief stays at ${brief.file}.`;
}
