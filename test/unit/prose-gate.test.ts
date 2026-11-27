// The prose gate checks README.md, AGENTS.md and every page under docs/, and
// a guard proves that Vale read each tracked page. Issue #94: the CI job once
// linted two files, and nothing noticed that docs/ sat outside it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COVERAGE_RULE, coverage, coverageConfig, lint, valeFailure, PROSE_PATHS, RELEASE_BODIES, releaseBodyAlerts, SIGNATURE_CASES, signatureFindings, trackedPages } from '../../scripts/prose.ts';

const root = path.resolve(import.meta.dirname, '../..');

/** The text of one job in a workflow file, from its key to the next job's. */
function jobText(workflow: string, job: string): string {
  const lines = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8').split('\n');
  const start = lines.indexOf(`  ${job}:`);
  assert.ok(start >= 0, `${workflow} has a ${job} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('the prose job lints the docs at warning level and runs the coverage guard', () => {
  const job = jobText('ci.yml', 'prose');
  assert.match(job, /run: npm run check:prose\s*$/m, 'the prose job runs the lint');
  assert.match(job, /run: npm run check:prose-coverage\s*$/m, 'the prose job runs the coverage guard');
  assert.doesNotMatch(job, /min_alert_level|minAlertLevel=error/, 'the prose job holds warnings to the same standard as pr-body');
});

test('every tracked page under docs/ falls under a path the lint passes to Vale', () => {
  const pages = trackedPages(root);
  assert.ok(pages.includes('docs/harnesses.md'));
  assert.ok(pages.includes('docs/test-briefs/tier3.md'));
  for (const page of pages) {
    assert.ok(PROSE_PATHS.some((entry) => page === entry || page.startsWith(`${entry}/`)), `${page} is outside ${PROSE_PATHS.join(', ')}`);
  }
});

test('the coverage config keeps the repository sections and adds the read rule to each', () => {
  const ini = 'StylesPath = .github/vale/styles\nVocab = Bellwether\n\n[*.md]\nTokenIgnores = (x)\nBasedOnStyles = ai-tells, noslop\n\n[docs/*.txt]\nBasedOnStyles = Vale\n';
  const out = coverageConfig(ini, '/scratch/styles');
  assert.match(out, /^StylesPath = \/scratch\/styles$/m);
  assert.match(out, /^Vocab = Bellwether$/m);
  assert.match(out, /^\[\*\.md\]\nTokenIgnores = \(x\)\nBasedOnStyles = ai-tells, noslop, BellwetherCoverage$/m);
  assert.match(out, /^\[docs\/\*\.txt\]\nBasedOnStyles = Vale, BellwetherCoverage$/m);
  assert.equal(COVERAGE_RULE, 'BellwetherCoverage.Read');
});

const hasVale = spawnSync('vale', ['--version']).status === 0;

test('the coverage guard names a docs page that the Vale configuration leaves out', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-prose-'));
  try {
    fs.mkdirSync(path.join(repo, 'styles'));
    fs.mkdirSync(path.join(repo, 'docs/sub'), { recursive: true });
    for (const file of ['README.md', 'AGENTS.md', 'docs/a.md', 'docs/sub/b.md']) fs.writeFileSync(path.join(repo, file), `# ${file}\n\nA page.\n`);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');

    // A section that matches only the top-level pages leaves docs/ unread.
    fs.writeFileSync(path.join(repo, '.vale.ini'), 'StylesPath = styles\n\n[{README,AGENTS}.md]\nBasedOnStyles = Vale\n');
    assert.deepEqual(coverage(repo).missing, ['docs/a.md', 'docs/sub/b.md']);

    fs.writeFileSync(path.join(repo, '.vale.ini'), 'StylesPath = styles\n\n[*.md]\nBasedOnStyles = Vale\n');
    const all = coverage(repo);
    assert.deepEqual(all.missing, []);
    assert.deepEqual(all.checked, ['AGENTS.md', 'README.md', 'docs/a.md', 'docs/sub/b.md']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The 0.1.5 release pull request failed the pr-body check on the description
// the release script wrote: too many of its sentences opened with "The". Each
// release would have needed a hand edit, so the template is held to the rules.
test('every form of the release description passes the rules the pr-body check applies', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  assert.match(RELEASE_BODIES['release-body-protocol-moves.md']!, /moves from 3 to 4/);
  assert.match(RELEASE_BODIES['release-body-protocol-stays.md']!, /stays the same/);
  assert.doesNotMatch(RELEASE_BODIES['release-body-first-release.md']!, / since /);
  assert.deepEqual(releaseBodyAlerts(root), []);
});

test('the prose lint reports an alert in a release description', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  const original = RELEASE_BODIES['release-body-protocol-stays.md'];
  RELEASE_BODIES['release-body-protocol-stays.md'] = 'The rule. The check. The text. The body. The line. The word.\n';
  try {
    assert.ok(lint(root).some((alert) => alert.includes('scripts/release.ts prBody: release-body-protocol-stays.md') && alert.includes('SentenceStartRepetition')));
  } finally {
    RELEASE_BODIES['release-body-protocol-stays.md'] = original!;
  }
});

// Agents lost pr-body runs to the em dash that starts their signature
// (issue #138). .vale.ini ignores the signature line, and these cases keep
// that exception from growing into one for any line with an em dash.
test('the signature exception accepts each signature form and no em dash in prose', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  assert.deepEqual(signatureFindings(root), []);
});

/** The repository's .vale.ini with its TokenIgnores line replaced, in a scratch file. */
function withTokenIgnores(line: string): { config: string; cleanup: () => void } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-signature-'));
  const ini = fs.readFileSync(path.join(root, '.vale.ini'), 'utf8');
  const stylesPath = path.resolve(root, /^\s*StylesPath\s*=\s*(.+?)\s*$/m.exec(ini)![1]!);
  const config = path.join(scratch, '.vale.ini');
  fs.writeFileSync(config, ini.replace(/^StylesPath = .*$/m, `StylesPath = ${stylesPath}`).replace(/^TokenIgnores = .*$/m, line));
  return { config, cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }) };
}

test('a TokenIgnores that ignores any line starting with an em dash fails the signature cases', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  const { config, cleanup } = withTokenIgnores('TokenIgnores = (?m)^—.*$');
  try {
    const findings = signatureFindings(root, config);
    for (const name of ['dash-before-unlinked-name.md', 'dash-before-prose.md', 'dash-before-other-link.md']) {
      assert.ok(findings.some((finding) => finding.includes(name) && finding.includes('lets an em dash in prose through')), `${name} is reported`);
    }
    assert.ok(!findings.some((finding) => finding.includes('dash-in-prose.md')), 'an em dash mid-line still fails');
  } finally {
    cleanup();
  }
});

test('a .vale.ini without the signature exception fails the signature cases', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  const { config, cleanup } = withTokenIgnores('');
  try {
    const rejected = Object.entries(SIGNATURE_CASES).filter(([, { passes }]) => passes).map(([name]) => name);
    const findings = signatureFindings(root, config);
    for (const name of rejected) assert.ok(findings.some((finding) => finding.includes(name) && finding.includes('rejects a signature')), `${name} is reported`);
  } finally {
    cleanup();
  }
});

// The 0.1.6 release worktree had never run `vale sync`, and the gate surfaced
// Vale's own E100 after the whole test run (issue #134). The error names the
// command and the directory to run it in, and never asks the reader what
// StylesPath is.
const MISSING_STYLE = "E100 [loadStyles] Runtime error\n\nstyle 'ai-tells' does not exist on StylesPath\n";

test('a missing style pack reads as styles that are not synced, with the command to run', () => {
  const message = valeFailure('/work/release-0.1.6', 2, MISSING_STYLE);
  assert.match(message, /style packs are not synced/);
  assert.ok(message.includes('cd /work/release-0.1.6 && vale sync'), message);
  assert.match(message, /ai-tells/, 'the message names the missing pack');
  assert.doesNotMatch(message, /E100|loadStyles|StylesPath/, 'the message is the gate\'s, not Vale\'s');
});

test('any other failure to run Vale keeps its own text and does not blame the sync', () => {
  const message = valeFailure('/work/main', 2, 'E100 [.vale.ini] Runtime error\n\nunknown key Bogus\n');
  assert.match(message, /unknown key Bogus/);
  assert.doesNotMatch(message, /vale sync/);
});

test('the lint in a checkout that never ran vale sync names the remedy', { skip: hasVale ? false : 'vale is not on PATH' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-unsynced-'));
  try {
    fs.mkdirSync(path.join(repo, 'styles'));
    fs.mkdirSync(path.join(repo, 'docs'));
    for (const file of ['README.md', 'AGENTS.md', 'docs/a.md']) fs.writeFileSync(path.join(repo, file), `# ${file}\n\nA page.\n`);
    fs.writeFileSync(path.join(repo, '.vale.ini'), 'StylesPath = styles\n\n[*.md]\nBasedOnStyles = ai-tells\n');
    assert.throws(() => lint(repo), (error: Error) => {
      assert.ok(error.message.includes(`cd ${repo} && vale sync`), error.message);
      assert.doesNotMatch(error.message, /loadStyles|StylesPath/);
      return true;
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
