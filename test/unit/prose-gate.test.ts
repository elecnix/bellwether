// The prose gate checks README.md, AGENTS.md and every page under docs/, and
// a guard proves that Vale read each tracked page. Issue #94: the CI job once
// linted two files, and nothing noticed that docs/ sat outside it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COVERAGE_RULE, coverage, coverageConfig, PROSE_PATHS, trackedPages } from '../../scripts/prose.ts';

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
