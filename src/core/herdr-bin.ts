// Which herdr binary Bellwether runs. The daemon's environment is whatever
// started it: a login shell, a herdr tab, or a non-interactive SSH session
// whose PATH lacks the directory herdr lives in (issue #186). So the lookup
// does not trust that environment alone. It tries, in order:
//
//   1. HERDR_BIN_PATH, when set. A value that is not an executable file is an
//      error, never a reason to look elsewhere, because the operator chose it.
//   2. The PATH this process inherited, because whoever started it chose that
//      PATH, and reading it starts no shell.
//   3. The PATH of the user's login shell, `$SHELL -l -c`, which reads the
//      profile files a non-interactive SSH session skips.
//   4. The usual install directories, the same list the move probe tries
//      (`installCandidates` in binaries.ts).
//
// When none holds herdr, the result is an error that names each place it
// looked, and `bellwether doctor` prints it for the daemon (`daemonHerdrLine`).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executables, installCandidates, pathCandidates } from './binaries.ts';

/** Where the lookup found herdr. */
export type HerdrSource = 'HERDR_BIN_PATH' | 'PATH' | 'login shell' | 'install directory';

export type HerdrLocation = { path: string; via: HerdrSource } | { error: string };

/** How long the login shell may take to print its PATH. */
const LOGIN_SHELL_MS = 5_000;
const MARKER = '__bellwether_path__';

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The PATH the login shell sets up, or why there is none. A profile may print text, so the PATH is read from a marked line. */
function loginShellPath(shell: string, env: NodeJS.ProcessEnv): Promise<{ path: string } | { error: string }> {
  return new Promise((resolve) => {
    execFile(shell, ['-l', '-c', `printf '\\n${MARKER}%s\\n' "$PATH"`], { env, timeout: LOGIN_SHELL_MS, encoding: 'utf8' }, (error, stdout) => {
      const line = String(stdout).split('\n').find((entry) => entry.startsWith(MARKER));
      if (line !== undefined) return resolve({ path: line.slice(MARKER.length) });
      resolve({ error: error ? error.message : 'it printed no PATH' });
    });
  });
}

const found = new Map<string, HerdrLocation & { path: string }>();

/** Find herdr as the file header describes. A result is kept for the same environment while its file stays executable. */
export async function locateHerdr(env: NodeJS.ProcessEnv = process.env): Promise<HerdrLocation> {
  const explicit = env['HERDR_BIN_PATH'];
  if (explicit) {
    return isExecutableFile(explicit) ? { path: explicit, via: 'HERDR_BIN_PATH' } : { error: `HERDR_BIN_PATH is ${explicit}, which is not an executable file` };
  }
  const shell = env['SHELL'] || os.userInfo().shell || '';
  const key = JSON.stringify([env['PATH'], shell, env['HOME'], env['BELLWETHER_HARNESS_DIRS']]);
  const kept = found.get(key);
  if (kept && isExecutableFile(kept.path)) return kept;

  const remember = (location: HerdrLocation & { path: string }): HerdrLocation => {
    found.set(key, location);
    return location;
  };
  const inherited = executables(pathCandidates('herdr', env['PATH']))[0];
  if (inherited) return remember({ path: inherited, via: 'PATH' });

  const misses = ['HERDR_BIN_PATH is unset', `the PATH this process inherited (${env['PATH'] || 'empty'}) has none`];
  if (shell) {
    const login = await loginShellPath(shell, env);
    if ('path' in login) {
      const fromLogin = executables(pathCandidates('herdr', login.path))[0];
      if (fromLogin) return remember({ path: fromLogin, via: 'login shell' });
      misses.push(`the login shell ${shell} has none on its PATH (${login.path || 'empty'})`);
    } else {
      misses.push(`the login shell ${shell} did not print its PATH (${login.error})`);
    }
  } else {
    misses.push('no login shell is known, because SHELL is unset');
  }
  const installs = installCandidates('herdr', env);
  const installed = executables(installs)[0];
  if (installed) return remember({ path: installed, via: 'install directory' });
  misses.push(installs.length ? `none of ${installs.map((file) => path.dirname(file)).join(', ')} holds it` : 'no install directory is searched, because BELLWETHER_HARNESS_DIRS is empty');
  return { error: `no herdr found: ${misses.join('; ')}. Set HERDR_BIN_PATH to the herdr binary, or start the daemon from a login shell` };
}

/** The herdr binary to run, or an error that says where the lookup looked. */
export async function herdrBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const location = await locateHerdr(env);
  if ('error' in location) throw new Error(location.error);
  return location.path;
}
