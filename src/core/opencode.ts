// The OpenCode v2 harness. Bellwether targets OpenCode 2 only, as published in
// @opencode/cli (the opencode-ai package stays on 1.x), and was designed
// against 2.4.2. Three facts of v2 shape the launch:
//
// - `opencode --session <id>` creates a session under exactly that id when
//   the first prompt is submitted, and `--prompt` fills and submits that first
//   prompt. So the spawn mints the id, and the store proves the brief arrived:
//   a top-level session with that id, in the child's directory, whose user
//   message holds the prompt.
// - A TUI connects by default to a shared background server, which reads the
//   configuration from its own environment, so a per-child OPENCODE_CONFIG on
//   the TUI would not reach it. `--standalone` gives the child a private server
//   that inherits the tab's environment, and with it the child's own MCP
//   configuration and the store path.
// - herdr types the agent's arguments into a shell, refuses a line break, and
//   cuts the command at 1,024 bytes, so the brief travels as a file inside the
//   child's directory, where OpenCode reads without an external-directory
//   question, and the prompt is one line that names it.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { channelEntry, MCP_SERVER_NAME } from './mcp-config.ts';
import { mcpConfigPath, mcpDir } from './paths.ts';

/** The OpenCode major version the harness speaks. */
export const OPENCODE_MAJOR = 2;

/** The release this harness was designed and checked against. */
export const OPENCODE_DESIGNED_AGAINST = '2.4.2';

/** Where OpenCode 2 is published. */
export const OPENCODE_PACKAGE = '@opencode/cli';

/** How long the spawn waits for the store to show the session. */
export const OPENCODE_SESSION_WAIT_MS = 30_000;

/** The flag that gives each child a private OpenCode server. */
export const OPENCODE_STANDALONE = '--standalone';

/**
 * A session id in the form OpenCode 2 mints: `ses_`, twelve hex digits of an
 * inverted millisecond clock and counter, so newer ids sort first, then
 * fourteen base-62 characters. OpenCode checks only the `ses` prefix, and
 * matching its form keeps its newest-first listing right.
 */
let lastStamp = 0;
let counter = 0;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function newOpenCodeSessionId(now = Date.now()): string {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter += 1;
  const value = ~(BigInt(now) * 0x1000n + BigInt(counter));
  let time = '';
  for (let index = 0; index < 6; index += 1) time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0');
  const tail = Array.from(randomBytes(14), (byte) => BASE62[byte % 62]).join('');
  return `ses_${time}${tail}`;
}

/** The one-line prompt that points the child at its brief. */
export function openCodeBriefLine(briefFile: string): string {
  return `Your task is in ${briefFile}. Read it, then do what it says.`;
}

/** The arguments an OpenCode child starts with. */
export function openCodeArgs(sessionId: string, briefFile: string | undefined, extra: string[] = []): string[] {
  return [OPENCODE_STANDALONE, '--session', sessionId, ...(briefFile ? ['--prompt', openCodeBriefLine(briefFile)] : []), ...extra];
}

/**
 * The store OpenCode 2 writes, by its own rule: OPENCODE_DB, taken relative
 * to the data directory when it is not absolute, or `opencode.db` there. The
 * spawn passes the result to the child as OPENCODE_DB, so the child's private
 * server and this lookup agree whatever environment the daemon started with.
 */
export function openCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = path.join(env['XDG_DATA_HOME'] || path.join(env['HOME'] || os.homedir(), '.local', 'share'), 'opencode');
  const named = env['OPENCODE_DB'];
  if (named) return path.isAbsolute(named) ? named : path.resolve(data, named);
  return path.join(data, 'opencode.db');
}

/** What `opencode --version` said on this machine, or why it could not be asked. */
export type OpenCodeProbe =
  | { version: string; binary: string; missing?: undefined; unreadable?: undefined }
  | { missing: string; version?: undefined; unreadable?: undefined }
  | { unreadable: string; binary: string; version?: undefined; missing?: undefined };

/** The version in OpenCode's `--version` output, which carries colour codes on a terminal. */
export function parseOpenCodeVersion(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(plain)?.[1];
}

/** The opencode on this PATH, as a path, or undefined. */
function onPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, 'opencode');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Ask the opencode on this machine's PATH for its version. */
export function probeOpenCode(env: NodeJS.ProcessEnv = process.env): Promise<OpenCodeProbe> {
  const binary = onPath(env);
  if (!binary) return Promise.resolve({ missing: `no opencode on the daemon's PATH` });
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 15_000, env: { ...env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      const printed = `${stdout}\n${stderr}`;
      const version = parseOpenCodeVersion(printed);
      if (version) resolve({ version, binary });
      else resolve({ unreadable: (printed.replace(/\u001b\[[0-9;]*m/g, '').trim() || error?.message || 'nothing').slice(0, 200), binary });
    });
  });
}

function majorOf(version: string): number | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : undefined;
}

function needs(): string {
  return `Bellwether's opencode kind needs OpenCode ${OPENCODE_MAJOR} (designed against ${OPENCODE_DESIGNED_AGAINST}, published as ${OPENCODE_PACKAGE})`;
}

/**
 * Refuse an OpenCode that is not version 2, naming what was found and what is
 * needed, and one whose version output names no version, such as the 2.0
 * preview's `vlocal`. An opencode the daemon cannot see is not refused here,
 * because the tab's shell may have another PATH: the store check after the
 * start reads the version the child's own server records on its session.
 */
export function requireOpenCodeV2(probe: OpenCodeProbe, name: string): void {
  if (probe.missing !== undefined) return;
  if (probe.unreadable !== undefined) throw new Error(`${name} was not started: ${probe.binary} --version printed "${probe.unreadable}", which names no version, and ${needs()}. Install it with \`npm install -g ${OPENCODE_PACKAGE}\`, or put an OpenCode 2 first on PATH.`);
  if (majorOf(probe.version) === OPENCODE_MAJOR) return;
  throw new Error(`${name} was not started: ${probe.binary} is OpenCode ${probe.version}, and ${needs()}. Install it with \`npm install -g ${OPENCODE_PACKAGE}\`, or put an OpenCode 2 first on PATH.`);
}

/** The MCP configuration an OpenCode child's private server reads: one local server, Bellwether's. */
export function openCodeMcpConfig(childId: string, environment: Record<string, string>, model?: string): { $schema: string; model?: string; mcp: { servers: Record<string, { type: 'local'; command: string[]; environment: Record<string, string> }> } } {
  return {
    $schema: 'https://opencode.ai/config.json',
    // The default model, used when neither the session nor its agent names one.
    ...(model ? { model } : {}),
    mcp: {
      servers: {
        [MCP_SERVER_NAME]: { type: 'local', command: [process.execPath, '--disable-warning=ExperimentalWarning', channelEntry(), '--child', childId], environment },
      },
    },
  };
}

/**
 * Write an OpenCode child's MCP configuration where a Claude Code child's
 * goes, with mode 0600, and return its path. The child's tab names it in
 * OPENCODE_CONFIG. The same cleanup removes it.
 */
export function writeOpenCodeMcpConfig(childId: string, environment: Record<string, string>, model?: string): string {
  const dir = mcpDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = mcpConfigPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(openCodeMcpConfig(childId, environment, model), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** The working directory as given and as the kernel resolves it. */
function dirForms(cwd: string): string[] {
  try {
    const real = fs.realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

function openStore(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export interface OpenCodeSession {
  id: string;
  directory: string;
  /** The OpenCode version that created the session. */
  version: string;
}

export interface SessionLookup {
  db: string;
  sessionId: string;
  cwd: string;
  /** The first prompt the spawn gave, which the session's user message must hold. */
  prompt: string;
  waitMs?: number;
  intervalMs?: number;
}

/** One look at the store: the session, or why it does not count yet. */
function lookOnce(input: SessionLookup): { found: OpenCodeSession } | { reason: string; final?: boolean } {
  if (!fs.existsSync(input.db)) return { reason: `the store ${input.db} does not exist` };
  let db: DatabaseSync;
  try {
    db = openStore(input.db);
  } catch (error) {
    return { reason: `the store ${input.db} could not be opened: ${(error as Error).message}` };
  }
  try {
    if (!hasTable(db, 'session_v2')) return { reason: `the store ${input.db} has no session_v2 table, so only OpenCode 1.x has written it; ${needs()}` };
    const row = db.prepare('SELECT id, parent_id, directory, version FROM session_v2 WHERE id = ?').get(input.sessionId) as { id: string; parent_id: string | null; directory: string; version: string } | undefined;
    if (!row) return { reason: `no session ${input.sessionId} in ${input.db}` };
    if (row.parent_id) return { reason: `session ${input.sessionId} in ${input.db} is a subagent of ${row.parent_id}`, final: true };
    if (!dirForms(input.cwd).includes(row.directory)) return { reason: `session ${input.sessionId} in ${input.db} runs in ${row.directory}, not ${input.cwd}`, final: true };
    if (majorOf(row.version) !== OPENCODE_MAJOR) return { reason: `session ${input.sessionId} in ${input.db} was written by OpenCode ${row.version}, and ${needs()}`, final: true };
    const prompted = db.prepare("SELECT 1 FROM session_message WHERE session_id = ? AND type = 'user' AND json_extract(data, '$.text') LIKE '%' || ? || '%' ESCAPE '\\' LIMIT 1").get(input.sessionId, input.prompt.replace(/[\\%_]/g, (match) => `\\${match}`));
    if (!prompted) return { reason: `session ${input.sessionId} in ${input.db} holds no user message with the brief's prompt` };
    return { found: { id: row.id, directory: row.directory, version: row.version } };
  } finally {
    db.close();
  }
}

/**
 * Wait for OpenCode's store to show the child's session: the top-level
 * session with the id the spawn minted, in the child's directory, written by
 * OpenCode 2, whose user message holds the prompt. That row is the proof the
 * brief arrived, since herdr reports no session for OpenCode. A subagent's
 * session, a session in another directory and one without the prompt do not
 * count. After the wait, the error names the store and what the last look saw.
 */
export async function findOpenCodeSession(input: SessionLookup): Promise<OpenCodeSession> {
  const waitMs = input.waitMs ?? OPENCODE_SESSION_WAIT_MS;
  const intervalMs = input.intervalMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const look = lookOnce(input);
    if ('found' in look) return look.found;
    // A session under the minted id that is a subagent, in another directory or
    // from another major version can never become the child's, so it fails now.
    if (look.final) throw new Error(`The session OpenCode recorded under ${input.sessionId} is not this child's: ${look.reason}.`);
    if (Date.now() >= deadline) throw new Error(`OpenCode never recorded session ${input.sessionId} with the brief's prompt within ${waitMs} ms: ${look.reason}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}

/**
 * The newest assistant answer in an OpenCode session: its text parts joined,
 * or the error that ended the turn when it wrote none. Undefined when the
 * store or the session holds neither.
 */
export function openCodeLastMessage(file: string, sessionId: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  let db: DatabaseSync;
  try {
    db = openStore(file);
  } catch {
    return undefined;
  }
  try {
    if (!hasTable(db, 'session_message')) return undefined;
    const messages = db.prepare("SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 50").all(sessionId) as { id: string; data: string }[];
    const parts = db.prepare("SELECT data FROM session_part WHERE message_id = ? AND type = 'text' ORDER BY ordinal");
    for (const message of messages) {
      const text = (parts.all(message.id) as { data: string }[])
        .map((part) => {
          try {
            const value = (JSON.parse(part.data) as { text?: unknown }).text;
            return typeof value === 'string' ? value : '';
          } catch {
            return '';
          }
        })
        .filter((value) => value.trim())
        .join('\n');
      if (text) return text;
      try {
        const error = (JSON.parse(message.data) as { error?: { message?: unknown } }).error;
        if (typeof error?.message === 'string' && error.message) return `OpenCode ended the turn with an error: ${error.message}`;
      } catch {
        // A row cut short is not an answer.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** What the store says of a session's activity: when it last changed, whether a turn runs, how the last one ended. */
export interface OpenCodeSessionState {
  updatedAt: number;
  busy: boolean;
  outcome?: string;
}

/**
 * The session's activity from the store. A turn runs when its busy time is
 * later than its idle time. A dialog waiting for an answer is not in the
 * store: OpenCode keeps pending permissions and questions in memory.
 */
export function openCodeSessionState(file: string, sessionId: string): OpenCodeSessionState | undefined {
  if (!fs.existsSync(file)) return undefined;
  let db: DatabaseSync;
  try {
    db = openStore(file);
  } catch {
    return undefined;
  }
  try {
    if (!hasTable(db, 'session_v2')) return undefined;
    const row = db.prepare('SELECT time_updated, time_busy, time_idle, idle_outcome FROM session_v2 WHERE id = ?').get(sessionId) as { time_updated: number; time_busy: number | null; time_idle: number | null; idle_outcome: string | null } | undefined;
    if (!row) return undefined;
    return { updatedAt: row.time_updated, busy: (row.time_busy ?? 0) > (row.time_idle ?? 0), ...(row.idle_outcome ? { outcome: row.idle_outcome } : {}) };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
