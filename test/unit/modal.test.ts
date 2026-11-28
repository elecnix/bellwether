// Tier 1: the screen check that runs before an idle event. It names a modal
// dialog from a pane's text with one short line, and it says nothing for a
// harness sitting at its own prompt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODAL_LINE_LIMIT, detectModal } from '../../src/core/modal.ts';
import { parseScreen } from '../../src/core/screen.ts';
import { CHANNEL_ACCEPT_SELECTED, CLAUDE_PROMPT, PERMISSION_QUESTION, TRUST_NO_SELECTED } from '../fixtures/claude-screens.ts';
import { CLAUDE_NUMBERED_DRAFT, CODEX_TWO_LINE_DRAFT, TRUST_DIMMED_HINT } from '../fixtures/ghost-screens.ts';

const PI_PROMPT = `
 Working in /var/tmp/example
 ────────────────────────────────────────────────
 >
 ────────────────────────────────────────────────
 ~/example (main)                    0.0%/200k (auto)
`;

/**
 * A pi extension's confirm dialog, as pi's ExtensionSelectorComponent draws
 * it: a rule, the title, the description, the options, the key hints and a
 * rule.
 */
const PI_CONFIRM = `
────────────────────────────────────────────────

 Share anonymous usage totals with the example-tool maintainers?

 Nothing leaves this machine unless you say yes.

 → Yes
   No

 ↑↓ navigate  enter select  esc cancel

────────────────────────────────────────────────
`;

test('a Claude Code permission question is a modal, named by its header and question', () => {
  const line = detectModal(PERMISSION_QUESTION);
  assert.equal(line, 'Bash command: Do you want to proceed?');
});

test('the folder-trust question is a modal, and its line tells it apart from a permission question', () => {
  const line = detectModal(TRUST_NO_SELECTED);
  assert.ok(line);
  assert.match(line, /^Accessing workspace: Quick safety check: Is this a project you created or one you trust\?/);
  assert.ok(line.length <= MODAL_LINE_LIMIT);
  assert.doesNotMatch(line, /proceed/);
});

test('the development-channel question is a modal, named by its first line', () => {
  assert.equal(detectModal(CHANNEL_ACCEPT_SELECTED), 'WARNING: Loading development channels');
});

test('a pi select list is a modal, named by its question', () => {
  assert.equal(detectModal(PI_CONFIRM), 'Share anonymous usage totals with the example-tool maintainers?');
});

test('a y/n question on the last lines is a modal', () => {
  assert.equal(detectModal('npm notice\nOk to proceed? (y/n) '), 'Ok to proceed? (y/n)');
  assert.equal(detectModal('Overwrite config.toml? [y/N]'), 'Overwrite config.toml? [y/N]');
});

test('a harness at its own prompt is not a modal', () => {
  assert.equal(detectModal(CLAUDE_PROMPT), undefined);
  assert.equal(detectModal(PI_PROMPT), undefined);
  assert.equal(detectModal(''), undefined);
});

test('a numbered list higher up in a finished answer is not a modal', () => {
  const answer = ['Which option did you mean?', ' > 1. Yes', '   2. No', ...Array.from({ length: 30 }, (_, index) => `line ${index}`), '❯ '].join('\n');
  assert.equal(detectModal(answer), undefined);
});

test('a long question is cut to the limit', () => {
  const question = `${'Do you really want to '.repeat(10)}continue?`;
  const line = detectModal(`${question}\n ❯ 1. Yes\n   2. No\n`);
  assert.ok(line);
  assert.equal(line.length, MODAL_LINE_LIMIT);
  assert.ok(line.endsWith('…'));
});

// The rule herdr-box-state.sh applies, and this module shares (issue #164): a
// dialog is a question with its options under it, and a solid selection
// marker or a y/n prompt. A numbered selection needs a numbered option beside
// it. An unnumbered one needs an option on the next line or the line before,
// and a confirm or cancel hint under the list. The six dialog shapes below
// are the ones that script tests.
const RULE = '─'.repeat(40);

test('a numbered selection dialog with its footer is a modal', () => {
  const screen = `${RULE}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently\n\n Esc to cancel\n`;
  assert.equal(detectModal(screen), 'Do you want to proceed?');
});

test('a dialog whose middle option is selected is a modal', () => {
  assert.equal(detectModal(' Pick one\n   1. First\n ❯ 2. Second\n   3. Third\n'), 'Pick one');
});

test('a dialog with a description under each option is a modal', () => {
  const screen = ' Which approach?\n ❯ 1. Keep the script\n      Its own logic, in perl.\n   2. Shell out\n      Needs node.\n';
  assert.equal(detectModal(screen), 'Which approach?');
});

test('an unnumbered dialog with its footer is a modal', () => {
  const screen = ' Is this a folder you trust?\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n';
  assert.equal(detectModal(screen), 'Is this a folder you trust?');
});

test('a dialog whose selection marker is faint is no modal here, where the script reads one', () => {
  // herdr-box-state.sh reads this screen as a dialog, because it only asks
  // whether the box is free. Here a faint marker is a suggestion: Bellwether
  // never reports, or answers, a selection the screen does not draw solid.
  const screen = parseScreen(' Is this a folder you trust?\r\n\r\n   No, exit\r\n \u001b[2m❯ Yes, I trust this folder\u001b[0m\r\n\r\n Enter to confirm · Esc to cancel', 'ansi');
  assert.equal(detectModal(screen), undefined);
});

test('a Codex approval dialog is a modal', () => {
  assert.equal(detectModal(' Allow command?\n› 1. Yes, proceed (y)\n  2. No (esc)\n'), 'Allow command?');
});

test('two lines typed into a box are a draft, not a modal', () => {
  // The second line lines up with the first line's text, as an option does,
  // but nothing is numbered and no confirm or cancel hint follows.
  assert.equal(detectModal(parseScreen(CODEX_TWO_LINE_DRAFT, 'ansi')), undefined);
  assert.equal(detectModal('⏺ The build passed.\n\n❯ first line\n  second line\n'), undefined);
});

test('a numbered list typed into a box under its rule is a draft, not a modal', () => {
  assert.equal(detectModal(parseScreen(CLAUDE_NUMBERED_DRAFT, 'ansi')), undefined);
});

test('an unnumbered list without a confirm or cancel hint is not a modal', () => {
  assert.equal(detectModal(' Pick a colour:\n → Red\n   Blue\n'), undefined);
});

test('a dialog that dims its unselected option and its hint is still a modal', () => {
  assert.match(detectModal(parseScreen(TRUST_DIMMED_HINT, 'ansi')) ?? '', /^Accessing workspace: Quick safety check: Is this a project you created/);
});
