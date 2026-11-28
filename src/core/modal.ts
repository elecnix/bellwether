// A modal dialog on a child's screen, named in one short line. The watcher
// calls this before it tells a parent that a child went idle, because a
// harness waiting on a dialog can read as idle to herdr: pi reports `blocked`
// to herdr only on herdr's own event, and an extension's confirm dialog never
// raises it. The line lets a parent tell a trust question from a permission
// question without reading the whole screen.
//
// What counts as a dialog is one rule, shared with the herdr skill's
// herdr-box-state.sh (issue #164): a dialog is a question with its options
// under it, and either a solid selection marker or a y/n prompt. A numbered
// selection needs another numbered option lined up with it. An unnumbered
// selection needs an option on the line before or after it, and a confirm or
// cancel hint under the list. Anything else is not a dialog, whatever it
// looks like: two lines typed into an input box line up like options, but
// they have no number and no hint. A screen this module calls a dialog has no
// input box (src/core/screen.ts), so a draft read as a dialog would vanish
// from agent_read and turn a finished turn into a blocked event.
//
// This module only reads text. Nothing here, nor in the watcher path that
// calls it, answers a dialog: approving a permission question is the
// operator's decision, not Bellwether's.

/** The longest line a parent gets for a dialog. */
export const MODAL_LINE_LIMIT = 100;

/** How many lines from the bottom of the screen a dialog may start. */
const WINDOW = 24;
/** A selection marker, then the text of the option it is on. */
const SELECTED = /^(\s*)([❯›→>])(\s+)(\S.*)$/u;
/** A question that takes a typed yes or no. */
const YES_NO = /\[(?:y\/n|Y\/n|y\/N)\]|\((?:y\/n|Y\/n|y\/N|yes\/no)\)/;
/** A horizontal rule or box edge, which closes the dialog above it. */
const RULE = /^[\s─━═╭╮╰╯┌┐└┘-]{3,}$/u;
/** A box's side borders, which are not part of the text. */
const BORDER = /^\s*[│┃]\s?|\s?[│┃]\s*$/gu;
/** A numbered option's text, such as `1. Yes` or `2) No`. */
const NUMBERED = /^\d+[.)]\s/;
/**
 * A key hint that confirms or cancels a selection, as a list draws it under
 * its options: Claude Code's `Enter to confirm · Esc to cancel`, pi's `enter
 * select  esc cancel`.
 */
const HINT = /\b(?:enter|return)\b(?: to)? (?:confirm|select|submit|choose)|\besc(?:ape)?\b(?: to)? (?:cancel|exit|go back|dismiss)/i;
/** How far a numbered option may sit from the selected one, past a description under each option. */
const NUMBERED_REACH = 12;
/** How far under the selected option an unnumbered list's hint may sit. */
const HINT_REACH = 8;

function clip(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > MODAL_LINE_LIMIT ? `${flat.slice(0, MODAL_LINE_LIMIT - 1)}…` : flat;
}

/** Whether `line` is an unselected option aligned with the selected one's text. */
function isOption(line: string, column: number): boolean {
  const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
  return indent === column && /^[\p{L}\p{N}]/u.test(line.slice(column));
}

/**
 * Whether the marked line at `at`, whose text `text` starts at `column`, is
 * the selected option of a list, by the rule at the top of this module.
 */
function isSelection(lines: string[], at: number, column: number, text: string): boolean {
  if (NUMBERED.test(text)) {
    for (const step of [-1, 1]) {
      for (let index = at + step; index >= 0 && index < lines.length && Math.abs(index - at) <= NUMBERED_REACH; index += step) {
        const line = lines[index] ?? '';
        if (RULE.test(line)) break;
        if (isOption(line, column) && NUMBERED.test(line.slice(column))) return true;
      }
    }
    return false;
  }
  if (!isOption(lines[at - 1] ?? '', column) && !isOption(lines[at + 1] ?? '', column)) return false;
  return lines.slice(at + 1, at + 1 + HINT_REACH).some((line) => HINT.test(line));
}

/**
 * A screen in its two views: `plain` holds every character, and `content`
 * holds the same lines with faint text blanked (src/core/screen.ts). A bare
 * string is both.
 */
export type ModalView = string | { plain: string; content: string };

/**
 * The one-line name of the modal dialog at the bottom of `screen`, or
 * undefined when the screen shows none. A dialog is a question that asks for
 * y/n, or a question above a selection list: a marked numbered option with
 * another numbered option lined up with it, or a marked option with one
 * lined up beside it and a confirm or cancel hint under the list. The name
 * is the dialog's first line and its question, when they differ, cut to
 * MODAL_LINE_LIMIT. A list with no text above it, only a rule, asks no
 * question and is no dialog.
 *
 * The selection marker and the y/n question must be drawn solid: a faint one
 * is a suggestion in an input box, such as Claude Code's, and not a question
 * the screen asks. The other options, the hint and the header may be faint,
 * because a dialog often dims what it has not selected.
 */
export function detectModal(screen: ModalView): string | undefined {
  const view = typeof screen === 'string' ? { plain: screen, content: screen } : screen;
  const split = (text: string): string[] => text.split('\n').map((line) => line.replace(BORDER, '').trimEnd());
  let plainAll = split(view.plain);
  let solidAll = split(view.content);
  while (plainAll.length && !plainAll[plainAll.length - 1]?.trim()) plainAll.pop();
  solidAll = solidAll.slice(0, plainAll.length);
  const plain = plainAll.slice(-WINDOW);
  const solid = solidAll.slice(-WINDOW);
  if (!plain.length) return undefined;

  const tail = solid.filter((line) => line.trim()).slice(-4);
  const yesNo = tail.find((line) => YES_NO.test(line));
  if (yesNo) return clip(yesNo);

  for (let index = solid.length - 1; index >= 0; index -= 1) {
    const match = SELECTED.exec(solid[index] ?? '');
    if (!match) continue;
    const column = (match[1]?.length ?? 0) + (match[2]?.length ?? 0) + (match[3]?.length ?? 0);
    if (!isSelection(plain, index, column, match[4] ?? '')) continue;
    let first = index;
    while (first > 0 && isOption(plain[first - 1] ?? '', column)) first -= 1;
    return nameAbove(plain, first);
  }
  return undefined;
}

/** The dialog's first line and its question, from the lines above its options. */
function nameAbove(lines: string[], firstOption: number): string | undefined {
  let start = 0;
  for (let index = firstOption - 1; index >= 0; index -= 1) {
    if (RULE.test(lines[index] ?? '')) {
      start = index + 1;
      break;
    }
  }
  const text = lines.slice(start, firstOption).map((line) => line.trim()).filter(Boolean);
  const header = text[0];
  if (!header) return undefined;
  const question = [...text].reverse().find((line) => line.includes('?'));
  if (!question || question === header) return clip(header);
  return clip(`${header.replace(/:\s*$/, '')}: ${question}`);
}
