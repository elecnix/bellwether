// Finding a child's transcript. The watcher reads the last assistant message
// from it, which is where a finished child's answer already sits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code replaces every non-alphanumeric character of the cwd with a dash. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
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

/** Pi names a session file `<timestamp>_<session id>.jsonl`. */
const endsWith = (name: string) => (sessionId: string): boolean => name.endsWith(`${sessionId}.jsonl`);

/**
 * Locate the transcript for a harness session. Pi and Claude Code both keep
 * one JSONL file per session, named after the session id, under a per-project
 * directory.
 */
export function resolveTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  // Pi reports its session as a path, Claude Code as an id. Take a path as one.
  if (sessionId.includes('/') || sessionId.endsWith('.jsonl')) return fs.existsSync(sessionId) ? sessionId : undefined;
  const home = os.homedir();
  if (harness === 'claude-code') {
    const root = path.join(home, '.claude', 'projects');
    const direct = cwd ? path.join(root, claudeProjectDir(cwd), `${sessionId}.jsonl`) : undefined;
    if (direct && fs.existsSync(direct)) return direct;
    return newestFile(root, endsWith(sessionId));
  }
  if (harness === 'pi') {
    const root = process.env['PI_CODING_AGENT_DIR'] ?? path.join(home, '.pi', 'agent');
    return newestFile(path.join(root, 'sessions'), endsWith(sessionId));
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
