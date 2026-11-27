// The bellwether commands a parent's daemon runs on another machine over SSH,
// and their arguments, each with the first release that took it. A far end
// that refuses one of these is older than that release, so the error can name
// the release instead of saying "upgrade" to a machine that may already run
// the latest published one.
//
// Each entry was found with `git log -S` on the command's parser in
// src/cli.ts and checked against the release commits with
// `git merge-base --is-ancestor`, as src/daemon/features.ts does for the
// daemon's operations.

export interface FarCommand {
  /** The command word, as `bellwether <command>` takes it. */
  command: string;
  /** An argument of the command, with its dashes, when the entry is for the argument alone. */
  argument?: string;
  /** The first release that took it. */
  version: string;
}

export const FAR_COMMANDS: readonly FarCommand[] = [
  // 0.1.4 carried the relay's first form: the child's machine records the child.
  { command: 'relay-register', version: '0.1.4' },
  // After 0.1.4: the brief travels on standard input, and the parent's daemon dials out.
  { command: 'relay-register', argument: '--brief-stdin', version: '0.1.5' },
  { command: 'relay-cleanup', version: '0.1.5' },
  { command: 'relay-bridge', version: '0.1.5' },
  ...['move-probe', 'move-export', 'move-import', 'move-discard', 'move-commit'].map((command) => ({ command, version: '0.1.5' })),
];

/** The entry for a command, or for one of its arguments. */
export function farCommand(command: string, argument?: string): FarCommand | undefined {
  return FAR_COMMANDS.find((entry) => entry.command === command && entry.argument === argument);
}

/** Compare two dotted versions numerically: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (Number.isFinite(left[index]) ? left[index]! : 0) - (Number.isFinite(right[index]) ? right[index]! : 0);
    if (difference) return difference;
  }
  return 0;
}
