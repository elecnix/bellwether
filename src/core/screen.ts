// A pane's screen as herdr draws it, with the styling that tells typed text
// from a suggestion.
//
// Claude Code draws a suggested next message in its input box in faint text
// (SGR 2), and Codex draws its composer placeholder the same way. herdr's
// `pane.read` in its text format drops the styling, so a suggestion and a
// draft somebody typed read as the same string. Bellwether reads every pane
// in herdr's ANSI format and keeps faint text out of what it treats as
// content: a faint line is never a dialog, an answer, a draft or a quote.
//
// The rule follows the herdr skill's `herdr-box-state.sh`: faint text is a
// suggestion, whatever it says. No harness is named here, and a harness that
// draws nothing faint never produces GHOST.

/** One run of characters that share a style. */
export interface ScreenRun {
  text: string;
  faint: boolean;
  reverse: boolean;
}

/** What a harness's input box holds: nothing, a suggestion it drew faint, or text somebody typed. */
export type BoxState = 'EMPTY' | 'GHOST' | 'DRAFT';

export interface InputBox {
  state: BoxState;
  /** The typed text for DRAFT. Empty for EMPTY and GHOST, so a suggestion's words never travel. */
  text: string;
}

export interface Screen {
  /** Whether herdr returned the styling. Without it, faint text cannot be told from content. */
  readonly styled: boolean;
  /** Each line's styled runs. */
  readonly lines: readonly (readonly ScreenRun[])[];
  /**
   * The screen as content: every faint character replaced by a space, so
   * columns still line up, and each line's trailing space trimmed. Dialog
   * detection, start checks and quotes read this view.
   */
  readonly content: string;
  /**
   * What the input box holds. Undefined when the screen shows no box, when a
   * dialog covers it, or when the screen came without its styling and the box
   * holds text, which could be either a suggestion or a draft.
   */
  readonly box: InputBox | undefined;
}

/** A screen with nothing on it, for a read that failed. */
export const BLANK_SCREEN: Screen = { styled: true, lines: [], content: '', box: undefined };

// CSI: ESC [ params intermediates final. OSC: ESC ] ... BEL or ST. Other ESC x pairs.
const ESCAPE = /\u001b(?:\[([0-9;:?<=>]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

interface Style {
  faint: boolean;
  reverse: boolean;
}

/**
 * Apply one SGR sequence's parameters to `style`. Extended colours (38, 48
 * and 58, with `;5;n` or `;2;r;g;b`) consume their arguments, so the 2 in
 * `38;2;153;153;153` never reads as faint.
 */
function applySgr(params: string, style: Style): void {
  if (params === '') {
    style.faint = false;
    style.reverse = false;
    return;
  }
  const parts = params.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    // A colon-separated colour, such as 38:2::153:153:153, is one parameter.
    const code = Number(part.split(':')[0] || '0');
    if (code === 38 || code === 48 || code === 58) {
      if (part.includes(':')) continue;
      const mode = Number(parts[index + 1]);
      index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
      continue;
    }
    if (code === 0) {
      style.faint = false;
      style.reverse = false;
    } else if (code === 2) style.faint = true;
    else if (code === 22) style.faint = false;
    else if (code === 7) style.reverse = true;
    else if (code === 27) style.reverse = false;
  }
}

/** Split an ANSI stream into lines of styled runs. Style carries across lines, as on a terminal. */
export function parseRuns(ansi: string): ScreenRun[][] {
  const style: Style = { faint: false, reverse: false };
  return ansi
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((raw) => {
      const runs: ScreenRun[] = [];
      const push = (text: string): void => {
        const clean = text.replace(/[\r\u0000-\u0008\u000b-\u001f\u007f]/g, '');
        if (!clean) return;
        const last = runs[runs.length - 1];
        if (last && last.faint === style.faint && last.reverse === style.reverse) last.text += clean;
        else runs.push({ text: clean, faint: style.faint, reverse: style.reverse });
      };
      let at = 0;
      for (const match of raw.matchAll(ESCAPE)) {
        push(raw.slice(at, match.index));
        at = match.index + match[0].length;
        if (match[2] === 'm' && match[1] !== undefined) applySgr(match[1], style);
      }
      push(raw.slice(at));
      return runs;
    });
}

function lineText(runs: readonly ScreenRun[], blankFaint: boolean): string {
  return runs.map((run) => (blankFaint && run.faint ? ' '.repeat([...run.text].length) : run.text)).join('');
}

/** A Claude Code (U+276F) or Codex (U+203A) prompt glyph. */
const GLYPH = /[❯›]/u;
/** A horizontal rule of U+2500, which pi draws above and below its editor. */
const RULE = /^─{3}/u;
/**
 * Footer hints that reuse the prompt glyph and are not the box, as
 * herdr-box-state.sh lists them. These locate the box; they say nothing
 * about whether its text is a suggestion.
 */
const FOOTER_HINT = /^(?:Press up to edit queued|ctrl\+enter to send now|paste again to expand)/;

/** Text and faint text after the glyph on one line, or undefined when the line has no glyph. */
function afterGlyph(runs: readonly ScreenRun[]): { solid: string; faint: string } | undefined {
  let seen = false;
  let solid = '';
  let faint = '';
  for (const run of runs) {
    let text = run.text;
    if (!seen) {
      const at = text.search(GLYPH);
      if (at < 0) continue;
      seen = true;
      text = text.slice(at + 1);
    }
    if (run.faint) faint += text;
    else solid += text;
  }
  return seen ? { solid: solid.trim(), faint: faint.trim() } : undefined;
}

function classify(solid: string, faint: string): InputBox {
  if (solid) return { state: 'DRAFT', text: solid };
  if (faint) return { state: 'GHOST', text: '' };
  return { state: 'EMPTY', text: '' };
}

/**
 * The input box, found the way herdr-box-state.sh finds it. For a glyph
 * prompt, it is the last line that starts with the glyph, since earlier ones
 * are past messages. For pi, which has no glyph, it is the lines between the
 * last two rules, when its editor's cursor, one reverse-video cell, sits
 * there. Typed text makes DRAFT even beside faint text; only a box whose
 * every character is faint is GHOST.
 */
export function inputBox(lines: readonly (readonly ScreenRun[])[]): InputBox | undefined {
  const plain = lines.map((runs) => lineText(runs, false));
  const rules = plain.flatMap((line, index) => (RULE.test(line) ? [index] : []));
  const lastRule = rules[rules.length - 1];
  const priorRule = rules[rules.length - 2];
  if (lastRule !== undefined && priorRule !== undefined && lastRule - priorRule >= 2) {
    const box = lines.slice(priorRule + 1, lastRule);
    if (!box.some((runs) => GLYPH.test(lineText(runs, false).trimStart().slice(0, 1)))) {
      // Without the cursor the box holds stray output over an editor pi last drew empty.
      if (!box.some((runs) => runs.some((run) => run.reverse))) return { state: 'EMPTY', text: '' };
      const solid = box.map((runs) => lineText(runs, true).trim()).filter(Boolean).join(' ');
      const faint = box.map((runs) => runs.filter((run) => run.faint).map((run) => run.text).join('').trim()).filter(Boolean).join(' ');
      return classify(solid, faint);
    }
  }
  let found: InputBox | undefined;
  for (const runs of lines) {
    if (!/^\s*[❯›]/u.test(lineText(runs, false))) continue;
    const after = afterGlyph(runs);
    if (!after) continue;
    if (FOOTER_HINT.test(after.solid) || FOOTER_HINT.test(after.faint)) continue;
    found = classify(after.solid, after.faint);
  }
  return found;
}

/**
 * Parse a pane read. `format` is the one herdr's answer names: a server that
 * ignored the request for ANSI answers `text`, and then the screen has no
 * styling to read, so its box is known only when empty.
 */
export function parseScreen(text: string, format: string | undefined, coversBox: (content: string) => boolean = () => false): Screen {
  const styled = format === 'ansi';
  const lines = parseRuns(styled ? text : text.replace(/\u001b/g, ''));
  const content = lines.map((runs) => lineText(runs, true).trimEnd()).join('\n');
  let box = coversBox(content) ? undefined : inputBox(lines);
  if (!styled && box && box.state !== 'EMPTY') box = undefined;
  return { styled, lines, content, box };
}

/** The one line that tells a reader what the input box holds. */
export function boxLine(screen: Screen): string | undefined {
  const box = screen.box;
  if (!box) {
    if (screen.styled || !inputBox(screen.lines)) return undefined;
    return 'Input box: unknown. herdr returned this screen without its styling, so its text could be a suggestion the harness drew or a draft somebody typed.';
  }
  if (box.state === 'EMPTY') return 'Input box: EMPTY.';
  if (box.state === 'GHOST') return 'Input box: GHOST. The harness shows a suggestion there in faint text. Nobody typed it, so it is left out of this screen.';
  return 'Input box: DRAFT. The text on its line was typed there and not sent.';
}

/**
 * The screen for a person or a parent to read: its content, with faint text
 * left out, and a last line that says what the input box holds.
 */
export function shownScreen(screen: Screen): string {
  const content = screen.content.trim();
  const line = boxLine(screen);
  if (!line) return content;
  return content ? `${content}\n${line}` : line;
}
