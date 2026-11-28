// The merged-work guard against real git (issue #296). Each case builds a
// scratch repository with a main and a pull request branch, then runs the
// check the pull request workflow runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkMergedWork, featureNames, REMOVES_MERGED_WORK } from '../../scripts/merged-work.ts';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_EDITOR: 'false',
};

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: GIT_ENV }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${stderr}`));
      else resolve(String(stdout).trim());
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

const NOTE = 'Bellwether now does something a person reads about.\n';

function features(entries: Record<string, string>): string {
  const lines = Object.entries(entries).map(([name, summary]) => `    ${/^\w+$/.test(name) ? name : `'${name}'`}: '${summary}',`);
  return [
    'export interface Feature {',
    "  kind: 'tool' | 'request';",
    '}',
    'const BASE: readonly Feature[] = [',
    "  ...brought('tool', 4, '0.1.3', {",
    ...lines,
    '  }),',
    '];',
    'export const FEATURES = [...BASE];',
    '',
  ].join('\n');
}

const BEFORE = { agent_spawn: 'A parent starts a child.' };
const FREEING = { ...BEFORE, agent_free: 'A parent frees a child.', 'relay-free': 'The far daemon writes the freeing.' };

/** A repository whose main has one merged pull request, #10, with its note, its feature entries and its code. */
async function repository(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'bellwether-merged-work-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--quiet', '-b', 'main']);
  const write = async (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) await rm(path.join(root, file));
      else {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      }
    }
  };
  const commit = async (subject: string, files: Record<string, string | null>) => {
    await write(files);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '--quiet', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const older = await commit('Start (#1)', { 'src/daemon/features.ts': features(BEFORE), 'src/a.ts': 'a\n' });
  await commit('Free a child (#10)', {
    'src/daemon/features.ts': features(FREEING),
    'src/free.ts': 'free\n',
    'release-notes/0.1.11/free.md': NOTE,
  });
  await git(root, ['checkout', '--quiet', '-b', 'branch']);
  const check = (labels: string[] = []) => checkMergedWork({ cwd: root, base: 'main', head: 'HEAD', labels });
  return { root, older, commit, check };
}

test('a branch that deletes a note it never added fails, and the failure names the note', async (t) => {
  const repo = await repository(t);
  await repo.commit('Tidy', { 'release-notes/0.1.11/free.md': null });
  const result = await repo.check();
  assert.equal(result.ok, false);
  assert.deepEqual(result.deletedNotes, ['release-notes/0.1.11/free.md']);
  assert.match(result.message, /release-notes\/0\.1\.11\/free\.md/);
  assert.match(result.message, new RegExp(REMOVES_MERGED_WORK));
});

test('a branch that adds a note and then deletes its own note passes', async (t) => {
  const repo = await repository(t);
  await repo.commit('Add mine', { 'src/b.ts': 'b\n', 'release-notes/0.1.12/mine.md': NOTE });
  await repo.commit('Drop mine', { 'release-notes/0.1.12/mine.md': null });
  const result = await repo.check();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.deletedNotes, []);
});

test('a branch that adds a FEATURES entry and rewords another passes', async (t) => {
  const repo = await repository(t);
  await repo.commit('Add peer_send', {
    'src/daemon/features.ts': features({ ...FREEING, agent_free: 'A parent frees a child, which becomes a peer.', peer_send: 'A pair sends messages.' }),
  });
  const result = await repo.check();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.removedFeatures, []);
});

test('a branch that removes a FEATURES entry fails, and the failure names the entry', async (t) => {
  const repo = await repository(t);
  const { agent_free: _gone, ...rest } = FREEING;
  await repo.commit('Drop agent_free', { 'src/daemon/features.ts': features(rest) });
  const result = await repo.check();
  assert.equal(result.ok, false);
  assert.deepEqual(result.removedFeatures, ['agent_free']);
  assert.match(result.message, /agent_free/);
});

test(`a branch that removes merged work passes with the ${REMOVES_MERGED_WORK} label, and still lists what it removes`, async (t) => {
  const repo = await repository(t);
  await repo.commit('Retire freeing', { 'src/daemon/features.ts': features(BEFORE), 'release-notes/0.1.11/free.md': null, 'src/free.ts': null });
  const result = await repo.check([REMOVES_MERGED_WORK]);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.deletedNotes, ['release-notes/0.1.11/free.md']);
  assert.deepEqual(result.removedFeatures, ['agent_free', 'relay-free']);
});

// The shape of e16cc52 (#289): the branch's commit names the current main as
// its parent, so the branch is not stale, but its tree is the tree from
// before #10 plus its own change. A squash merge writes that tree over main.
test('a commit on the current main that carries the tree from before another pull request fails', async (t) => {
  const repo = await repository(t);
  await git(repo.root, ['read-tree', repo.older]);
  const blob = await git(repo.root, ['hash-object', '-w', '--stdin'], 'a, fixed\n');
  await git(repo.root, ['update-index', '--cacheinfo', `100644,${blob},src/a.ts`]);
  const tree = await git(repo.root, ['write-tree']);
  const stale = await git(repo.root, ['commit-tree', tree, '-p', 'main', '-m', 'Fix a'], '');
  await git(repo.root, ['reset', '--quiet', '--hard', stale]);
  assert.equal(await git(repo.root, ['rev-parse', 'HEAD^']), await git(repo.root, ['rev-parse', 'main']), 'precondition: the branch builds on the current main');

  const result = await repo.check();
  assert.equal(result.ok, false, 'the branch reverts #10 and the guard passed it');
  assert.deepEqual(result.deletedNotes, ['release-notes/0.1.11/free.md']);
  assert.deepEqual(result.removedFeatures, ['agent_free', 'relay-free']);
});

test('a stale branch whose main moved on passes, because the check compares against the merge base', async (t) => {
  const repo = await repository(t);
  await repo.commit('Fix a', { 'src/a.ts': 'a, fixed\n' });
  await git(repo.root, ['checkout', '--quiet', 'main']);
  await repo.commit('Remove a note on main (#11)', { 'release-notes/0.1.11/free.md': null });
  await git(repo.root, ['checkout', '--quiet', 'branch']);
  const result = await repo.check();
  assert.equal(result.ok, true, result.message);
});

test('feature names come from the BASE table only, never from an interface field', () => {
  assert.deepEqual(featureNames(features(FREEING)), ['agent_free', 'agent_spawn', 'relay-free']);
  assert.deepEqual(featureNames(''), []);
});
