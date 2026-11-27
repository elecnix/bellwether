// An OpenCode v2 store for the session lookup and agent_read. The tables are
// the ones OpenCode 2.4.2 created in an empty database (`opencode session
// list --standalone` with OPENCODE_DB set), copied column for column, so the
// queries run against the shape the real harness writes. The rows follow what
// the same binary wrote for `opencode run --session ses_… "<prompt>"`: a user
// message with the prompt in `data.text`, an assistant message whose text
// lives in `session_part`, and the busy and idle times on the session.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE project (
  id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text, icon_url_override text, icon_color text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer, time_active integer DEFAULT 0 NOT NULL,
  time_archived integer, sandboxes text NOT NULL, commands text
);
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text, fork_boundary text,
  slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL, share_url text,
  summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text,
  cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
  time_busy integer, time_idle integer, time_viewed integer, idle_outcome text, time_compacting integer, time_archived integer,
  time_suspended integer, resume_attempts integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
);
CREATE TABLE session_part (
  message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, call_id text,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  PRIMARY KEY (message_id, ordinal),
  FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
);
`;

/** The tables OpenCode 1.x keeps, with no `session_v2`: a store only 1.x has written. */
const V1_SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

export interface FixtureSession {
  id: string;
  directory: string;
  prompt?: string;
  parentId?: string;
  version?: string;
  /** Text parts of one assistant message, in order. */
  reply?: string[];
  /** An assistant message that ended in this error, with no text. */
  error?: string;
  createdAt?: number;
  busyAt?: number;
  idleAt?: number;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
}

export function openCodeStore(file: string, version: 'v2' | 'v1' = 'v2'): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(version === 'v2' ? SCHEMA : V1_SCHEMA);
  if (version === 'v2') db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj_fixture', '/', 0, 0, '[]')").run();
  return db;
}

let messages = 0;

/** Write a session the way OpenCode 2.4.2 does, and return the database for more. */
export function addSession(db: DatabaseSync, session: FixtureSession): void {
  const created = session.createdAt ?? Date.now();
  db.prepare(
    'INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, version, time_created, time_updated, time_busy, time_idle, idle_outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(session.id, 'prj_fixture', session.parentId ?? null, 'fixture', session.directory, session.version ?? '2.4.2', created, session.idleAt ?? session.busyAt ?? created, session.busyAt ?? null, session.idleAt ?? null, session.outcome ?? null);
  let seq = 0;
  const message = (type: string, data: unknown): string => {
    messages += 1;
    const id = `msg_fixture${String(messages).padStart(6, '0')}`;
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, session.id, type, (seq += 1), created + seq, created + seq, JSON.stringify(data));
    return id;
  };
  if (session.prompt !== undefined) message('user', { time: { created }, text: session.prompt, files: [] });
  if (session.reply || session.error) {
    const assistant = message('assistant', { time: { created }, agent: 'build', model: { id: 'example-model', providerID: 'example' }, content: [], ...(session.error ? { finish: 'error', error: { type: 'provider.example', message: session.error } } : { finish: 'stop' }) });
    (session.reply ?? []).forEach((text, ordinal) => {
      db.prepare('INSERT INTO session_part (message_id, session_id, ordinal, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(assistant, session.id, ordinal, 'text', created, created, JSON.stringify({ type: 'text', text }));
    });
  }
  if (session.outcome) message('idle', { time: { created }, outcome: session.outcome });
}

/** Mark a session busy or idle again, as OpenCode does at the start and end of a turn. */
export function touchSession(db: DatabaseSync, id: string, at: number): void {
  db.prepare('UPDATE session_v2 SET time_updated = ?, time_busy = ? WHERE id = ?').run(at, at, id);
}
