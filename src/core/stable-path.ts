// The path a tool file should name for a file of this install (issue #266).
// Under Homebrew, a file sits in a versioned Cellar directory that `brew
// upgrade` deletes, and the formula's `opt/` link names the same file by a
// path that stays.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The same file by a path that survives `brew upgrade`: a file in a Homebrew
 * Cellar, `<prefix>/Cellar/<formula>/<version>/<rest>`, becomes
 * `<prefix>/opt/<formula>/<rest>` when that link leads to this very file.
 * Any other path, or a Cellar path whose link leads to another version, stays.
 */
export function stablePath(file: string): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(file);
  if (!match) return file;
  const [, prefix, formula, rest] = match as unknown as [string, string, string, string];
  const opt = path.join(prefix, 'opt', formula, rest);
  try {
    return fs.realpathSync(opt) === fs.realpathSync(file) ? opt : file;
  } catch {
    return file;
  }
}

/** The Node a tool file starts, by the path that outlives an upgrade. */
export function nodeCommand(): string {
  return stablePath(process.execPath);
}

