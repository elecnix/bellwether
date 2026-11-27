// Claude Code opens on up to two dialogs before its prompt: the folder-trust
// question, and the confirmation for --dangerously-load-development-channels,
// which every Claude Code child gets so it loads the Bellwether channel. No
// setting a user can write skips the second one: Claude Code admits a channel
// without that flag only from an allowlist in managed settings, and the flag
// always asks (docs/probes.md, sections 6 and 7). So the spawn answers both,
// the way a person would, and only while it holds the child's events.
//
// The answer is driven by the child's status events. The watch opens before
// the harness starts, so the first blocked event cannot slip past it. The
// screen is read when a status arrives, and again after each key, until no
// dialog is left. An accepting option that the screen numbers is answered with
// its digit, which selects and confirms it wherever the cursor is, so a longer
// list or a cursor that starts lower cannot turn the answer into another
// option (issue #133). An option without a number is walked to with the
// arrows, and Enter goes out only once the screen shows that option selected,
// so a dialog whose shape changed fails the spawn instead of taking a stray
// Enter.
import type { HerdrClient, Subscription } from './herdr-client.ts';

/** A startup dialog's id within its harness's set, such as `trust`. */
export type StartupDialog = string;

/**
 * The startup dialogs one harness shows before its prompt, which the spawn
 * answers for the person. Each names the text that shows it and the option
 * that accepts it. A harness's registry entry carries its set.
 */
export interface StartupDialogSet {
  /** The harness's name in an error. */
  harness: string;
  dialogs: readonly { id: StartupDialog; name: string; shows: RegExp; accept: string }[];
  /** The dialog that comes last, after which the child is at its prompt. */
  last?: StartupDialog;
  /**
   * Dialogs the spawn never answers, because they grant a permission rather
   * than ask a startup question. One on screen fails the start at once, by
   * name, with what the person has to do.
   */
  refuse?: readonly { id: StartupDialog; name: string; shows: RegExp; why: string }[];
}

// Claude Code marks the selected option with ❯, and Codex with ›.
const SELECTED = /^\s*[❯›>]\s/u;

/**
 * Claude Code's two: the folder-trust question, and the development-channel
 * confirmation. The channel question numbers its options, so it takes the
 * digit 1. The trust question shows no numbers and ignores a digit (Claude
 * Code 2.1.318), so it is walked with the arrows, which is safe there because
 * Enter waits for the screen to show "Yes, I trust this folder" selected.
 */
export const CLAUDE_STARTUP: StartupDialogSet = {
  harness: 'Claude Code',
  dialogs: [
    { id: 'trust', name: 'the folder-trust question', shows: /Is this a project you created or one you trust|Accessing workspace:/, accept: 'Yes, I trust this folder' },
    { id: 'channel', name: 'the development-channel question', shows: /WARNING: Loading development channels/, accept: 'I am using this for local development' },
  ],
  last: 'channel',
};

/** What a dialog is called in a message to the person. */
export function dialogName(id: StartupDialog, set: StartupDialogSet = CLAUDE_STARTUP): string {
  return set.dialogs.find((dialog) => dialog.id === id)?.name ?? id;
}

/** herdr's statuses for a child that is past its dialogs. */
const READY = new Set(['idle', 'working', 'done']);

export function detectDialog(screen: string, set: StartupDialogSet = CLAUDE_STARTUP): StartupDialog | undefined {
  return set.dialogs.find((dialog) => dialog.shows.test(screen))?.id;
}

/** A dialog on screen that the spawn refuses to answer, or undefined. */
export function detectRefused(screen: string, set: StartupDialogSet): NonNullable<StartupDialogSet['refuse']>[number] | undefined {
  return set.refuse?.find((dialog) => dialog.shows.test(screen));
}

/** A start that stopped on a dialog Bellwether never answers. */
export class StartupDialogRefused extends Error {
  readonly dialog: StartupDialog;
  constructor(message: string, dialog: StartupDialog) {
    super(message);
    this.name = 'StartupDialogRefused';
    this.dialog = dialog;
  }
}

/**
 * The key that answers a selection list with `wanted`. When the screen numbers
 * the option, as in `1. I am using this for local development`, it is that
 * digit, which Claude Code takes as select and confirm in one key wherever
 * the cursor is. Otherwise it is the arrow that moves the selection toward
 * the option, or Enter once it is selected. Undefined when the screen shows
 * neither the option nor a selection, which happens while a dialog is still
 * drawing.
 */
export function answerKey(screen: string, wanted: string): string | undefined {
  const line = screen.split('\n').find((candidate) => candidate.includes(wanted));
  const numbered = line?.replace(SELECTED, '').match(/^\s*(\d)\.\s+(.*)$/);
  if (numbered && numbered[2]?.trim().startsWith(wanted)) return numbered[1];
  return keyToward(screen, wanted);
}

/** Whether a key from answerKey confirms the option, rather than moving toward it. */
export function confirms(key: string): boolean {
  return key === 'Enter' || /^\d$/.test(key);
}

/**
 * The arrow that moves a selection list toward `wanted`, or Enter once it is
 * selected. Undefined when the screen shows neither the option nor a
 * selection, which happens while a dialog is still drawing.
 */
export function keyToward(screen: string, wanted: string): 'Enter' | 'Up' | 'Down' | undefined {
  const lines = screen.split('\n');
  const target = lines.findIndex((line) => line.includes(wanted));
  const selected = lines.findIndex((line) => SELECTED.test(line));
  if (target < 0 || selected < 0) return undefined;
  if (target === selected) return 'Enter';
  return target < selected ? 'Up' : 'Down';
}

/** The option the selection marker is on, for an error message. */
function selectedOption(screen: string): string | undefined {
  const line = screen.split('\n').find((candidate) => SELECTED.test(candidate));
  return line?.replace(SELECTED, '').replace(/^\d+\.\s*/, '').trim() || undefined;
}

export class StartupDialogTimeout extends Error {
  readonly dialog: StartupDialog | undefined;
  constructor(message: string, dialog: StartupDialog | undefined) {
    super(message);
    this.name = 'StartupDialogTimeout';
    this.dialog = dialog;
  }
}

export interface StartupWatch {
  /**
   * Answer the dialogs, and resolve once the child is past them: no dialog on
   * screen, and either the channel confirmation answered or herdr reporting
   * the child idle, working or done. Rejects with StartupDialogTimeout when the
   * child is not past them in time, naming the screen it was on.
   */
  answer(): Promise<StartupDialog[]>;
  close(): void;
}

export interface StartupWatchOptions {
  /** How long to wait for the dialogs, and to get past them. */
  timeoutMs?: number;
  /** How long a screen takes to redraw after a key. */
  redrawMs?: number;
  /** The harness's dialogs. Claude Code's by default. */
  dialogs?: StartupDialogSet;
}

/** Open the status watch for a child whose harness shows startup dialogs. Call before agent.start. */
export async function watchStartup(client: HerdrClient, paneId: string, signal?: AbortSignal, options: StartupWatchOptions = {}): Promise<StartupWatch> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const redrawMs = options.redrawMs ?? 300;
  const set = options.dialogs ?? CLAUDE_STARTUP;
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let status = 'unknown';
  let wake: (() => void) | undefined;
  const subscription: Subscription = await client.subscribe(
    [{ type: 'pane.agent_status_changed', pane_id: paneId }],
    (event) => {
      const value = event.data['agent_status'];
      if (event.data['pane_id'] !== paneId || typeof value !== 'string') return;
      status = value;
      wake?.();
    },
    controller.signal,
  );

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Wait for the next status event, or `ms`, whichever comes first. */
  const nextStatus = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  return {
    async answer() {
      const deadline = Date.now() + timeoutMs;
      const answered: StartupDialog[] = [];
      let screen = '';
      let dialog: StartupDialog | undefined;
      while (Date.now() < deadline && !controller.signal.aborted) {
        // TODO(api): the screen is the only evidence of which startup question is
        // up, because herdr's blocked status does not name the dialog and Claude Code
        // has no API for either question. A documented flag or setting that
        // pre-answers the folder-trust and development-channel questions would retire
        // this read, as would `channelsEnabled` with `allowedChannelPlugins` in managed
        // settings for the channel question (docs/probes.md, section 7).
        screen = await client.paneRead({ paneId, source: 'visible', lines: 40 }).catch(() => screen);
        // A dialog that grants a permission is never answered, and herdr can
        // read the pane as idle while it waits, so it is checked first.
        const refused = detectRefused(screen, set);
        if (refused) throw new StartupDialogRefused(`${set.harness} in pane ${paneId} stopped on ${refused.name}, which Bellwether never answers: ${refused.why}`, refused.id);
        dialog = detectDialog(screen, set);
        if (dialog) {
          const wanted = set.dialogs.find((entry) => entry.id === dialog)?.accept ?? '';
          const key = answerKey(screen, wanted);
          if (key) {
            // TODO(api): keys typed into the pane answer a question no API reaches. A
            // documented way to pre-answer Claude Code's development-channel and
            // folder-trust questions, or a managed-settings allowlist (`channelsEnabled`,
            // `allowedChannelPlugins`) that removes the channel question, would retire them.
            await client.sendKeys(paneId, [key]);
            if (confirms(key) && !answered.includes(dialog)) answered.push(dialog);
          }
          await sleep(redrawMs);
          continue;
        }
        // The set's last dialog, Claude Code's channel confirmation, comes
        // last, so once it is answered and gone the child is at its prompt. A
        // child that never shows it is ready when herdr's status says so.
        if ((set.last !== undefined && answered.includes(set.last)) || READY.has(status)) return answered;
        // A blocked pane with no dialog on screen is still drawing it.
        await nextStatus(status === 'blocked' ? redrawMs : Math.max(0, deadline - Date.now()));
      }
      if (controller.signal.aborted) throw new Error(`the spawn was cancelled while ${set.harness} in pane ${paneId} was starting`);
      throw timeoutError(set, paneId, timeoutMs, dialog, status, screen);
    },
    close() {
      subscription.close();
      controller.abort();
    },
  };
}

function timeoutError(set: StartupDialogSet, paneId: string, timeoutMs: number, dialog: StartupDialog | undefined, status: string, screen: string): StartupDialogTimeout {
  const seconds = Math.round(timeoutMs / 1000);
  const tail = screen.trim().split('\n').slice(-12).join('\n');
  if (dialog) {
    const selected = selectedOption(screen);
    const where = selected ? `with "${selected}" selected` : 'with no option selected';
    return new StartupDialogTimeout(`${set.harness} in pane ${paneId} was still on ${dialogName(dialog, set)}, ${where}, when the spawn timed out after ${seconds} s. The screen:\n${tail}`, dialog);
  }
  return new StartupDialogTimeout(`${set.harness} in pane ${paneId} never reached its prompt before the spawn timed out after ${seconds} s: herdr reported it ${status}, on a screen Bellwether does not answer. The screen:\n${tail}`, undefined);
}
