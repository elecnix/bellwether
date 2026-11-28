// The scanner behind each ownership gate. The design matrix
// (docs/design-matrix.md) gives each family of child record fields one
// owner: the incarnation family (issue #277) and the delivery family (issue
// #278) so far. A gate names its owner file, its fields, the writes to a
// field of the same name on another kind of object, and the types whose
// literals are records of the family. The scanner then finds every
// assignment, delete, Object.assign or Reflect call, and copy or literal of
// such a record that names one of the fields, in any file of src/ but the owner.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export interface Finding {
  file: string;
  line: number;
  rule: 'write' | 'copy' | 'assign' | 'literal';
  text: string;
}

export interface OwnerGate {
  /** The one file that may write the fields, relative to the repository. */
  owner: string;
  fields: readonly string[];
  /** Writes to a field of the same name on an object of another kind, keyed by file and receiver, each with its reason. */
  notMine: Record<string, string>;
  /** The types whose literals are records of the family, such as `ChildRecord`. */
  literalTypes: readonly string[];
}

/**
 * The names the code gives a child record. A literal that spreads one of them
 * and sets an owned field is a copy of the record with that field changed. A
 * spread of anything else, such as `...(cond ? { cwd } : {})`, builds another
 * object. The design matrix reads fields by the same names.
 */
const RECORD_NAMES = ['child', 'entry', 'record', 'existing', 'original', 'restored', 'started', 'moved', 'saved', 'earlier', 'known', 'current', 'previous', 'message', 'found', 'delivery', 'notice'];
const RECORD_SPREAD = new RegExp(`(^|\\?\\?|\\|\\|)\\s*(${RECORD_NAMES.join('|')})$|\\.children\\.find\\(|childById\\(`);

/** The source with comments and the contents of strings blanked, keeping every offset and line. */
export function codeOnly(source: string): string {
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

/** Whether a top-level spread in a literal copies a record. */
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

export interface Scanner {
  scanSource(file: string, source: string): Finding[];
  scanAll(): Finding[];
  /** Each exemption that no longer names a write the scan would otherwise flag. */
  staleExemptions(): string[];
}

export function ownerScanner(gate: OwnerGate): Scanner {
  const fields = gate.fields.join('|');
  const types = gate.literalTypes.join('|');
  const key = new RegExp(`(^|[,{\\s])(${fields})\\s*(:|,|$)`);
  const write = new RegExp(`(\\([^()\\n]*\\)|[\\w$]+(?:\\??\\.[\\w$]+|\\[[^\\]\\n]*\\])*)\\s*\\??\\.\\s*(${fields})\\s*(=(?![=>])|\\?\\?=|\\|\\|=|&&=|\\+=|-=)`, 'g');
  const remove = new RegExp(`delete\\s+(\\([^()\\n]*\\)|[\\w$]+(?:\\??\\.[\\w$]+|\\[[^\\]\\n]*\\])*)\\s*\\??\\.\\s*(${fields})\\b`, 'g');
  const indexed = new RegExp(`\\[\\s*['"\`](${fields})['"\`]\\s*\\]\\s*(=(?![=>])|\\?\\?=)`, 'g');
  const typedBefore = new RegExp(`(:\\s*(${types})\\s*=|\\bas\\s+(${types})|satisfies\\s+(${types})|<(${types})>)\\s*\\(?\\s*$`);
  const typedAfter = new RegExp(`^\\)?\\s*(as|satisfies)\\s+(${types})\\b`);

  const scanSource = (file: string, source: string): Finding[] => {
    if (file === gate.owner) return [];
    const raw = source;
    const code = codeOnly(source);
    const found: Finding[] = [];
    const quoted = (offset: number, length: number): string => raw.slice(offset, offset + length).replace(/\s+/g, ' ').trim();

    for (const pattern of [write, remove]) {
      for (const match of code.matchAll(pattern)) {
        const receiver = (match[1] ?? '').trim();
        if (gate.notMine[`${file} ${receiver}`]) continue;
        found.push({ file, line: lineOf(code, match.index), rule: 'write', text: quoted(match.index, match[0].length) });
      }
    }
    for (const match of raw.matchAll(indexed)) found.push({ file, line: lineOf(code, match.index), rule: 'write', text: quoted(match.index, match[0].length) });

    // Object.assign and Reflect write past readonly, so any that names a field is a write.
    for (const match of code.matchAll(/\b(Object\.assign|Reflect\.set|Reflect\.deleteProperty|Reflect\.defineProperty|Object\.defineProperty)\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      const args = code.slice(open, closing(code, open) + 1);
      const named = new RegExp(`\\b(${fields})\\b`).test(args) || new RegExp(`['"\`](${fields})['"\`]`).test(raw.slice(open, closing(code, open) + 1));
      if (named) found.push({ file, line: lineOf(code, match.index), rule: 'assign', text: quoted(match.index, Math.min(120, args.length + match[0].length)) });
    }

    for (let at = code.indexOf('{'); at >= 0; at = code.indexOf('{', at + 1)) {
      const end = closing(code, at);
      const own = topLevel(code.slice(at + 1, end));
      const before = code.slice(Math.max(0, at - 80), at);
      const after = code.slice(end + 1).trimStart();
      // A destructuring pattern reads the fields, and a block or a type is no literal.
      if (/(const|let|var)\s*$/.test(before) || /^=(?![=>])/.test(after) || /^\)\s*(:[^=]*)?=>/.test(after) || /^:\s*[\w<]/.test(after)) continue;
      if (!key.test(own)) continue;
      const literalOfRecord = typedBefore.test(before) || typedAfter.test(after);
      if (!literalOfRecord && !spreadsRecord(code.slice(at + 1, end))) continue;
      found.push({ file, line: lineOf(code, at), rule: literalOfRecord ? 'literal' : 'copy', text: quoted(at, Math.min(120, end - at + 1)) });
    }
    return found;
  };

  return {
    scanSource,
    scanAll: () => sourceFiles().flatMap((file) => scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))),
    staleExemptions: () =>
      Object.keys(gate.notMine).filter((exemption) => {
        const [file, ...rest] = exemption.split(' ');
        const receiver = rest.join(' ');
        const code = codeOnly(fs.readFileSync(path.join(ROOT, file ?? ''), 'utf8'));
        return ![...code.matchAll(write), ...code.matchAll(remove)].some((match) => (match[1] ?? '').trim() === receiver);
      }),
  };
}
