// Claude Code opens on up to two dialogs before its prompt: the folder-trust
// question, and the confirmation for --dangerously-load-development-channels,
// which every Claude Code child gets so it loads the Bellwether channel. No
// supported setting skips the second one: Claude Code registers a `server:`
// channel only under that flag, and the flag always asks. So the spawn answers
// both, the way a person would, and only while it holds the child's events.
//
// The answer is driven by the child's status events. The watch opens before
// the harness starts, so the first blocked event cannot slip past it. The
// screen is read when a status arrives, and again after each key, until no
// dialog is left.
import type { HerdrClient, Subscription } from './herdr-client.ts';

export type StartupDialog = 'trust' | 'channel';

const TRUST = /Is this a project you created or one you trust|Accessing workspace:/;
const CHANNEL = /WARNING: Loading development channels/;
const TRUST_ACCEPT = 'Yes, I trust this folder';
const CHANNEL_ACCEPT = 'I am using this for local development';
const SELECTED = /^\s*[❯>]\s/;

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

export type StartupOutcome = 'started' | 'untrusted' | 'timeout';

export interface StartupWatch {
  /** Answer the dialogs, and resolve once the child is past them or a person has to decide. */
  answer(options: { trusted: boolean }): Promise<StartupOutcome>;
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
    async answer({ trusted }) {
      const deadline = Date.now() + timeoutMs;
      let channelAnswered = false;
      while (Date.now() < deadline && !controller.signal.aborted) {
        const screen = await client.paneRead({ paneId, source: 'visible', lines: 40 }).catch(() => '');
        const dialog = detectDialog(screen);
        if (dialog === 'trust' && !trusted) return 'untrusted';
        if (dialog) {
          const key = keyToward(screen, dialog === 'trust' ? TRUST_ACCEPT : CHANNEL_ACCEPT);
          if (key) {
            await client.sendKeys(paneId, [key]);
            if (dialog === 'channel' && key === 'Enter') channelAnswered = true;
          }
          await sleep(redrawMs);
          continue;
        }
        // Every Claude Code child loads the Bellwether channel, so its
        // confirmation always comes, and it is the last of the two. Once it is
        // answered and gone, anything else on screen is the watcher's to report.
        if (channelAnswered) return 'started';
        // A blocked pane with no dialog on screen is still drawing it.
        await nextStatus(status === 'blocked' ? redrawMs : Math.max(0, deadline - Date.now()));
      }
      return 'timeout';
    },
    close() {
      subscription.close();
      controller.abort();
    },
  };
}
