// Cline. herdr detects it, and agent_adopt takes a pane that runs it. By
// default agent_spawn refuses it: Cline runs every TUI session it can inside
// one shared background hub, and MCP servers load in the process that runs
// the session, so a per-child MCP configuration does not stay with its child.
// A caller who passes `-y` in args gets a child in Cline's unattended mode,
// which keeps off the hub, and the spawn reply prints what that mode costs.
// Facts checked against Cline 3.0.76:
//
// - `CLINE_MCP_SETTINGS_PATH` names the MCP settings file, and the TUI reads
//   it. But `cline -i` asks for the "auto" backend, which joins a running hub,
//   and starts one when none runs. The hub keeps the environment of the
//   session that started it, and outlives that session. A second child then
//   loads the first child's server, and the operator's own Cline sessions load
//   it too. The environment cannot pick the local backend for the TUI.
// - `-y` forces the local backend and leaves the hub alone, but it is Cline's
//   unattended mode: a narrower tool set and system prompt. A -y TUI stays up
//   after its first task and takes a follow-up typed at its prompt.
// - herdr reports no agent_session for Cline, and `--id` only reopens a
//   session Cline already has. The store is `sessions.db`, in
//   CLINE_DB_DATA_DIR, else CLINE_DATA_DIR/db, else CLINE_DIR/data/db, else
//   ~/.cline/data/db. A `sessions` row holds session_id, pid, started_at and
//   updated_at (ISO, UTC), ended_at, status, cwd, is_subagent, the first
//   prompt wrapped in `<user_input mode="...">`, and messages_path. The
//   messages file is JSON: `{ messages: [{ role, content: [{ type, text }] }] }`.
// - A session the TUI runs records the TUI's pid; one the hub runs records
//   the hub's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_HOST } from '../machine.ts';
import { channelEntry, MCP_SERVER_NAME } from '../mcp-config.ts';
import { mcpConfigPath, mcpDir } from '../paths.ts';
import type { ChildRecord } from '../types.ts';
import { briefSentence, modelFlag, noTranscript } from './shared.ts';
import type { HarnessEntry } from './types.ts';

/** The Cline release these facts were checked against. */
export const CLINE_CHECKED_AGAINST = '3.0.76';

/** The request on Cline's repository for a per-session MCP configuration and a hub-off switch. */
export const CLINE_UPSTREAM_REQUEST = 'https://github.com/cline/cline/issues/15881';

/** How long a store lookup waits for the session to show. */
export const CLINE_SESSION_WAIT_MS = 30_000;

/** The flags that put Cline in its unattended mode, which keeps a session off the shared hub. */
export const CLINE_OPT_IN = ['-y', '--yolo'];

/** Why agent_spawn refuses a cline child started the default way. */
export const CLINE_REFUSAL =
  'Cline runs each terminal session inside one shared background hub, and MCP servers load in the hub, so a per-child Bellwether server does not stay with its child: ' +
  "a second child's reports would be credited to the first, the hub a child starts outlives the child, and the operator's own Cline sessions would load the child's server. " +
  `Cline has no per-session MCP configuration and no switch that keeps a session off the hub (${CLINE_UPSTREAM_REQUEST}). ` +
  'Pass -y in args to start the child in Cline\'s unattended mode instead, whose costs the spawn reply lists';

/** What the spawn reply says when the caller turns on Cline's unattended mode. */
export const CLINE_OPT_IN_NOTE =
  "Cline runs this child in its unattended mode (-y), which keeps the session in the child's own process and off Cline's shared background hub, so its Bellwether server stays its own. " +
  'The mode costs: a narrower tool set (read_files, search_codebase, run_commands, fetch_web_content, editor, ask_question and MCP tools), no skills, sub-agents or teams, ' +
  "Cline's unattended system prompt, and every tool call approved without a question. The child stays up after its first task and takes an agent_send follow-up. " +
  `Without -y, the spawn is refused: in the shared hub a second child's reports would be credited to the first, the hub would outlive the child, and the operator's own Cline sessions would load the child's server (${CLINE_UPSTREAM_REQUEST}).`;

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
      [MCP_SERVER_NAME]: { transport: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', channelEntry(), '--child', childId], env } },
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
  // An older daemon starts cline without the -y gate.
  since: { protocol: 4, version: '0.1.5' },
  // Cline's read_files reads a file outside the working directory without a question.
  brief: { where: 'prompts', argument: briefSentence },
  chosenBy: 'flag',
  launchArgs: ({ model, extra = [], files }) => [...modelFlag(model, extra), '-i', ...(files.briefFile ? [briefSentence(files.briefFile)] : []), ...extra],
  // herdr reports no agent_session for Cline; an adopted child's session is found in the store by agent_read and the watcher.
  session: { from: 'herdr', kind: 'id' },
  /**
   * The default launch is refused for the shared hub, and only `-y` in args
   * opens the door. A child on another machine is refused, because the store
   * is read where the child runs.
   */
  async preflight({ name, host, args }) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: a cline child runs on this machine only for now, because Cline's store is read where it runs. Omit machine.`);
    if (!clineOptedIn(args)) throw new Error(`${name} was not started: ${CLINE_REFUSAL}.`);
  },
  spawnNote: (_child, args) => (clineOptedIn(args) ? CLINE_OPT_IN_NOTE : undefined),
  reports: {
    via: 'harness-config',
    local: (child, { env }) => ({ env: { CLINE_MCP_SETTINGS_PATH: writeClineMcpSettings(child.id, { ...env }) } }),
    remoteRefusal: "a cline child runs on this machine only for now, because Cline's store is read where it runs",
  },
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
