// Cline. herdr detects it, and agent_adopt takes a pane that runs it. Each
// child agent_spawn starts runs in Cline's sandbox mode, with a data directory
// of its own, so its session runs in its own process and never meets Cline's
// shared background hub. A caller who passes `-y` in args also gets Cline's
// benchmark mode, and the spawn reply prints what that mode costs. Facts
// checked against Cline 3.0.76, by reading its published bundle:
//
// - `CLINE_MCP_SETTINGS_PATH` names the MCP settings file, and the session
//   reads it. MCP servers load in the process that runs the session.
// - `cline -i` asks for the "auto" backend, which joins a running hub and
//   starts one when none runs. The hub is started with the environment of the
//   session that started it, keeps running after that session, and has no
//   idle exit. A second session that joins it loads the first one's servers.
//   The TUI asks for "auto" by name, so CLINE_SESSION_BACKEND_MODE does not
//   reach it.
// - The TUI forces the local backend, which runs the session in its own
//   process and starts no hub, in two cases: `-y`, and sandbox mode.
//   `--data-dir <dir>` or CLINE_SANDBOX=1 turns sandbox mode on, and
//   CLINE_SANDBOX_DATA_DIR names the directory. Sandbox mode keeps the
//   default act mode, its tools, skills, sub-agents and teams; `-y` is the
//   benchmark mode: six built-in tools instead of 26, no skills or sub-agents,
//   and another system prompt. A -y TUI stays up after its first task and
//   takes a follow-up typed at its prompt.
// - Sandbox mode sets CLINE_DATA_DIR, CLINE_DB_DATA_DIR,
//   CLINE_SESSION_DATA_DIR, CLINE_TEAM_DATA_DIR, CLINE_PROVIDER_SETTINGS_PATH
//   and CLINE_HOOKS_LOG_PATH under its directory, whatever the environment
//   says. It leaves CLINE_DIR (skills, rules, workflows, hooks, plugins),
//   CLINE_MCP_SETTINGS_PATH and CLINE_GLOBAL_SETTINGS_PATH alone. The provider
//   settings, sign-ins included, are `<dir>/settings/providers.json`, which
//   Cline replaces by writing a temporary file and renaming it. So the spawn
//   links `<dir>/settings` to the operator's settings directory: a sign-in the
//   child refreshes lands in the operator's own file.
// - herdr reports no agent_session for Cline, and `--id` only reopens a
//   session Cline already has. The store is `sessions.db`, in
//   CLINE_DB_DATA_DIR, else CLINE_DATA_DIR/db, else CLINE_DIR/data/db, else
//   ~/.cline/data/db; a sandboxed child's is `<dir>/db/sessions.db`. A
//   `sessions` row holds session_id, pid, started_at and updated_at (ISO,
//   UTC), ended_at, status, cwd, is_subagent, the first prompt wrapped in
//   `<user_input mode="...">`, and messages_path. The messages file is JSON:
//   `{ messages: [{ role, content: [{ type, text }] }] }`.
// - A session the TUI runs records the TUI's pid; one the hub runs records
//   the hub's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_HOST } from '../machine.ts';
import { channelEntry, MCP_SERVER_NAME } from '../mcp-config.ts';
import { clineDataDir, mcpConfigPath, mcpDir } from '../paths.ts';
import type { ChildRecord } from '../types.ts';
import { briefSentence, modelFlag, noTranscript } from './shared.ts';
import type { HarnessEntry } from './types.ts';
import { nodeCommand, stablePath } from '../stable-path.ts';

/** The Cline release these facts were checked against. */
export const CLINE_CHECKED_AGAINST = '3.0.76';

/** How long a store lookup waits for the session to show. */
export const CLINE_SESSION_WAIT_MS = 30_000;

/** The flags that put Cline in its benchmark mode. */
export const CLINE_OPT_IN = ['-y', '--yolo'];

/** What the spawn reply says of a child started the default way: where it runs, and what it shares. */
export function clineSandboxNote(dataDir: string, settingsDir: string): string {
  return (
    `Cline runs this child in Cline's sandbox mode, with its own data directory at ${dataDir}. ` +
    "Its session runs in the child's own process, outside Cline's shared hub, and loads only its own Bellwether server. " +
    `It keeps Cline's default mode, and it signs in with your provider settings through a link to ${settingsDir}. ` +
    "Cline records the session in the child's own store, so `cline history` does not list it. agent_read reads it there."
  );
}

/** What the spawn reply says when the caller turns on Cline's benchmark mode: what -y costs, measured on Cline 3.0.76. */
export const CLINE_OPT_IN_NOTE =
  'Cline runs this child with -y, in its own data directory, and it stays up after its first task, so agent_send reaches it. ' +
  "The cost is Cline's benchmark mode: a different system prompt, six built-in tools (read_files, search_codebase, run_commands, fetch_web_content, editor and ask_question) plus its MCP tools, where the default mode offers 26, " +
  'no skills and no sub-agents or teams. Cline\'s own help says of -y: "DANGEROUS: use only in sandboxed environments."';

/** Whether the caller's extra arguments turn on Cline's unattended mode. */
export function clineOptedIn(args: readonly string[] = []): boolean {
  return args.some((arg) => CLINE_OPT_IN.includes(arg));
}

/**
 * The MCP settings a Cline child reads through CLINE_MCP_SETTINGS_PATH: one
 * stdio server, Bellwether's, with this child's id. The file replaces Cline's
 * global settings for the child, so a Bellwether server there is not loaded twice.
 */
export function clineMcpSettings(childId: string, env: Record<string, string>): { mcpServers: Record<string, { transport: { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } }> } {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { transport: { type: 'stdio', command: nodeCommand(), args: ['--disable-warning=ExperimentalWarning', stablePath(channelEntry()), '--child', childId], env } },
    },
  };
}

/** Write a Cline child's MCP settings where a Claude Code child's MCP config goes, with mode 0600, and return the path. The same cleanup removes it. */
export function writeClineMcpSettings(childId: string, env: Record<string, string>): string {
  const dir = mcpDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = mcpConfigPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(clineMcpSettings(childId, env), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** The provider settings file a Cline session outside sandbox mode reads, by Cline's own rule. */
export function clineProviderSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env['CLINE_PROVIDER_SETTINGS_PATH']?.trim();
  if (named) return named;
  const dataDir = env['CLINE_DATA_DIR']?.trim() || path.join(env['CLINE_DIR']?.trim() || path.join(env['HOME'] || os.homedir(), '.cline'), 'data');
  return path.join(dataDir, 'settings', 'providers.json');
}

/**
 * The directory a sandboxed child's `settings` link points at: the one that
 * holds the operator's providers.json. Sandbox mode reads
 * `<dir>/settings/providers.json`, so a file under another name cannot be
 * reached through the link, and the spawn refuses it by name.
 */
export function clineSettingsDir(env: NodeJS.ProcessEnv = process.env): string {
  const file = clineProviderSettingsPath(env);
  if (path.basename(file) !== 'providers.json') {
    throw new Error(
      `CLINE_PROVIDER_SETTINGS_PATH names ${file}, and a Cline child in sandbox mode reads its provider settings only from a file named providers.json, through a link to the directory that holds it. Rename the file to providers.json, or unset the variable`,
    );
  }
  return path.dirname(file);
}

/**
 * Give a sandboxed child its data directory, mode 0700, with `settings`
 * linked to the operator's settings directory, which is created when Cline
 * has not written it yet. A link that already points there stays.
 */
export function prepareClineDataDir(dataDir: string, settingsDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const link = path.join(dataDir, 'settings');
  let current: string | undefined;
  try {
    current = fs.readlinkSync(link);
  } catch {
    current = undefined;
  }
  if (current === settingsDir) return;
  fs.rmSync(link, { force: true, recursive: false });
  fs.symlinkSync(settingsDir, link, 'dir');
}

/** A sandboxed child's data directory, from its store: `<dir>/db/sessions.db`. */
function dataDirOf(store: string): string {
  return path.dirname(path.dirname(store));
}

/** The store Cline writes, by its own rule. */
export function clineDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dbDir = env['CLINE_DB_DATA_DIR']?.trim();
  if (dbDir) return path.join(dbDir, 'sessions.db');
  const dataDir = env['CLINE_DATA_DIR']?.trim() || path.join(env['CLINE_DIR']?.trim() || path.join(env['HOME'] || os.homedir(), '.cline'), 'data');
  return path.join(dataDir, 'db', 'sessions.db');
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

/** Run a read against the store, or undefined when the store is absent, unreadable or has no sessions table. */
function withStore<T>(file: string, read: (db: DatabaseSync) => T): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() === undefined) return undefined;
    return read(db);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

interface SessionRow {
  session_id: string;
  pid: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  cwd: string;
  prompt: string | null;
  messages_path: string | null;
  updated_at: string;
}

export interface ClineLookup {
  db: string;
  cwd: string;
  /** The first prompt the spawn gave, which the session's prompt must hold. */
  prompt: string;
  /** The spawn's start, as an ISO time: an older session in the same directory does not count. */
  since: string;
  waitMs?: number;
  intervalMs?: number;
}

/** One look at the store: the session id, or why none counts yet. */
function lookOnce(input: ClineLookup): { found: string } | { reason: string } {
  if (!fs.existsSync(input.db)) return { reason: `the store ${input.db} does not exist` };
  const dirs = dirForms(input.cwd);
  const rows = withStore(input.db, (db) =>
    db
      .prepare(`SELECT session_id, prompt FROM sessions WHERE is_subagent = 0 AND started_at >= ? AND cwd IN (${dirs.map(() => '?').join(', ')}) ORDER BY started_at DESC`)
      .all(input.since, ...dirs) as Pick<SessionRow, 'session_id' | 'prompt'>[],
  );
  if (!rows) return { reason: `the store ${input.db} could not be read as a Cline sessions store` };
  if (rows.length === 0) return { reason: `${input.db} holds no top-level session in ${input.cwd} started at or after ${input.since}` };
  const prompted = rows.find((row) => row.prompt?.includes(input.prompt));
  if (!prompted) return { reason: `${input.db} holds ${rows.length} top-level session${rows.length === 1 ? '' : 's'} in ${input.cwd} since ${input.since}, and none holds the brief's prompt` };
  return { found: prompted.session_id };
}

/**
 * Wait for Cline's store to show a session the spawn started: the newest
 * top-level session in the child's directory, started at or after the spawn,
 * whose prompt holds the brief line. That row is the proof the brief arrived.
 * A sub-agent's session, an older run in a reused directory and a session in
 * another directory do not count. After the wait, the error names the store
 * and what the last look saw.
 */
export async function findClineSession(input: ClineLookup): Promise<string> {
  const waitMs = input.waitMs ?? CLINE_SESSION_WAIT_MS;
  const intervalMs = input.intervalMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const look = lookOnce(input);
    if ('found' in look) return look.found;
    if (Date.now() >= deadline) throw new Error(`Cline never recorded a session with the brief's prompt within ${waitMs} ms: ${look.reason}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}

/**
 * The session of a Cline already running in a directory, for a pane that
 * agent_adopt took: the live top-level session that the given process
 * records, or failing that, the newest live top-level session there. A
 * session the hub runs records the hub's pid, so the directory is the
 * fallback. Undefined when the store holds no live session there.
 */
export function liveClineSession(input: { db: string; cwd: string; pid?: number }): string | undefined {
  const dirs = dirForms(input.cwd);
  const rows = withStore(
    input.db,
    (db) => db.prepare(`SELECT session_id, pid FROM sessions WHERE is_subagent = 0 AND ended_at IS NULL AND cwd IN (${dirs.map(() => '?').join(', ')}) ORDER BY started_at DESC`).all(...dirs) as Pick<SessionRow, 'session_id' | 'pid'>[],
  );
  return (rows?.find((row) => input.pid !== undefined && row.pid === input.pid) ?? rows?.[0])?.session_id;
}

function sessionRow(file: string, sessionId: string): SessionRow | undefined {
  return withStore(file, (db) => db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined);
}

/** The text parts of a message's content, joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const value = typeof part === 'object' && part !== null ? (part as { type?: unknown; text?: unknown }) : {};
      return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
    })
    .filter((text) => text.trim())
    .join('\n');
}

/**
 * The newest assistant answer in a Cline session, read from the messages
 * file its row names. Undefined when the row, the file or an answer is missing.
 */
export function clineLastMessage(file: string, sessionId: string): string | undefined {
  const row = sessionRow(file, sessionId);
  if (!row?.messages_path) return undefined;
  let messages: unknown;
  try {
    messages = (JSON.parse(fs.readFileSync(row.messages_path, 'utf8')) as { messages?: unknown }).messages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null;
    if (message?.role !== 'assistant') continue;
    const text = textOf(message.content);
    if (text) return text;
  }
  return undefined;
}

/** What the store says of a session: when it last changed, its status, and whether it ended. */
export interface ClineSessionState {
  updatedAt: number;
  status: string;
  ended: boolean;
}

/** A session's state from its row, or undefined when the store has no such session. */
export function clineSessionState(file: string, sessionId: string): ClineSessionState | undefined {
  const row = sessionRow(file, sessionId);
  if (!row) return undefined;
  const updatedAt = Date.parse(row.updated_at);
  return { updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0, status: row.status, ended: row.ended_at !== null };
}

/**
 * The store and session a child's conversation is read from. A child
 * adopted from a pane carries no session, because herdr reports none for
 * Cline, so its session is the live one in its directory.
 */
function storedSession(child: ChildRecord, store: string = child.store ?? clineDbPath()): { store: string; session: string } | undefined {
  if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST) return undefined;
  const session = child.session?.value ?? (child.cwd ? liveClineSession({ db: store, cwd: child.cwd }) : undefined);
  return session ? { store, session } : undefined;
}

export const cline: HarnessEntry = {
  kind: 'cline',
  harness: 'cline',
  label: 'Cline',
  // An older daemon refuses cline without -y, or starts it without a sandbox.
  since: { protocol: 4, version: '0.1.5' },
  // Cline's read_files reads a file outside the working directory without a question.
  brief: { where: 'prompts', launch: briefSentence },
  chosenBy: 'flag',
  launchArgs: ({ model, extra = [], files }) => [...modelFlag(model, extra), '-i', ...(files.briefFile ? [briefSentence(files.briefFile)] : []), ...extra],
  // herdr reports no agent_session for Cline, and `--id` only reopens a session
  // Cline already has, so the spawn finds the session Cline picked, in the
  // child's own data directory. An adopted child's session is found in the
  // operator's store by agent_read and the watcher.
  session: {
    from: 'store',
    storePath: (hooks, child) => hooks.store ?? path.join(clineDataDir(child.id), 'db', 'sessions.db'),
    async confirm({ store, cwd, briefFile, since }, hooks) {
      return findClineSession({ db: store, cwd, prompt: briefSentence(briefFile), since, waitMs: hooks.waitMs, intervalMs: hooks.intervalMs });
    },
  },
  /**
   * A child on another machine is refused, because the store is read where
   * the child runs. So is a provider settings file the sandbox's link cannot
   * reach.
   */
  async preflight({ name, host }) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: a cline child runs on this machine only for now, because Cline's store is read where it runs. Omit machine.`);
    try {
      clineSettingsDir();
    } catch (error) {
      throw new Error(`${name} was not started: ${(error as Error).message}.`);
    }
  },
  spawnNote: (child, args) => {
    if (clineOptedIn(args)) return CLINE_OPT_IN_NOTE;
    return child.store ? clineSandboxNote(dataDirOf(child.store), clineSettingsDir()) : undefined;
  },
  reports: {
    via: 'harness-config',
    // The child runs in sandbox mode in its own data directory, which holds the
    // store this daemon reads, and reads its own MCP settings.
    local(child, { env }) {
      const dataDir = child.store ? dataDirOf(child.store) : clineDataDir(child.id);
      prepareClineDataDir(dataDir, clineSettingsDir());
      return { env: { CLINE_SANDBOX: '1', CLINE_SANDBOX_DATA_DIR: dataDir, CLINE_MCP_SETTINGS_PATH: writeClineMcpSettings(child.id, { ...env }) } };
    },
    remoteRefusal: "a cline child runs on this machine only for now, because Cline's store is read where it runs",
  },
  // Cline has no inbound path: it loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session, so a parent's message is typed into its pane.
  inbox: { via: 'none', reason: 'Cline loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session' },
  conversation: {
    locate: noTranscript('Cline'),
    lastMessage(child) {
      const found = storedSession(child);
      return found ? clineLastMessage(found.store, found.session) : undefined;
    },
    pending(child) {
      const store = child.store ?? clineDbPath();
      if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST) return { note: `${child.name} runs on machine ${child.host}, and Bellwether reads Cline's store only on this machine.`, withScreen: true };
      const found = storedSession(child, store);
      if (!found) return { note: `Cline's store at ${store} holds no live session in ${child.cwd ?? 'an unknown directory'}.`, withScreen: true };
      const state = clineSessionState(found.store, found.session);
      if (state && !state.ended) return { note: `Cline's store at ${store} holds no answer from session ${found.session} yet; its status is ${state.status}.`, withScreen: true };
      return { note: `Cline's store at ${store} holds no answer from session ${found.session}${state ? '' : ', and no such session'}.`, withScreen: !state };
    },
    // A session's row changes with each step it takes, and the store says so without a screen read.
    activity(child) {
      const found = storedSession(child);
      return found ? clineSessionState(found.store, found.session)?.updatedAt : undefined;
    },
  },
  // Cline keeps a pending tool approval or question in memory, not in its store, so a dialog is read off the screen.
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list with a marked option, or a y/n question (detectModal)' }, activity: 'store' },
  movable: false,
};
