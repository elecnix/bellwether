// A fixture Cline store: the `sessions` table as Cline 3.0.76 creates it in
// sessions.db, and the messages file each row names.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  status TEXT NOT NULL,
  status_lock INTEGER NOT NULL DEFAULT 0,
  interactive INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  team_name TEXT,
  enable_tools INTEGER NOT NULL,
  enable_spawn INTEGER NOT NULL,
  enable_teams INTEGER NOT NULL,
  parent_session_id TEXT,
  parent_agent_id TEXT,
  agent_id TEXT,
  conversation_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  metadata_json TEXT,
  transcript_path TEXT NOT NULL DEFAULT '',
  hook_path TEXT NOT NULL,
  messages_path TEXT,
  updated_at TEXT NOT NULL
)`;

/** Create (or open) a fixture store at `file`. */
export function clineStore(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export interface FixtureSession {
  id: string;
  cwd: string;
  /** The first prompt, which Cline stores wrapped in `<user_input mode="act">`. */
  prompt: string;
  startedAt: string;
  updatedAt?: string;
  endedAt?: string;
  pid?: number;
  status?: string;
  subagent?: boolean;
  /** Assistant answers, in order, written to the messages file after the user's prompt. */
  replies?: string[];
}

/** Add a session row and its messages file, as Cline writes them. */
export function addClineSession(db: DatabaseSync, file: string, session: FixtureSession): string {
  const messagesPath = path.join(path.dirname(file), '..', 'sessions', session.id, `${session.id}.messages.json`);
  fs.mkdirSync(path.dirname(messagesPath), { recursive: true });
  const messages = [
    { id: `u-${session.id}`, role: 'user', content: [{ type: 'text', text: `<user_input mode="act">${session.prompt}</user_input>` }], ts: 1 },
    ...(session.replies ?? []).map((text, index) => ({ id: `a-${index}`, role: 'assistant', content: [{ type: 'text', text }], ts: 2 + index })),
  ];
  fs.writeFileSync(messagesPath, JSON.stringify({ version: 1, sessionId: session.id, messages }));
  db.prepare(
    `INSERT INTO sessions (session_id, source, pid, started_at, ended_at, status, interactive, provider, model, cwd, workspace_root, enable_tools, enable_spawn, enable_teams, is_subagent, prompt, hook_path, messages_path, updated_at)
     VALUES (?, 'cli', ?, ?, ?, ?, 1, 'openai-compatible', 'example-model', ?, ?, 1, 0, 0, ?, ?, '', ?, ?)`,
  ).run(
    session.id,
    session.pid ?? 4242,
    session.startedAt,
    session.endedAt ?? null,
    session.status ?? 'idle',
    session.cwd,
    session.cwd,
    session.subagent ? 1 : 0,
    `<user_input mode="act">${session.prompt}</user_input>`,
    messagesPath,
    session.updatedAt ?? session.startedAt,
  );
  return messagesPath;
}
