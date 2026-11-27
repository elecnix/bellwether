// Input boxes as herdr's `pane.read --format ansi` returns them, for the
// three cases a box can be in: text somebody typed, a suggestion the harness
// drew faint (SGR 2), and nothing. The Claude Code shapes follow a live Claude
// Code 2.1 pane read on 2026-11-27: rules in a 24-bit gray, the U+276F glyph
// and a no-break space, then the suggestion in `ESC[2m`. The Codex shapes
// follow its composer, whose placeholder is drawn the same faint way. Every
// suggestion's words are synthetic.
//
// `paneReadAnswer` answers a `pane.read` the way herdr does: the ANSI stream
// for `format: "ansi"`, and the same screen with every escape removed for
// the text format, which is what Bellwether read before it asked for ANSI.

const ESC = '\u001b';
const GRAY = `${ESC}[0m${ESC}[38;2;136;136;136m`;
const RESET = `${ESC}[0m`;
const FAINT = `${ESC}[2m`;
const RULE = `${GRAY}${'─'.repeat(60)}${RESET}`;

/** Words a suggestion shows in the cases below. They must never reach a parent as somebody's. */
export const SUGGESTION = 'cut the example 0.0.0 release';
/** Words somebody typed into the box. */
export const TYPED = 'please hold the example release';

const CLAUDE_ABOVE = [
  `${ESC}[0m${ESC}[38;2;255;255;255m⏺ ${RESET}The example build passed, and nothing else is open.`,
  '',
  `${ESC}[0m${ESC}[38;2;153;153;153m✻ Churned for 22s · done${RESET}`,
  '',
];
const CLAUDE_FOOTER = `  ${ESC}[0m${ESC}[38;2;255;193;7m⏵⏵ auto mode on${RESET}${ESC}[38;2;153;153;153m (shift+tab to cycle)${RESET}`;

function claude(box: string): string {
  return [...CLAUDE_ABOVE, RULE, `❯ ${box}`, RULE, CLAUDE_FOOTER].join('\r\n');
}

function codex(box: string): string {
  return [`${ESC}[0m• The example build passed.`, '', `${ESC}[1m›${RESET} ${box}`, '', `  ${ESC}[2m⏎ send   ⌃J newline   ⌃C quit${RESET}`].join('\r\n');
}

export interface BoxCase {
  name: string;
  ansi: string;
  /** What Bellwether reports for the box from the ANSI stream. */
  state: 'EMPTY' | 'GHOST' | 'DRAFT';
}

export const CLAUDE_GHOST = claude(`${RESET}${FAINT}${SUGGESTION}${RESET}`);
export const CLAUDE_DRAFT = claude(`${RESET}${TYPED}`);
export const CLAUDE_EMPTY = claude(`${RESET}`);
export const CODEX_GHOST = codex(`${FAINT}Ask Codex to do anything${RESET}`);
export const CODEX_DRAFT = codex(TYPED);
export const CODEX_EMPTY = codex('');

export const BOX_CASES: BoxCase[] = [
  { name: 'Claude Code, a suggestion', ansi: CLAUDE_GHOST, state: 'GHOST' },
  { name: 'Claude Code, typed text', ansi: CLAUDE_DRAFT, state: 'DRAFT' },
  { name: 'Claude Code, an empty box', ansi: CLAUDE_EMPTY, state: 'EMPTY' },
  { name: 'Codex, its placeholder', ansi: CODEX_GHOST, state: 'GHOST' },
  { name: 'Codex, typed text', ansi: CODEX_DRAFT, state: 'DRAFT' },
  { name: 'Codex, an empty box', ansi: CODEX_EMPTY, state: 'EMPTY' },
];

/**
 * An idle Claude Code child whose box suggests a yes-or-no question. In the
 * text format it ends in the y/n form a dialog uses; drawn faint, it is a
 * suggestion and no dialog at all.
 */
export const CLAUDE_GHOST_QUESTION = claude(`${RESET}${FAINT}Ship the example release now? (y/n)${RESET}`);

/**
 * Claude Code's folder-trust question with the accepting option drawn faint
 * under the selection marker. A faint line is not an option the screen
 * offers, so the spawn must not take it as selected and press Enter.
 */
export const TRUST_FAINT_ACCEPT = [
  `${RULE}`,
  ' Accessing workspace:',
  '',
  ' /var/tmp/example',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  '   No, exit',
  ` ${FAINT}❯ Yes, I trust this folder${RESET}`,
  '',
  ' Enter to confirm · Esc to cancel',
].join('\r\n');

/** Remove every escape sequence, as herdr's text format does. */
export function stripAnsi(ansi: string): string {
  // eslint-disable-next-line no-control-regex
  return ansi.replace(/\u001b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, '').replace(/\r\n/g, '\n');
}

/** A `pane.read` result for `screen` in the format the request named, the way herdr answers. */
export function paneReadAnswer(params: Record<string, unknown>, screen: string, paneId = String(params['pane_id'])): unknown {
  const format = params['format'] === 'ansi' ? 'ansi' : 'text';
  return { type: 'pane_read', read: { pane_id: paneId, source: String(params['source']), format, text: format === 'ansi' ? screen : stripAnsi(screen) } };
}

/**
 * A permission dialog that dims the options it has not selected, under a
 * solid selection marker. It asks a question, so it is a dialog and no input
 * box: the `❯` line is the selected option, not a draft and not a suggestion.
 */
export const PERMISSION_DIMMED = [
  `${RULE}`,
  ' Bash command',
  '',
  '   rm -rf example-build',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  `${FAINT}   2. Yes, and don't ask again for this command${RESET}`,
  `${FAINT}   3. No, and tell Claude what to do differently${RESET}`,
  '',
  ' Esc to cancel',
].join('\r\n');

/** The folder-trust question with its unselected accepting option dimmed, which the spawn walks to. */
export const TRUST_DIMMED_ACCEPT = [
  `${RULE}`,
  ' Accessing workspace:',
  '',
  ' /var/tmp/example',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ❯ No, exit',
  `${FAINT}   Yes, I trust this folder${RESET}`,
  '',
  ' Enter to confirm · Esc to cancel',
].join('\r\n');
