// Codex's own record of its sessions, which Bellwether reads because herdr
// reports no agent_session for Codex. herdr 0.9.5 lists a codex integration
// that installs a SessionStart hook, and a machine without that integration,
// or with a hook another integration wrote, reports no session at all. So the
// spawn does not wait for herdr: it finds the session in Codex's rollouts.
//
// Codex writes one rollout per session, at
// `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<local time>-<id>.jsonl`,
// where CODEX_HOME defaults to `~/.codex`. The first line is the session's
// `session_meta`, with its id, working directory and start time. Each user
// and assistant message follows as a `response_item` line. Codex 0.160.0 also
// keeps a SQLite index (`state_5.sqlite`), whose file name carries a schema
// version, so Bellwether reads the rollout, which is also the transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How long the spawn waits for Codex to write the session's rollout. */
export const CODEX_SESSION_WAIT_MS = 30_000;

/** Codex's home on this machine, as Codex resolves it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const named = env['CODEX_HOME'];
  return named ? path.resolve(named) : path.join(env['HOME'] || os.homedir(), '.codex');
}

/** The directory that holds the rollouts under a Codex home. */
export function codexSessionsDir(home: string): string {
  return path.join(home, 'sessions');
}

/** The working directory as given and as the kernel resolves it. */
export function dirForms(cwd: string): string[] {
  try {
    const real = fs.realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  /** `cli` for the terminal UI; an object for a subagent's session. */
  source?: unknown;
}

interface RolloutLine {
  type?: string;
  payload?: Record<string, unknown>;
}

function parseLine(line: string): RolloutLine | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as RolloutLine) : undefined;
  } catch {
    return undefined;
  }
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The session a rollout file opens with, or undefined when its first line is not a session_meta. */
export function rolloutMeta(file: string): SessionMeta | undefined {
  let first = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // The first line carries the base instructions and can be long.
      const buffer = Buffer.alloc(256 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      first = buffer.subarray(0, read).toString('utf8').split('\n')[0] ?? '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const line = parseLine(first);
  const payload = line?.payload;
  if (line?.type !== 'session_meta' || !payload) return undefined;
  const { id, cwd, timestamp, source } = payload;
  if (typeof id !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') return undefined;
  return { id, cwd, timestamp, source };
}

/** The text of a `response_item` message line for a role, or undefined. */
function messageText(line: RolloutLine, role: 'user' | 'assistant'): string | undefined {
  const payload = line.payload;
  if (line.type !== 'response_item' || payload?.['type'] !== 'message' || payload['role'] !== role) return undefined;
  const content = payload['content'];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter((value) => value.trim())
    .join('\n');
  return text || undefined;
}

/** Every rollout file under a sessions directory, in the day directories from `since` on. */
function rolloutsSince(sessions: string, since: number): string[] {
  const files: string[] = [];
  // Codex names the day directory in local time, so a day either side is read too.
  const floor = new Date(since - 86_400_000);
  const floorKey = `${floor.getFullYear()}${String(floor.getMonth() + 1).padStart(2, '0')}${String(floor.getDate()).padStart(2, '0')}`;
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort();
    } catch {
      return [];
    }
  };
  for (const year of list(sessions)) {
    for (const month of list(path.join(sessions, year))) {
      for (const day of list(path.join(sessions, year, month))) {
        if (`${year}${month}${day}` < floorKey) continue;
        const dir = path.join(sessions, year, month, day);
        for (const name of list(dir)) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name));
      }
    }
  }
  return files;
}

export interface CodexSessionLookup {
  /** Codex's home, which holds the sessions directory. */
  home: string;
  cwd: string;
  /** When the child's record was written, before Codex started. */
  since: string;
  /** The first prompt the spawn gave, which the session's first user message must hold. */
  prompt: string;
  waitMs?: number;
  intervalMs?: number;
}

export interface CodexSession {
  id: string;
  rollout: string;
}

/** One look at the rollouts: the session, or why none counts yet. */
function lookOnce(input: CodexSessionLookup): { found: CodexSession } | { reason: string } {
  const sessions = codexSessionsDir(input.home);
  if (!fs.existsSync(sessions)) return { reason: `${sessions} does not exist` };
  const since = Date.parse(input.since);
  // A clock read a little apart from Codex's own still counts.
  const earliest = since - 5_000;
  const dirs = dirForms(input.cwd);
  let nearest: string | undefined;
  const found: CodexSession[] = [];
  for (const file of rolloutsSince(sessions, since)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < earliest) continue;
    const meta = rolloutMeta(file);
    if (!meta || Date.parse(meta.timestamp) < earliest) continue;
    // A subagent's session names its parent thread in an object.
    if (typeof meta.source === 'object' && meta.source !== null) continue;
    if (!dirs.includes(meta.cwd)) {
      nearest ??= `session ${meta.id} runs in ${meta.cwd}, not ${input.cwd}`;
      continue;
    }
    const prompted = readLines(file).some((line) => {
      const parsed = parseLine(line);
      return parsed !== undefined && (messageText(parsed, 'user') ?? '').includes(input.prompt);
    });
    if (!prompted) {
      nearest = `session ${meta.id} in ${input.cwd} holds no user message with the brief's prompt yet`;
      continue;
    }
    found.push({ id: meta.id, rollout: file });
  }
  // The prompt names the brief file, whose name is the child id, so one session at most holds it.
  if (found[0]) return { found: found[0] };
  return { reason: nearest ?? `no rollout under ${sessions} started after ${input.since}` };
}

/**
 * Wait for Codex to write the child's session: a rollout started after the
 * child's record, in the child's directory, not a subagent's, whose user
 * message holds the brief's prompt. That rollout is the proof the brief
 * arrived. After the wait, the error names the sessions directory and what
 * the last look saw.
 */
export async function findCodexSession(input: CodexSessionLookup): Promise<CodexSession> {
  const waitMs = input.waitMs ?? CODEX_SESSION_WAIT_MS;
  const intervalMs = input.intervalMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const look = lookOnce(input);
    if ('found' in look) return look.found;
    if (Date.now() >= deadline) throw new Error(`Codex never wrote a session with the brief's prompt under ${codexSessionsDir(input.home)} within ${waitMs} ms: ${look.reason}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}

/** The rollout of a session under a Codex home, or undefined. */
export function findRollout(home: string, sessionId: string): string | undefined {
  const sessions = codexSessionsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(sessions, { recursive: true }) as string[];
  } catch {
    return undefined;
  }
  const suffix = `-${sessionId}.jsonl`;
  const name = names.find((entry) => path.basename(entry).startsWith('rollout-') && entry.endsWith(suffix));
  return name ? path.join(sessions, name) : undefined;
}

/** The newest assistant answer in a rollout, or undefined when it holds none. */
export function codexLastMessage(file: string): string | undefined {
  const lines = readLines(file);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseLine(lines[index] ?? '');
    const text = parsed ? messageText(parsed, 'assistant') : undefined;
    if (text) return text;
  }
  return undefined;
}

/** When a rollout last grew, in milliseconds, or undefined when it is gone. */
export function codexActivity(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
