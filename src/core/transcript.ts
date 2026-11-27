// Finding a child's transcript. The watcher reads the last assistant message
// from it, which is where a finished child's answer already sits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildSession } from './types.ts';

/** Claude Code's state root, which a lab overrides with CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
}

/** Claude Code caps a project directory name at this many characters. */
const CLAUDE_PROJECT_DIR_MAX = 200;

/** The 32-bit string hash Claude Code appends to a project directory name it cut short. */
function claudeNameHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash;
}

/**
 * The directory Claude Code keeps a working directory's sessions in, under
 * `projects`. It replaces every character outside A-Z, a-z and 0-9 with a
 * dash. A name longer than 200 characters keeps its first 200, then a dash
 * and the base-36 hash of the whole working directory. Pi names its session
 * directories by a different rule, so this is for Claude Code only.
 */
export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (name.length <= CLAUDE_PROJECT_DIR_MAX) return name;
  return `${name.slice(0, CLAUDE_PROJECT_DIR_MAX)}-${Math.abs(claudeNameHash(cwd)).toString(36)}`;
}

/** The file Claude Code writes a session to, for a session id and the directory it started in. */
export function claudeTranscriptPath(sessionId: string, cwd: string, configDir = claudeConfigDir()): string {
  return path.join(configDir, 'projects', claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

function newestFile(dir: string, matches: (name: string) => boolean, depth = 3): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  const walk = (current: string, remaining: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && remaining > 0) walk(full, remaining - 1);
      else if (entry.isFile() && matches(entry.name)) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { file: full, mtime };
        } catch {
          // A transcript that vanished is not an error here.
        }
      }
    }
  };
  walk(dir, depth);
  return best?.file;
}

/** Pi names a session file `<timestamp>_<session id>.jsonl`, so the file name ends with the session id. */
const endsWith = (sessionId: string) => (name: string): boolean => name.endsWith(`${sessionId}.jsonl`);

/** Where a session's transcript is, or why there is none on this machine. */
export type TranscriptLookup = { path: string; missing?: undefined } | { path?: undefined; missing: string };

/** The working directory as given and as the kernel resolves it. Claude Code names its directory after the second. */
function cwdForms(cwd: string): string[] {
  try {
    const real = fs.realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

/**
 * Locate the transcript for a harness session. Pi and Claude Code both keep
 * one JSONL file per session, named after the session id, under a per-project
 * directory. When there is no file, the answer says why, because a child that
 * exits before its first turn never gets one.
 */
export function locateTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): TranscriptLookup {
  if (!sessionId) return { missing: 'herdr has not reported the session yet' };
  // Pi reports its session as a path, Claude Code as an id. Take a path as one.
  if (sessionId.includes('/') || sessionId.endsWith('.jsonl')) return fs.existsSync(sessionId) ? { path: sessionId } : { missing: `the session file ${sessionId} does not exist` };
  if (harness === 'claude-code') {
    const expected = cwd ? cwdForms(cwd).map((form) => claudeTranscriptPath(sessionId, form)) : [];
    const direct = expected.find((file) => fs.existsSync(file));
    if (direct) return { path: direct };
    // A session started in another directory, or under a rule this code does not know.
    const root = path.join(claudeConfigDir(), 'projects');
    const found = newestFile(root, endsWith(sessionId), 1);
    if (found) return { path: found };
    const where = expected[0] ?? `${root}/*/${sessionId}.jsonl`;
    return { missing: `Claude Code has not written ${where}. It writes the file at the session's first turn, so a child that exits before one has no transcript.` };
  }
  if (harness === 'pi') {
    const root = path.join(process.env['PI_CODING_AGENT_DIR'] ?? path.join(os.homedir(), '.pi', 'agent'), 'sessions');
    const found = newestFile(root, endsWith(sessionId));
    return found ? { path: found } : { missing: `no file under ${root} ends in ${sessionId}.jsonl` };
  }
  return { missing: `Bellwether reads no transcript for the ${harness} harness` };
}

/** The transcript's path for a harness session, when the file exists on this machine. */
export function resolveTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): string | undefined {
  return locateTranscript(harness, sessionId, cwd).path;
}

/** herdr's agent_session for a pane, as a kind and a value. */
export function sessionFrom(agentSession: unknown): ChildSession | undefined {
  const value = sessionValueFrom(agentSession);
  if (!value) return undefined;
  const kind = typeof agentSession === 'object' && agentSession !== null ? (agentSession as Record<string, unknown>)['kind'] : undefined;
  return { kind: typeof kind === 'string' && kind ? kind : value.includes('/') ? 'path' : 'id', value };
}

/** The name herdr reports for an agent, when it differs from the one the parent gave. */
export function agentNameOf(agent: Record<string, unknown>, given: string): string | undefined {
  const name = agent['name'];
  return typeof name === 'string' && name && name !== given ? name : undefined;
}

/**
 * The provider and model a pi session file says it runs on: its first
 * model_change entry, which pi writes when the session starts. Undefined when
 * the file is missing or names none yet.
 */
export function piSessionModel(file: string): { provider: string; id: string } | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('"model_change"')) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry['type'] === 'model_change' && typeof entry['provider'] === 'string' && typeof entry['modelId'] === 'string') return { provider: entry['provider'], id: entry['modelId'] };
    } catch {
      // A line cut short by a write in progress is not the entry.
    }
  }
  return undefined;
}

/** The session value herdr reports for a pane, whatever shape it takes. */
export function sessionValueFrom(agentSession: unknown): string | undefined {
  if (typeof agentSession === 'string') return agentSession;
  if (typeof agentSession === 'object' && agentSession !== null) {
    const value = (agentSession as Record<string, unknown>)['value'];
    if (typeof value === 'string' && value.length > 0) return value;
    const id = (agentSession as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

/** The text of a transcript message body: a string, or the text parts of a list. */
export function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['text'] === 'string' ? String((entry as Record<string, unknown>)['text']) : '')).filter(Boolean);
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * The last assistant message in a Pi or Claude Code transcript, which is where
 * a finished child's answer sits. Undefined when the file is missing or holds none.
 */
export function lastAssistantMessage(file: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[index] ?? 'null');
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const message = record['message'];
    const role = record['type'] === 'assistant' ? 'assistant' : typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['role'] : undefined;
    if (role !== 'assistant') continue;
    const body = typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['content'] : record['content'];
    const text = messageText(body);
    if (text?.trim()) return text;
  }
  return undefined;
}
