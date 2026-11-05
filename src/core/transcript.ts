// Finding a child's transcript. The watcher reads the last assistant message
// from it, which is where a finished child's answer already sits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code replaces every non-alphanumeric character of the cwd with a dash. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function newestFile(dir: string, name: string, depth = 3): string | undefined {
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
      else if (entry.isFile() && entry.name === name) {
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

/**
 * Locate the transcript for a harness session. Pi and Claude Code both keep
 * one JSONL file per session, named after the session id, under a per-project
 * directory.
 */
export function resolveTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const home = os.homedir();
  if (harness === 'claude-code') {
    const root = path.join(home, '.claude', 'projects');
    const direct = cwd ? path.join(root, claudeProjectDir(cwd), `${sessionId}.jsonl`) : undefined;
    if (direct && fs.existsSync(direct)) return direct;
    return newestFile(root, `${sessionId}.jsonl`);
  }
  if (harness === 'pi') {
    const root = process.env['PI_CODING_AGENT_DIR'] ?? path.join(home, '.pi', 'agent');
    return newestFile(path.join(root, 'sessions'), `${sessionId}.jsonl`);
  }
  return undefined;
}
