// The pieces of the startup-dialog answer that need no socket: which dialog a
// screen shows, and which key moves toward the accepting option. The last
// cases read screens copied from a real Claude Code 2.1.332 pane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerKey, confirms, detectDialog, keyToward } from '../../src/core/startup-dialogs.ts';
import { CHANNEL_ACCEPT_SELECTED, CHANNEL_EXIT_SELECTED, CHANNEL_FIVE_EXIT_SELECTED, CLAUDE_PROMPT, PERMISSION_QUESTION, TRUST_NO_SELECTED, TRUST_YES_SELECTED } from '../fixtures/claude-screens.ts';

const TRUST_ACCEPT = 'Yes, I trust this folder';
const CHANNEL_ACCEPT = 'I am using this for local development';

test('the trust question and the channel confirmation are told apart', () => {
  assert.equal(detectDialog('Quick safety check: Is this a project you created or one you trust?'), 'trust');
  assert.equal(detectDialog('WARNING: Loading development channels'), 'channel');
  assert.equal(detectDialog('╭───╮\n│ > │'), undefined);
});

test('the key moves the selection toward the wanted option, then confirms it', () => {
  const below = ' ❯ 1. No, exit\n   2. Yes, I trust this folder';
  const above = '   1. Yes, I trust this folder\n ❯ 2. No, exit';
  const on = ' ❯ 1. Yes, I trust this folder\n   2. No, exit';
  assert.equal(keyToward(below, TRUST_ACCEPT), 'Down');
  assert.equal(keyToward(above, TRUST_ACCEPT), 'Up');
  assert.equal(keyToward(on, TRUST_ACCEPT), 'Enter');
  assert.equal(keyToward('drawing…', TRUST_ACCEPT), undefined);
});

test('the real trust question opens on "No, exit", so the first key is Down, never Enter', () => {
  assert.equal(detectDialog(TRUST_NO_SELECTED), 'trust');
  assert.equal(keyToward(TRUST_NO_SELECTED, TRUST_ACCEPT), 'Down');
  assert.equal(keyToward(TRUST_YES_SELECTED, TRUST_ACCEPT), 'Enter');
});

test('the real channel question opens on its accepting option, and "Exit" selected calls for Up', () => {
  assert.equal(detectDialog(CHANNEL_ACCEPT_SELECTED), 'channel');
  assert.equal(keyToward(CHANNEL_ACCEPT_SELECTED, CHANNEL_ACCEPT), 'Enter');
  assert.equal(keyToward(CHANNEL_EXIT_SELECTED, CHANNEL_ACCEPT), 'Up');
});

test('a dialog with no selection marker gets no key', () => {
  assert.equal(keyToward(TRUST_NO_SELECTED.replace('❯', ' '), TRUST_ACCEPT), undefined);
});

test('the prompt and a permission question are not startup dialogs', () => {
  assert.equal(detectDialog(CLAUDE_PROMPT), undefined);
  assert.equal(detectDialog(PERMISSION_QUESTION), undefined);
});

test('a numbered option is answered with its digit, wherever the cursor is (issue #133)', () => {
  assert.equal(answerKey(CHANNEL_ACCEPT_SELECTED, CHANNEL_ACCEPT), '1');
  assert.equal(answerKey(CHANNEL_EXIT_SELECTED, CHANNEL_ACCEPT), '1');
  assert.equal(answerKey(CHANNEL_FIVE_EXIT_SELECTED, CHANNEL_ACCEPT), '1');
  assert.equal(confirms('1'), true);
});

test('an option without a number is walked to with the arrows, and Enter waits for it to be selected', () => {
  assert.equal(answerKey(TRUST_NO_SELECTED, TRUST_ACCEPT), 'Down');
  assert.equal(answerKey(TRUST_YES_SELECTED, TRUST_ACCEPT), 'Enter');
  assert.equal(confirms('Down'), false);
  // A screen still drawing gets no key at all.
  assert.equal(answerKey('drawing…', TRUST_ACCEPT), undefined);
});
