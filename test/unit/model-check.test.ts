// Tier 1: the model checker runs under a memory ceiling. everystate keeps every
// state in memory, and a configuration with no bound on its state space once
// filled a 32 GB machine and its swap. These cases run model/check.sh over a
// stand-in checker, so they need no everystate, and fail when the ceiling does
// not stop a run that grows past it, or when run-all.sh calls the checker
// without check.sh.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const model = path.resolve(import.meta.dirname, '../../model');

/** A stand-in checker: it allocates the given MiB, holds them, then exits with the given code. */
function standIn(dir: string, mib: number, code: number): string {
  const file = path.join(dir, `checker-${mib}-${code}`);
  fs.writeFileSync(file, `#!/usr/bin/env node
const held = [];
for (let i = 0; i < ${mib}; i++) held.push(Buffer.alloc(1 << 20, 1));
setTimeout(() => process.exit(${code}), 1500);
`, { mode: 0o755 });
  return file;
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
      const result = await check(standIn(dir, 400, 0), { ...env, EVERYSTATE_MEMORY: '128M' });
      assert.equal(result.code, 137, result.stderr);
      assert.match(result.stderr, /passed the memory ceiling of 128M/);
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
