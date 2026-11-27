// Whether the person trusted a repository in Claude Code before. A spawn only
// answers Claude Code's folder-trust question for a folder the person already
// vouched for: a new worktree of a repository they trusted, or a folder under
// one they trusted. Anything else waits for the person.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code keeps its per-project trust in .claude.json. */
export function claudeStateFile(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function trustedProjects(stateFile: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    return Object.entries(parsed.projects ?? {})
      .filter(([, project]) => project?.hasTrustDialogAccepted === true)
      .map(([dir]) => canonical(dir));
  } catch {
    return [];
  }
}

function canonical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Whether `dir` is `root` or sits under it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** Every checkout of the repository that holds `dir`, or none outside git. */
function repositoryCheckouts(dir: string): string[] {
  try {
    const listing = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return listing
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonical(line.slice('worktree '.length)));
  } catch {
    return [];
  }
}

export function claudeTrustsRepository(cwd: string, stateFile = claudeStateFile()): boolean {
  const trusted = trustedProjects(stateFile);
  if (!trusted.length) return false;
  const dir = canonical(cwd);
  const checkouts = repositoryCheckouts(dir);
  // In git, Claude Code reads trust only inside the repository, so a trusted
  // home folder does not count. Any checkout of the same repository does.
  if (checkouts.length) return trusted.some((project) => checkouts.some((checkout) => within(project, checkout)));
  return trusted.some((project) => within(dir, project));
}
