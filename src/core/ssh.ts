// Running the bellwether command on another machine over SSH. herdr's own
// machine support already logs in this way, so Bellwether uses the same
// transport and the operator's SSH configuration as it stands: BatchMode, so
// a prompt fails instead of waiting, and no key or known_hosts entry of its
// own. Nothing here writes under ~/.ssh.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, farCommand, type FarCommand } from './far-commands.ts';
import { remoteLogDir, slug } from './paths.ts';
import { BELLWETHER_BUILD_ID, BELLWETHER_VERSION } from './version.ts';

/** Quote one word for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exit code the remote side uses when no bellwether command is installed there. */
export const NO_BELLWETHER_EXIT = 78;

/**
 * The remote side: find a bellwether command, because a non-interactive SSH
 * shell often has a shorter PATH than a login shell. The arguments follow as
 * positional words, so none of them is parsed by the remote shell.
 */
const BELLWETHER_SCRIPT = [
  'for c in "$(command -v bellwether 2>/dev/null)" "$HOME/.local/bin/bellwether" "$HOME/.npm-global/bin/bellwether" /home/linuxbrew/.linuxbrew/bin/bellwether /opt/homebrew/bin/bellwether /usr/local/bin/bellwether $(ls -d "$HOME"/.nvm/versions/node/*/bin/bellwether 2>/dev/null | sort -r); do',
  '  [ -n "$c" ] && [ -x "$c" ] || continue',
  '  exec "$c" "$@"',
  'done',
  "echo 'no bellwether command on this machine; install @elecnix/bellwether there' >&2",
  `exit ${NO_BELLWETHER_EXIT}`,
].join('\n');

/** The command line SSH runs on the remote machine for `bellwether <args>`. */
export function remoteBellwetherCommand(args: string[]): string {
  return [`sh -c ${shellQuote(BELLWETHER_SCRIPT)} bellwether`, ...args.map(shellQuote)].join(' ');
}

/** The ssh argv for one remote bellwether command. */
export function sshArgv(target: string, args: string[]): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', target, remoteBellwetherCommand(args)];
}

/**
 * The ssh argv for the relay connection a parent's daemon holds open to a
 * child's machine. Keepalives make a dead link fail on the parent's side
 * within a minute, rather than when the kernel gives up on it. The heartbeat
 * does the same on the child's side: the parent writes a line at that
 * interval, and the bridge exits after three intervals without one. A bridge
 * from before the heartbeat ignores the flag.
 */
export function relayBridgeArgv(target: string, heartbeatMs: number): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T', target, remoteBellwetherCommand(['relay-bridge', '--heartbeat-ms', String(heartbeatMs)])];
}

/** How many heartbeat intervals a bridge waits without a line from the parent before it exits. */
export const HEARTBEAT_MISSES = 3;

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The bellwether arguments that ran, so a failure can say which command or argument the far end lacked. */
  command?: string[];
  /** The file that holds the whole output of a failed command, when it could be written. */
  log?: string;
}

export interface SshOptions {
  /** The ssh binary. Defaults to the one on PATH, which is what tests replace. */
  ssh?: string;
  timeoutMs?: number;
  /** Text for the remote command's standard input, so a brief never sits on a command line. */
  input?: string;
  /** The most output to accept, in bytes. A session bundle needs far more than a report. Default 8 MiB. */
  maxBuffer?: number;
}

/**
 * Run `bellwether <args>` on `target` and resolve with its exit code and
 * output. It never rejects for a non-zero exit: the caller decides whether a
 * code means retry or give up. A missing ssh binary resolves with code 127.
 */
export function runRemoteBellwether(target: string, args: string[], options: SshOptions = {}): Promise<SshResult> {
  return new Promise<SshResult>((settle) => {
    const resolve = (result: SshResult): void => settle(result.code === 0 ? { ...result, command: args } : keepLog(target, { ...result, command: args }));
    const child = execFile(options.ssh ?? 'ssh', sshArgv(target, args), { timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const fault = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (fault.code === 'ENOENT') return resolve({ code: 127, stdout, stderr: `ssh is not installed: ${fault.message}` });
      if (fault.killed) return resolve({ code: 124, stdout, stderr: `${stderr}\nssh to ${target} timed out after ${options.timeoutMs ?? 30_000} ms`.trim() });
      resolve({ code: typeof fault.code === 'number' ? fault.code : 1, stdout, stderr: stderr || fault.message });
    });
    // A closed pipe only means ssh exited first; its exit code says why.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/** How many failure logs to keep: the newest, so the directory never grows without bound. */
const KEPT_LOGS = 20;

/**
 * Write the whole output of a failed remote command to a file of its own,
 * mode 0600, and keep only the newest few. A failure to write leaves the
 * result without a log, because the error itself matters more than the copy.
 */
function keepLog(target: string, result: SshResult): SshResult {
  if (!result.stderr.trim() && !result.stdout.trim()) return result;
  try {
    const dir = remoteLogDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(target)}-${process.pid}.log`);
    const heading = `ssh ${target} bellwether ${(result.command ?? []).join(' ')}\nexit ${result.code}\n`;
    fs.writeFileSync(file, `${heading}\n--- stderr\n${result.stderr}\n--- stdout\n${result.stdout}\n`, { mode: 0o600 });
    for (const old of fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort().slice(0, -KEPT_LOGS)) fs.rmSync(path.join(dir, old), { force: true });
    return { ...result, log: file };
  } catch {
    return result;
  }
}

/**
 * A line a crash prints that says nothing of its cause: a stack frame, the
 * Node.js version banner, the caret under the source excerpt, the file and
 * line the excerpt came from, or SSH's note about a new host key.
 */
function isNoise(line: string): boolean {
  return /^\s+at\s/.test(line)
    || /^\s*Node\.js v\d/.test(line)
    || /^\s*\^+\s*$/.test(line)
    || /^(?:file:\/\/|node:|\/)\S*:\d+\s*$/.test(line)
    || /^Warning: Permanently added /.test(line)
    || /^\s*[{}]\s*$/.test(line)
    || /^\s+(?:errno|code|syscall|path|generatedMessage|operator):\s/.test(line);
}

/** A line Node prints for a thrown error: `Error: …`, `TypeError: …`, `Error [ERR_X]: …`, `Uncaught …`. */
const ERROR_LINE = /^(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error(?:\s\[[A-Z0-9_]+\])?:\s/;
/** The one line a bellwether command prints for its own failure, `bellwether <command>: …`. */
const BELLWETHER_LINE = /^bellwether [a-z-]+: /;

/**
 * The line the far machine meant as its error. In order: the one line a
 * bellwether command prints for its own failure, then the line a Node crash
 * prints for the error it threw, then the first line that is not a stack
 * frame, a Node.js banner, a source excerpt's caret or location, or SSH's
 * host-key note. Undefined when the output holds nothing but those.
 */
export function farErrorLine(output: string): string | undefined {
  return farError(output.split('\n')).cause;
}

function farError(lines: string[]): { cause?: string; index: number } {
  const own = lines.findLastIndex((line) => BELLWETHER_LINE.test(line));
  if (own >= 0) return { cause: lines[own]!.trim(), index: own };
  const thrown = lines.findIndex((line) => ERROR_LINE.test(line));
  if (thrown >= 0) return { cause: lines[thrown]!.trim(), index: thrown };
  // The first plain line, but past a crash's source excerpt: with a location line there, its excerpt comes before the caret.
  const caret = lines.findIndex((line) => /^\s*\^+\s*$/.test(line));
  const plain = lines.findIndex((line, index) => index > caret && line.trim() && !isNoise(line));
  return plain >= 0 ? { cause: lines[plain]!.trim(), index: plain } : { index: -1 };
}

/** How many lines of context follow the cause in a failure's message. */
const CONTEXT_LINES = 2;

/**
 * Why a remote command failed, for a log, a record or a tool's error. It
 * leads with the far end's own error line and a little context after it,
 * says where the rest of the output is, and advises an upgrade only when the
 * far end's failure shows a release difference.
 */
export function describeFailure(target: string, result: SshResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n');
  const { cause, index } = farError(lines);
  const context = cause ? lines.slice(index + 1).filter((line) => line.trim() && !isNoise(line)) : [];
  const shown = [cause, ...context.slice(0, CONTEXT_LINES)].filter(Boolean).map((line) => line!.trim());
  // The source line Node quotes above its caret is code, not output a person needs counted.
  const excerpt = (index: number): boolean => /^\s*\^+\s*$/.test(lines[index + 1] ?? '');
  const left = lines.filter((line, index) => line.trim() && !isNoise(line) && !excerpt(index)).length - shown.length;
  const rest = left > 0 ? ` (${left} more line${left === 1 ? '' : 's'} ${result.log ? `in ${result.log}` : 'left out'})` : '';
  const advice = releaseAdvice(target, result);
  const head = `ssh ${target} exited with ${result.code}${shown.length ? `: ${shown.join(' / ')}` : ''}${rest}`;
  if (!advice) return head;
  return `${head}${/[.!?]$/.test(head) ? '' : '.'} ${advice}`;
}

/** What this install runs, for an error that asks for the same release elsewhere. */
function thisInstall(): string {
  return `this machine runs Bellwether ${BELLWETHER_VERSION} build ${BELLWETHER_BUILD_ID}`;
}

/** Advice for a far end that is older than what this machine asked of it. */
function olderThan(target: string, what: string, entry: FarCommand): string {
  const ahead = compareVersions(BELLWETHER_VERSION, entry.version) < 0;
  const install = ahead
    ? `This machine runs a build of ${BELLWETHER_VERSION} from before the ${entry.version} release (build ${BELLWETHER_BUILD_ID}), so install that same build on ${target}.`
    : `Install ${entry.version} or later there; ${thisInstall()}.`;
  return `${what} came with Bellwether ${entry.version}, and the bellwether that ssh runs on ${target} is older. ${install} If ${target} already has it, ssh's non-interactive PATH finds an older copy first.`;
}

/**
 * The upgrade advice a failure earns, or undefined when nothing in it points
 * at a release difference: a protocol mismatch, an argument or a command the
 * far end refused that a known release brought, or no bellwether at all.
 */
export function releaseAdvice(target: string, result: SshResult): string | undefined {
  const output = `${result.stderr}\n${result.stdout}`;
  const [command, ...args] = result.command ?? [];
  if (result.code === NO_BELLWETHER_EXIT) return /install @elecnix\/bellwether/.test(output) ? undefined : `Install @elecnix/bellwether on ${target}.`;
  if (/protocol_mismatch|serves protocols? \d/.test(output)) return `The two machines run releases that speak different daemon protocols. Update @elecnix/bellwether on ${target}; ${thisInstall()}.`;
  if (!command) return undefined;
  const unknown = /unknown argument (--[\w-]+)/.exec(output)?.[1];
  if (unknown) {
    const entry = args.includes(unknown) ? farCommand(command, unknown) : undefined;
    return entry ? olderThan(target, `${command} ${unknown}`, entry) : undefined;
  }
  // A release without the command prints its usage, or, like 0.1.4, takes the word for a session command and fails the session's hello.
  if (/^Usage: bellwether /m.test(output) || /invalid_hello: the parent needs/.test(output) || new RegExp(`unknown command:? ${command}\\b`).test(output)) {
    const entry = farCommand(command);
    return entry ? olderThan(target, command, entry) : undefined;
  }
  return undefined;
}
