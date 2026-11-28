// A daemon whose environment cannot reach herdr (issue #186). After a reboot,
// a parent on another machine started this machine's daemon over SSH, whose
// non-interactive PATH lacked herdr, and every operation that needs herdr then
// failed with `spawn herdr ENOENT`. Each case starts the daemon in this test
// process with the environment such an SSH session gives it, and runs
// `bellwether doctor` as a person would, in a process of its own whose PATH
// does have herdr. No real daemon process starts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listMachines } from '../../src/core/machine.ts';
import { startDaemon } from '../../src/daemon/server.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';
import { isolate } from '../fixtures/isolated.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const ENV_KEYS = ['PATH', 'SHELL', 'BELLWETHER_HARNESS_DIRS', 'HERDR_BIN_PATH'] as const;

/**
 * A home, a fake herdr socket, a herdr binary in a directory of its own, and
 * this process's environment set to what a non-interactive SSH session gives
 * the daemon: a PATH without that directory, a login shell whose PATH lacks it
 * too, and no install directory that holds it.
 */
async function sshStarted(t: { after: (fn: () => void | Promise<void>) => void }) {
  const space = isolate(t, 'bellwether-daemon-herdr-');
  const herdrSocket = await startFakeHerdr();
  t.after(() => herdrSocket.stop());
  const herdrDir = path.join(space.root, 'herdr-home', '.local', 'bin');
  fs.mkdirSync(herdrDir, { recursive: true });
  const herdr = path.join(herdrDir, 'herdr');
  fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([{ id: 'm1', label: 'far', target: 'far.example', session: 'default', enabled: false }])}'\n`, { mode: 0o755 });
  const sshPath = `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  const shell = path.join(space.root, 'login-shell');
  fs.writeFileSync(shell, `#!/bin/sh\nPATH='${sshPath}'\nexport PATH\neval "$3"\n`, { mode: 0o755 });

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env['PATH'] = sshPath;
  process.env['SHELL'] = shell;
  process.env['BELLWETHER_HARNESS_DIRS'] = '';
  delete process.env['HERDR_BIN_PATH'];

  // doctor runs where a person runs it: a shell whose PATH has herdr.
  const doctorEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${herdrDir}${path.delimiter}${sshPath}`, HERDR_SOCKET_PATH: herdrSocket.socketPath };
  const daemonSocket = path.join(space.home, 'daemon.sock');
  return { herdr, doctorEnv, daemonSocket, space };
}

test('doctor names a daemon that cannot run herdr, though herdr works in the shell doctor runs in', async (t) => {
  const { doctorEnv, daemonSocket, space } = await sshStarted(t);
  const daemon = await startDaemon({ socketPath: daemonSocket, home: space.home, idleMs: 60_000, pruneEveryMs: false });
  t.after(() => daemon.close());

  // What the issue saw: the daemon's first herdr command fails, and the message names herdr.
  await assert.rejects(listMachines(), /no herdr found: HERDR_BIN_PATH is unset; the PATH this process inherited \(.*\) has none; the login shell .* has none on its PATH/);

  const result = await run(['doctor'], doctorEnv);
  const line = result.stdout.split('\n').find((entry) => entry.includes('daemon herdr:')) ?? '';
  assert.match(line, new RegExp(`^  fail  daemon herdr: the daemon \\(pid ${process.pid}\\) cannot run herdr, so every operation that needs it fails: no herdr found: `), result.stdout);
  assert.match(line, /Set HERDR_BIN_PATH to the herdr binary, or start the daemon from a login shell\. Then run bellwether drain/);
  assert.notEqual(result.status, 0, 'a daemon without herdr fails doctor');
});

test('the same daemon with HERDR_BIN_PATH set runs herdr, and doctor says where it came from', async (t) => {
  const { herdr, doctorEnv, daemonSocket, space } = await sshStarted(t);
  process.env['HERDR_BIN_PATH'] = herdr;
  const daemon = await startDaemon({ socketPath: daemonSocket, home: space.home, idleMs: 60_000, pruneEveryMs: false });
  t.after(() => daemon.close());

  assert.deepEqual(await listMachines(), [{ id: 'm1', label: 'far', target: 'far.example', session: 'default', enabled: false }]);

  const result = await run(['doctor'], doctorEnv);
  assert.match(result.stdout, new RegExp(`\\n  ok    daemon herdr: ${herdr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, from HERDR_BIN_PATH\\n`), result.stdout);
});
