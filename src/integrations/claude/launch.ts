// What the Claude Code server learns about the Claude Code process that
// started it, which the MCP handshake does not say (issue #184).
//
// The session. Claude Code starts its MCP servers before an interactive
// `--resume` picks a session, and a `/resume` inside a running session keeps
// the servers it has, so CLAUDE_CODE_SESSION_ID can name a session the person
// has left. Claude Code keeps the session it shows now in
// `sessions/<pid>.json` under its config directory, and rewrites that file
// when the session changes.
//
// The channel. Claude Code puts a server's notification in its session only
// for a server it loaded as a channel, which it does when a channel flag on
// its command line names the server. The initialize request is the same
// either way, so the command line is the one place that tells.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The session a Claude Code process shows now, from its sessions file, or `fallback` while that file is missing or unreadable. */
export function currentClaudeSession(configDir: string, pid: number, fallback: string): string {
  try {
    const value = (JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')) as { sessionId?: unknown }).sessionId;
    return typeof value === 'string' && value ? value : fallback;
  } catch {
    return fallback;
  }
}

const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels'];

/** Whether a channel entry names this server: as Bellwether's plugin, or as a server named bellwether, which is how a spawn's MCP config names it. */
function namesBellwether(entry: string): boolean {
  return entry === 'server:bellwether' || entry.startsWith('plugin:bellwether@');
}

/**
 * Whether a Claude Code command line loads the Bellwether server as a
 * channel. A flag takes its entries after `=` or as the arguments that follow
 * it up to the next flag, and each may be a comma-separated list. Nothing
 * after `--` is a flag.
 */
export function loadsBellwetherChannel(argv: string[]): boolean {
  let inFlag = false;
  for (const arg of argv) {
    if (arg === '--') return false;
    if (arg.startsWith('-')) {
      const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
      inFlag = CHANNEL_FLAGS.includes(flag) && value === undefined;
      if (CHANNEL_FLAGS.includes(flag) && value?.split(',').some(namesBellwether)) return true;
      continue;
    }
    if (inFlag && arg.split(',').some(namesBellwether)) return true;
  }
  return false;
}

/**
 * The command line of a process, as its arguments: from /proc on Linux, and
 * from ps elsewhere, which joins them with spaces. Empty when neither answers.
 */
export function processArgv(pid: number): string[] {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    // Not Linux, or the process is gone.
  }
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}
