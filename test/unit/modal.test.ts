// Tier 1: the screen check that runs before an idle event. It names a modal
// dialog from a pane's text with one short line, and it says nothing for a
// harness sitting at its own prompt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODAL_LINE_LIMIT, detectModal } from '../../src/core/modal.ts';
import { CHANNEL_ACCEPT_SELECTED, CLAUDE_PROMPT, PERMISSION_QUESTION, TRUST_NO_SELECTED } from '../fixtures/claude-screens.ts';

const PI_PROMPT = `
 Working in /var/tmp/example
 ────────────────────────────────────────────────
 >
 ────────────────────────────────────────────────
 ~/example (main)                    0.0%/200k (auto)
`;

/** A pi extension's confirm dialog, as pi-tui draws a select list. */
const PI_CONFIRM = `
 Share anonymous usage totals with the example-tool maintainers?
 Nothing leaves this machine unless you say yes.

 → Yes
   No
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
