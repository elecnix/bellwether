// Tier 1: the incarnation family has one writer (issue #277). The fields that
// describe one run of a child in one pane are written only in
// src/core/incarnation.ts, through its transitions, so the five ways a child
// comes back clear the same fields by construction. These cases fail when any
// other file in src/ assigns or deletes one of those fields, copies a record
// with one of them changed, or builds a child record that names one. The
// typecheck holds the other half: ChildRecord declares each field readonly,
// so a write through any alias fails there, and this scan catches the casts
// and copies the typecheck lets through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { INCARNATION_FIELDS, LIFETIMES } from '../../src/core/incarnation.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OWNER = path.join('src', 'core', 'incarnation.ts');
const FIELDS = INCARNATION_FIELDS.join('|');

/**
 * Writes to a field of the same name on an object that is not a child record.
 * Each is keyed by file and receiver. A child record under one of these names
 * still fails the typecheck, because the fields are readonly.
 */
const NOT_A_CHILD: Record<string, string> = {
  'src/cli.ts process': 'the process exit code',
  'src/core/remote.ts this': 'a remote herdr client names its machine',
  'src/integrations/claude/transcript.ts this': 'a transcript reader keeps the session and directory it reads',
  'src/daemon/client.ts (this.parent as { session: string })': 'a daemon client keeps the session it says hello for',
  'src/daemon/relay-links.ts link': 'a relay link that is closing',
  'src/daemon/protocol.ts caller': 'the identity an adapter sends with a call',
  'src/daemon/server.ts info': 'the parent session a hello describes',
  'src/core/session-state.ts result': 'what a machine answers about a session path',
  'src/core/resume.ts next.brief': 'the brief a resume hands over',
  'src/core/spawn.ts brief': 'a brief on the spawn record',
  'src/core/classifier.ts next': "the classifier's own state for a child",
  'src/daemon/server.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
  'src/daemon/service.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
  'src/core/restart.ts parentRecord': 'a parent record, which keeps its own pane and restart failure',
};

/**
 * The names the code gives a child record. A literal that spreads one of them
 * and sets an incarnation field is a copy of the record with its run changed.
 * A spread of anything else, such as `...(cond ? { cwd } : {})`, builds
 * another object. The design matrix reads fields by the same names.
 */
const RECORD_NAMES = ['child', 'entry', 'record', 'existing', 'original', 'restored', 'started', 'moved', 'saved', 'earlier', 'known', 'current', 'previous'];
const RECORD_SPREAD = new RegExp(`(^|\\?\\?|\\|\\|)\\s*(${RECORD_NAMES.join('|')})$|\\.children\\.find\\(|childById\\(`);

/** Whether a top-level spread in a literal copies a child record. */
function spreadsRecord(body: string): boolean {
  let depth = 0;
  let start = -1;
  const spreads: string[] = [];
  for (let at = 0; at <= body.length; at += 1) {
    const char = body[at] ?? ',';
    if (depth === 0 && body.startsWith('...', at)) start = at + 3;
    if ('{(['.includes(char)) depth += 1;
    else if ('})]'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0 && start >= 0) {
      spreads.push(body.slice(start, at).trim());
      start = -1;
    }
  }
  return spreads.some((spread) => {
    let inner = spread;
    while (inner.startsWith('(') && closing(inner, 0) === inner.length - 1) inner = inner.slice(1, -1).trim();
    return RECORD_SPREAD.test(inner);
  });
}

interface Finding {
  file: string;
  line: number;
  rule: 'write' | 'copy' | 'assign' | 'literal';
  text: string;
}

/** The source with comments and the contents of strings blanked, keeping every offset and line. */
function codeOnly(source: string): string {
  let out = '';
  let index = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  while (index < source.length) {
    const rest = source.slice(index);
    const comment = /^(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (comment) {
      out += blank(comment[0]);
      index += comment[0].length;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      let end = index + 1;
      let depth = 0;
      while (end < source.length) {
        const char = source[end];
        if (char === '\\') {
          end += 2;
          continue;
        }
        if (quote === '`' && char === '$' && source[end + 1] === '{') depth += 1;
        else if (quote === '`' && char === '}' && depth > 0) depth -= 1;
        else if (char === quote && depth === 0) break;
        end += 1;
      }
      out += quote + blank(source.slice(index + 1, end)) + (source[end] ?? '');
      index = end + 1;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** The index of the bracket that closes the one at `open`. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let at = open; at < code.length; at += 1) {
    const char = code[at] ?? '';
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  return code.length;
}

/** The text of a literal at its own depth, with every nested bracket's contents removed. */
function topLevel(body: string): string {
  let out = '';
  let depth = 0;
  for (const char of body) {
    if ('{(['.includes(char)) depth += 1;
    if (depth === 0) out += char;
    if ('})]'.includes(char)) depth -= 1;
  }
  return out;
}

const KEY = new RegExp(`(^|[,{\\s])(${FIELDS})\\s*(:|,|$)`);
const WRITE = new RegExp(`(\\([^()\\n]*\\)|[\\w$]+(?:\\??\\.[\\w$]+|\\[[^\\]\\n]*\\])*)\\s*\\??\\.\\s*(${FIELDS})\\s*(=(?![=>])|\\?\\?=|\\|\\|=|&&=|\\+=|-=)`, 'g');
const DELETE = new RegExp(`delete\\s+(\\([^()\\n]*\\)|[\\w$]+(?:\\??\\.[\\w$]+|\\[[^\\]\\n]*\\])*)\\s*\\??\\.\\s*(${FIELDS})\\b`, 'g');
const INDEXED = new RegExp(`\\[\\s*['"\`](${FIELDS})['"\`]\\s*\\]\\s*(=(?![=>])|\\?\\?=)`, 'g');

/** Every write to an incarnation field in one file that is not the owner's. */
export function scanSource(file: string, source: string): Finding[] {
  if (file === OWNER) return [];
  const raw = source;
  const code = codeOnly(source);
  const found: Finding[] = [];
  const quoted = (offset: number, length: number): string => raw.slice(offset, offset + length).replace(/\s+/g, ' ').trim();

  for (const pattern of [WRITE, DELETE]) {
    for (const match of code.matchAll(pattern)) {
      const receiver = (match[1] ?? '').trim();
      if (NOT_A_CHILD[`${file} ${receiver}`]) continue;
      found.push({ file, line: lineOf(code, match.index), rule: 'write', text: quoted(match.index, match[0].length) });
    }
  }
  for (const match of raw.matchAll(INDEXED)) found.push({ file, line: lineOf(code, match.index), rule: 'write', text: quoted(match.index, match[0].length) });

  // Object.assign and Reflect write past readonly, so any that names a field is a write.
  for (const match of code.matchAll(/\b(Object\.assign|Reflect\.set|Reflect\.deleteProperty|Reflect\.defineProperty|Object\.defineProperty)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = code.slice(open, closing(code, open) + 1);
    const named = new RegExp(`\\b(${FIELDS})\\b`).test(args) || new RegExp(`['"\`](${FIELDS})['"\`]`).test(raw.slice(open, closing(code, open) + 1));
    if (named) found.push({ file, line: lineOf(code, match.index), rule: 'assign', text: quoted(match.index, Math.min(120, args.length + match[0].length)) });
  }

  for (let at = code.indexOf('{'); at >= 0; at = code.indexOf('{', at + 1)) {
    const end = closing(code, at);
    const own = topLevel(code.slice(at + 1, end));
    const before = code.slice(Math.max(0, at - 80), at);
    const after = code.slice(end + 1).trimStart();
    // A destructuring pattern reads the fields, and a block or a type is no literal.
    if (/(const|let|var)\s*$/.test(before) || /^=(?![=>])/.test(after) || /^\)\s*(:[^=]*)?=>/.test(after) || /^:\s*[\w<]/.test(after)) continue;
    if (!KEY.test(own)) continue;
    const literalOfRecord = /(:\s*ChildRecord\s*=|\bas\s+ChildRecord|satisfies\s+ChildRecord|<ChildRecord>)\s*\(?\s*$/.test(before) || /^\)?\s*(as|satisfies)\s+ChildRecord\b/.test(after);
    if (!literalOfRecord && !spreadsRecord(code.slice(at + 1, end))) continue;
    found.push({ file, line: lineOf(code, at), rule: literalOfRecord ? 'literal' : 'copy', text: quoted(at, Math.min(120, end - at + 1)) });
  }
  return found;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(relative);
    }
  };
  walk('src');
  return files;
}

function scanAll(): Finding[] {
  return sourceFiles().flatMap((file) => scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
}

test('the scan flags each way a module could write an incarnation field without the owner', () => {
  const rules = (source: string): string[] => scanSource('src/core/example.ts', source).map((finding) => finding.rule);
  assert.deepEqual(rules('entry.exitedAt = at;'), ['write']);
  assert.deepEqual(rules('c.paneId = pane;'), ['write'], 'any name for the record');
  assert.deepEqual(rules('delete record.harnessEnded;'), ['write']);
  assert.deepEqual(rules('entry.harnessSeenAt ??= now;'), ['write']);
  assert.deepEqual(rules('(entry as { paneId: string }).paneId = pane;'), ['write'], 'a cast past readonly');
  assert.deepEqual(rules("entry['awaitsResume'] = at;"), ['write']);
  assert.deepEqual(rules('Object.assign(entry, { tabId });'), ['assign']);
  assert.deepEqual(rules("Reflect.set(entry, 'closing', value);"), ['assign']);
  assert.deepEqual(rules('upsertChild(id, { ...entry, host: target });'), ['copy']);
  assert.deepEqual(rules('const view = { ...child, session };'), ['copy'], 'a shorthand key');
  assert.deepEqual(rules("const child: ChildRecord = { id, name, paneId: '', host };"), ['literal']);
});

test('the scan leaves reads, comparisons, destructuring and the owner alone', () => {
  const rules = (source: string, file = 'src/core/example.ts'): string[] => scanSource(file, source).map((finding) => finding.rule);
  assert.deepEqual(rules('if (entry.paneId === pane) return;'), []);
  assert.deepEqual(rules('const { paneId, ...rest } = entry;'), []);
  assert.deepEqual(rules('// entry.exitedAt = at;'), [], 'a comment');
  assert.deepEqual(rules("log('entry.exitedAt = at');"), [], 'a string');
  assert.deepEqual(rules('await client.request({ paneId: child.paneId });'), [], 'a request that is no record copy');
  assert.deepEqual(rules('entry.exitedAt = at;', OWNER), []);
  assert.deepEqual(rules('process.exitCode = 1;', 'src/cli.ts'), [], 'a field of the same name elsewhere');
});

test('no file but src/core/incarnation.ts writes an incarnation field', () => {
  const findings = scanAll();
  assert.deepEqual(
    findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}: ${finding.text}`),
    [],
    'call a transition in src/core/incarnation.ts instead (issue #277). A field of the same name on another kind of object goes in NOT_A_CHILD with the reason.',
  );
});

test('every exemption still names a write the scan would otherwise flag', () => {
  for (const key of Object.keys(NOT_A_CHILD)) {
    const [file, ...rest] = key.split(' ');
    const receiver = rest.join(' ');
    const code = codeOnly(fs.readFileSync(path.join(ROOT, file ?? ''), 'utf8'));
    const used = [...code.matchAll(WRITE), ...code.matchAll(DELETE)].some((match) => (match[1] ?? '').trim() === receiver);
    assert.ok(used, `${key} no longer writes an incarnation field, so remove its exemption`);
  }
});

test('ChildRecord declares every incarnation field readonly, so the typecheck sees every alias', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const body = /export interface ChildRecord \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  assert.ok(body, 'ChildRecord was not found in src/core/types.ts');
  const loose = INCARNATION_FIELDS.filter((field) => !new RegExp(`^\\s+readonly ${field}\\??:`, 'm').test(body));
  assert.deepEqual(loose, [], 'declare these fields readonly in ChildRecord');
});

test('the family covers the fields the design matrix names', () => {
  // docs/design-matrix.md, step 1. A field leaves the family only by a change to this list and the table.
  const named = ['paneId', 'tabId', 'host', 'cwd', 'session', 'lastStatus', 'startingUntil', 'exitedAt', 'exitCode', 'harnessEnded', 'harnessSeenAt', 'tabClosedAt', 'paneEnd', 'reportPending', 'resumedAt', 'restartFailed', 'crossingFailed', 'awaitsResume', 'closing', 'restartInDoubt'];
  assert.deepEqual(named.filter((field) => !INCARNATION_FIELDS.includes(field as never)), []);
  assert.ok(Object.keys(LIFETIMES).length > INCARNATION_FIELDS.length, 'the table lists every field of ChildRecord, owned or not');
});
