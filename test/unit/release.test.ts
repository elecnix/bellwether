import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FEATURES, type Feature } from '../../src/daemon/features.ts';
import { approvalNotice, bumpFormula, compareVersions, featureLine, installNotice, prBody, protocolOf, release, ReleaseError, SITE_TIMEOUT_MS, staleSiteMessage, type ReleaseDeps, type RunOptions, type RunResult } from '../../scripts/release.ts';
import { bylineOpening, SITE_URL } from '../../scripts/site-version.ts';

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
  /** What `npm install --global` of the release tarball answers over the previous version, when it fails. */
  installOver?: RunResult;
  /** What the installed `bellwether --version` prints. */
  installedVersion?: string;
  /** The version each read of the deployed site names, in order; the last one repeats. */
  site: string[];
  /** The feature table in the release tree's `src/daemon/features.ts`. */
  treeFeatures: Feature[];
  /** What `vale sync` answers in the release worktree. */
  valeSync?: RunResult;
}

/** A documentation page as the pages workflow deploys it, with the byline that names `version`. */
const sitePage = (version: string): string => `<main><h1 id="bellwether">Bellwether</h1>${bylineOpening(version)}≈ 3 min read · </p></main>`;

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
    site: ['0.1.4'],
    treeFeatures: [],
    ...overrides,
  };
  const calls: string[] = [];
  const logs: string[] = [];
  const bodies: string[] = [];
  let sleeps = 0;
  const siteReads: string[] = [];
  const syncDirs: string[] = [];
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
    if (line === 'git show origin/main:package.json') return ok(JSON.stringify({ type: 'module', version: world.mainVersion }));
    if (line.startsWith('git log -1')) return ok('c0ffee\n');
    if (line === 'git rev-parse origin/main') return ok('abc1234def\n');
    if (line.startsWith('git status --porcelain')) return ok(world.dirty);
    if (line.startsWith('git rev-parse --verify')) return { code: 1, stdout: '', stderr: '' };
    if (line.startsWith('git worktree add')) {
      const tree = args.find((arg) => arg.includes('release-'))!;
      await mkdir(path.join(tree, 'src/daemon'), { recursive: true });
      await writeFile(path.join(tree, 'src/daemon/protocol.ts'), 'export const DAEMON_PROTOCOL = 3;\n');
      await writeFile(path.join(tree, 'src/daemon/features.ts'), `export const FEATURES = ${JSON.stringify(world.treeFeatures)};\n`);
      await writeFile(path.join(tree, 'package.json'), JSON.stringify({ type: 'module', version: world.mainVersion }));
      await mkdir(path.join(tree, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(tree, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'bellwether', version: world.mainVersion }, null, 2)}\n`);
      return ok();
    }
    if (line === 'vale sync') {
      syncDirs.push(options.cwd ?? '');
      return world.valeSync ?? ok();
    }
    if (line.startsWith('npm version')) {
      await writeFile(path.join(options.cwd!, 'package.json'), JSON.stringify({ type: 'module', version: args[1] }));
      return ok();
    }
    if (line.startsWith('git checkout')) {
      await writeFile(path.join(options.cwd!, 'package.json'), JSON.stringify({ type: 'module', version: world.mainVersion }));
      return ok();
    }
    if (line.startsWith('gh run list')) return ok(JSON.stringify([{ databaseId: 7, status: 'completed', conclusion: world.ciConclusion }]));
    if (line.startsWith('gh pr list')) {
      const head = args[args.indexOf('--head') + 1]!;
      return ok(JSON.stringify(world.prs.filter((pr) => pr.url.includes(head.startsWith('release/') ? 'bellwether/' : 'homebrew-tap/'))));
    }
    if (line.startsWith('gh pr create -R elecnix/bellwether')) {
      bodies.push(await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8'));
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
    if (line.startsWith('npm pack')) return ok(JSON.stringify([{ filename: 'elecnix-bellwether-0.1.4.tgz' }]));
    if (line.startsWith('npm install --global')) {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      if (world.installOver && args.at(-1)!.endsWith('.tgz') && path.basename(prefix) === 'over') return world.installOver;
      return ok();
    }
    if (cmd.endsWith(`${path.sep}bin${path.sep}bellwether`)) {
      return args[0] === '--version' ? ok(`${world.installedVersion ?? '0.1.4'}\n`) : ok('  relay-bridge                             join stdin and stdout to this machine\'s daemon\n');
    }
    return ok();
  };

  const deps: ReleaseDeps = {
    run,
    fetchBytes: async () => new TextEncoder().encode('tarball'),
    fetchText: async (url) => {
      siteReads.push(url);
      const version = world.site.length > 1 ? world.site.shift()! : world.site[0]!;
      return { status: 200, text: sitePage(version) };
    },
    sleep: async () => { sleeps++; },
    log: (line) => logs.push(line),
    cwd: top,
  };
  return { deps, world, calls, logs, bodies, root, siteReads, syncDirs, sleeps: () => sleeps };
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

  const tree = path.join(h.root, 'release-0.1.4');
  const plugin = JSON.parse(await readFile(path.join(tree, '.claude-plugin/plugin.json'), 'utf8')) as { version?: string };
  assert.equal(plugin.version, '0.1.4', 'the release bumps the plugin manifest with the package');
  const commit = h.calls.find((call) => call.startsWith('git commit'))!;
  assert.match(commit, /\.claude-plugin\/plugin\.json/, 'the release commit carries the plugin manifest');
});

test('a dirty tree is refused before anything is pushed', async () => {
  const h = await harness({ dirty: ' M src/cli.ts\n' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /uncommitted changes/);
  assert.ok(!h.calls.some((call) => call.startsWith('git push') || call.startsWith('npm version')));
});

// The 0.1.6 release stopped after its whole test run: the fresh worktree had
// never run `vale sync`, so the prose gate found no style pack (issue #134).
test('a fresh release syncs the prose styles in its worktree before the gates', async () => {
  const h = await harness();
  await release({ version: '0.1.4' }, h.deps);
  const tree = path.join(h.root, 'release-0.1.4');
  assert.deepEqual(h.syncDirs, [tree], 'vale sync runs once, in the release worktree');
  const order = ['npm ci', 'vale sync', 'npm run typecheck', 'npm test'];
  let at = -1;
  for (const step of order) {
    const next = h.calls.findIndex((call, index) => index > at && call === step);
    assert.ok(next > at, `${step} runs after the step before it:\n${h.calls.join('\n')}`);
    at = next;
  }
});

test('a vale sync that fails stops the release before the tests, naming the command', async () => {
  const h = await harness({ valeSync: { code: 2, stdout: '', stderr: 'E100 [sync] Runtime error\ndial tcp: lookup github.com: no such host' } });
  const error = await release({ version: '0.1.4' }, h.deps).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof ReleaseError, String(error));
  const tree = path.join(h.root, 'release-0.1.4');
  assert.match(error.message, /`vale sync` failed in /);
  assert.ok(error.message.includes(`cd ${tree} && vale sync`), error.message);
  assert.match(error.message, /no such host/, 'the error keeps what Vale said');
  assert.ok(!h.calls.some((call) => call === 'npm test' || call === 'npm run typecheck'), 'no gate runs without the styles');
  assert.ok(!h.calls.some((call) => call.startsWith('git push')), 'nothing is pushed');
});

test('a release on a machine without Vale names the version to install', async () => {
  const h = await harness({ valeSync: { code: 127, stdout: '', stderr: 'Error: spawn vale ENOENT' } });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /Install Vale 3\.20\.0/);
  assert.ok(!h.calls.some((call) => call === 'npm test'));
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
  assert.deepEqual(outcome, { state: 'published', formula: 'merged', tapPr: 'https://github.com/elecnix/homebrew-tap/pull/7', site: 'current' });
  const put = h.calls.find((call) => call.startsWith('gh api -X PUT'))!;
  const text = Buffer.from(put.split('content=')[1]!, 'base64').toString('utf8');
  assert.match(text, new RegExp(`url "${TARBALL}"`));
  assert.match(text, new RegExp(`sha256 "${createHash('sha256').update('tarball').digest('hex')}"`));
  assert.ok(h.calls.some((call) => call.startsWith('gh pr merge 7 -R elecnix/homebrew-tap')));
});

test('a published version whose formula already points at it changes nothing', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: bumpFormula(FORMULA, TARBALL, 'b'.repeat(64)) });
  const outcome = await release({ version: '0.1.4' }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'current', site: 'current' });
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr') || call.includes('-X')));
});

test('an older published version leaves the tap alone, so the formula never moves backwards', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4' });
  const outcome = await release({ version: '0.1.3' }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'skipped', site: 'superseded' });
  assert.ok(!h.calls.some((call) => call.startsWith('gh')));
  assert.deepEqual(h.siteReads, [], 'the site names the newer version, so it is not read');
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
  assert.match(prBody('0.1.4', '0.1.3', { from: 2, to: 3 }, FEATURES), /moves from 2 to 3/);
  assert.match(prBody('0.1.4', '0.1.3', undefined, FEATURES), /stays the same/);
});

test('the pull request body lists every feature that features.ts records under the released version', () => {
  const versions = [...new Set(FEATURES.map((feature) => feature.version))];
  assert.ok(versions.includes('0.1.6'), 'features.ts records the ancestry request under 0.1.6');
  for (const version of versions) {
    const body = prBody(version, undefined, undefined, FEATURES);
    for (const feature of FEATURES) {
      const line = featureLine(feature);
      assert.match(line, new RegExp(`\`${feature.name.split(/[.=]/).pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``), `the line for ${feature.name} names it`);
      assert.ok(line.includes(feature.summary), `the line for ${feature.name} carries its summary`);
      if (feature.version === version) assert.ok(body.includes(line), `the ${version} body omits ${feature.name}:\n${body}`);
      else assert.ok(!body.includes(line), `the ${version} body lists ${feature.name}, which ${feature.version} brought:\n${body}`);
    }
  }
  assert.match(prBody('0.1.6', '0.1.5', undefined, FEATURES), /^- The `ancestry` request\. /m);
});

test('a feature added for a release appears in its body, and a release without one says so', () => {
  const base: Feature[] = [{ name: 'hello', kind: 'request', protocol: 2, version: '0.1.3', summary: 'A session opens its connection.' }];
  const added: Feature = { name: 'example_tool', kind: 'tool', protocol: 4, version: '0.1.4', summary: 'A parent asks for an example.' };
  const kind: Feature = { name: 'agent_spawn.kind=example', kind: 'argument', protocol: 4, version: '0.1.4', summary: 'Starts an Example child.' };
  const without = prBody('0.1.4', '0.1.3', undefined, base);
  assert.doesNotMatch(without, /example/);
  assert.match(without, /doesn't record a new tool, request, notice or argument under 0\.1\.4/);
  const body = prBody('0.1.4', '0.1.3', undefined, [...base, added, kind]);
  assert.match(body, /^- The `example_tool` tool\. A parent asks for an example\.$/m);
  assert.match(body, /^- The `example` kind of `agent_spawn`\. Starts an Example child\.$/m);
  assert.doesNotMatch(body, /`hello`/, 'a feature from an earlier release stays out');
  assert.doesNotMatch(body, /doesn't record/);
});

test('the release pull request lists the features recorded in the tree it releases', async () => {
  const h = await harness({ treeFeatures: [{ name: 'example_tool', kind: 'tool', protocol: 3, version: '0.1.4', summary: 'A parent asks for an example.' }] });
  await release({ version: '0.1.4' }, h.deps);
  assert.match(h.bodies[0]!, /^- The `example_tool` tool\. A parent asks for an example\.$/m, h.bodies[0]);
});

test('each release message points at a docs file that exists, never at the README', async () => {
  const { readFile } = await import('node:fs/promises');
  const messages = [
    prBody('0.1.4', '0.1.3', { from: 2, to: 3 }, FEATURES),
    approvalNotice({ from: 2, to: 3 }),
    installNotice('0.1.4', 'the tap formula already points at 0.1.4'),
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /README/);
    const docs = [...message.matchAll(/docs\/[a-z-]+\.md(?:#([a-z0-9-]+))?/g)];
    assert.ok(docs.length > 0, `no docs pointer in: ${message}`);
    for (const match of docs) {
      const [pathPart, anchor] = match[0].split('#');
      const text = await readFile(path.join(import.meta.dirname, '../..', pathPart!), 'utf8');
      if (anchor) {
        const slugs = [...text.matchAll(/^#+ (.+)$/gm)].map((h) => h[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
        assert.ok(slugs.includes(anchor), `${pathPart} has no heading for #${anchor}`);
      }
    }
  }
});

test('the release tarball installs into an empty global prefix and over the published latest before it is staged', async () => {
  const h = await harness({ mainVersion: '0.1.4' });
  await release({ version: '0.1.4' }, h.deps);
  const pack = h.calls.findIndex((call) => call.startsWith('npm pack'));
  const installs = h.calls.filter((call) => call.startsWith('npm install'));
  const stage = h.calls.findIndex((call) => call.startsWith('npx -y npm@12 stage publish'));
  assert.ok(pack >= 0 && pack < stage, h.calls.join('\n'));
  assert.equal(installs.length, 3, installs.join('\n'));
  for (const call of installs) assert.match(call, /^npm install --global --prefix \S+bellwether-install-\S+ /, 'every install names a throwaway prefix, never the real global one');
  assert.match(installs[0]!, /\/empty .*\.tgz$/);
  assert.match(installs[1]!, /\/over .*@elecnix\/bellwether@0\.1\.3$/, 'the previous version goes in first');
  assert.match(installs[2]!, /\/over .*\.tgz$/, 'then the release tarball goes over it');
  const checks = h.calls.filter((call) => call.includes(`${path.sep}bin${path.sep}bellwether `));
  assert.deepEqual(checks.map((call) => call.split(' ').slice(1).join(' ')), ['--version', 'help', '--version', 'help']);
  assert.ok(h.calls.findLastIndex((call) => call.includes(`${path.sep}bin${path.sep}bellwether `)) < stage, 'every check runs before the stage');
});

test('a release tarball that fails to install over the published latest stops the release before it is staged', async () => {
  const installOver = { code: 217, stdout: '', stderr: "npm ERR! code ENOTEMPTY\nnpm ERR! syscall rename\nnpm ERR! ENOTEMPTY: directory not empty, rename '/p/lib/node_modules/@elecnix/bellwether' -> '/p/lib/node_modules/@elecnix/.bellwether-Ab12'\n" };
  const h = await harness({ mainVersion: '0.1.4', installOver });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), (error: Error) => {
    assert.match(error.message, /over 0\.1\.3/);
    assert.match(error.message, /npm exited with 217/);
    assert.match(error.message, /ENOTEMPTY: directory not empty/);
    return true;
  });
  assert.ok(!h.calls.some((call) => call.includes('stage publish')), 'nothing was staged');
});

test('an installed release that reports another version or lacks relay-bridge stops before it is staged', async () => {
  const h = await harness({ mainVersion: '0.1.4', installedVersion: '0.1.3' });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), /into an empty global prefix.*prints 0\.1\.3, not 0\.1\.4/s);
  assert.ok(!h.calls.some((call) => call.includes('stage publish')));
});

const CURRENT_FORMULA = bumpFormula(FORMULA, TARBALL, 'b'.repeat(64));

test('a published release ends once the deployed site names the new version', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: CURRENT_FORMULA, site: ['0.1.3', '0.1.3', '0.1.4'] });
  const outcome = await release({ version: '0.1.4', sitePollMs: 30_000 }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'current', site: 'current' });
  assert.deepEqual(h.siteReads, [SITE_URL, SITE_URL, SITE_URL]);
  assert.equal(h.sleeps(), 2, 'one wait between each pair of reads');
  assert.ok(h.logs.includes(`the documentation site at ${SITE_URL} names 0.1.4`), h.logs.join('\n'));
});

test('a deployed site that keeps the old version past the bound fails the release, naming the url and both versions', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: CURRENT_FORMULA, site: ['0.1.3'] });
  await assert.rejects(release({ version: '0.1.4' }, h.deps), (error: Error) => {
    assert.ok(error instanceof ReleaseError);
    assert.equal(error.message, staleSiteMessage('0.1.4', SITE_URL, '0.1.3', 15));
    assert.match(error.message, /https:\/\/elecnix\.github\.io\/bellwether\/ still shows 0\.1\.3 after 15 minutes, not 0\.1\.4/);
    assert.match(error.message, /gh workflow run pages\.yml/);
    assert.match(error.message, /npm run site/);
    return true;
  });
  assert.equal(h.sleeps(), SITE_TIMEOUT_MS / 30_000, 'the default bound is fifteen minutes of thirty-second waits');
  assert.equal(h.siteReads.length, h.sleeps() + 1);
});

test('--skip-site ends the release without reading the site, and says so', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: CURRENT_FORMULA, site: ['0.1.3'] });
  const outcome = await release({ version: '0.1.4', skipSite: true }, h.deps);
  assert.deepEqual(outcome, { state: 'published', formula: 'current', site: 'skipped' });
  assert.deepEqual(h.siteReads, []);
  assert.ok(h.logs.some((line) => line.startsWith('--skip-site:') && line.includes(SITE_URL)), h.logs.join('\n'));
});

test('a site that cannot be read counts as stale, and the error says what the read found', async () => {
  const h = await harness({ published: ['0.1.3', '0.1.4'], latest: '0.1.4', formulaOnMain: CURRENT_FORMULA });
  h.deps.fetchText = async () => { throw new Error('getaddrinfo ENOTFOUND elecnix.github.io'); };
  await assert.rejects(release({ version: '0.1.4', sitePollMs: 1, siteTimeoutMs: 2 }, h.deps), /still shows no page \(getaddrinfo ENOTFOUND elecnix\.github\.io\)/);
});
