// Builds the documentation site from the Markdown in this repository: one
// self-contained HTML file per page, written to _site/ by default.
//
//   node scripts/build-site.ts [out-dir]
//
// The pages come from README.md and docs/, so an edit there reaches the site
// at the next build. site/template.html holds the page shell and its script,
// and site/report-page.css is the stylesheet pasted into it. A link to a
// Markdown file the site does not publish goes to that file on GitHub.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, type Token, type Tokens } from 'marked';
import { bylineOpening, bylineVersion, SITE_NAME } from './site-version.ts';

export interface Page {
  source: string;
  output: string;
  label?: string;
}

/** The published pages, in the order a reader needs them. */
export const PAGES: readonly Page[] = [
  { source: 'README.md', output: 'index.html', label: 'Overview' },
  { source: 'docs/install.md', output: 'install.html' },
  { source: 'docs/tools.md', output: 'tools.html' },
  { source: 'docs/recovery.md', output: 'recovery.html' },
  { source: 'docs/remote-machines.md', output: 'remote-machines.html' },
  { source: 'docs/moving.md', output: 'moving.html' },
  { source: 'docs/teleporting.md', output: 'teleporting.html' },
  { source: 'docs/liberation.md', output: 'liberation.html' },
  { source: 'docs/routes.md', output: 'routes.html' },
  { source: 'docs/harnesses.md', output: 'harnesses.html' },
  { source: 'docs/opencode.md', output: 'opencode.html' },
  { source: 'docs/codex.md', output: 'codex.html' },
  { source: 'docs/kilo.md', output: 'kilo.html' },
  { source: 'docs/upgrading.md', output: 'upgrading.html' },
  { source: 'docs/releasing.md', output: 'releasing.html' },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Heading { depth: number; id: string; text: string }

interface Rendered {
  page: Page;
  title: string;
  label: string;
  description: string;
  headings: Heading[];
  body: string;
}

export interface BuildOptions {
  outDir: string;
  root?: string;
}

export interface BuiltPage {
  output: string;
  title: string;
}

const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const plainText = (html: string): string =>
  html.replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

/** GitHub's heading anchors, so a link written for GitHub works on the site. */
function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base);
    seen.set(base, (n ?? -1) + 1);
    return n === undefined ? base : `${base}-${n + 1}`;
  };
}

function repoUrl(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { repository: string };
  const match = /^github:(.+)$/.exec(pkg.repository);
  if (!match) throw new Error(`package.json repository is not github:owner/name: ${pkg.repository}`);
  return `https://github.com/${match[1]}`;
}

/** Points a link in `source` at the site page that publishes its target, or at GitHub. */
function rewriteHref(href: string, source: string, repo: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  const hash = href.indexOf('#');
  const path = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? '' : href.slice(hash);
  const target = posix.normalize(posix.join(posix.dirname(source), path));
  const page = PAGES.find((p) => p.source === target);
  if (page) return page.output + fragment;
  return `${repo}/blob/main/${target}${fragment}`;
}

function render(page: Page, root: string, repo: string): Rendered {
  const markdown = readFileSync(join(root, page.source), 'utf8');
  const slug = slugger();
  const headings: Heading[] = [];
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = plainText(inner);
        const id = slug(text);
        headings.push({ depth, id, text });
        return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
      },
    },
  });

  const tokens = md.lexer(markdown);
  md.walkTokens(tokens, (t) => {
    if (t.type === 'link') (t as Tokens.Link).href = rewriteHref((t as Tokens.Link).href, page.source, repo);
  });

  const h1 = tokens.findIndex((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 1);
  if (h1 !== 0) throw new Error(`${page.source}: the first block must be the page's # heading`);
  // The lead is the paragraph right under the page title, when there is one.
  const next = tokens.findIndex((t, i) => i > 0 && t.type !== 'space');
  const lead = tokens[next]?.type === 'paragraph' ? next : -1;
  const part = (from: number, to?: number): string => md.parser(tokens.slice(from, to) as Token[]);

  const heading = part(0, 1);
  const title = headings[0]!.text;
  const before = lead === -1 ? part(1) : part(1, lead);
  const leadHtml = lead === -1 ? '' : part(lead, lead + 1).replace(/^<p>/, '<p class="lead">');
  const after = lead === -1 ? '' : part(lead + 1);
  const description = lead === -1 ? title : plainText(leadHtml).trim();

  const body = (before + leadHtml + after)
    .replaceAll('<table>', '<div class="table-wrap"><table>')
    .replaceAll('</table>', '</table></div>');

  return { page, title, label: page.label ?? title, description, headings, body: heading + '{{byline}}' + body };
}

/** Minutes to read, by the visual-style formula: prose, code lines and table rows. */
function readingMinutes(html: string): number {
  const code = [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)];
  const codeLines = code.reduce((n, m) => n + m[1]!.trim().split('\n').length, 0);
  const prose = plainText(html.replace(/<pre>[\s\S]*?<\/pre>/g, ' '));
  const words = prose.split(/\s+/).filter(Boolean).length;
  const rows = (html.match(/<tr>/g)?.length ?? 0) - (html.match(/<thead>/g)?.length ?? 0);
  return Math.max(1, Math.ceil(words / 238 + (codeLines * 3) / 60 + (rows * 8) / 60));
}

function navHtml(pages: Rendered[], current: Rendered): string {
  const lines: string[] = [];
  for (const p of pages) {
    const here = p === current;
    lines.push(`        <li><a href="${p.page.output}"${here ? ' aria-current="page"' : ''}>${escapeHtml(p.label)}</a></li>`);
    if (!here) continue;
    for (const h of p.headings.filter((x) => x.depth === 2)) {
      lines.push(`        <li><a class="sub" href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`);
    }
  }
  return lines.join('\n');
}

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);

export function buildSite({ outDir, root = REPO_ROOT }: BuildOptions): BuiltPage[] {
  const repo = repoUrl(root);
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const css = readFileSync(join(root, 'site/report-page.css'), 'utf8');
  const template = readFileSync(join(root, 'site/template.html'), 'utf8').replace('/*REPORT-PAGE-CSS*/', () => css);
  const pages = PAGES.map((p) => render(p, root, repo));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // Pages serves the files as they are, without a Jekyll pass.
  writeFileSync(join(outDir, '.nojekyll'), '');

  return pages.map((p) => {
    const minutes = readingMinutes(p.body);
    const byline = `${bylineOpening(escapeHtml(version))}≈ ${minutes} min read · `
      + `<a href="${repo}/blob/main/${p.page.source}">${escapeHtml(p.page.source)} on GitHub</a></p>\n`;
    const title = p.page.output === 'index.html' ? SITE_NAME : `${p.title} · ${SITE_NAME}`;
    const html = fill(template, {
      title: escapeHtml(title),
      description: escapeHtml(p.description),
      nav: navHtml(pages, p),
      content: p.body.replace('{{byline}}', () => byline),
    });
    // The release checks the deployed site by this byline, so a page that does
    // not name the package's version fails the build rather than the release.
    const shown = bylineVersion(html);
    if (shown !== version) {
      throw new Error(`${p.page.output}: the byline names ${shown ?? 'no version'}, not ${version} from package.json. Check that site/template.html keeps {{content}} and that scripts/site-version.ts matches the byline.`);
    }
    writeFileSync(join(outDir, p.page.output), html);
    return { output: p.page.output, title };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(REPO_ROOT, '_site'));
  for (const page of buildSite({ outDir })) console.log(`${page.output}  ${page.title}`);
  console.log(`wrote ${PAGES.length} pages to ${outDir}`);
}
