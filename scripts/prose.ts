// The prose gate, run by the `prose` CI job and by hand.
//
// `lint` runs Vale over README.md, AGENTS.md and docs/ with the repository's
// own .vale.ini, and fails on any alert at warning level or above. That is the
// standard the pr-body check holds a pull request's description to, so a page
// and a description pass or fail by the same rules.
//
// `coverage` proves which files Vale read. It runs Vale over the same paths
// with the same configuration plus one rule, BellwetherCoverage.Read, that
// fires once in every file Vale lints, and fails when a tracked page under
// docs/ is not among them. A page that a narrower path list, a glob or a
// section of .vale.ini leaves out shows up here by name (issue #94).
//
// `lint` also renders each form of the release pull request's description
// that `npm run release` writes, and holds it to the same rules. The pr-body
// check reads that description, so a template that fails it would stop every
// release at its own pull request.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prBody } from './release.ts';
import { FEATURES } from '../src/daemon/features.ts';

/** What the lint passes to Vale. A directory covers every page under it. */
export const PROSE_PATHS = ['README.md', 'AGENTS.md', 'docs'] as const;

export const COVERAGE_STYLE = 'BellwetherCoverage';
export const COVERAGE_RULE = `${COVERAGE_STYLE}.Read`;

// One alert per file: an occurrence rule over the whole raw file, whose limit
// any file with two non-space characters exceeds. Vale reads max: 0 as no
// limit, so the limit is 1.
const READ_RULE = `extends: occurrence
message: "Vale read this file."
level: suggestion
scope: raw
max: 1
token: '\\S'
`;

/** The Markdown pages the gate must cover: README.md, AGENTS.md and every tracked page under docs/. */
export function trackedPages(root: string): string[] {
  // A git pathspec's * crosses directories, so docs/*.md lists docs/test-briefs/ too.
  const out = execFileSync('git', ['ls-files', '-z', '--', 'README.md', 'AGENTS.md', 'docs/*.md'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).sort();
}

/** The repository's configuration with a scratch StylesPath, and the read rule added to every section. */
export function coverageConfig(ini: string, stylesPath: string): string {
  return ini
    .split('\n')
    .map((line) => {
      if (/^\s*StylesPath\s*=/.test(line)) return `StylesPath = ${stylesPath}`;
      if (/^\s*BasedOnStyles\s*=/.test(line)) return `${line.trimEnd()}, ${COVERAGE_STYLE}`;
      return line;
    })
    .join('\n');
}

function vale(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('vale', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`vale did not run (${result.error.message}). Install Vale 3.20.0, the version CI pins.`);
  // Vale exits 1 when it reports an error-level alert, and 2 when it cannot run.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`vale exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}\nRun \`vale sync\` once to fetch the rule packages.`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every alert at warning level or above, one per line, in the pages and in each release description. */
export function lint(root: string): string[] {
  const pages = vale(root, ['--output=line', '--minAlertLevel=warning', ...PROSE_PATHS]).stdout.split('\n').filter(Boolean);
  return [...pages, ...releaseBodyAlerts(root)];
}

/** Each form the release pull request's description takes, by the file name its alerts carry. */
export const RELEASE_BODIES: Record<string, string> = {
  'release-body-protocol-moves.md': prBody('0.1.5', '0.1.4', { from: 3, to: 4 }, FEATURES),
  'release-body-protocol-stays.md': prBody('0.1.6', '0.1.5', undefined, FEATURES),
  'release-body-first-release.md': prBody('0.1.0', undefined, undefined, FEATURES),
  // One body per release that features.ts names, so every summary in the table passes Vale.
  ...Object.fromEntries([...new Set(FEATURES.map((feature) => feature.version))].map((version) => [`release-body-features-${version}.md`, prBody(version, undefined, undefined, FEATURES)])),
};

/**
 * The alerts at warning level or above in each release description, checked
 * as the pr-body check checks one: a copy named *.md, with the repository's
 * .vale.ini and no global configuration.
 */
export function releaseBodyAlerts(root: string): string[] {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-release-body-'));
  try {
    const files = Object.entries(RELEASE_BODIES).map(([name, body]) => {
      const file = path.join(scratch, name);
      fs.writeFileSync(file, body);
      return file;
    });
    const { stdout } = vale(root, ['--no-global', `--config=${path.join(root, '.vale.ini')}`, '--output=line', '--minAlertLevel=warning', ...files]);
    return stdout.split('\n').filter(Boolean).map((line) => line.split(scratch + path.sep).join('scripts/release.ts prBody: '));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The pages Vale read with the repository's configuration, and the tracked pages it did not read. */
export function coverage(root: string): { checked: string[]; missing: string[] } {
  const ini = fs.readFileSync(path.join(root, '.vale.ini'), 'utf8');
  const stylesPath = path.resolve(root, /^\s*StylesPath\s*=\s*(.+?)\s*$/m.exec(ini)?.[1] ?? 'styles');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-prose-'));
  try {
    const styles = path.join(scratch, 'styles');
    fs.mkdirSync(path.join(styles, COVERAGE_STYLE), { recursive: true });
    for (const entry of fs.existsSync(stylesPath) ? fs.readdirSync(stylesPath) : []) fs.symlinkSync(path.join(stylesPath, entry), path.join(styles, entry));
    fs.writeFileSync(path.join(styles, COVERAGE_STYLE, 'Read.yml'), READ_RULE);
    const config = path.join(scratch, '.vale.ini');
    fs.writeFileSync(config, coverageConfig(ini, styles));

    const { stdout } = vale(root, [`--config=${config}`, '--output=JSON', '--minAlertLevel=suggestion', ...PROSE_PATHS.filter((entry) => fs.existsSync(path.join(root, entry)))]);
    const alerts = JSON.parse(stdout || '{}') as Record<string, Array<{ Check: string }>>;
    const checked = Object.entries(alerts)
      .filter(([, list]) => list.some((alert) => alert.Check === COVERAGE_RULE))
      .map(([file]) => path.relative(root, path.resolve(root, file)))
      .sort();
    const missing = trackedPages(root).filter((page) => !checked.includes(page));
    return { checked, missing };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(mode: string | undefined): number {
  const root = path.resolve(import.meta.dirname, '..');
  if (mode === 'lint') {
    const alerts = lint(root);
    for (const alert of alerts) console.log(alert);
    if (alerts.length > 0) {
      console.error(`vale: ${alerts.length} alerts at warning level or above in ${PROSE_PATHS.join(', ')} and the release descriptions. Fix the prose; the level stays at warning.`);
      return 1;
    }
    console.log(`vale: no alerts in ${PROSE_PATHS.join(', ')} or in the ${Object.keys(RELEASE_BODIES).length} release descriptions.`);
    return 0;
  }
  if (mode === 'coverage') {
    const { checked, missing } = coverage(root);
    for (const page of checked) console.log(`read ${page}`);
    if (missing.length > 0) {
      console.error(`vale did not read ${missing.join(', ')}. Make sure ${PROSE_PATHS.join(', ')} and the sections of .vale.ini cover every tracked page.`);
      return 1;
    }
    console.log(`vale read all ${checked.length} files, including every tracked page under docs/.`);
    return 0;
  }
  console.error('usage: node scripts/prose.ts lint|coverage');
  return 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv[2]);
