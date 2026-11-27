// The version of the installed package, read from the package.json above this
// file. From the sources that is ../../package.json of src/core, and from the
// build it is the same path above dist/core, so one lookup serves both.
//
// A version number is not a build: every install of one release reports the
// same number, whichever commit it was made from. So each install also names
// its build. `npm run build` writes dist/build.json with the commit and the
// build time, and a run from the sources of a checkout asks git for the
// commit it stands on.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function readVersion(): string {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (manifest.name === '@elecnix/bellwether' && manifest.version) return manifest.version;
    }
    dir = path.dirname(dir);
  }
  return 'unknown';
}

export const BELLWETHER_VERSION = readVersion();

/** Which code an install runs, beyond its version number. */
export interface BuildInfo {
  /** The git commit the install was built from, in full. */
  commit?: string;
  /** Whether the tree had changes no commit holds when it was built. */
  dirty?: boolean;
  /** When `npm run build` made it, for a built install. */
  builtAt?: string;
  /** A built install carries build.json, and a checkout run from its sources asks git. */
  source: 'build' | 'checkout' | 'unknown';
}

/** The file `npm run build` writes beside the compiled code. */
export const BUILD_FILE = 'build.json';

/**
 * The build of the code in `root`, the directory that holds the core
 * directory: dist/ for a built install, src/ for the sources. A build.json
 * there wins. Without one, the git checkout around it names the commit.
 */
export function readBuild(root: string = path.dirname(import.meta.dirname), git: (args: string[], cwd: string) => string = runGit): BuildInfo {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, BUILD_FILE), 'utf8')) as Partial<BuildInfo>;
    return {
      source: 'build',
      ...(typeof parsed.commit === 'string' && parsed.commit ? { commit: parsed.commit } : {}),
      ...(parsed.dirty === true ? { dirty: true } : {}),
      ...(typeof parsed.builtAt === 'string' && parsed.builtAt ? { builtAt: parsed.builtAt } : {}),
    };
  } catch {
    // No build file: the sources of a checkout, or a build from before build files.
  }
  try {
    const commit = git(['rev-parse', 'HEAD'], root).trim();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return { source: 'unknown' };
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.'], root).trim() !== '';
    return { source: 'checkout', commit, ...(dirty ? { dirty: true } : {}) };
  } catch {
    return { source: 'unknown' };
  }
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
}

/**
 * The build in a dozen characters, for a protocol field and a log line: the
 * short commit, with `+changes` for a tree that differs from it, or `unknown`.
 */
export function buildId(build: Pick<BuildInfo, 'commit' | 'dirty'>): string {
  if (!build.commit) return 'unknown';
  return `${build.commit.slice(0, 12)}${build.dirty ? '+changes' : ''}`;
}

/** One line a person can read: the version, the commit, and how the install came about. */
export function describeBuild(version: string, build: BuildInfo): string {
  if (!build.commit) return `${version} (build unknown: no ${BUILD_FILE} and no git checkout)`;
  const changes = build.dirty ? ', with changes no commit holds' : '';
  if (build.source === 'build') return `${version} (commit ${buildId({ commit: build.commit })}${changes}, built ${build.builtAt ?? 'at an unknown time'})`;
  return `${version} (commit ${buildId({ commit: build.commit })}${changes}, run from a checkout)`;
}

export const BELLWETHER_BUILD = readBuild();

/** This install's build, for the handshakes. */
export const BELLWETHER_BUILD_ID = buildId(BELLWETHER_BUILD);
