// A Codex rollout as Codex 0.160.0 writes it: the session_meta line, then
// response_item lines for the user's prompt and each assistant answer. The
// field names were read from a rollout a real Codex 0.160.0 wrote in a
// scratch CODEX_HOME. Only the fields Bellwether reads are kept.
import fs from 'node:fs';
import path from 'node:path';

export interface RolloutInput {
  /** The Codex home, which holds `sessions/`. */
  home: string;
  id: string;
  cwd: string;
  /** When the session started. */
  at?: Date;
  prompt?: string;
  replies?: string[];
  /** A subagent's session names its parent thread in an object. */
  source?: unknown;
}

function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}

/** Write a rollout where Codex would, and return its path. */
export function writeRollout(input: RolloutInput): string {
  const at = input.at ?? new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const dir = path.join(input.home, 'sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp(at)}-${input.id}.jsonl`);
  const time = at.toISOString();
  const lines: unknown[] = [
    { timestamp: time, ordinal: 0, type: 'session_meta', payload: { session_id: input.id, id: input.id, timestamp: time, cwd: input.cwd, originator: 'codex-tui', cli_version: '0.160.0', source: input.source ?? 'cli' } },
    { timestamp: time, ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${input.cwd}</cwd>\n</environment_context>` }] } },
  ];
  if (input.prompt !== undefined) lines.push({ timestamp: time, ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }] } });
  for (const reply of input.replies ?? []) lines.push({ timestamp: time, ordinal: lines.length, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}
