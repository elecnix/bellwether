// Checks that test fixtures name only public providers and models, or synthetic ones.
//
// This repository is public. A fixture that names a provider account, a model or a tier taken
// from somebody's own setup publishes that name, and a force-push does not take it back. The
// check is an allow-list on purpose: a deny-list would have to spell out the names it protects.
//
// It reads every file under test/, picks out the strings that stand in a provider, model or tier
// position, and fails on each one that is neither public nor synthetic. A failure prints the file,
// the line and a redacted form of the value, never the value itself, because a CI log is public.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prefixes that mark an identifier as made up for a test. Matched case-insensitively. */
export const SYNTHETIC_PREFIXES = ['example', 'fake', 'test', 'stub', 'mock'] as const;

/**
 * Providers a fixture may name. Each one is a built-in provider of a public harness, and each
 * entry says where the test tree uses it. Add one only when you can point to it in public.
 */
export const PUBLIC_PROVIDERS: Record<string, string> = {
  // A provider built into pi (`@earendil-works/pi-ai`). test/integration/restart.test.ts.
  openrouter: 'pi built-in provider',
};

/**
 * Model families a fixture may name. A model id is legal when it is one of these or starts with
 * one of these followed by `-`.
 */
export const PUBLIC_MODEL_FAMILIES: Record<string, string> = {
  // Claude Code's `--model haiku` alias. test/fixtures/claude-screens.ts.
  haiku: 'Claude Code model alias',
  // DeepSeek's public models, such as deepseek-v4.1-flash in pi's catalog. test/integration/pi-launch.test.ts.
  deepseek: 'DeepSeek public model family',
};

export type IdentifierKind = 'provider' | 'model';

export interface Finding {
  file: string;
  line: number;
  kind: IdentifierKind;
  /** The value with everything but its first and last character hidden, and its length. */
  redacted: string;
}

/** Hides a value so that a log can say which one failed without publishing it. */
export function redact(value: string): string {
  if (value.length <= 2) return `${'*'.repeat(value.length)} (${value.length} chars)`;
  return `${value[0]}${'*'.repeat(value.length - 2)}${value[value.length - 1]} (${value.length} chars)`;
}

function synthetic(value: string): boolean {
  const lower = value.toLowerCase();
  return SYNTHETIC_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** A bare version, such as `4`, `v2` or `3.5.1`. */
function versionShaped(value: string): boolean {
  return /^v?\d+(\.\d+)*$/i.test(value);
}

export function legalProvider(value: string): boolean {
  return synthetic(value) || Object.hasOwn(PUBLIC_PROVIDERS, value.toLowerCase());
}

export function legalModel(value: string): boolean {
  if (synthetic(value) || versionShaped(value)) return true;
  const slash = value.indexOf('/');
  if (slash > 0) {
    // A model path, `provider/model`: both halves must pass on their own.
    const owner = value.slice(0, slash);
    const rest = value.slice(slash + 1);
    return (legalProvider(owner) || legalFamily(owner)) && legalModel(rest);
  }
  return legalFamily(value);
}

function legalFamily(value: string): boolean {
  const lower = value.toLowerCase();
  return Object.keys(PUBLIC_MODEL_FAMILIES).some((family) => lower === family || lower.startsWith(`${family}-`));
}

// An identifier inside a quoted string: it starts with a letter or digit, which leaves out a
// template placeholder such as `${name}`.
const VALUE = String.raw`([A-Za-z0-9][\w.:@/-]*)`;
const QUOTE = `['"\`]`;

interface Pattern {
  regex: RegExp;
  /** Which capture groups hold values, and what kind each one is. */
  groups: Array<[number, IdentifierKind]>;
}

// Each pattern finds a value in a provider, model or tier position. A tier stands where a model
// would, so it takes the model rule.
const PATTERNS: Pattern[] = [
  // provider: 'x', defaultProvider: 'x', const PARENT_PROVIDER = 'x', and the JSON "provider":"x"
  { regex: new RegExp(String.raw`\b\w*provider\w*['"]?\s*[:=]\s*${QUOTE}${VALUE}${QUOTE}`, 'gi'), groups: [[1, 'provider']] },
  // model: 'x', modelId: 'x', defaultModel: 'x', tier: 'x', and the JSON "modelId":"x"
  { regex: new RegExp(String.raw`\b\w*(?:model|tier)\w*['"]?\s*[:=]\s*${QUOTE}${VALUE}${QUOTE}`, 'gi'), groups: [[1, 'model']] },
  // { provider: 'x', id: 'y' }, the shape of a model on a record or a call
  { regex: new RegExp(String.raw`\bprovider\s*:\s*${QUOTE}[^'"\`]*${QUOTE}\s*,\s*id\s*:\s*${QUOTE}${VALUE}${QUOTE}`, 'gi'), groups: [[1, 'model']] },
  // model: { id: 'y' }
  { regex: new RegExp(String.raw`\bmodel\w*\s*:\s*\{\s*id\s*:\s*${QUOTE}${VALUE}${QUOTE}`, 'gi'), groups: [[1, 'model']] },
  // --provider x, --model x, --tier=x, and the same split into array elements: '--model', 'x'
  { regex: new RegExp(String.raw`--provider${QUOTE}?(?:=|\s+|\s*,\s*${QUOTE})${VALUE}`, 'gi'), groups: [[1, 'provider']] },
  { regex: new RegExp(String.raw`--(?:model|tier)${QUOTE}?(?:=|\s+|\s*,\s*${QUOTE})${VALUE}`, 'gi'), groups: [[1, 'model']] },
  // The prose a spawn reply carries: "provider account x, model y"
  { regex: new RegExp(String.raw`provider account ${VALUE}, model ${VALUE}`, 'gi'), groups: [[1, 'provider'], [2, 'model']] },
];

// enabledModels: ['a/b', 'c/d'] and other lists of model strings. A list of objects is left to the
// patterns above, which read each object's keys.
const MODEL_LIST = /\b\w*(?:models|tiers)['"]?\s*[:=]\s*\[([^\]{]*)\]/gi;
const LIST_ITEM = new RegExp(`${QUOTE}${VALUE}${QUOTE}`, 'g');

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Scans one file's text and returns a finding for each identifier that is neither public nor synthetic. */
export function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const check = (value: string, kind: IdentifierKind, index: number): void => {
    // Strip trailing punctuation that prose or a regex leaves on a value.
    const trimmed = value.replace(/[.:/]+$/, '');
    if (trimmed === '') return;
    const legal = kind === 'provider' ? legalProvider(trimmed) : legalModel(trimmed);
    if (legal) return;
    const line = lineOf(text, index);
    const key = `${line}:${kind}:${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, line, kind, redacted: redact(trimmed) });
  };
  for (const { regex, groups } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      for (const [group, kind] of groups) {
        const value = match[group];
        if (value !== undefined) check(value, kind, match.index);
      }
    }
  }
  for (const list of text.matchAll(MODEL_LIST)) {
    const body = list[1] ?? '';
    for (const item of body.matchAll(LIST_ITEM)) {
      if (item[1] !== undefined) check(item[1], 'model', list.index);
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/** Scans every file under the given roots. Paths in the findings are relative to `base`. */
export function scanTree(base: string, roots: string[] = ['test']): Finding[] {
  const files: string[] = [];
  for (const root of roots) {
    const dir = path.join(base, root);
    if (fs.existsSync(dir)) walk(dir, files);
  }
  return files.sort().flatMap((file) => scanText(fs.readFileSync(file, 'utf8'), path.relative(base, file)));
}

/** The message a failing run prints. It carries no identifier in clear. */
export function report(findings: Finding[]): string {
  const lines = findings.map((f) => `${f.file}:${f.line}: ${f.kind} ${f.redacted} is neither a public ${f.kind} nor synthetic`);
  return [
    ...lines,
    '',
    `Use a synthetic ${findings.some((f) => f.kind === 'provider') ? 'provider or model' : 'model'} id in a test fixture: start it with one of ${SYNTHETIC_PREFIXES.join(', ')}.`,
    'A real-looking name from elsewhere may belong to somebody, and this repository is public.',
    'To allow a public provider or model family, add it to scripts/fixture-identifiers.ts with where it is public.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = path.resolve(import.meta.dirname, '..');
  const findings = scanTree(base);
  if (findings.length > 0) {
    process.stderr.write(`${report(findings)}\n`);
    process.exit(1);
  }
  process.stdout.write('fixture identifiers: every provider and model under test/ is public or synthetic\n');
}
