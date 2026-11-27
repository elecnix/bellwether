// Tier 1: faint text on a pane is a suggestion, never content. Each box case
// runs in both of herdr's formats. From the ANSI stream Bellwether reads EMPTY,
// GHOST or DRAFT; from the text format, which drops the styling, it claims
// only an empty box, because a suggestion and a draft read the same there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectModal } from '../../src/core/modal.ts';
import { boxLine, parseRuns, parseScreen, shownScreen } from '../../src/core/screen.ts';
import { BOX_CASES, CLAUDE_GHOST_QUESTION, SUGGESTION, TYPED, stripAnsi } from '../fixtures/ghost-screens.ts';

for (const box of BOX_CASES) {
  test(`${box.name}: the ANSI format reads ${box.state}`, () => {
    const screen = parseScreen(box.ansi, 'ansi');
    assert.equal(screen.box?.state, box.state);
    assert.equal(screen.box?.text, box.state === 'DRAFT' ? TYPED : '');
    const shown = shownScreen(screen);
    assert.match(shown, new RegExp(`Input box: ${box.state}\\.`));
    assert.ok(!shown.includes(SUGGESTION), 'a suggestion reached the screen shown to a parent');
    assert.ok(!shown.includes('Ask Codex to do anything'), 'a placeholder reached the screen shown to a parent');
    if (box.state === 'DRAFT') assert.ok(shown.includes(TYPED), 'typed text left the screen');
  });

  test(`${box.name}: the text format claims no state it cannot see`, () => {
    const screen = parseScreen(stripAnsi(box.ansi), 'text');
    assert.equal(screen.styled, false);
    if (box.state === 'EMPTY') {
      assert.equal(screen.box?.state, 'EMPTY');
      return;
    }
    assert.equal(screen.box, undefined, 'a box read without styling was called a draft or a suggestion');
    assert.match(boxLine(screen) ?? '', /^Input box: unknown\. herdr returned this screen without its styling/);
  });
}

test('a faint yes-or-no question in the box is no dialog, though its text reads like one', () => {
  assert.ok(detectModal(stripAnsi(CLAUDE_GHOST_QUESTION)), 'the text format must read as a dialog, or this case proves nothing');
  assert.equal(detectModal(parseScreen(CLAUDE_GHOST_QUESTION, 'ansi').content), undefined);
});

test('an extended colour argument of 2 is not faint, and SGR 22 or a reset ends faint text', () => {
  const runs = parseRuns('\u001b[38;2;153;153;153mgray\u001b[0m \u001b[48;5;2mgreen\u001b[0m \u001b[38:2::1:2:3mcolon\u001b[0m');
  assert.deepEqual(runs[0]?.filter((run) => run.faint), []);
  const ended = parseRuns('\u001b[1;2mfaint\u001b[22mplain \u001b[2;3mfaint\u001b[mplain');
  assert.deepEqual(ended[0]?.map((run) => [run.text, run.faint]), [['faint', true], ['plain ', false], ['faint', true], ['plain', false]]);
});

test('faint text carries across a line end, as on a terminal, until a reset', () => {
  const screen = parseScreen('\u001b[2mone\r\ntwo\u001b[0m\r\nthree', 'ansi');
  assert.equal(screen.content, '\n\nthree');
});

test('typed text beside a faint tail is a draft, and only the typed part travels', () => {
  const screen = parseScreen('❯ fix the\u001b[2m failing example test\u001b[0m', 'ansi');
  assert.deepEqual(screen.box, { state: 'DRAFT', text: 'fix the' });
  assert.equal(screen.content, '❯ fix the');
});

test('a pi editor between two rules reads from its cursor cell', () => {
  const rule = '─'.repeat(20);
  assert.deepEqual(parseScreen([rule, '\u001b[7m \u001b[0m', rule, ' footer'].join('\r\n'), 'ansi').box, { state: 'EMPTY', text: '' });
  assert.deepEqual(parseScreen([rule, `${TYPED}\u001b[7m \u001b[0m`, rule].join('\r\n'), 'ansi').box, { state: 'DRAFT', text: TYPED });
  // Output that landed between the rules without pi's cursor is not the editor's text.
  assert.deepEqual(parseScreen([rule, 'stray extension output', rule].join('\r\n'), 'ansi').box, { state: 'EMPTY', text: '' });
});

test('a screen with no box says nothing about one', () => {
  const screen = parseScreen('$ ls\r\nREADME.md', 'ansi');
  assert.equal(screen.box, undefined);
  assert.equal(shownScreen(screen), '$ ls\nREADME.md');
});
