// The herdr lookup (issue #186): HERDR_BIN_PATH, then the inherited PATH, then
// the login shell's PATH, then the install directories. Each case hands
// locateHerdr an environment of its own, with a fake login shell, so no case
// depends on the herdr or the profile of the machine that runs it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { locateHerdr } from '../../src/core/herdr-bin.ts';

interface Space {
  root: string;
  /** A directory that holds an executable herdr. */
  herdrDir: string;
  herdr: string;
  /** A directory with no herdr in it. */
  emptyDir: string;
  /** A login shell whose profile prints a line, then sets PATH to `loginPath`, then runs the command it was given. */
  shell(loginPath: string): string;
}

function space(t: { after: (fn: () => void) => void }): Space {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-herdr-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const herdrDir = path.join(root, 'herdr-home', 'bin');
  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(herdrDir, { recursive: true });
  fs.mkdirSync(emptyDir);
  const herdr = path.join(herdrDir, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let shells = 0;
  return {
    root,
    herdrDir,
    herdr,
    emptyDir,
    shell(loginPath) {
      const file = path.join(root, `login-shell-${(shells += 1)}`);
      // Called as `<shell> -l -c <command>`, like sh, bash, zsh and fish.
      fs.writeFileSync(file, `#!/bin/sh\necho 'a profile that prints a greeting'\nPATH='${loginPath}'\nexport PATH\neval "$3"\n`, { mode: 0o755 });
      return file;
    },
  };
}

test('a daemon whose PATH, login shell and install directories lack herdr gets an error that names herdr and each place it looked', async (t) => {
  const s = space(t);
  const shell = s.shell(s.emptyDir);
  const result = await locateHerdr({ PATH: s.emptyDir, SHELL: shell, HOME: s.root, BELLWETHER_HARNESS_DIRS: '' });
  assert.ok('error' in result, JSON.stringify(result));
  assert.match(result.error, /^no herdr found: HERDR_BIN_PATH is unset; /);
  assert.match(result.error, new RegExp(`the PATH this process inherited \\(${s.emptyDir}\\) has none`));
  assert.match(result.error, new RegExp(`the login shell ${shell} has none on its PATH \\(${s.emptyDir}\\)`));
  assert.match(result.error, /Set HERDR_BIN_PATH to the herdr binary, or start the daemon from a login shell$/);
});

test('HERDR_BIN_PATH wins over every other place, even with no herdr on PATH', async (t) => {
  const s = space(t);
  assert.deepEqual(await locateHerdr({ PATH: s.emptyDir, SHELL: s.shell(s.emptyDir), HOME: s.root, BELLWETHER_HARNESS_DIRS: '', HERDR_BIN_PATH: s.herdr }), { path: s.herdr, via: 'HERDR_BIN_PATH' });
});

test('a HERDR_BIN_PATH that is not an executable file is an error, rather than a reason to look elsewhere', async (t) => {
  const s = space(t);
  const missing = path.join(s.root, 'nowhere', 'herdr');
  assert.deepEqual(await locateHerdr({ PATH: s.herdrDir, HERDR_BIN_PATH: missing }), { error: `HERDR_BIN_PATH is ${missing}, which is not an executable file` });
});

test('the inherited PATH is read before any shell starts', async (t) => {
  const s = space(t);
  // A login shell that would fail the test if it ran.
  const shell = path.join(s.root, 'no-shell');
  fs.writeFileSync(shell, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  assert.deepEqual(await locateHerdr({ PATH: `${s.emptyDir}${path.delimiter}${s.herdrDir}`, SHELL: shell, HOME: s.root, BELLWETHER_HARNESS_DIRS: '' }), { path: s.herdr, via: 'PATH' });
});

test("the login shell's PATH finds herdr that a non-interactive SSH shell's PATH lacks, past what its profile prints", async (t) => {
  const s = space(t);
  const result = await locateHerdr({ PATH: s.emptyDir, SHELL: s.shell(`/usr/bin${path.delimiter}${s.herdrDir}`), HOME: s.root, BELLWETHER_HARNESS_DIRS: '' });
  assert.deepEqual(result, { path: s.herdr, via: 'login shell' });
});

test('the install directories find herdr when the login shell cannot run', async (t) => {
  const s = space(t);
  const result = await locateHerdr({ PATH: s.emptyDir, SHELL: path.join(s.root, 'no-such-shell'), HOME: s.root, BELLWETHER_HARNESS_DIRS: s.herdrDir });
  assert.deepEqual(result, { path: s.herdr, via: 'install directory' });
});

test("the install directories include ~/.local/bin, where the issue's machine kept herdr", async (t) => {
  const s = space(t);
  const local = path.join(s.root, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.copyFileSync(s.herdr, path.join(local, 'herdr'));
  fs.chmodSync(path.join(local, 'herdr'), 0o755);
  const result = await locateHerdr({ PATH: s.emptyDir, SHELL: s.shell(s.emptyDir), HOME: s.root });
  assert.deepEqual(result, { path: path.join(local, 'herdr'), via: 'install directory' });
});
