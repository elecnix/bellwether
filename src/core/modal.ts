// A modal dialog on a child's screen, named in one short line. The watcher
// calls this before it tells a parent that a child went idle, because a
// harness waiting on a dialog can read as idle to herdr: pi reports `blocked`
// to herdr only on herdr's own event, and an extension's confirm dialog never
// raises it. The line lets a parent tell a trust question from a permission
// question without reading the whole screen.
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
 * A screen in its two views: `plain` holds every character, and `content`
 * holds the same lines with faint text blanked (src/core/screen.ts). A bare
 * string is both.
 */
export type ModalView = string | { plain: string; content: string };

/**
 * The one-line name of the modal dialog at the bottom of `screen`, or
 * undefined when the screen shows none. A dialog is either a selection list
 * with at least two aligned options, one of them marked, or a question that
 * asks for y/n. The name is the dialog's first line and its question, when
 * they differ, cut to MODAL_LINE_LIMIT.
 *
 * The selection marker and the y/n question must be drawn solid: a faint one
 * is a suggestion in an input box, such as Claude Code's, and not a question
 * the screen asks. The other options and the header may be faint, because a
 * dialog often dims the options it has not selected.
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
    const before = plain[index - 1] ?? '';
    const after = plain[index + 1] ?? '';
    if (!isOption(before, column) && !isOption(after, column)) continue;
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
