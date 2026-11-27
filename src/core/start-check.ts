// Whether a harness that was just started is running. A start that reports
// success for a harness that already exited leaves the parent to learn of the
// failure from a later event (issue #130). So the start watches two things.
//
// Until herdr detects the harness, the pane's foreground process says whether
// it runs: the harness holds the foreground while it runs, and the shell has
// it back once the harness exits. A harness that held it and gave it back
// ended at startup, and the start fails with the lines it printed.
//
// A harness can also stay up and refuse to work, as pi does when it has no
// key for the provider it was given: it prints the error and sits at its
// prompt. For a harness whose entry names such a fatal line, the start waits
// for its first status after detection. `working` means it took its prompt.
// `idle` or `done` with the fatal line on screen fails the start, quoting the
// line. A child that shows no status within the wait is slow rather than
// dead: the start succeeds, and the spawn says it could not confirm it.

/** A harness that exited, or stopped on a fatal error, before it took its prompt. */
export class HarnessStartFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessStartFailed';
  }
}

/** How a start ended, when it did not fail. */
export type StartOutcome = { confirmed: true } | { confirmed: false; waitedMs: number };

/** The fields of herdr's pane.process_info that tell the shell from a program it runs. */
export interface ProcessInfo {
  shellPid: number;
  foregroundGroup: number;
}

export function processInfoOf(reply: unknown): ProcessInfo | undefined {
  const info = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>)['process_info'] : undefined;
  if (typeof info !== 'object' || info === null) return undefined;
  const shellPid = (info as Record<string, unknown>)['shell_pid'];
  const foregroundGroup = (info as Record<string, unknown>)['foreground_process_group_id'];
  return typeof shellPid === 'number' && typeof foregroundGroup === 'number' ? { shellPid, foregroundGroup } : undefined;
}

/**
 * Tracks the pane's foreground across checks. It reports an exit only after
 * it has seen the harness hold the foreground, because the shell also holds
 * it before it has run the typed line.
 */
export class ForegroundTracker {
  private ran = false;

  /** Record one check. True when the harness ran and the shell has the foreground again. */
  exited(info: ProcessInfo | undefined): boolean {
    if (!info) return false;
    if (info.foregroundGroup !== info.shellPid) {
      this.ran = true;
      return false;
    }
    return this.ran;
  }

  get sawHarness(): boolean {
    return this.ran;
  }
}

/**
 * The lines a harness printed after its launch line, for an error message:
 * the first fatal line when the entry names one and the screen shows it,
 * otherwise up to four lines that follow the launch line, without the shell
 * prompt that comes back after an exit.
 */
export function startupQuote(screen: string, kind: string, fatal?: RegExp): string | undefined {
  const lines = screen.split('\n').map((line) => line.trimEnd());
  if (fatal) {
    const line = lines.find((candidate) => fatal.test(candidate));
    if (line) return line.trim();
  }
  let start = -1;
  lines.forEach((line, index) => {
    if (line.includes(`command ${kind}`) || line.includes(`${kind} `)) start = index;
  });
  const after = (start >= 0 ? lines.slice(start + 1) : lines).filter((line) => line.trim() !== '');
  // The last line after an exit is the shell's prompt, which the harness did not print.
  if (after.length > 1) after.pop();
  const picked = after.slice(0, 4).map((line) => line.trim());
  return picked.length ? picked.join(' / ') : undefined;
}

/** The fatal line on a screen, or undefined. */
export function fatalLine(screen: string, fatal: RegExp): string | undefined {
  return screen
    .split('\n')
    .find((line) => fatal.test(line))
    ?.trim();
}
