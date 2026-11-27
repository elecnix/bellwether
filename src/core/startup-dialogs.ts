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
import type { ModalView } from './modal.ts';
import { BLANK_SCREEN, type Screen } from './screen.ts';
import type { DialogDecision } from './types.ts';

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
  dialogs: readonly KnownDialog[];
  /** The dialog that comes last, after which the child is at its prompt. */
  last?: StartupDialog;
  /**
   * Dialogs the spawn never answers, because they grant a permission rather
   * than ask a startup question. One on screen fails the start at once, by
   * name, with what the person has to do.
   */
  refuse?: readonly { id: StartupDialog; name: string; shows: RegExp; why: string }[];
}

/** One dialog the spawn and the watcher answer, and the option they choose. */
export interface KnownDialog {
  id: StartupDialog;
  name: string;
  shows: RegExp;
  /** The option chosen: the first of these labels that the screen lists. */
  accept: string | readonly string[];
  /**
   * What the answer decided, for a dialog the parent must hear about. A
   * dialog with this field goes on the child's record as a decision, and the
   * parent's next event about the child names it. The startup questions
   * every Claude Code child gets have none: their answer is the same each time.
   */
  decides?: string;
  /** Whether the answer refuses what the child asked: a decision's `outcome`. Accepted by default. */
  outcome?: DialogDecision['outcome'];
  /** Whether the dialog asks about a path, which the decision then keeps. */
  names?: 'path';
}

// Claude Code marks the selected option with ❯, and Codex with ›.
const SELECTED = /^\s*[❯›>]\s/u;

/**
 * Claude Code's startup questions, the folder-trust question and the
 * development-channel confirmation, and two questions it asks while it works,
 * each answered No. The launch settings give the child the Bellwether home as
 * a working directory (src/core/claude-hooks.ts), so a read there never asks:
 * a read question is for a path beyond what the spawn gave, and Bellwether
 * declines it with the answer that saves nothing to the operator's settings.
 * Claude Code asks it only on a machine that has not settled such reads
 * already, so on other machines no read question comes and nothing is declined.
 * Claude Code asks a person to approve a shell command it cannot prove free of
 * a dangerous rm, and Bellwether never approves a command for the operator, so
 * it declines that one too. The child hears No, as if a person had chosen it,
 * and the parent hears what was declined in its next event about the child.
 * A numbered option takes its digit. The trust question shows no numbers and
 * ignores a digit (Claude Code 2.1.318), so it is walked with the arrows,
 * which is safe there because Enter waits for the screen to show "Yes, I
 * trust this folder" selected.
 */
export const CLAUDE_STARTUP: StartupDialogSet = {
  harness: 'Claude Code',
  dialogs: [
    { id: 'trust', name: 'the folder-trust question', shows: /Is this a project you created or one you trust|Accessing workspace:/, accept: 'Yes, I trust this folder' },
    { id: 'channel', name: 'the development-channel question', shows: /WARNING: Loading development channels/, accept: 'I am using this for local development' },
    {
      id: 'outside-read',
      name: 'the question about a read outside the working directories',
      shows: /Allow this read outside the working directories\?/,
      accept: 'No, and ask again next time',
      decides: 'declined the read, which is outside the directories its launch allowed, and saved nothing to the settings',
      outcome: 'declined',
      names: 'path',
    },
    {
      id: 'dangerous-rm',
      name: 'the dangerous-rm question',
      shows: /Dangerous rm operation/,
      accept: ['No, and tell Claude what to do differently', 'No'],
      decides: 'declined the shell command, which Claude Code could not prove safe and asks a person to approve',
      outcome: 'declined',
    },
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

/** A start that stopped on a question no entry in the harness's set names. */
export class StartupDialogUnknown extends Error {
  readonly question: string;
  constructor(message: string, question: string) {
    super(message);
    this.name = 'StartupDialogUnknown';
    this.question = question;
  }
}

/** A numbered option line, selected or not, as Claude Code and Codex draw a choice. */
const OPTION = /^\s*(?:[❯›>]\s*)?\d+\.\s+\S/u;
/** The frame characters around a dialog's text. */
const FRAME = /^[\s│┃|╭╮╰╯─]+|[\s│┃|╭╮╰╯─]+$/gu;

/**
 * The question a dialog on screen asks: the nearest line above its first
 * numbered option that ends with a question mark. Undefined when the screen
 * shows no numbered option under a question, which is how a prompt, a
 * working child and a dialog still drawing look.
 */
export function dialogQuestion(screen: string): string | undefined {
  const lines = screen.split('\n').map(unframed);
  const first = lines.findIndex((line) => OPTION.test(line));
  if (first < 0) return undefined;
  return lines
    .slice(0, first)
    .reverse()
    .find((line) => line.endsWith('?'));
}

/** A screen line without the frame drawn around a dialog. */
function unframed(line: string): string {
  return line.replace(FRAME, '');
}

/**
 * The path a dialog asks about: the argument of the tool call it shows, such
 * as `Read(/srv/other/eslint.config.js)`, or failing that the first line that
 * holds only an absolute path. Undefined when the screen shows neither.
 */
export function dialogPath(screen: string): string | undefined {
  const call = /\b[A-Z][A-Za-z]*\((\/[^)\n]*)\)/.exec(screen)?.[1];
  if (call) return call.trim();
  return screen
    .split('\n')
    .map(unframed)
    .find((line) => /^\/\S+$/.test(line));
}

/** The label among `accept` that the screen lists as an option, or the first one. */
function chosenLabel(screen: string, accept: KnownDialog['accept']): string {
  const labels = typeof accept === 'string' ? [accept] : accept;
  return labels.find((label) => optionLine(screen.split('\n'), label) >= 0) ?? labels[0] ?? '';
}

/**
 * The index of the option line that starts with `label`, or -1. On a screen
 * with numbered options only a numbered line counts, so the dialog's own text
 * never does. Claude Code's folder-trust question numbers none.
 */
function optionLine(lines: readonly string[], label: string): number {
  const numbered = lines.some((line) => OPTION.test(unframed(line)));
  return lines.findIndex((line) => {
    const text = unframed(line);
    if (numbered && !OPTION.test(text)) return false;
    return text.replace(/^[❯›>]\s*/u, '').replace(/^\d+\.\s*/, '').startsWith(label);
  });
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
export function answerKey(screen: ModalView, wanted: string): string | undefined {
  const lines = views(screen).plain.split('\n');
  const at = optionLine(lines, wanted);
  const digit = at >= 0 ? /^(?:[❯›>]\s*)?(\d)\.\s/u.exec(unframed(lines[at] ?? ''))?.[1] : undefined;
  return digit ?? keyToward(screen, wanted);
}

/** Both views of a screen; a bare string is both. */
function views(screen: ModalView): { plain: string; content: string } {
  return typeof screen === 'string' ? { plain: screen, content: screen } : screen;
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
export function keyToward(screen: ModalView, wanted: string): 'Enter' | 'Up' | 'Down' | undefined {
  const { plain, content } = views(screen);
  // An option line, not any line that mentions the label: a dialog's own
  // text can hold a word such as "No". The option may be drawn faint, as a
  // dialog dims the options it has not selected, but the selection marker
  // must be solid: a faint marker is a suggestion, and Enter on it would
  // answer a question nobody chose an answer to.
  const target = optionLine(plain.split('\n'), wanted);
  const selected = content.split('\n').findIndex((line) => SELECTED.test(line));
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
  /**
   * The answers that decided something the parent must hear about, in the
   * order given: each names the question, the option chosen and the keys sent.
   */
  readonly decisions: DialogDecision[];
  close(): void;
}

export interface StartupWatchOptions {
  /** How long to wait for the dialogs, and to get past them. */
  timeoutMs?: number;
  /** How long a screen takes to redraw after a key. */
  redrawMs?: number;
  /** The harness's dialogs. Claude Code's by default. */
  dialogs?: StartupDialogSet;
  /** Who answers, for the decision record. */
  by?: DialogDecision['by'];
  /**
   * Called as each decision's Enter goes out, before the child moves on, so
   * the record holds the decision before any event the answer causes.
   */
  onDecision?: (decision: DialogDecision) => void;
}

/** How many reads in a row must show the same unknown question before the start fails on it. */
const UNKNOWN_READS = 3;

/** Open the status watch for a child whose harness shows startup dialogs. Call before agent.start. */
export async function watchStartup(client: HerdrClient, paneId: string, signal?: AbortSignal, options: StartupWatchOptions = {}): Promise<StartupWatch> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const redrawMs = options.redrawMs ?? 300;
  const set = options.dialogs ?? CLAUDE_STARTUP;
  const by = options.by ?? 'spawn';
  const decisions: DialogDecision[] = [];
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
    decisions,
    async answer() {
      const deadline = Date.now() + timeoutMs;
      const answered: StartupDialog[] = [];
      let screen = '';
      let read: Screen = BLANK_SCREEN;
      let dialog: StartupDialog | undefined;
      let unknown: { question: string; reads: number } | undefined;
      /** The decision whose keys are going out, until its Enter. */
      let pending: DialogDecision | undefined;
      while (Date.now() < deadline && !controller.signal.aborted) {
        // TODO(api): the screen is the only evidence of which startup question is
        // up, because herdr's blocked status does not name the dialog and Claude Code
        // has no API for either question. A documented flag or setting that
        // pre-answers the folder-trust and development-channel questions would retire
        // this read, as would `channelsEnabled` with `allowedChannelPlugins` in managed
        // settings for the channel question (docs/probes.md, section 7).
        // Whether a question is up is decided on every line, faint or not, and
        // only then which option answers it: answerKey presses Enter only on a
        // solid selection marker, so a faint line never counts as an answer.
        read = await client.paneRead({ paneId, source: 'visible', lines: 40 }).catch(() => read);
        screen = read.plain;
        // A dialog that grants a permission is never answered, and herdr can
        // read the pane as idle while it waits, so it is checked first.
        const refused = detectRefused(screen, set);
        if (refused) throw new StartupDialogRefused(`${set.harness} in pane ${paneId} stopped on ${refused.name}, which Bellwether never answers: ${refused.why}`, refused.id);
        dialog = detectDialog(screen, set);
        if (dialog) {
          unknown = undefined;
          const known = set.dialogs.find((entry) => entry.id === dialog);
          const wanted = known ? chosenLabel(screen, known.accept) : '';
          const key = answerKey(read, wanted);
          if (key) {
            // TODO(api): keys typed into the pane answer a question no API reaches. A
            // documented way to pre-answer Claude Code's development-channel and
            // folder-trust questions, or a managed-settings allowlist (`channelsEnabled`,
            // `allowedChannelPlugins`) that removes the channel question, would retire them.
            // The read and dangerous-rm questions reach a PermissionRequest hook, but its
            // input names only the tool, not why Claude Code asks, so a hook cannot tell
            // them from a question the operator owns: a reason field there would retire
            // these keys too.
            await client.sendKeys(paneId, [key]);
            if (known?.decides) {
              // Every key goes on the record, so the parent learns exactly what was typed.
              const asked = known.names === 'path' ? dialogPath(screen) : undefined;
              pending ??= { dialog: known.id, name: known.name, question: dialogQuestion(screen) ?? known.name, answer: wanted, decided: known.decides, keys: [], at: '', by, outcome: known.outcome ?? 'accepted', ...(asked ? { path: asked } : {}) };
              pending.keys.push(key);
            }
            if (confirms(key)) {
              if (!answered.includes(dialog)) answered.push(dialog);
              // The answer is complete. The same question asked again is a decision of its own.
              if (pending) {
                const decision = { ...pending, at: new Date().toISOString() };
                decisions.push(decision);
                options.onDecision?.(decision);
              }
              pending = undefined;
            }
          }
          await sleep(redrawMs);
          continue;
        }
        // The set's last dialog, Claude Code's channel confirmation, comes
        // last, so once it is answered and gone the child is at its prompt. A
        // child that never shows it is ready when herdr's status says so.
        if ((set.last !== undefined && answered.includes(set.last)) || READY.has(status)) return answered;
        // A question no entry names fails the start by name rather than wait
        // for a person: once it holds still for a few reads, it is a dialog
        // and not one being drawn.
        const question = status === 'blocked' ? dialogQuestion(screen) : undefined;
        unknown = question ? { question, reads: unknown?.question === question ? unknown.reads + 1 : 1 } : undefined;
        if (unknown && unknown.reads >= UNKNOWN_READS) throw unknownError(set, paneId, unknown.question, screen);
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

function unknownError(set: StartupDialogSet, paneId: string, question: string, screen: string): StartupDialogUnknown {
  const tail = screen.trim().split('\n').slice(-12).join('\n');
  const known = set.dialogs.map((dialog) => dialog.name).join(', ');
  return new StartupDialogUnknown(`${set.harness} in pane ${paneId} stopped on a question Bellwether does not know: "${question}". Bellwether answers only ${known}, so it ended the start rather than leave the question for a person. The screen:\n${tail}`, question);
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
