// Where a program Bellwether runs may sit. A non-interactive SSH shell often
// has a shorter PATH than the login shell herdr starts a tab with, so the
// usual install places are tried after PATH. The move probe looks for a
// harness this way, and the herdr lookup (herdr-bin.ts) uses the same list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The file `name` in each directory of a PATH value, in order. */
export function pathCandidates(name: string, pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
}

/**
 * The file `name` in each usual install directory. BELLWETHER_HARNESS_DIRS,
 * when set, replaces those directories with its own list, and an empty value
 * names none, which is how a test makes a program absent on a machine that
 * has it.
 */
export function installCandidates(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env['BELLWETHER_HARNESS_DIRS'];
  if (override !== undefined) return pathCandidates(name, override);
  const home = env['HOME'] || os.homedir();
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let nvmBins: string[] = [];
  try {
    nvmBins = fs.readdirSync(nvm).sort().reverse().map((version) => path.join(nvm, version, 'bin', name));
  } catch {
    // No nvm here.
  }
  return [path.join(home, '.local', 'bin', name), path.join(home, 'bin', name), path.join(home, '.npm-global', 'bin', name), '/home/linuxbrew/.linuxbrew/bin/' + name, '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, ...nvmBins];
}

/** Each candidate that is an executable file, in order, once. */
export function executables(candidates: string[]): string[] {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate);
    } catch {
      // Not here.
    }
  }
  return found;
}
