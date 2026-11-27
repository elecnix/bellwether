// Tier 1: the `reads` a parent names for one child, and what the parent is
// told when Bellwether declines a read outside them (issue #142).
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReads, readsSuggestion } from '../../src/core/reads.ts';
import { describeDecisions } from '../../src/core/registry.ts';
import { registerFlags } from '../../src/core/remote.ts';
import type { DialogDecision } from '../../src/core/types.ts';

const HOME = '/home/example';

test('reads takes absolute paths, normalized and without repeats', () => {
  assert.equal(checkReads(undefined, HOME), undefined);
  assert.deepEqual(checkReads(['/home/example/Source/dotfiles/lint/', '/srv/example/../example/skills', '/home/example/Source/dotfiles/lint'], HOME), ['/home/example/Source/dotfiles/lint', '/srv/example/skills']);
  assert.deepEqual(checkReads([], HOME), []);
});

test('reads refuses what would let a child read the world', () => {
  assert.throws(() => checkReads(['~/.agents/skills'], HOME), /not an absolute path/);
  assert.throws(() => checkReads(['Source/dotfiles'], HOME), /not an absolute path/);
  assert.throws(() => checkReads(['/'], HOME), /root of the filesystem/);
  assert.throws(() => checkReads([HOME], HOME), /holds the operator's home/);
  assert.throws(() => checkReads(['/home'], HOME), /holds the operator's home/);
  assert.throws(() => checkReads('/srv/example', HOME), /list of absolute paths/);
  assert.throws(() => checkReads([''], HOME), /list of absolute paths/);
});

test('the suggestion for a declined file is its directory, and a directory is kept', () => {
  assert.equal(readsSuggestion('/srv/other/eslint.config.js'), '/srv/other');
  assert.equal(readsSuggestion('/home/example/.agents/skills/review'), '/home/example/.agents/skills/review');
});

const declined = (path: string, at: string): DialogDecision => ({
  dialog: 'outside-read',
  name: 'the question about a read outside the working directories',
  question: 'Allow this read outside the working directories?',
  answer: 'No, and ask again next time',
  decided: 'declined the read, which is outside the directories its launch allowed, and saved nothing to the settings',
  keys: ['3'],
  at,
  by: 'watcher',
  outcome: 'declined',
  path,
});

test('a declined read tells the parent which path, how often, and which field widens the set', () => {
  const first = declined('/srv/other/eslint.config.js', '2026-11-27T22:00:00.000Z');
  const once = describeDecisions('kid (w1:p1)', [first]);
  assert.match(once, /^Bellwether declined kid \(w1:p1\)'s read of \/srv\/other\/eslint\.config\.js/);
  assert.match(once, /agent_restart with reads \["\/srv\/other"\] keeps its session/);
  assert.doesNotMatch(once, /second time/);
  // The parent sent the same instruction again, and the child met the same No.
  const twice = describeDecisions('kid (w1:p1)', [declined('/srv/other/eslint.config.js', '2026-11-27T22:08:00.000Z')], [{ ...first, told: true }]);
  assert.match(twice, /This is the second time Bellwether declined that path for it, so the brief needs it\./);
});

test('an accepted answer reads as an answer, and a declined command names no read set', () => {
  const accepted: DialogDecision = { ...declined('/srv/x', 'now'), outcome: 'accepted' };
  delete accepted.path;
  assert.match(describeDecisions('kid', [accepted]), /^Bellwether answered /);
  const rm: DialogDecision = { ...declined('/srv/x', 'now'), dialog: 'dangerous-rm', name: 'the dangerous-rm question', question: 'Do you want to proceed?', answer: 'No, and tell Claude what to do differently' };
  delete rm.path;
  const text = describeDecisions('kid', [rm]);
  assert.match(text, /^Bellwether declined for kid: the dangerous-rm question/);
  assert.doesNotMatch(text, /reads/);
});

test('a child on another machine takes its reads to relay-register there, and a child without them sends no flag', () => {
  const parent = { id: 'example-parent' };
  const child = { id: 'example-child', name: 'kid', kind: 'claude', cwd: '/srv/work' };
  assert.deepEqual(registerFlags(parent, child).includes('--reads'), false, 'an older far daemon still takes the registration');
  const flags = registerFlags(parent, { ...child, reads: ['/srv/other'] });
  assert.equal(flags[flags.indexOf('--reads') + 1], '["/srv/other"]');
});
