// Tier 1: the model checker runs under a memory ceiling. everystate keeps every
// state in memory, and a configuration with no bound on its state space once
// filled a 32 GB machine and its swap. These cases run model/check.sh over a
// stand-in checker, so they need no everystate, and fail when the ceiling does
// not stop a run that grows past it, or when run-all.sh calls the checker
// without check.sh.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const model = path.resolve(import.meta.dirname, '../../model');

/**
 * A stand-in checker: it allocates the given MiB and holds them, then exits with the given code, or with 'killed'
 * holds them until something stops it. The buffers stay on `globalThis`: a local array that no timer refers to is
 * garbage once the script ends, and a collection then took the resident size back under the ceiling before the
 * watchdog's next read. A stand-in over the ceiling never exits on its own, so the only way its run ends is the cap.
 */
function standIn(dir: string, mib: number, code: number | 'killed'): string {
  const file = path.join(dir, `checker-${mib}-${code}`);
  const end = code === 'killed' ? 'setInterval(() => {}, 60_000);' : `setTimeout(() => process.exit(${code}), 1500);`;
  fs.writeFileSync(file, `#!/usr/bin/env node
globalThis.held = [];
for (let i = 0; i < ${mib}; i++) globalThis.held.push(Buffer.alloc(1 << 20, 1));
${end}
`, { mode: 0o755 });
  return file;
}

/**
 * A stand-in for the npm launcher: a shell script that runs a child checker and waits for it, the way
 * `bin/everystate.mjs` runs the native binary with `spawnSync`. The child grows to the given MiB, writes its PID to
 * `child.pid` beside the launcher, and exits 0 after three seconds, so a watchdog that reads only the launcher's own
 * resident size lets the run end with 0 (issue #263).
 */
function launcher(dir: string, mib: number, holdMs = 3000): { file: string; childPid: () => number } {
  const child = path.join(dir, 'child.mjs');
  const pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(child, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
globalThis.held = [];
for (let i = 0; i < ${mib}; i++) globalThis.held.push(Buffer.alloc(1 << 20, 1));
setTimeout(() => process.exit(0), ${holdMs});
`);
  const file = path.join(dir, 'launcher');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${JSON.stringify(process.execPath)} ${JSON.stringify(child)}\n`, { mode: 0o755 });
  return { file, childPid: () => Number(fs.readFileSync(pidFile, 'utf8')) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function check(checker: string, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(path.join(model, 'check.sh'), ['-json', 'Claims.tla'], { env: { ...process.env, EVERYSTATE: checker, ...env }, timeout: 60_000 });
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? 1, stderr: failed.stderr ?? '' };
  }
}

const caps = os.platform() === 'linux' ? ['systemd', 'watchdog'] : ['watchdog'];

for (const cap of caps) {
  const env: Record<string, string> = cap === 'watchdog' ? { EVERYSTATE_CAP: 'watchdog' } : {};

  test(`a check that grows past the ceiling is stopped and named (${cap})`, async (t) => {
    if (cap === 'systemd') {
      try {
        await run('systemd-run', ['--user', '--scope', '--quiet', 'true']);
      } catch {
        t.skip('no systemd user session');
        return;
      }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-model-'));
    try {
      const result = await check(standIn(dir, 400, 'killed'), { ...env, EVERYSTATE_MEMORY: '128M' });
      assert.equal(result.code, 137, result.stderr);
      assert.match(result.stderr, /passed the memory ceiling of 128M/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a launcher whose child grows past the ceiling is stopped, child and all (${cap})`, async (t) => {
    if (cap === 'systemd') {
      try {
        await run('systemd-run', ['--user', '--scope', '--quiet', 'true']);
      } catch {
        t.skip('no systemd user session');
        return;
      }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-model-'));
    try {
      const stand = launcher(dir, 400);
      const result = await check(stand.file, { ...env, EVERYSTATE_MEMORY: '128M' });
      assert.equal(result.code, 137, `the launcher's child grew to 400 MiB under a 128M ceiling, and the run ended ${result.code}:\n${result.stderr}`);
      assert.match(result.stderr, /passed the memory ceiling of 128M/);
      assert.equal(alive(stand.childPid()), false, 'the child checker outlived the stop');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a check under the ceiling keeps its own exit code (${cap})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-model-'));
    try {
      const result = await check(standIn(dir, 16, 12), { ...env, EVERYSTATE_MEMORY: '512M' });
      assert.equal(result.code, 12, result.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a check stopped from outside stops the launcher's child too (watchdog)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-model-'));
  try {
    const stand = launcher(dir, 8, 60_000);
    const proc = spawn(path.join(model, 'check.sh'), ['Claims.tla'], { env: { ...process.env, EVERYSTATE: stand.file, EVERYSTATE_CAP: 'watchdog', EVERYSTATE_MEMORY: '512M' }, stdio: 'ignore' });
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(dir, 'child.pid')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const child = stand.childPid();
    proc.kill('SIGTERM');
    await exited;
    const gone = Date.now() + 5_000;
    while (alive(child) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 50));
    const survived = alive(child);
    if (survived) process.kill(child, 'SIGKILL');
    assert.equal(survived, false, 'check.sh took SIGTERM and left the child checker running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a ceiling that is not a size is refused before the checker starts', async () => {
  const result = await check('/nonexistent/everystate', { EVERYSTATE_MEMORY: 'lots' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is not a size/);
});

test('run-all.sh calls the checker only through check.sh', () => {
  const script = fs.readFileSync(path.join(model, 'run-all.sh'), 'utf8');
  const commands = script.split('\n').filter((line) => !line.trim().startsWith('#'));
  assert.ok(commands.some((line) => line.includes('./check.sh')), 'run-all.sh does not run ./check.sh');
  assert.ok(!commands.some((line) => /\$ES"?\s+-/.test(line) || /\beverystate\s+-/.test(line)), 'run-all.sh calls everystate without the memory ceiling');
});
