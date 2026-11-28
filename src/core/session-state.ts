// The machine side of a move: what runs on the machine that holds a session,
// or that will. A parent's daemon calls these directly for its own machine,
// and over SSH, through `bellwether move-*`, for another, so the same code
// reads and writes the files in both directions. Every path is computed here,
// on the machine it names, from that machine's own home and environment.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executables, installCandidates, pathCandidates } from './binaries.ts';
import { claudeConfigDir } from './transcript.ts';
import { locateTranscript } from './harnesses/index.ts';
import { bellwetherHome } from './paths.ts';
import { BELLWETHER_VERSION } from './version.ts';
import { findLeftBehind, type LeftBehind, type LeftBehindRequest } from './move-leftovers.ts';
import { parsePiModelList, piModelOf, claudeVersionsOf, sha256, targetSessionLayout, type HarnessDirs, type HarnessProbe, type ModelPair, type MovableHarness } from './move-plan.ts';

/** This machine's harness directories, from its environment. */
export function harnessDirs(): HarnessDirs {
  const piAgentDir = process.env['PI_CODING_AGENT_DIR'] ? expandHome(process.env['PI_CODING_AGENT_DIR']) : path.join(os.homedir(), '.pi', 'agent');
  const piSessionDir = process.env['PI_CODING_AGENT_SESSION_DIR'] ? expandHome(process.env['PI_CODING_AGENT_SESSION_DIR']) : undefined;
  return { claudeConfigDir: claudeConfigDir(), piAgentDir, ...(piSessionDir ? { piSessionDir } : {}) };
}

function expandHome(value: string): string {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Every executable file named `name` on PATH, then in the usual install directories (binaries.ts), in order. */
export function findBinaries(name: string): string[] {
  return executables([...pathCandidates(name, process.env['PATH']), ...installCandidates(name)]);
}

function run(file: string, args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const fault = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (fault.name === 'AbortError') return resolve({ code: 124, stdout, stderr: `stopped at the caller's deadline` });
      resolve({ code: typeof fault.code === 'number' ? fault.code : 1, stdout, stderr: fault.killed ? `timed out after ${timeoutMs} ms` : stderr || fault.message });
    });
  });
}

/**
 * The harness binary for a movable harness, and the version it prints. The
 * first candidate that reports a version wins, so a stale copy earlier on
 * PATH, such as one under a node_modules/.bin, does not hide a working one.
 */
export async function probeHarness(harness: MovableHarness, signal?: AbortSignal): Promise<HarnessProbe> {
  const name = harness === 'pi' ? 'pi' : 'claude';
  const binaries = findBinaries(name);
  if (!binaries.length) return { error: `no ${name} on PATH or in the usual install directories` };
  let first: HarnessProbe | undefined;
  for (const binary of binaries) {
    const result = await run(binary, ['--version'], undefined, signal);
    const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    if (result.code === 0 && version) return { path: binary, version };
    const detail = result.stderr.trim() ? `: ${result.stderr.trim().split('\n').pop()}` : '';
    // A launcher whose program is gone, such as a shim left by an uninstall, exits with 127.
    first ??= result.code === 127 ? { error: `${binary} is there, but the program it starts is missing${detail}` } : { path: binary, error: `${binary} --version exited with ${result.code}${detail}` };
  }
  return first ?? { error: `no ${name} reported a version` };
}

/** The provider and model pairs pi on this machine offers, from `pi --list-models`. */
export async function piModels(binary: string, signal?: AbortSignal): Promise<{ models?: ModelPair[]; error?: string }> {
  const result = await run(binary, ['--list-models'], 60_000, signal);
  if (result.code !== 0) return { error: `pi --list-models exited with ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').pop()}` : ''}` };
  try {
    return { models: parsePiModelList(result.stdout) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export interface ProbeRequest {
  /** The harnesses to look for. Both when absent. */
  harnesses?: MovableHarness[];
  /** A working directory to check for. */
  cwd?: string;
  /** List pi's models, which takes a few seconds. */
  piModels?: boolean;
  /** Pi session files on this machine whose model to read. */
  piSessions?: string[];
  /** A child on this machine to check for work a move would leave behind (issue #224). */
  leftBehind?: LeftBehindRequest;
}

export interface ProbeResult {
  hostname: string;
  bellwether: string;
  dirs: HarnessDirs;
  harnesses: Partial<Record<MovableHarness, HarnessProbe>>;
  cwd?: { path: string; exists: boolean };
  piModels?: ModelPair[];
  piModelsError?: string;
  /** The file pi reads custom providers and models from on this machine. */
  piModelsFile: string;
  /** The pair each named pi session last used, when the file is here. */
  piSessionModels?: Record<string, ModelPair | null>;
  /** What a move of the child named in the request would leave behind here. A Bellwether before 0.1.10 leaves it out. */
  leftBehind?: LeftBehind;
}

/** What this machine offers a move: its harnesses, their versions, a directory and pi's models. An aborted signal stops the commands it runs. */
export async function probeMachine(request: ProbeRequest = {}, signal?: AbortSignal): Promise<ProbeResult> {
  const dirs = harnessDirs();
  const wanted = request.harnesses ?? ['claude-code', 'pi'];
  const harnesses: ProbeResult['harnesses'] = {};
  for (const harness of wanted) harnesses[harness] = await probeHarness(harness, signal);
  const result: ProbeResult = { hostname: os.hostname(), bellwether: BELLWETHER_VERSION, dirs, harnesses, piModelsFile: path.join(dirs.piAgentDir, 'models.json') };
  if (request.cwd) result.cwd = { path: request.cwd, exists: isDirectory(request.cwd) };
  if (request.piModels) {
    const pi = harnesses.pi ?? (await probeHarness('pi', signal));
    if (!pi.path) result.piModelsError = pi.error ?? 'pi is not installed';
    else {
      const listed = await piModels(pi.path, signal);
      if (listed.models) result.piModels = listed.models;
      else result.piModelsError = listed.error;
    }
  }
  if (request.leftBehind) result.leftBehind = await findLeftBehind(request.leftBehind);
  if (request.piSessions?.length) {
    result.piSessionModels = {};
    for (const file of request.piSessions) {
      try {
        result.piSessionModels[file] = piModelOf(fs.readFileSync(file, 'utf8')) ?? null;
      } catch {
        result.piSessionModels[file] = null;
      }
    }
  }
  return result;
}

function realOr(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** One file of a session, as it crosses between machines. */
export interface BundleFile {
  /** The path relative to the session's directory: the session file's own name, or a path under its side directory. */
  rel: string;
  /** The bytes, base64. */
  data: string;
}

export interface ExportRequest {
  harness: MovableHarness;
  /** The session as herdr reported it: an id for Claude Code, a file path for Pi. */
  session: string;
  cwd?: string;
}

export interface SessionBundle {
  harness: MovableHarness;
  /** Where the session file sat on the source. */
  sourceFile: string;
  /** The session file's name, which it keeps on the target. */
  fileName: string;
  files: BundleFile[];
  /** For Claude Code: every version its transcript records as a writer. */
  recordedVersions: string[];
  /** For Pi: the provider and model the session last used. */
  piModel?: ModelPair;
}

/** Every file under a directory, relative to it, sorted so two reads of one tree compare equal. */
function filesUnder(root: string, prefix: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const name = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) found.push(name);
    }
  };
  walk(root, prefix);
  return found.sort();
}

/**
 * Read a session off this machine: its file, and for Claude Code the side
 * directory that holds its tool results and subagent transcripts.
 */
export function exportSession(request: ExportRequest): SessionBundle {
  const found = locateTranscript(request.harness, request.session, request.cwd);
  if (!found.path) throw new Error(`the session ${request.session} is not on ${os.hostname()}: ${found.missing}`);
  const sourceFile = found.path;
  const fileName = path.basename(sourceFile);
  const main = fs.readFileSync(sourceFile);
  const files: BundleFile[] = [{ rel: fileName, data: main.toString('base64') }];
  if (request.harness === 'claude-code') {
    const side = path.join(path.dirname(sourceFile), path.basename(fileName, '.jsonl'));
    for (const rel of filesUnder(side, path.basename(fileName, '.jsonl'))) files.push({ rel, data: fs.readFileSync(path.join(path.dirname(sourceFile), rel)).toString('base64') });
  }
  const text = main.toString('utf8');
  const bundle: SessionBundle = { harness: request.harness, sourceFile, fileName, files, recordedVersions: request.harness === 'claude-code' ? claudeVersionsOf(text) : [] };
  if (request.harness === 'pi') {
    const pair = piModelOf(text);
    if (pair) bundle.piModel = pair;
  }
  return bundle;
}

export interface ImportRequest {
  harness: MovableHarness;
  /** The child the files belong to, which names the backups of any file the import replaces. */
  childId: string;
  /** The working directory the child resumes in on this machine. */
  cwd: string;
  fileName: string;
  files: BundleFile[];
}

/** One file the import wrote, read back from disk. */
export interface WrittenFile {
  rel: string;
  path: string;
  bytes: number;
  sha256: string;
  /** Whether the file was new, rather than a longer copy of one already there. */
  created: boolean;
}

export interface ImportResult {
  /** The session file on this machine, which the harness resumes. */
  sessionFile: string;
  files: WrittenFile[];
}

/** The backup an import keeps of a file it replaced, until the move commits or is undone. */
export function backupPath(file: string, childId: string): string {
  return `${file}.bellwether-move-${childId.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/**
 * The destination's own list of the files a crossing's imports plan to write
 * for one child, and whether each was new there. It lands before the first
 * file does, so a parent's daemon that stops before its mark lists the files
 * still leaves a discard or a commit every file to settle.
 */
export function importListPath(childId: string): string {
  return path.join(bellwetherHome(), 'move-imports', `${childId.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

type ListedFile = { path: string; created: boolean };

function readImportList(childId: string): ListedFile[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(importListPath(childId), 'utf8')) as { files?: unknown };
    return Array.isArray(parsed.files) ? parsed.files.filter((file): file is ListedFile => typeof file?.path === 'string' && typeof file?.created === 'boolean') : [];
  } catch {
    return [];
  }
}

function writeImportList(childId: string, files: ListedFile[]): void {
  const file = importListPath(childId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ childId, files })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/** The files a settle covers: those the caller names, and those the destination listed, where its own word on `created` wins. */
function settledFiles(request: SettleRequest): ListedFile[] {
  const files = new Map(request.files.map((file) => [file.path, file]));
  for (const file of readImportList(request.childId)) files.set(file.path, file);
  return [...files.values()];
}

/** Whether `prefix` is the first part of `whole`. */
function startsWith(whole: Buffer, prefix: Buffer): boolean {
  return prefix.length <= whole.length && whole.subarray(0, prefix.length).equals(prefix);
}

/**
 * Write a session onto this machine, where its harness looks for it from the
 * working directory the child resumes in, and read every file back. A file
 * already at a target path must be an earlier copy of the same session, so
 * the new content starts with it, as it does when a child moves back to a
 * machine it ran on before. Anything else would be a different conversation,
 * which the import refuses to overwrite. A replaced file keeps a backup until
 * the move commits or is undone.
 */
export function importSession(request: ImportRequest): ImportResult {
  // Claude Code names its project directory after the working directory with
  // symbolic links followed; pi resolves it without following them.
  const cwd = request.harness === 'claude-code' ? realOr(request.cwd) : request.cwd;
  const layout = targetSessionLayout(request.harness, request.fileName, cwd, harnessDirs());
  const base = layout.dir;
  const planned = request.files.map((file) => {
    const target = path.resolve(base, file.rel);
    if (target !== path.join(base, file.rel) || !target.startsWith(`${base}${path.sep}`)) throw new Error(`the bundle names ${file.rel}, which falls outside ${base}`);
    if (file.rel !== request.fileName && !file.rel.startsWith(`${path.basename(request.fileName, '.jsonl')}/`)) throw new Error(`the bundle names ${file.rel}, which is not part of the session ${request.fileName}`);
    return { rel: file.rel, target, data: Buffer.from(file.data, 'base64') };
  });
  // Check every file before writing any, so a refusal leaves nothing behind.
  for (const file of planned) {
    let existing: Buffer | undefined;
    try {
      existing = fs.readFileSync(file.target);
    } catch {
      continue;
    }
    if (!startsWith(file.data, existing)) {
      throw new Error(`${file.target} already exists on ${os.hostname()} and holds content the moved session does not, so Bellwether refused to overwrite another conversation. Move that file aside, then move the child.`);
    }
  }
  // List every file before writing any. A file an earlier import of this
  // crossing listed keeps that import's word on whether it was new here.
  const listed = new Map(readImportList(request.childId).map((file) => [file.path, file]));
  for (const file of planned) {
    if (!listed.has(file.target)) listed.set(file.target, { path: file.target, created: !fs.existsSync(file.target) && !fs.existsSync(backupPath(file.target, request.childId)) });
  }
  writeImportList(request.childId, [...listed.values()]);
  const written: WrittenFile[] = [];
  for (const file of planned) {
    fs.mkdirSync(path.dirname(file.target), { recursive: true, mode: 0o700 });
    const backup = backupPath(file.target, request.childId);
    const created = listed.get(file.target)?.created ?? true;
    // Only a file that was here before the crossing has a backup, and a
    // second import in one crossing keeps the first, the file as it was then.
    if (!created && fs.existsSync(file.target) && !fs.existsSync(backup)) fs.copyFileSync(file.target, backup);
    const temp = `${file.target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, file.data, { mode: 0o600 });
    fs.renameSync(temp, file.target);
    const back = fs.readFileSync(file.target);
    written.push({ rel: file.rel, path: file.target, bytes: back.length, sha256: sha256(back), created });
  }
  return { sessionFile: layout.file, files: written };
}

export interface SettleRequest {
  childId: string;
  files: { path: string; created: boolean }[];
}

/** Undo an import: remove the files it created, and put back the ones it replaced, listed or named. */
export function discardImport(request: SettleRequest): { removed: number; restored: number } {
  let removed = 0;
  let restored = 0;
  for (const file of settledFiles(request)) {
    const backup = backupPath(file.path, request.childId);
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, file.path);
      restored += 1;
    } else if (file.created && fs.existsSync(file.path)) {
      fs.rmSync(file.path, { force: true });
      removed += 1;
    }
  }
  fs.rmSync(importListPath(request.childId), { force: true });
  return { removed, restored };
}

/** Keep an import: the backups of the files it replaced go, listed or named. */
export function commitImport(request: SettleRequest): { removed: number } {
  let removed = 0;
  for (const file of settledFiles(request)) {
    const backup = backupPath(file.path, request.childId);
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { force: true });
      removed += 1;
    }
  }
  fs.rmSync(importListPath(request.childId), { force: true });
  return { removed };
}
