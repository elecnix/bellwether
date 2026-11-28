import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, PAGES } from '../../scripts/build-site.ts';
import { bylineVersion } from '../../scripts/site-version.ts';

const out = mkdtempSync(join(tmpdir(), 'bellwether-site-'));
const built = buildSite({ outDir: out });
const page = (name: string): string => readFileSync(join(out, name), 'utf8');

test('the site has one HTML file per page, in reading order, and nothing else', () => {
  assert.deepEqual(PAGES.map((p) => p.source), [
    'README.md',
    'docs/install.md',
    'docs/tools.md',
    'docs/recovery.md',
    'docs/remote-machines.md',
    'docs/moving.md',
    'docs/teleporting.md',
    'docs/liberation.md',
    'docs/routes.md',
    'docs/harnesses.md',
    'docs/opencode.md',
    'docs/codex.md',
    'docs/kilo.md',
    'docs/upgrading.md',
    'docs/releasing.md',
  ]);
  assert.deepEqual(readdirSync(out).sort(), [...PAGES.map((p) => p.output), '.nojekyll'].sort());
  assert.deepEqual(built.map((b) => b.output), PAGES.map((p) => p.output));
});

test('each page renders from its Markdown, so an edit to docs/ reaches the site', () => {
  assert.match(page('index.html'), /<h1 id="bellwether">Bellwether<\/h1>/);
  assert.match(page('tools.html'), /<td><code>agent_spawn<\/code><\/td>/);
  assert.match(page('remote-machines.html'), /<h2 id="report-path">Report path<\/h2>/);
});

test('each page stands alone: no stylesheet, script, image or font from a file or the network', () => {
  for (const { output } of PAGES) {
    const html = page(output);
    assert.doesNotMatch(html, /<link\b[^>]*rel="?stylesheet/i, output);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i, output);
    assert.doesNotMatch(html, /<img\b/i, output);
    assert.doesNotMatch(html, /@import|@font-face|url\(/i, output);
  }
});

test('each page is accessible by default: lang, its own title, a skip link and one h1', () => {
  for (const { output } of PAGES) {
    const html = page(output);
    assert.match(html, /<html lang="en"/, output);
    assert.match(html, /<a class="skip" href="#content">/, output);
    assert.match(html, /<main id="content"/, output);
    assert.equal(html.match(/<h1\b/g)?.length, 1, output);
  }
  assert.match(page('index.html'), /<title>Bellwether<\/title>/);
  assert.match(page('tools.html'), /<title>Tools and events · Bellwether<\/title>/);
});

test('headings descend one level at a time', () => {
  for (const { output } of PAGES) {
    const levels = [...page(output).matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    levels.forEach((level, i) => {
      if (i > 0) assert.ok(level <= levels[i - 1]! + 1, `${output}: h${levels[i - 1]} then h${level}`);
    });
  }
});

test('the rail lists the pages in order, marks the current one, and nests its headings', () => {
  const html = page('recovery.html');
  const nav = html.slice(html.indexOf('<nav id="railnav"'), html.indexOf('</nav>', html.indexOf('<nav id="railnav"')));
  const hrefs = [...nav.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, PAGES.map((p) => p.output));
  assert.match(nav, /<a href="recovery.html" aria-current="page">/);
  assert.match(nav, /<a class="sub" href="#a-blocked-or-stuck-child">A blocked or stuck child<\/a>/);
  assert.match(html, /<aside class="rail" id="rail" data-open="true">/);
});

test('a link to a published page goes to its HTML, and one to an unpublished file goes to GitHub', () => {
  assert.match(page('index.html'), /href="remote-machines.html"/);
  assert.match(page('index.html'), /href="https:\/\/github.com\/elecnix\/bellwether\/blob\/main\/AGENTS.md"/);
  assert.match(page('install.html'), /href="index.html#install"/);
  assert.match(page('install.html'),
    /href="https:\/\/github.com\/elecnix\/bellwether\/blob\/main\/docs\/probes.md#7-starting-the-channel-with---channels-instead-of-the-development-flag"/);
  assert.match(page('releasing.html'), /href="upgrading.html"/);
  for (const { output } of PAGES) {
    for (const [, href] of page(output).matchAll(/href="([^"]+)"/g)) {
      if (/\.md(#|$)/.test(href!)) assert.ok(href!.startsWith('https://github.com/'), `${output}: ${href}`);
    }
  }
});

test('tables scroll sideways inside their own wrapper', () => {
  assert.match(page('tools.html'), /<div class="table-wrap"><table>/);
});

test('the byline gives the version and a reading time', () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
  assert.match(page('releasing.html'), new RegExp(`<p class="byline">Bellwether ${version.replaceAll('.', '\\.')} · ≈ \\d+ min read`));
});

test('only a paragraph right under the page title becomes the lead', () => {
  assert.match(page('index.html'), /<p class="lead">Bellwether lets a coding agent/);
  assert.doesNotMatch(page('recovery.html'), /class="lead"/);
});

test('the rail stands 88px clear of the column, and the column keeps its 980px', () => {
  // 236px rail + 88px gap + 980px column + two 16px gutters = 1336px.
  const wrap = page('index.html').match(/\.wrap \{[^}]*\}/)?.[0] ?? '';
  assert.match(wrap, /grid-template-columns: 236px minmax\(0, 980px\);/);
  assert.match(wrap, /gap: 88px;/);
  assert.match(wrap, /max-width: 1336px;/);
});

test('each page byline names the version in package.json, which the release reads back from the deployed site', () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string };
  for (const { output } of PAGES) assert.equal(bylineVersion(page(output)), version, output);
});

test('a build whose pages lose the byline fails instead of publishing a site the release cannot check', () => {
  const repo = join(import.meta.dirname, '../..');
  const root = mkdtempSync(join(tmpdir(), 'bellwether-site-root-'));
  for (const part of ['package.json', 'README.md', 'docs', 'site']) cpSync(join(repo, part), join(root, part), { recursive: true });
  const template = join(root, 'site/template.html');
  writeFileSync(template, readFileSync(template, 'utf8').replace('{{content}}', ''));
  assert.throws(() => buildSite({ outDir: join(root, '_site'), root }), /index\.html: the byline names no version, not \d+\.\d+\.\d+ from package\.json/);
});
