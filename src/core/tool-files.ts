// The install paths a child's tool files name (issue #266). A Claude Code
// child's MCP configuration names this Node and this package's channel entry,
// and its settings file names them again in the dialog hook's command. Other
// harnesses' configurations sit in the same directory and name the same two.
// Under Homebrew each path sits in a versioned Cellar directory, and `brew
// upgrade` of Bellwether or of Node deletes the old one, so a file written
// before the upgrade names a path that no longer exists.
//
// Two changes answer it. A writer names Homebrew's `opt/` link where one
// points at the same file, because that link outlives every upgrade. The
// daemon, at its start and when a child's adapter says hello, writes this
// install's path in place of each install path a tool file names that no
// longer exists, and leaves every other file, and every other path, alone.
// Each rewrite goes to tool-repairs.log, and doctor warns about it.
import fs from 'node:fs';
import path from 'node:path';
import { cliEntry } from './claude-hooks.ts';
import { bellwetherHome, claudeSettingsDir, mcpDir } from './paths.ts';
import { nodeCommand, stablePath } from './stable-path.ts';

export { stablePath } from './stable-path.ts';

/** One install path a tool file names that no longer exists. */
export interface ToolFileFinding {
  file: string;
  childId: string;
  missing: string;
  /** This install's path for the same file, or undefined when none takes its place. */
  replacement?: string;
}

/** A rewrite the daemon made, as tool-repairs.log keeps it. */
interface RepairLine {
  at: string;
  file: string;
  childId: string;
  missing: string;
  replacement: string;
}

export function toolRepairLogPath(): string {
  return path.join(bellwetherHome(), 'tool-repairs.log');
}

/** Each directory that holds per-child tool files, one `<child id>.json` each. */
function toolFileDirs(): string[] {
  return [mcpDir(), claudeSettingsDir()];
}

function childFiles(childId?: string): { file: string; childId: string }[] {
  return toolFileDirs().flatMap((dir) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    return names.map((name) => ({ file: path.join(dir, name), childId: name.slice(0, -'.json'.length) })).filter((entry) => !childId || entry.childId === childId || entry.file === path.join(dir, `${childId}.json`));
  });
}

/**
 * This install's file for a missing install path: Node by its basename, and a
 * file of a Bellwether package, under its `src/` or `dist/`, by its path
 * there. Anything else has no replacement.
 */
function replacementFor(missing: string): string | undefined {
  if (path.basename(missing) === 'node' || path.basename(missing) === path.basename(process.execPath)) return nodeCommand();
  const inPackage = /.*\/(?:src|dist)\/(.+)\.(?:js|ts)$/.exec(missing);
  if (!inPackage) return undefined;
  const entry = cliEntry();
  const candidate = path.join(path.dirname(entry), `${inPackage[1]}${path.extname(entry)}`);
  return fs.existsSync(candidate) ? stablePath(candidate) : undefined;
}

/**
 * The absolute paths one string of a tool file names: the whole string, or
 * each single-quoted word of a hook command.
 */
function pathsIn(value: string): string[] {
  if (value.startsWith('/') && !/\s/.test(value)) return [value];
  return [...value.matchAll(/'(\/[^']*)'/g)].map((match) => match[1] as string);
}

function eachString(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map((item) => eachString(item, visit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, eachString(item, visit)]));
  return value;
}

/**
 * Whether a path is one a Bellwether install writes into a tool file: the
 * Node that runs it, or a file of the package. A directory a parent named in
 * `reads`, or a path another tool's server takes, is not.
 */
function installPath(file: string): boolean {
  return path.basename(file) === 'node' || path.basename(file) === path.basename(process.execPath) || /\/(?:src|dist)\/.+\.(?:js|ts)$/.test(file);
}

function findingsIn(file: string, childId: string, json: unknown): ToolFileFinding[] {
  const found = new Map<string, ToolFileFinding>();
  eachString(json, (text) => {
    for (const named of pathsIn(text)) {
      if (found.has(named) || fs.existsSync(named)) continue;
      const replacement = replacementFor(named);
      // A missing path no install writes, such as a directory in a read set, is not this repair's to judge.
      if (!replacement && !installPath(named) && !commandPath(json, named)) continue;
      found.set(named, { file, childId, missing: named, ...(replacement ? { replacement } : {}) });
    }
    return text;
  });
  return [...found.values()];
}

/** Whether a path is a server's `command`, which a tool file needs to exist whoever wrote it. */
function commandPath(json: unknown, named: string): boolean {
  let hit = false;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'command' && (item === named || (Array.isArray(item) && item[0] === named))) hit = true;
        walk(item);
      }
    }
  };
  walk(json);
  return hit;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Each install path one tool file names that no longer exists. */
export function inspectToolFile(file: string, childId = path.basename(file, '.json')): ToolFileFinding[] {
  const json = readJson(file);
  return json === undefined ? [] : findingsIn(file, childId, json);
}

/**
 * Write this install's path in place of each missing install path in the tool
 * files of one child, or of every child when `childId` is absent. A file that
 * names only paths that exist is not written. Returns every finding, the ones
 * with no replacement too, and logs each rewrite.
 */
export function repairToolFiles(options: { childId?: string; log?: (line: string) => void }): ToolFileFinding[] {
  const all: ToolFileFinding[] = [];
  for (const { file, childId } of childFiles(options.childId)) {
    const json = readJson(file);
    if (json === undefined) continue;
    const found = findingsIn(file, childId, json);
    if (!found.length) continue;
    all.push(...found);
    const swaps = new Map(found.filter((item) => item.replacement).map((item) => [item.missing, item.replacement as string]));
    if (!swaps.size) continue;
    const rewritten = eachString(json, (text) => {
      if (swaps.has(text)) return swaps.get(text) as string;
      return text.replace(/'(\/[^']*)'/g, (whole, named: string) => (swaps.has(named) ? `'${swaps.get(named)}'` : whole));
    });
    const mode = fs.statSync(file).mode & 0o777;
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(rewritten, null, 2)}\n`, { mode: mode || 0o600 });
    fs.renameSync(temp, file);
    const at = new Date().toISOString();
    for (const [missing, replacement] of swaps) {
      fs.appendFileSync(toolRepairLogPath(), `${JSON.stringify({ at, file, childId, missing, replacement } satisfies RepairLine)}\n`, { mode: 0o600 });
      options.log?.(`tool file of child ${childId}: ${file} named ${missing}, which no longer exists; wrote ${replacement} in its place`);
    }
  }
  return all;
}

function repairLines(): RepairLine[] {
  let text: string;
  try {
    text = fs.readFileSync(toolRepairLogPath(), 'utf8');
  } catch {
    return [];
  }
  const latest = new Map<string, RepairLine>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as RepairLine;
      latest.set(`${entry.file}\0${entry.missing}`, entry);
    } catch {
      // A torn last line from a crash names nothing.
    }
  }
  return [...latest.values()];
}

/**
 * doctor's lines: a `warn` for each rewrite the daemon made in a tool file
 * that still names the path it wrote, and a `warn` for each missing install
 * path a tool file names now.
 */
export function toolFileLines(): string[] {
  const lines: string[] = [];
  for (const entry of repairLines()) {
    let text: string;
    try {
      text = fs.readFileSync(entry.file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(entry.replacement)) continue;
    lines.push(`warn  tool file: child ${entry.childId}: ${entry.file} named ${entry.missing}, which no longer exists, and the daemon wrote ${entry.replacement} in its place at ${entry.at}`);
  }
  for (const { file, childId } of childFiles()) {
    for (const item of inspectToolFile(file, childId)) {
      lines.push(
        item.replacement
          ? `warn  tool file: child ${childId}: ${file} names ${item.missing}, which no longer exists; the daemon writes ${item.replacement} in its place at its next start or the child's next hello`
          : `warn  tool file: child ${childId}: ${file} names ${item.missing}, which no longer exists, and no file of this install takes its place. Restart the child to write its files again.`,
      );
    }
  }
  return lines;
}
