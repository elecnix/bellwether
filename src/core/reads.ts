// The paths one child reads beside its working directory and the Bellwether
// home, which a parent names at spawn or restart (`reads`). A brief that tells
// a child to copy a rule from another checkout, or to follow a skill under the
// operator's dotfiles, needs that one directory. The parent knows it, so it says
// so at launch, and Claude Code never asks about a read there. The list widens
// what a child reads without a question; it limits nothing, because a machine
// where Claude Code no longer asks lets a child read outside it too (see
// src/core/claude-hooks.ts). Naming the whole home, or the root,
// would teach every child to read the world, so both are refused, by name.
import os from 'node:os';
import path from 'node:path';

/**
 * The paths a `reads` argument names, each absolute and normalized, or
 * undefined when the argument is absent. Throws on a value that is not a list
 * of absolute paths, and on the filesystem root, the operator's home or a
 * directory that holds it.
 */
export function checkReads(given: unknown, home = os.homedir()): string[] | undefined {
  if (given === undefined) return undefined;
  if (!Array.isArray(given) || given.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error('reads takes a list of absolute paths, such as ["/home/me/Source/dotfiles/lint"].');
  const reads: string[] = [];
  for (const entry of given as string[]) {
    if (!path.isAbsolute(entry)) throw new Error(`reads names ${entry}, which is not an absolute path. Write it in full; a ~ is not expanded.`);
    const resolved = path.resolve(entry);
    if (resolved === path.parse(resolved).root) throw new Error(`reads names ${entry}, the root of the filesystem. Name the directory the brief needs.`);
    const relative = path.relative(resolved, path.resolve(home));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error(`reads names ${entry}, which holds the operator's home. Name the directory under it that the brief needs.`);
    if (!reads.includes(resolved)) reads.push(resolved);
  }
  return reads;
}

/** The directory to suggest for a declined read: the file's own directory, or the path itself when it has no extension. */
export function readsSuggestion(declined: string): string {
  return path.extname(declined) ? path.dirname(declined) : declined;
}
