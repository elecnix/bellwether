// A Kilo CLI 7 store for the session lookup and agent_read. The four tables
// are the ones @kilocode/cli 7.8.40 created in an empty database (KILO_DB set,
// a scratch home), copied column for column. The rows follow what the same
// binary wrote for `kilo --prompt "<prompt>"`: a user message whose prompt
// sits in a text part, an assistant message whose text sits in its parts, and
// `time.completed` on the assistant message once its turn ended.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE project ( id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text, icon_url_override text, icon_color text, time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer, sandboxes text NOT NULL, commands text );
CREATE TABLE session ( id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer, CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE );
CREATE TABLE message ( id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL, CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE );
CREATE TABLE part ( id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL, CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE );
`;

export interface KiloFixtureSession {
  id: string;
  directory: string;
  prompt?: string;
  parentId?: string;
  version?: string;
  createdAt?: number;
  /** Text parts of one assistant message, in order. */
  reply?: string[];
  /** An assistant message that ended in this error, with no text. */
  error?: string;
  /** The assistant message is still being written: it has no completion time. */
  busy?: boolean;
}

export function kiloStore(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('global', '/', 'git', 0, 0, '[]')").run();
  return db;
}

let counter = 0;
const next = (prefix: string): string => {
  counter += 1;
  return `${prefix}_fixture${String(counter).padStart(6, '0')}`;
};

/** Write a session the way Kilo CLI 7.8.40 does. */
export function addKiloSession(db: DatabaseSync, session: KiloFixtureSession): void {
  const created = session.createdAt ?? Date.now();
  db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, time_created, time_updated) VALUES (?, 'global', ?, 'fixture', ?, '', 'fixture', ?, ?, ?)").run(
    session.id,
    session.parentId ?? null,
    session.directory,
    session.version ?? '7.8.40',
    created,
    created + 1,
  );
  const message = (data: unknown, at: number): string => {
    const id = next('msg');
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, session.id, at, at, JSON.stringify(data));
    return id;
  };
  const part = (messageId: string, data: unknown, at: number): void => {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(next('prt'), messageId, session.id, at, at, JSON.stringify(data));
  };
  if (session.prompt !== undefined) {
    const user = message({ role: 'user', time: { created: created + 2 }, agent: 'code', model: { providerID: 'example', modelID: 'example-model' } }, created + 2);
    part(user, { type: 'text', text: session.prompt }, created + 2);
  }
  if (session.reply || session.error || session.busy) {
    const done = session.busy ? {} : { completed: created + 20 };
    const assistant = message({ role: 'assistant', time: { created: created + 3, ...done }, ...(session.error ? { error: { name: 'APIError', data: { message: session.error } } } : {}), finish: 'stop' }, created + 3);
    part(assistant, { type: 'step-start' }, created + 4);
    (session.reply ?? []).forEach((text, index) => part(assistant, { type: 'text', text }, created + 5 + index));
  }
}
