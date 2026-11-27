// Kilo CLI 7, a fork of OpenCode 1.x, and what Bellwether reads of it. Each
// fact here was checked against @kilocode/cli 7.8.40:
//
// - `kilo --session <id>` only continues a session that exists, and exits with
//   "Session not found" for a new id. So the spawn cannot pick the id. It
//   starts kilo with `--prompt`, which submits the first prompt, and finds the
//   session in kilo's store by the child's directory, the spawn's start time
//   and the brief line.
// - The store is SQLite: KILO_DB, taken relative to the data directory when it
//   is not absolute, or `kilo.db` in `$XDG_DATA_HOME/kilo`. The tables are
//   `session`, `message` and `part`, as in OpenCode 1.x. The spawn passes the
//   path to the child as KILO_DB, so the child and this lookup agree.
// - KILO_CONFIG names one more configuration file, merged over the global
//   one. Its `mcp` section takes a local server as `{ type: 'local', command,
//   environment }`, and a server under the same name in the global file is
//   replaced by it. Kilo does not read Claude Code's `.claude.json` or
//   `.mcp.json`.
// - npm's `kilo` is a Node launcher that runs a binary named `.kilo`. herdr
//   0.9.5 detects kilo by its process name, `kilo`, so it never detects a
//   child started through that launcher, and Bellwether could not watch it.
//   The native binary under the name `kilo` is detected.
// - A file outside the working directory raises kilo's "Access external
//   directory" permission question, so the brief goes inside it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { channelEntry, MCP_SERVER_NAME } from '../mcp-config.ts';
import { mcpConfigPath, mcpDir } from '../paths.ts';
import type { VersionProbe } from './types.ts';

/** The Kilo CLI major version the entry speaks. */
export const KILO_MAJOR = 7;

/** The release this entry was designed and checked against. */
export const KILO_DESIGNED_AGAINST = '7.8.40';

/** Where the Kilo CLI is published. */
export const KILO_PACKAGE = '@kilocode/cli';

/** How long the spawn waits for the store to show the session. */
export const KILO_SESSION_WAIT_MS = 30_000;

/** How far before the spawn's start a session may be stamped, for a clock that steps. */
const CLOCK_SLACK_MS = 5_000;

/** The one-line prompt that points the child at its brief. */
export function kiloBriefLine(briefFile: string): string {
  return `Your task is in ${briefFile}. Read it, then do what it says.`;
}

/** The store kilo writes, by its own rule. */
export function kiloDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = path.join(env['XDG_DATA_HOME'] || path.join(env['HOME'] || os.homedir(), '.local', 'share'), 'kilo');
  const named = env['KILO_DB'];
  if (named) return path.isAbsolute(named) ? named : path.resolve(data, named);
  return path.join(data, 'kilo.db');
}

/** The version in `kilo --version` output. */
export function parseKiloVersion(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(plain)?.[1];
}

function onPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, 'kilo');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** What the kilo on the daemon's PATH is: its version, or why it cannot be used. */
export type KiloProbe = VersionProbe & { launcher?: string };

/** Whether a file is a script, such as npm's Node launcher, rather than the native binary. */
export function isScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      return head.toString('latin1') === '#!';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Ask the kilo on this machine's PATH for its version, and say whether it is npm's launcher. */
export function probeKilo(env: NodeJS.ProcessEnv = process.env): Promise<KiloProbe> {
  const binary = onPath(env);
  if (!binary) return Promise.resolve({ missing: `no kilo on the daemon's PATH` });
  const launcher = isScript(fs.realpathSync(binary)) ? fs.realpathSync(binary) : undefined;
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 15_000, env: { ...env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      const printed = `${stdout}\n${stderr}`;
      const version = parseKiloVersion(printed);
      const tail = launcher ? { launcher } : {};
      if (version) resolve({ version, binary, ...tail });
      else resolve({ unreadable: (printed.trim() || error?.message || 'nothing').slice(0, 200), binary, ...tail });
    });
  });
}

function majorOf(version: string): number | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : undefined;
}

function needs(): string {
  return `Bellwether's kilo kind needs Kilo CLI ${KILO_MAJOR} (designed against ${KILO_DESIGNED_AGAINST}, published as ${KILO_PACKAGE})`;
}

/**
 * Refuse a kilo that herdr would not detect, or that is not Kilo CLI 7. A kilo
 * the daemon cannot see is not refused, because the tab's shell may have
 * another PATH: the store check after the start still has to find the session.
 */
export function requireKilo(probe: KiloProbe, name: string): void {
  if (probe.missing !== undefined) return;
  if (probe.launcher) {
    throw new Error(
      `${name} was not started: ${probe.binary} is a script (${probe.launcher}), such as npm's Node launcher for ${KILO_PACKAGE}, which runs the real binary as \`.kilo\`. herdr detects kilo by its process name, so it would never see the child and Bellwether could not watch it. Put the native binary first on PATH under the name kilo, for example \`ln -s "$(npm root -g)/${KILO_PACKAGE}/bin/.kilo" ~/.local/bin/kilo\`.`,
    );
  }
  if (probe.unreadable !== undefined) throw new Error(`${name} was not started: ${probe.binary} --version printed "${probe.unreadable}", which names no version, and ${needs()}.`);
  if (majorOf(probe.version) === KILO_MAJOR) return;
  throw new Error(`${name} was not started: ${probe.binary} is Kilo CLI ${probe.version}, and ${needs()}.`);
}

/** The configuration a kilo child reads through KILO_CONFIG: one local server, Bellwether's. */
export function kiloMcpConfig(childId: string, environment: Record<string, string>): { $schema: string; mcp: Record<string, { type: 'local'; command: string[]; environment: Record<string, string> }> } {
  return {
    $schema: 'https://app.kilo.ai/config.json',
    mcp: {
      [MCP_SERVER_NAME]: { type: 'local', command: [process.execPath, '--disable-warning=ExperimentalWarning', channelEntry(), '--child', childId], environment },
    },
  };
}

/**
 * Write a kilo child's configuration where a Claude Code child's MCP file
 * goes, with mode 0600, and return its path. The same cleanup removes it.
 */
export function writeKiloMcpConfig(childId: string, environment: Record<string, string>): string {
  const dir = mcpDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = mcpConfigPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(kiloMcpConfig(childId, environment), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function dirForms(cwd: string): string[] {
  try {
    const real = fs.realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

function hasTables(db: DatabaseSync, names: string[]): boolean {
  return names.every((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined);
}

/** Open the store read-only, or undefined when it is absent or unreadable. */
function openStore(file: string): DatabaseSync | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

export interface KiloLookup {
  db: string;
  cwd: string;
  /** The first prompt the spawn gave, which the session's user message must hold. */
  prompt: string;
  /** When the spawn began, in milliseconds. */
  since: number;
  waitMs?: number;
  intervalMs?: number;
}

/** One look at the store: the session id, or why none counts yet. */
function lookOnce(input: KiloLookup): { found: string } | { reason: string } {
  if (!fs.existsSync(input.db)) return { reason: `the store ${input.db} does not exist` };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.db, { readOnly: true });
  } catch (error) {
    return { reason: `the store ${input.db} could not be opened: ${(error as Error).message}` };
  }
  try {
    if (!hasTables(db, ['session', 'message', 'part'])) return { reason: `the store ${input.db} has no session, message and part tables, so Kilo CLI ${KILO_MAJOR} did not write it; ${needs()}` };
    const dirs = dirForms(input.cwd);
    const rows = db
      .prepare(`SELECT id, directory, version FROM session WHERE parent_id IS NULL AND time_created >= ? AND directory IN (${dirs.map(() => '?').join(', ')}) ORDER BY time_created`)
      .all(input.since - CLOCK_SLACK_MS, ...dirs) as { id: string; directory: string; version: string }[];
    if (!rows.length) return { reason: `no top-level session in ${input.cwd} started after ${new Date(input.since).toISOString()} in ${input.db}` };
    const prompted = db.prepare(
      "SELECT 1 FROM part JOIN message ON message.id = part.message_id WHERE part.session_id = ? AND json_extract(message.data, '$.role') = 'user' AND json_extract(part.data, '$.type') = 'text' AND json_extract(part.data, '$.text') LIKE '%' || ? || '%' ESCAPE '\\' LIMIT 1",
    );
    const pattern = input.prompt.replace(/[\\%_]/g, (match) => `\\${match}`);
    const found = rows.find((row) => prompted.get(row.id, pattern));
    if (!found) return { reason: `${rows.length} session${rows.length === 1 ? '' : 's'} in ${input.cwd} since the spawn, and none holds a user message with the brief's prompt, in ${input.db}` };
    if (majorOf(found.version) !== KILO_MAJOR) return { reason: `session ${found.id} in ${input.db} was written by Kilo CLI ${found.version}, and ${needs()}` };
    return { found: found.id };
  } finally {
    db.close();
  }
}

/**
 * Wait for kilo's store to show the child's session: a top-level session in
 * the child's directory, created after the spawn began, whose user message
 * holds the prompt. The prompt names the brief file, whose name carries the
 * child id, so no other session matches. After the wait, the error names the
 * store and what the last look saw.
 */
export async function findKiloSession(input: KiloLookup): Promise<string> {
  const waitMs = input.waitMs ?? KILO_SESSION_WAIT_MS;
  const intervalMs = input.intervalMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const look = lookOnce(input);
    if ('found' in look) return look.found;
    if (Date.now() >= deadline) throw new Error(`Kilo never recorded a session with the brief's prompt within ${waitMs} ms: ${look.reason}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}

function textOf(data: string): string {
  try {
    const part = JSON.parse(data) as { type?: unknown; text?: unknown };
    return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
  } catch {
    return '';
  }
}

/**
 * The newest assistant answer in a kilo session: its text parts joined, or
 * the error that ended the turn when it wrote none. Undefined when the store
 * or the session holds neither.
 */
export function kiloLastMessage(file: string, sessionId: string): string | undefined {
  const db = openStore(file);
  if (!db) return undefined;
  try {
    if (!hasTables(db, ['message', 'part'])) return undefined;
    const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 50").all(sessionId) as { id: string; data: string }[];
    const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id');
    for (const message of messages) {
      const text = (parts.all(message.id) as { data: string }[])
        .map((part) => textOf(part.data))
        .filter((value) => value.trim())
        .join('\n');
      if (text) return text;
      try {
        const error = (JSON.parse(message.data) as { error?: { data?: { message?: unknown }; message?: unknown } }).error;
        const said = error?.data?.message ?? error?.message;
        if (typeof said === 'string' && said) return `Kilo ended the turn with an error: ${said}`;
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

/** What the store says of a session: when it last changed, and whether an answer is still being written. */
export interface KiloSessionState {
  updatedAt: number;
  busy: boolean;
}

/**
 * The session's activity from the store. A turn runs while its newest
 * assistant message has no completion time. A pending permission or question
 * is not in the store: kilo keeps it in memory.
 */
export function kiloSessionState(file: string, sessionId: string): KiloSessionState | undefined {
  const db = openStore(file);
  if (!db) return undefined;
  try {
    if (!hasTables(db, ['session', 'message', 'part'])) return undefined;
    const row = db.prepare('SELECT time_updated FROM session WHERE id = ?').get(sessionId) as { time_updated: number } | undefined;
    if (!row) return undefined;
    const stamps = db.prepare('SELECT max(time_updated) AS at FROM part WHERE session_id = ?').get(sessionId) as { at: number | null };
    const newest = db.prepare("SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 1").get(sessionId) as { data: string } | undefined;
    let busy = false;
    if (newest) {
      try {
        busy = (JSON.parse(newest.data) as { time?: { completed?: unknown } }).time?.completed === undefined;
      } catch {
        busy = false;
      }
    }
    return { updatedAt: Math.max(row.time_updated, stamps.at ?? 0), busy };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
