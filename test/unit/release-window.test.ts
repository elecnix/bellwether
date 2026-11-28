// The release check against real git, one case per breach that model/Release.tla
// found (issue #211). Each case replays the model's trace.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_ENTRY_LABEL } from '../../scripts/release.ts';
import { releaseWorld } from '../fixtures/release-world.ts';

const NOTE = 'Bellwether now does something a person reads about.\n';

async function world(t: test.TestContext) {
  const w = await releaseWorld('0.1.0');
  t.after(() => w.cleanup());
  return w;
}

// ShippedHasNote. Trace: Open(#11, no note), StartRelease, Merge(#11), FinishRelease.
test('a pull request that merges while the gates run, with no note, stops the release before it stages', async (t) => {
  const w = await world(t);
  await w.merge('Add A (#10)', { 'a.txt': 'a\n', 'release-notes/0.2.0/a.md': NOTE });
  const run = await w.release('0.2.0', {
    duringGates: () => w.merge('Add B (#11)', { 'b.txt': 'b\n' }),
  });
  assert.equal(run.staged, false, `0.2.0 reached staging with #11 in its release commit and no note for it. Log:\n${run.logs.join('\n')}`);
  assert.deepEqual(run.missing, [11], run.error);
  assert.match(run.error ?? '', /merged while the release pull request was open/);
});

test('the late pull request stages once a note under the version names it on main', async (t) => {
  const w = await world(t);
  const first = await w.release('0.2.0', { duringGates: () => w.merge('Add B (#11)', { 'b.txt': 'b\n' }) });
  assert.deepEqual(first.missing, [11], first.error);
  await w.merge('Note for B (#12)', { 'release-notes/0.2.0/b.md': `---\nprs: [11]\n---\n${NOTE}` }, [NO_ENTRY_LABEL]);
  const second = await w.release('0.2.0');
  assert.equal(second.staged, true, second.error);
});

test('the late pull request stages once it carries the label', async (t) => {
  const w = await world(t);
  const first = await w.release('0.2.0', { duringGates: () => w.merge('Bump a dependency (#11)', { 'b.txt': 'b\n' }) });
  assert.deepEqual(first.missing, [11], first.error);
  w.label(11, NO_ENTRY_LABEL);
  const second = await w.release('0.2.0');
  assert.equal(second.staged, true, second.error);
});

test('a release with nothing merged during its gates stages', async (t) => {
  const w = await world(t);
  await w.merge('Add A (#10)', { 'a.txt': 'a\n', 'release-notes/0.2.0/a.md': NOTE });
  const run = await w.release('0.2.0');
  assert.equal(run.staged, true, run.error);
});

// NoNoteUnderPublished. Trace: Open(#21, note under 0.2.0), StartRelease, FinishRelease, Merge(#21).
async function after020(t: test.TestContext) {
  const w = await world(t);
  const run = await w.release('0.2.0');
  assert.equal(run.staged, true, `precondition: 0.2.0 stages\n${run.error}`);
  w.publish('0.2.0');
  return w;
}

test('a note under a published version stops the next release, though its pull request has another entry', async (t) => {
  const w = await after020(t);
  await w.merge('Add X (#21)', { 'x.txt': 'x\n', 'release-notes/0.2.0/x.md': NOTE, 'release-notes/0.3.0/x.md': NOTE });
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/x.md merged after 0.2.0 was published, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/x\.md/);
});

test('a note under a published version stops the next release, though its pull request carries the label', async (t) => {
  const w = await after020(t);
  await w.merge('Tidy (#22)', { 'release-notes/0.2.0/y.md': NOTE }, [NO_ENTRY_LABEL]);
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/y.md merged after 0.2.0 was published, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/y\.md/);
});

test('a note under a published version stops the next release, though no pull request number names its commit', async (t) => {
  const w = await after020(t);
  await w.merge('direct push', { 'release-notes/0.2.0/z.md': NOTE });
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/z.md merged after 0.2.0 was published, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/z\.md/);
});

// A note belongs to the version whose release commit carries every pull request it names. A note
// that moves into a file after that release, as #206 moved the entries 0.1.7 to 0.1.9 had shipped,
// names pull requests that shipped there, so it stays where it is. Ancestry comes from git, never
// from a date, because a squash merge keeps the author's date and a rebase moves it.
async function shippedThenPublished(t: test.TestContext) {
  const w = await world(t);
  await w.merge('Add A (#10)', { 'a.txt': 'a\n', 'release-notes/0.2.0/a-first.md': NOTE });
  const run = await w.release('0.2.0');
  assert.equal(run.staged, true, `precondition: 0.2.0 stages\n${run.error}`);
  w.publish('0.2.0');
  return w;
}

test('a note added after its version was published, naming a pull request that shipped in it, lets the next release stage', async (t) => {
  const w = await shippedThenPublished(t);
  await w.merge('Give each note a file (#21)', { 'release-notes/0.2.0/a.md': `---\nprs: [10]\n---\n${NOTE}` }, [NO_ENTRY_LABEL]);
  const run = await w.release('0.3.0');
  assert.equal(run.staged, true, `release-notes/0.2.0/a.md names #10, which shipped in 0.2.0, and 0.3.0 refused it:\n${run.error}`);
});

test('a note under a published version that names a pull request merged after that release stops the next release', async (t) => {
  const w = await shippedThenPublished(t);
  await w.merge('Add B (#22)', { 'b.txt': 'b\n', 'release-notes/0.3.0/b.md': NOTE });
  await w.merge('Note for B (#23)', { 'release-notes/0.2.0/b.md': `---\nprs: [22]\n---\n${NOTE}` }, [NO_ENTRY_LABEL]);
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/b.md names #22, which merged after 0.2.0, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/b\.md/);
  assert.match(run.error ?? '', /#22/);
});

test('a note under a published version that names one shipped pull request and one later one stops the next release', async (t) => {
  const w = await shippedThenPublished(t);
  await w.merge('Add C (#24)', { 'c.txt': 'c\n', 'release-notes/0.3.0/c.md': NOTE });
  await w.merge('Notes (#25)', { 'release-notes/0.2.0/ac.md': `---\nprs: [10, 24]\n---\n${NOTE}` }, [NO_ENTRY_LABEL]);
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/ac.md names #24, which merged after 0.2.0, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/ac\.md/);
});

test('a note under a published version that names a pull request no commit on main carries stops the next release', async (t) => {
  const w = await shippedThenPublished(t);
  await w.merge('Notes (#26)', { 'release-notes/0.2.0/ghost.md': `---\nprs: [999]\n---\n${NOTE}` }, [NO_ENTRY_LABEL]);
  const run = await w.release('0.3.0');
  assert.equal(run.staged, false, `release-notes/0.2.0/ghost.md names #999, which no commit on main carries, and 0.3.0 staged. Log:\n${run.logs.join('\n')}`);
  assert.match(run.error ?? '', /release-notes\/0\.2\.0\/ghost\.md/);
});

// The release pull request's description (issue #265). The run composes it before the gates, and GitHub
// squash-merges the release branch onto main as it stands at the merge, so a note or a FEATURES entry that
// merges during the gates ships in the release. The description has to list it too.
const LATE = 'Bellwether now does a thing that merged while the gates ran.\n';
const FEATURE_LATE = "export const FEATURES = [{ name: 'example_late', kind: 'tool', protocol: 3, version: '0.2.0', summary: 'A parent asks for an example.', prs: [11] }];\n";

test('a note and a feature that merge while the gates run reach the release pull request description', async (t) => {
  const w = await world(t);
  await w.merge('Add A (#10)', { 'a.txt': 'a\n', 'release-notes/0.2.0/a.md': NOTE });
  const run = await w.release('0.2.0', {
    duringGates: () => w.merge('Add B (#11)', { 'b.txt': 'b\n', 'release-notes/0.2.0/b.md': LATE, 'src/daemon/features.ts': FEATURE_LATE }),
  });
  assert.equal(run.staged, true, run.error);
  const body = run.description ?? '';
  assert.match(body, /^- Bellwether now does something a person reads about\. \(#10\)$/m, body);
  assert.match(body, /^- Bellwether now does a thing that merged while the gates ran\. \(#11\)$/m, `the note #11 merged during the gates is in the release, and the description leaves it out:\n${body}`);
  assert.match(body, /^- The `example_late` tool\. A parent asks for an example\.$/m, `the FEATURES entry #11 merged during the gates is in the release, and the description leaves it out:\n${body}`);
  assert.doesNotMatch(body, /doesn't record a new tool/, body);
});

test('a note filed after the release commit for a pull request it carries reaches the description on the next run', async (t) => {
  const w = await world(t);
  const first = await w.release('0.2.0', { duringGates: () => w.merge('Add B (#11)', { 'b.txt': 'b\n' }) });
  assert.deepEqual(first.missing, [11], first.error);
  await w.merge('Note for B (#12)', { 'release-notes/0.2.0/b.md': `---\nprs: [11]\n---\n${LATE}` }, [NO_ENTRY_LABEL]);
  const second = await w.release('0.2.0');
  assert.equal(second.staged, true, second.error);
  assert.match(second.description ?? '', /^- Bellwether now does a thing that merged while the gates ran\. \(#11\)$/m, second.description);
});

test('a note under the version for a pull request that merged after the release commit stays out of the description', async (t) => {
  const w = await world(t);
  await w.merge('Add A (#10)', { 'a.txt': 'a\n', 'release-notes/0.2.0/a.md': NOTE });
  const run = await w.release('0.2.0', {
    afterRelease: () => w.merge('Add C (#13)', { 'c.txt': 'c\n', 'release-notes/0.2.0/c.md': 'Bellwether now does a thing the release does not carry.\n' }),
  });
  assert.equal(run.staged, true, run.error);
  assert.match(run.description ?? '', /\(#10\)$/m, run.description);
  assert.doesNotMatch(run.description ?? '', /does not carry/, `#13 merged after the release commit, and the description lists its note:\n${run.description}`);
});
