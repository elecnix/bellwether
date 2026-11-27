// The pieces of the startup-dialog answer that need no socket: which dialog a
// screen shows, and which key moves toward the accepting option. The last
// cases read screens copied from a real Claude Code 2.1.332 pane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerKey, CLAUDE_STARTUP, confirms, detectDialog, dialogPath, dialogQuestion, keyToward, optionBlock } from '../../src/core/startup-dialogs.ts';
import { CHANNEL_ACCEPT_SELECTED, CHANNEL_EXIT_SELECTED, CHANNEL_FIVE_EXIT_SELECTED, CHANNEL_TWO_MARKED, CHANNEL_UNDER_GLYPH_PROMPT, CHANNEL_WITHOUT_PROMPT, CLAUDE_PROMPT, DANGEROUS_RM_QUESTION, OUTSIDE_READ_QUESTION, PERMISSION_QUESTION, TRUST_NO_SELECTED, TRUST_YES_SELECTED, underGlyphPrompt, UNKNOWN_STARTUP_QUESTION } from '../fixtures/claude-screens.ts';

const TRUST_ACCEPT = 'Yes, I trust this folder';
const CHANNEL_ACCEPT = 'I am using this for local development';

/** The text each dialog shows, which anchors the search for its options. */
function shows(id: string): RegExp {
  const dialog = CLAUDE_STARTUP.dialogs.find((entry) => entry.id === id);
  assert.ok(dialog, `no dialog ${id}`);
  return dialog.shows;
}
const TRUST = shows('trust');
const CHANNEL = shows('channel');
const READ = shows('outside-read');
const RM = shows('dangerous-rm');
const PROCEED = /Proceed\?/;

test('the trust question and the channel confirmation are told apart', () => {
  assert.equal(detectDialog('Quick safety check: Is this a project you created or one you trust?'), 'trust');
  assert.equal(detectDialog('WARNING: Loading development channels'), 'channel');
  assert.equal(detectDialog('╭───╮\n│ > │'), undefined);
});

test('the key moves the selection toward the wanted option, then confirms it', () => {
  const question = ' Is this a project you created or one you trust?\n';
  const below = `${question} ❯ 1. No, exit\n   2. Yes, I trust this folder`;
  const above = `${question}   1. Yes, I trust this folder\n ❯ 2. No, exit`;
  const on = `${question} ❯ 1. Yes, I trust this folder\n   2. No, exit`;
  assert.equal(keyToward(below, TRUST_ACCEPT, TRUST), 'Down');
  assert.equal(keyToward(above, TRUST_ACCEPT, TRUST), 'Up');
  assert.equal(keyToward(on, TRUST_ACCEPT, TRUST), 'Enter');
  assert.equal(keyToward('drawing…', TRUST_ACCEPT, TRUST), undefined);
});

test('the real trust question opens on "No, exit", so the first key is Down, never Enter', () => {
  assert.equal(detectDialog(TRUST_NO_SELECTED), 'trust');
  assert.equal(keyToward(TRUST_NO_SELECTED, TRUST_ACCEPT, TRUST), 'Down');
  assert.equal(keyToward(TRUST_YES_SELECTED, TRUST_ACCEPT, TRUST), 'Enter');
});

test('the real channel question opens on its accepting option, and "Exit" selected calls for Up', () => {
  assert.equal(detectDialog(CHANNEL_ACCEPT_SELECTED), 'channel');
  assert.equal(keyToward(CHANNEL_ACCEPT_SELECTED, CHANNEL_ACCEPT, CHANNEL), 'Enter');
  assert.equal(keyToward(CHANNEL_EXIT_SELECTED, CHANNEL_ACCEPT, CHANNEL), 'Up');
});

test('a dialog with no selection marker gets no key', () => {
  assert.equal(keyToward(TRUST_NO_SELECTED.replace('❯', ' '), TRUST_ACCEPT, TRUST), undefined);
});

test('the prompt and a permission question are not startup dialogs', () => {
  assert.equal(detectDialog(CLAUDE_PROMPT), undefined);
  assert.equal(detectDialog(PERMISSION_QUESTION), undefined);
});

test('the read and dangerous-rm questions are known, and each is answered No', () => {
  assert.equal(detectDialog(OUTSIDE_READ_QUESTION), 'outside-read');
  assert.equal(detectDialog(DANGEROUS_RM_QUESTION), 'dangerous-rm');
  // Each No is numbered, so its digit answers it wherever the selection starts.
  assert.equal(answerKey(OUTSIDE_READ_QUESTION, 'No, and ask again next time', READ), '3');
  assert.equal(answerKey(DANGEROUS_RM_QUESTION, 'No, and tell Claude what to do differently', RM), '2');
  // Walked with the arrows, the selection goes down to the No that saves nothing, and Enter waits for it.
  assert.equal(keyToward(OUTSIDE_READ_QUESTION, 'No, and ask again next time', READ), 'Down');
  const onNo = OUTSIDE_READ_QUESTION.replace(' ❯ 1. Yes, and keep', '   1. Yes, and keep').replace('   3. No, and ask again', ' ❯ 3. No, and ask again');
  assert.equal(keyToward(onNo, 'No, and ask again next time', READ), 'Enter');
  // The other No, which would save a block into the operator's settings, is never the target.
  const onBlock = OUTSIDE_READ_QUESTION.replace(' ❯ 1. Yes, and keep', '   1. Yes, and keep').replace('   2. No, and block', ' ❯ 2. No, and block');
  assert.equal(keyToward(onBlock, 'No, and ask again next time', READ), 'Down');
  assert.equal(keyToward(DANGEROUS_RM_QUESTION, 'No, and tell Claude what to do differently', RM), 'Down');
});

test('an option label matches an option line, not the dialog text that mentions it', () => {
  const screen = ' No changes are made until you choose.\n Proceed?\n ❯ 1. Yes\n   2. No';
  assert.equal(keyToward(screen, 'No', PROCEED), 'Down');
  assert.equal(answerKey(screen, 'No', PROCEED), '2');
});

test('the question a dialog asks is the line above its options that ends with a question mark', () => {
  assert.equal(dialogQuestion(OUTSIDE_READ_QUESTION), 'Allow this read outside the working directories?');
  assert.equal(dialogQuestion(DANGEROUS_RM_QUESTION), 'Do you want to proceed?');
  assert.equal(dialogQuestion(UNKNOWN_STARTUP_QUESTION), 'Import them into this session?');
  assert.equal(dialogQuestion('│ Trust this folder? │\n│ ❯ 1. Yes         │'), 'Trust this folder?');
  // A prompt, and a screen with no numbered option, ask nothing.
  assert.equal(dialogQuestion(CLAUDE_PROMPT), undefined);
  assert.equal(dialogQuestion('Is it done?\nworking…'), undefined);
});

test('a numbered option is answered with its digit, wherever the cursor is (issue #133)', () => {
  assert.equal(answerKey(CHANNEL_ACCEPT_SELECTED, CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(answerKey(CHANNEL_EXIT_SELECTED, CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(answerKey(CHANNEL_FIVE_EXIT_SELECTED, CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(confirms('1'), true);
});

test('an option without a number is walked to with the arrows, and Enter waits for it to be selected', () => {
  assert.equal(answerKey(TRUST_NO_SELECTED, TRUST_ACCEPT, TRUST), 'Down');
  assert.equal(answerKey(TRUST_YES_SELECTED, TRUST_ACCEPT, TRUST), 'Enter');
  assert.equal(confirms('Down'), false);
  // A screen still drawing gets no key at all.
  assert.equal(answerKey('drawing…', TRUST_ACCEPT, TRUST), undefined);
});

test('a declined read keeps the path its dialog shows', () => {
  assert.equal(dialogPath(OUTSIDE_READ_QUESTION), '/var/tmp/example-other-repo/eslint.config.js');
  assert.equal(dialogPath('│ Read file │\n│ /srv/example/skill/SKILL.md │\n Allow?'), '/srv/example/skill/SKILL.md');
  assert.equal(dialogPath(DANGEROUS_RM_QUESTION), undefined);
});

test('the options are the block under the question, so a ❯ shell prompt above it is never the selection (issue #160)', () => {
  // The screen from the issue: the prompt line, the warning, the options with the cursor on 1.
  assert.equal(answerKey(CHANNEL_UNDER_GLYPH_PROMPT, CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(keyToward(CHANNEL_UNDER_GLYPH_PROMPT, CHANNEL_ACCEPT, CHANNEL), 'Enter');
  // The same screen with the prompt line absent answers identically.
  assert.equal(answerKey(CHANNEL_WITHOUT_PROMPT, CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(keyToward(CHANNEL_WITHOUT_PROMPT, CHANNEL_ACCEPT, CHANNEL), 'Enter');
  const seen = (screen: string): unknown => optionBlock(screen, CHANNEL)?.options.map(({ label, digit, selected }) => ({ label, digit, selected }));
  assert.deepEqual(seen(CHANNEL_UNDER_GLYPH_PROMPT), seen(CHANNEL_WITHOUT_PROMPT));
  // The folder-trust question has no numbers, so its arrow walk reads the marker:
  // the one in the option block, never the one that starts the prompt line.
  assert.equal(answerKey(underGlyphPrompt(TRUST_NO_SELECTED), TRUST_ACCEPT, TRUST), 'Down');
  assert.equal(answerKey(underGlyphPrompt(TRUST_YES_SELECTED), TRUST_ACCEPT, TRUST), 'Enter');
  assert.equal(answerKey(underGlyphPrompt(CHANNEL_EXIT_SELECTED), CHANNEL_ACCEPT, CHANNEL), '1');
  assert.equal(keyToward(underGlyphPrompt(CHANNEL_EXIT_SELECTED), CHANNEL_ACCEPT, CHANNEL), 'Up');
});

test('the option block is the contiguous, aligned lines under the question, and only they carry the selection', () => {
  const block = optionBlock(underGlyphPrompt(TRUST_YES_SELECTED), TRUST);
  assert.deepEqual(block?.options.map((option) => [option.label, option.selected]), [
    ['No, exit', false],
    ['Yes, I trust this folder', true],
  ]);
  assert.deepEqual(optionBlock(OUTSIDE_READ_QUESTION, READ)?.options.map((option) => option.digit), ['1', '2', '3', '4']);
  // A screen whose question has no options under it yet has no block.
  assert.equal(optionBlock(' WARNING: Loading development channels\n', CHANNEL), undefined);
  // The prompt alone, with no question on screen, has none either.
  assert.equal(optionBlock(CLAUDE_PROMPT, CHANNEL), undefined);
});

test('a block with the marker on two options gets no key, not even its digit', () => {
  const block = optionBlock(CHANNEL_TWO_MARKED, CHANNEL);
  assert.deepEqual(block?.marked, ['❯ 1. I am using this for local development', '❯ 2. Exit']);
  assert.equal(answerKey(CHANNEL_TWO_MARKED, CHANNEL_ACCEPT, CHANNEL), undefined);
  assert.equal(keyToward(CHANNEL_TWO_MARKED, CHANNEL_ACCEPT, CHANNEL), undefined);
});

test('every Claude Code dialog names a line its screen shows, so its options have an anchor', () => {
  const screens: Record<string, string> = { trust: TRUST_NO_SELECTED, channel: CHANNEL_ACCEPT_SELECTED, 'outside-read': OUTSIDE_READ_QUESTION, 'dangerous-rm': DANGEROUS_RM_QUESTION };
  for (const dialog of CLAUDE_STARTUP.dialogs) {
    const screen = screens[dialog.id] ?? '';
    assert.ok(optionBlock(screen, dialog.shows), `${dialog.id} has an option block under its own line`);
  }
});
