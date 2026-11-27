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
// dialog is left. A key goes out only toward the accepting option, and Enter
// only once the screen shows that option selected, so a dialog whose shape
// changed fails the spawn instead of taking a stray Enter.
import type { HerdrClient, Subscription } from './herdr-client.ts';

export type StartupDialog = 'trust' | 'channel';

const TRUST = /Is this a project you created or one you trust|Accessing workspace:/;
const CHANNEL = /WARNING: Loading development channels/;
const TRUST_ACCEPT = 'Yes, I trust this folder';
const CHANNEL_ACCEPT = 'I am using this for local development';
const SELECTED = /^\s*[❯>]\s/;

/** What each dialog is called in a message to the person. */
export const DIALOG_NAMES: Record<StartupDialog, string> = {
  trust: 'the folder-trust question',
  channel: 'the development-channel question',
};

/** herdr's statuses for a child that is past its dialogs. */
const READY = new Set(['idle', 'working', 'done']);

export function detectDialog(screen: string): StartupDialog | undefined {
  if (TRUST.test(screen)) return 'trust';
  if (CHANNEL.test(screen)) return 'channel';
  return undefined;
}

/**
 * The key that moves a selection list toward `wanted`, or confirms it once it
 * is selected. Undefined when the screen shows neither the option nor a
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
}

/** Open the status watch for a Claude Code child. Call before agent.start. */
export async function watchStartup(client: HerdrClient, paneId: string, signal?: AbortSignal, options: StartupWatchOptions = {}): Promise<StartupWatch> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const redrawMs = options.redrawMs ?? 300;
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
        screen = await client.paneRead({ paneId, source: 'visible', lines: 40 }).catch(() => screen);
        dialog = detectDialog(screen);
        if (dialog) {
          const key = keyToward(screen, dialog === 'trust' ? TRUST_ACCEPT : CHANNEL_ACCEPT);
          if (key) {
            await client.sendKeys(paneId, [key]);
            if (key === 'Enter' && !answered.includes(dialog)) answered.push(dialog);
          }
          await sleep(redrawMs);
          continue;
        }
        // The channel confirmation comes last, so once it is answered and gone
        // the child is at its prompt. A child started with no development
        // channel never shows it, and herdr's status says when it is ready.
        if (answered.includes('channel') || READY.has(status)) return answered;
        // A blocked pane with no dialog on screen is still drawing it.
        await nextStatus(status === 'blocked' ? redrawMs : Math.max(0, deadline - Date.now()));
      }
      if (controller.signal.aborted) throw new Error(`the spawn was cancelled while Claude Code in pane ${paneId} was starting`);
      throw timeoutError(paneId, timeoutMs, dialog, status, screen);
    },
    close() {
      subscription.close();
      controller.abort();
    },
  };
}

function timeoutError(paneId: string, timeoutMs: number, dialog: StartupDialog | undefined, status: string, screen: string): StartupDialogTimeout {
  const seconds = Math.round(timeoutMs / 1000);
  const tail = screen.trim().split('\n').slice(-12).join('\n');
  if (dialog) {
    const selected = selectedOption(screen);
    const where = selected ? `with "${selected}" selected` : 'with no option selected';
    return new StartupDialogTimeout(`Claude Code in pane ${paneId} was still on ${DIALOG_NAMES[dialog]}, ${where}, when the spawn timed out after ${seconds} s. The screen:\n${tail}`, dialog);
  }
  return new StartupDialogTimeout(`Claude Code in pane ${paneId} never reached its prompt before the spawn timed out after ${seconds} s: herdr reported it ${status}, on a screen Bellwether does not answer. The screen:\n${tail}`, undefined);
}
