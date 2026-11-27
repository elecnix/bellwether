// Running the bellwether command on another machine over SSH. herdr's own
// machine support already logs in this way, so Bellwether uses the same
// transport and the operator's SSH configuration as it stands: BatchMode, so
// a prompt fails instead of waiting, and no key or known_hosts entry of its
// own. Nothing here writes under ~/.ssh.
import { execFile } from 'node:child_process';

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
 * child's machine. Keepalives make a dead link fail within a minute, rather
 * than when the kernel gives up on it.
 */
export function relayBridgeArgv(target: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T', target, remoteBellwetherCommand(['relay-bridge'])];
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshOptions {
  /** The ssh binary. Defaults to the one on PATH, which is what tests replace. */
  ssh?: string;
  timeoutMs?: number;
  /** Text for the remote command's standard input, so a brief never sits on a command line. */
  input?: string;
}

/**
 * Run `bellwether <args>` on `target` and resolve with its exit code and
 * output. It never rejects for a non-zero exit: the caller decides whether a
 * code means retry or give up. A missing ssh binary resolves with code 127.
 */
export function runRemoteBellwether(target: string, args: string[], options: SshOptions = {}): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = execFile(options.ssh ?? 'ssh', sshArgv(target, args), { timeout: options.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
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

/** One line that says why a remote command failed, for a log or a record. */
export function describeFailure(target: string, result: SshResult): string {
  const detail = result.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
  return `ssh ${target} exited with ${result.code}${detail ? `: ${detail}` : ''}`;
}
