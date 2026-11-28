// What a move leaves behind on the machine a child leaves (issue #224). A
// session crosses, and its processes and its worktrees do not: a background
// job the session started ends when the move closes its tab, and a worktree
// the session worked in stays where it is, with whatever it holds that exists
// nowhere else. A move refuses on either unless its caller accepts the loss.
//
// The source machine computes these facts itself, in the daemon for this
// machine and through `bellwether move-probe` for another, because only that
// machine sees its process table and its worktrees. A worktree is judged by
// the same checks retirement runs before it removes one (`workChecks`).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { locateTranscript } from './harnesses/index.ts';
import { realRetireOps, workChecks, type RetireOps } from './retire.ts';
import type { MovableHarness } from './move-plan.ts';
import type { ProcessInfo } from './start-check.ts';

/** One process, as the source machine's process table shows it. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
  /** Whether its environment carries the child's id, as every process its tab starts does. */
  carriesChild: boolean;
  /** When it started, in seconds on any clock the whole table shares. Undefined when the table cannot say. */
  startedAt?: number;
}

/** A background job: the topmost process of one, with its command line. */
export interface BackgroundJob {
  pid: number;
  command: string;
}

/** A worktree the session worked in whose work exists only there. */
export interface WorktreeAtRisk {
  worktree: string;
  branch?: string;
  /** Each check that failed, in retirement's words. */
  risks: string[];
}

export interface LeftBehindRequest {
  childId: string;
  harness: MovableHarness;
  /** The session as herdr reported it: an id for Claude Code, a file path for pi. */
  session: string;
  /** The child's working directory on the source. */
  cwd?: string;
  /** herdr's process info for the child's pane: the pane's shell and the harness in its foreground. */
  pane?: ProcessInfo;
  /** The working directories of the other live children on the source, whose worktrees are theirs. */
  others?: string[];
}

export interface LeftBehind {
  jobs: BackgroundJob[];
  /** Why the process table could not answer, when it could not. */
  jobsUnknown?: string;
  worktrees: WorktreeAtRisk[];
}

/**
 * How long after the harness starts a process it runs still counts as one of
 * its own servers. Claude Code starts its MCP servers, and pi its extensions'
 * helpers, as the session opens. A process the harness starts later came from
 * the session's work, such as pi-ghpr-monitor's `gh monitor`.
 */
export const HARNESS_STARTUP_S = 60;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'tcsh', 'csh']);

/** Whether a command line starts a shell, as a harness's shell tool does for each command. */
export function isShell(command: string): boolean {
  const program = command.trim().split(/\s+/)[0] ?? '';
  return SHELLS.has(path.basename(program).replace(/^-/, ''));
}

/** A command line short enough for a refusal. */
function shortCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

/**
 * The background jobs of a child's session, from the processes that carry its
 * id. The pane's shell and the harness belong to the child, and so does every
 * process under one of the harness's own servers: a child of the harness that
 * is not a shell and started with it, such as an MCP server or an extension's
 * helper. A shell the harness started is a command from its shell tool, and a
 * move happens only between turns, so such a shell still running is a
 * background job, as is any other process the harness started after its
 * startup, such as a watch an extension runs. A process that carries the id
 * outside the harness's tree, such as a job whose shell exited and left it to
 * init, is one too. Each job is reported once, by its topmost process, and
 * shown by the first command under its shells, because a harness's shell
 * line is mostly its own setup.
 */
export function backgroundJobs(table: ProcessEntry[], pane: ProcessInfo | undefined): BackgroundJob[] | { unknown: string } {
  const carriers = table.filter((entry) => entry.carriesChild);
  if (!carriers.length) return [];
  if (!pane) return { unknown: "herdr did not report the pane's shell and foreground process, so Bellwether cannot tell the harness from a job" };
  const byPid = new Map(carriers.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of carriers) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const owned = new Set<number>([pane.shellPid]);
  const harness = pane.foregroundGroup !== pane.shellPid ? byPid.get(pane.foregroundGroup) : undefined;
  if (harness) {
    owned.add(harness.pid);
    const walk = (pid: number): void => {
      owned.add(pid);
      for (const entry of children.get(pid) ?? []) walk(entry.pid);
    };
    const server = (entry: ProcessEntry): boolean => !isShell(entry.command) && (entry.startedAt === undefined || harness.startedAt === undefined || entry.startedAt - harness.startedAt <= HARNESS_STARTUP_S);
    for (const entry of children.get(harness.pid) ?? []) if (server(entry)) walk(entry.pid);
  }
  const loose = carriers.filter((entry) => !owned.has(entry.pid));
  const looseIds = new Set(loose.map((entry) => entry.pid));
  const shown = (entry: ProcessEntry): string => {
    let at = entry;
    while (isShell(at.command)) {
      const next = (children.get(at.pid) ?? [])[0];
      if (!next) return at.command;
      at = next;
    }
    return at.command;
  };
  return loose.filter((entry) => !looseIds.has(entry.ppid)).map((entry) => ({ pid: entry.pid, command: shortCommand(shown(entry)) }));
}

const ABSOLUTE_PATH = /(?:^|[\s"'=:(`])(\/[^\s"'`;|&<>()]+)/g;

/** Every absolute path in a value's strings, at any depth. */
function pathsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(ABSOLUTE_PATH)) if (match[1]) into.add(match[1].replace(/[.,]+$/, ''));
  } else if (Array.isArray(value)) {
    for (const item of value) pathsIn(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) pathsIn(item, into);
  }
}

/**
 * The directories a session worked in, from its transcript: each directory
 * Claude Code records as an entry's working directory, and each absolute path
 * in the input of a tool the model called, such as a `cd` in a shell command
 * or a file it edited, in Claude Code's `tool_use` or pi's `toolCall`. What a
 * tool printed back is left out: a listing of other worktrees is not work.
 */
export function sessionPaths(transcript: string): string[] {
  const found = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry['cwd'] === 'string' && entry['cwd'].startsWith('/')) found.add(entry['cwd']);
    const message = (entry['message'] ?? entry) as Record<string, unknown>;
    if (message['role'] !== 'assistant' || !Array.isArray(message['content'])) continue;
    for (const item of message['content'] as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      if (call['type'] === 'tool_use') pathsIn(call['input'], found);
      else if (call['type'] === 'toolCall') pathsIn(call['arguments'], found);
    }
  }
  return [...found];
}

/**
 * The linked worktree a path sits in: the nearest directory above it whose
 * `.git` is a file. A `.git` directory marks a main worktree or a plain
 * clone, which a move never counts as the child's own. A path that no longer
 * exists counts from the nearest directory above it that does.
 */
export function linkedWorktreeOf(target: string, cache = new Map<string, string | null>()): string | undefined {
  let dir = path.resolve(target);
  const seen: string[] = [];
  for (;;) {
    const known = cache.get(dir);
    if (known !== undefined) {
      for (const entry of seen) cache.set(entry, known);
      return known ?? undefined;
    }
    seen.push(dir);
    let marker: fs.Stats | undefined;
    try {
      marker = fs.statSync(path.join(dir, '.git'));
    } catch {
      marker = undefined;
    }
    if (marker) {
      const result = marker.isFile() ? realpath(dir) : null;
      for (const entry of seen) cache.set(entry, result);
      return result ?? undefined;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      for (const entry of seen) cache.set(entry, null);
      return undefined;
    }
    dir = up;
  }
}

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The worktrees a session worked in whose work exists only there, judged as retirement judges a worktree. */
export async function worktreesAtRisk(dirs: string[], others: string[], ops: Pick<RetireOps, 'inspect' | 'dirty' | 'stashes' | 'safety'>): Promise<WorktreeAtRisk[]> {
  const cache = new Map<string, string | null>();
  const theirs = new Set(others.map((dir) => linkedWorktreeOf(dir, cache)).filter((dir): dir is string => Boolean(dir)));
  const worktrees = new Set(dirs.map((dir) => linkedWorktreeOf(dir, cache)).filter((dir): dir is string => Boolean(dir) && !theirs.has(dir as string)));
  const found: WorktreeAtRisk[] = [];
  for (const dir of worktrees) {
    const facts = await ops.inspect(dir);
    if ('error' in facts || facts.main) continue;
    if (!facts.branch) {
      const dirty = await ops.dirty(facts.worktree);
      const risks = [`it has a detached HEAD at ${facts.head.slice(0, 12)}, so Bellwether cannot tell whether its commits exist anywhere else`];
      if (dirty.length) risks.unshift(`the worktree has ${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}`);
      found.push({ worktree: facts.worktree, risks });
      continue;
    }
    const { failing } = await workChecks(ops, { ...facts, branch: facts.branch });
    if (failing.length) found.push({ worktree: facts.worktree, branch: facts.branch, risks: failing });
  }
  return found;
}

function run(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout) });
    });
  });
}

/**
 * This machine's processes, each marked by whether its environment carries
 * the child's id. Linux answers from /proc, and macOS from `ps`, whose `-E`
 * adds each process's environment after its command line. Undefined when
 * neither can be read.
 */
export async function processTable(childId: string, proc = '/proc'): Promise<ProcessEntry[] | undefined> {
  const marker = `BELLWETHER_CHILD=${childId}`;
  if (fs.existsSync(path.join(proc, 'self', 'stat'))) {
    const table: ProcessEntry[] = [];
    for (const name of fs.readdirSync(proc)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(path.join(proc, name, 'stat'), 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(fields[1]);
        // Field 22 of stat, the start in clock ticks since boot, which Linux counts at 100 a second for every program.
        const startedAt = Number(fields[19]) / 100;
        const command = fs.readFileSync(path.join(proc, name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
        let carriesChild = false;
        try {
          carriesChild = fs.readFileSync(path.join(proc, name, 'environ'), 'utf8').split('\0').includes(marker);
        } catch {
          // Another user's process, which a child of this user does not start.
        }
        table.push({ pid: Number(name), ppid, command, carriesChild, ...(Number.isFinite(startedAt) ? { startedAt } : {}) });
      } catch {
        // A process that exited while the table was read.
      }
    }
    return table;
  }
  const plain = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,etime=,command=']);
  const withEnv = await run('ps', ['-A', '-ww', '-E', '-o', 'pid=,command=']);
  if (plain.code !== 0 || withEnv.code !== 0) return undefined;
  const carrying = new Set<number>();
  for (const line of withEnv.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && ` ${match[2]} `.includes(` ${marker} `)) carrying.add(Number(match[1]));
  }
  const now = Date.now() / 1000;
  return plain.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const elapsed = elapsedSeconds(match[3] ?? '');
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[4] ?? '', carriesChild: carrying.has(Number(match[1])), ...(elapsed === undefined ? {} : { startedAt: now - elapsed }) }];
  });
}

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function elapsedSeconds(value: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
}

/** What a move of this child would leave behind on this machine. */
export async function findLeftBehind(request: LeftBehindRequest, ops: RetireOps = realRetireOps()): Promise<LeftBehind> {
  const table = await processTable(request.childId);
  const jobs = table ? backgroundJobs(table, request.pane) : { unknown: 'this machine offers neither /proc nor ps' };
  const dirs = request.cwd ? [request.cwd] : [];
  const found = locateTranscript(request.harness, request.session, request.cwd);
  if (found.path) {
    try {
      dirs.push(...sessionPaths(fs.readFileSync(found.path, 'utf8')));
    } catch {
      // The transcript went away; the working directory still counts.
    }
  }
  const worktrees = await worktreesAtRisk(dirs, request.others ?? [], ops);
  return Array.isArray(jobs) ? { jobs, worktrees } : { jobs: [], jobsUnknown: jobs.unknown, worktrees };
}

/** One line per thing the move would leave behind on `source`, for a refusal or a reply. */
export function leftBehindLines(childName: string, source: string, left: LeftBehind | undefined, bellwetherVersion?: string): string[] {
  if (!left) {
    return [`Bellwether on ${source}${bellwetherVersion ? ` (${bellwetherVersion})` : ''} predates the check for work a move leaves behind, so it cannot say whether ${childName} runs background jobs or holds unpushed work there. Update Bellwether on ${source}, or pass accept_loss to move ${childName} anyway.`];
  }
  const lines: string[] = [];
  if (left.jobs.length) {
    const named = left.jobs.map((job) => `process ${job.pid} (\`${job.command}\`)`).join(', ');
    lines.push(`${childName} runs ${left.jobs.length === 1 ? 'a background job' : `${left.jobs.length} background jobs`} on ${source}: ${named}. A move closes the session there, which ends ${left.jobs.length === 1 ? 'that job' : 'those jobs'}, and the session on the other machine would wait for a result that never comes. Let a job finish, or stop it, before the move. A watch such as \`gh monitor\` never finishes on its own: stop it, and arm it again from the other machine after the move. Or pass accept_loss to move anyway.`);
  }
  if (left.jobsUnknown) lines.push(`Bellwether cannot tell whether ${childName} runs background jobs on ${source}: ${left.jobsUnknown}. Pass accept_loss to move it anyway.`);
  for (const entry of left.worktrees) {
    lines.push(`${childName} worked in the worktree ${entry.worktree}${entry.branch ? ` on branch ${entry.branch}` : ''} on ${source}, where ${entry.risks.join('; ')}. A move carries the session and not the worktree, so that work would stay on ${source}. Commit the changes, apply or drop the stash, and push the branch before the move, or pass accept_loss to move anyway.`);
  }
  return lines;
}
