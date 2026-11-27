import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bumpFormula, compareVersions, prBody, protocolOf, release, ReleaseError, type ReleaseDeps, type RunOptions, type RunResult } from '../../scripts/release.ts';

const TARBALL = 'https://registry.npmjs.org/@elecnix/bellwether/-/bellwether-0.1.4.tgz';
const FORMULA = [
  'class Bellwether < Formula',
  '  url "https://registry.npmjs.org/@elecnix/bellwether/-/bellwether-0.1.3.tgz"',
  `  sha256 "${'a'.repeat(64)}"`,
  'end',
  '',
].join('\n');

interface World {
  published: string[];
  latest: string;
  stages: Array<Array<{ id: string; packageName: string; version: string; status: string }>>;
  mainVersion: string;
  prs: Array<{ number: number; state: string; url: string }>;
  monitor: string;
  dirty: string;
  ciConclusion: string;
  formulaOnMain: string;
}

/** A scripted npm, git and gh. Each call is recorded as one line, and the world answers it. */
async function harness(overrides: Partial<World> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'release-test-'));
  const top = path.join(root, 'main');
  await mkdir(top);
  const world: World = {
    published: ['0.1.3'],
    latest: '0.1.3',
    stages: [[]],
    mainVersion: '0.1.3',
    prs: [],
    monitor: '{"type":"ci-all-green"}',
    dirty: '',
    ciConclusion: 'success',
    formulaOnMain: FORMULA,
    ...overrides,
  };
  const calls: string[] = [];
  const logs: string[] = [];
  let sleeps = 0;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const content = (text: string) => ok(JSON.stringify({ content: Buffer.from(text).toString('base64'), sha: 'blob1' }));

  const run = async (cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (line.startsWith('npm view @elecnix/bellwether@') && line.endsWith(' version')) {
      const version = args[1]!.split('@').pop()!;
      return world.published.includes(version) ? ok(`${version}\n`) : { code: 1, stdout: '', stderr: 'npm error code E404' };
    }
    if (line === 'npm view @elecnix/bellwether dist-tags.latest') return ok(`${world.latest}\n`);
    if (line.endsWith('dist.tarball')) {
      const version = args[1]!.split('@').pop()!;
      return ok(`https://registry.npmjs.org/@elecnix/bellwether/-/bellwether-${version}.tgz\n`);
    }
    if (line.startsWith('npx -y npm@12 stage list')) return ok(JSON.stringify(world.stages.length > 1 ? world.stages.shift() : world.stages[0]));
    if (line.startsWith('npx -y npm@12 stage publish')) {
      world.stages = [[{ id: 'stage-1', packageName: '@elecnix/bellwether', version: '0.1.4', status: 'staged' }]];
      return ok();
    }
    if (line === 'git rev-parse --show-toplevel') return ok(`${top}\n`);
    if (line === 'git show origin/main:package.json') return ok(JSON.stringify({ version: world.mainVersion }));
    if (line.startsWith('git log -1')) return ok('c0ffee\n');
    if (line === 'git rev-parse origin/main') return ok('abc1234def\n');
    if (line.startsWith('git status --porcelain')) return ok(world.dirty);
    if (line.startsWith('git rev-parse --verify')) return { code: 1, stdout: '', stderr: '' };
    if (line.startsWith('git worktree add')) {
      const tree = args.find((arg) => arg.includes('release-'))!;
      await mkdir(path.join(tree, 'src/daemon'), { recursive: true });
      await writeFile(path.join(tree, 'src/daemon/protocol.ts'), 'export const DAEMON_PROTOCOL = 3;\n');
      await writeFile(path.join(tree, 'package.json'), JSON.stringify({ version: world.mainVersion }));
      return ok();
    }
    if (line.startsWith('npm version')) {
      await writeFile(path.join(options.cwd!, 'package.json'), JSON.stringify({ version: args[1] }));
      return ok();
    }
    if (line.startsWith('git checkout')) {
      await writeFile(path.join(options.cwd!, 'package.json'), JSON.stringify({ version: world.mainVersion }));
      return ok();
    }
    if (line.startsWith('gh run list')) return ok(JSON.stringify([{ databaseId: 7, status: 'completed', conclusion: world.ciConclusion }]));
    if (line.startsWith('gh pr list')) {
      const head = args[args.indexOf('--head') + 1]!;
      return ok(JSON.stringify(world.prs.filter((pr) => pr.url.includes(head.startsWith('release/') ? 'bellwether/' : 'homebrew-tap/'))));
    }
    if (line.startsWith('gh pr create -R elecnix/bellwether')) {
      world.prs.push({ number: 40, state: 'OPEN', url: 'https://github.com/elecnix/bellwether/pull/40' });
      return ok('https://github.com/elecnix/bellwether/pull/40\n');
    }
    if (line.startsWith('gh pr create -R elecnix/homebrew-tap')) {
      world.prs.push({ number: 7, state: 'OPEN', url: 'https://github.com/elecnix/homebrew-tap/pull/7' });
      return ok();
    }
    if (line.startsWith('gh monitor')) return ok(`{"type":"first-poll"}\n${world.monitor}\n`);
    if (line.startsWith('gh pr merge')) {
      for (const pr of world.prs) if (pr.state === 'OPEN') pr.state = 'MERGED';
      world.mainVersion = '0.1.4';
      return ok();
    }
    if (line.includes('contents/Formula/bellwether.rb?ref=main')) return content(world.formulaOnMain);
    if (line.includes('contents/Formula/bellwether.rb?ref=')) return content(FORMULA);
    if (line.includes('git/ref/heads/bellwether-')) return { code: 1, stdout: '', stderr: 'Not Found' };
    if (line.includes('git/ref/heads/main')) return ok('base1\n');
    if (line.startsWith('tar -xzOf')) return ok('export const DAEMON_PROTOCOL = 2;\n');
    return ok();
  };

  const deps: ReleaseDeps = {
    run,
    fetchBytes: async () => new TextEncoder().encode('tarball'),
    sleep: async () => { sleeps++; },
    log: (line) => logs.push(line),
    cwd: top,
  };
  return { deps, world, calls, logs, root, sleeps: () => sleeps };
}

test('a version that is not three numbers is refused before any command runs', async () => {
  const h = await harness();
  await assert.rejects(release({ version: 'v0.1.4' }, h.deps), /must look like 1\.2\.3/);
  assert.deepEqual(h.calls, []);
});

test('a version that is not newer than the published latest is refused', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.5'], latest: '0.1.5' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /not newer than 0\.1\.5/);
});

test('a fresh release runs the gates, bumps, opens and merges the pull request, then stages from the merged commit', async () => {
  const h = await harness();
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.deepEqual(outcome, {
    state: 'awaiting-approval',
    stageId: 'stage-1',
    approve: 'npx -y npm@12 stage approve stage-1 --otp <code>',
    protocolChange: { from: 2, to: 3 },
  });
  const order = ['npm run typecheck', 'npm test', 'npm run doctor', 'npm version 0.1.4 --no-git-tag-version', 'git commit', 'git push', 'gh pr create -R elecnix/bellwether', 'gh monitor 40', 'gh pr merge 40', 'git checkout --quiet --detach c0ffee', 'npx -y npm@12 stage publish'];
  let at = -1;
  for (const step of order) {
    const next = h.calls.findIndex((call, index) => index > at && call.startsWith(step));
    assert.ok(next > at, `${step} runs after the step before it:\n${h.calls.join('\n')}`);
    at = next;
  }
  assert.ok(!h.calls.some((call) => call.includes('stage approve')), 'the script never approves');
});

test('a dirty tree is refused before anything is pushed', async () => {
  const h = await harness({ dirty: ' M src/cli.ts\n' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /uncommitted changes/);
  assert.ok(!h.calls.some((call) => call.startsWith('git push') || call.startsWith('npm version')));
});

test('a red main is refused before the gates run', async () => {
  const h = await harness({ ciConclusion: 'failure' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /ended failure/);
  assert.ok(!h.calls.some((call) => call.startsWith('npm test')));
});

test('a second run resumes the open release pull request instead of opening another', async () => {
  const h = await harness({ prs: [{ number: 40, state: 'OPEN', url: 'https://github.com/elecnix/bellwether/pull/40' }] });
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.equal(outcome.state, 'awaiting-approval');
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr create')));
  assert.ok(!h.calls.some((call) => call.startsWith('npm test')), 'the gates ran when the pull request was opened');
  assert.ok(h.calls.some((call) => call.startsWith('gh pr merge 40')));
});

test('a failing check stops the release without a merge', async () => {
  const h = await harness({ monitor: '{"type":"new-failing-checks"}' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /failing checks/);
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr merge')));
});

test('a merged release with nothing staged goes straight to stage publish', async () => {
  const h = await harness({ mainVersion: '0.1.4' });
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.equal(outcome.state, 'awaiting-approval');
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr')));
  assert.ok(h.calls.some((call) => call.startsWith('git worktree add --detach')));
});

test('a staged version under review is waited on, then the approve command is returned', async () => {
  const item = { id: 'stage-9', packageName: '@elecnix/bellwether', version: '0.1.4' };
  const h = await harness({ stages: [[{ ...item, status: 'validating' }], [{ ...item, status: 'validating' }], [{ ...item, status: 'staged' }]] });
  const outcome = await release({ version: '0.1.4', pollMs: 1 }, h.deps);
  assert.equal(outcome.state, 'awaiting-approval');
  assert.equal(h.sleeps(), 2);
  assert.ok(!h.calls.some((call) => call.startsWith('git') || call.includes('stage publish')), 'a staged run touches neither git nor the stage');
});

test('a staged version the review rejected stops with its status', async () => {
  const h = await harness({ stages: [[{ id: 'stage-9', packageName: '@elecnix/bellwether', version: '0.1.4', status: 'rejected' }]] });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /is rejected/);
});

test('a review that never finishes times out with an instruction to run again', async () => {
  const h = await harness({ stages: [[{ id: 'stage-9', packageName: '@elecnix/bellwether', version: '0.1.4', status: 'validating' }]] });
  await assert.rejects(release({ version: '0.1.4', pollMs: 10, validateTimeoutMs: 30 }, h.deps), /still validating/);
});

test('a published version opens and merges the tap pull request with the new url and sha256', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4' });
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'merged', tapPr: 'https://github.com/elecnix/homebrew-tap/pull/7' });
  const put = h.calls.find((call) => call.startsWith('gh api -X PUT'))!;
  const text = Buffer.from(put.split('content=')[1]!, 'base64').toString('utf8');
  assert.match(text, new RegExp(`url "${TARBALL}"`));
  assert.match(text, new RegExp(`sha256 "${createHash('sha256').update('tarball').digest('hex')}"`));
  assert.ok(h.calls.some((call) => call.startsWith('gh pr merge 7 -R elecnix/homebrew-tap')));
});

test('a published version whose formula already points at it changes nothing', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: bumpFormula(FORMULA, TARBALL, 'b'.repeat(64)) });
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'current' });
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr') || call.includes('-X')));
});

test('an older published version leaves the tap alone, so the formula never moves backwards', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4' });
  const outcome = await release({ version: '0.1.3' }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'skipped' });
  assert.ok(!h.calls.some((call) => call.startsWith('gh')));
});

test('a registry that cannot be reached stops the release instead of reading as unpublished', async () => {
  const h = await harness();
  const run = h.deps.run;
  h.deps.run = async (cmd, args, options) => (cmd === 'npm' && args[0] === 'view' ? { code: 1, stdout: '', stderr: 'npm error code ENOTFOUND' } : run(cmd, args, options));
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /npm view failed/);
});

test('bumpFormula replaces only the url and the sha256', () => {
  const next = bumpFormula(FORMULA, TARBALL, 'b'.repeat(64));
  assert.equal(next, FORMULA.replace('0.1.3', '0.1.4').replace('a'.repeat(64), 'b'.repeat(64)));
  assert.throws(() => bumpFormula('class X < Formula\nend\n', TARBALL, 'b'.repeat(64)), ReleaseError);
});

test('versions compare by number, and the protocol is read from either source form', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0);
  assert.equal(protocolOf('export const DAEMON_PROTOCOL = 3;'), 3);
  assert.equal(protocolOf('nothing here'), undefined);
});

test('the pull request body says whether the protocol moves', () => {
  assert.match(prBody('0.1.4', '0.1.3', { from: 2, to: 3 }), /moves from 2 to 3/);
  assert.match(prBody('0.1.4', '0.1.3', undefined), /stays the same/);
});
