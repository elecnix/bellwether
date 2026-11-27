// The fake ssh's plan of outcomes must hold under concurrent calls. A call
// that read the plan before the test replaced it must not bring the old plan
// back, or a case that ends a refusal with `plan([])` keeps being refused.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { installFakeSsh } from '../fixtures/fake-ssh.ts';

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-fake-ssh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'box', '.bellwether');
  fs.mkdirSync(home, { recursive: true });
  const ssh = installFakeSsh(t, root, { box: { home, userHome: path.dirname(home) } });
  return { root, ssh, bin: path.join(ssh.dir, 'ssh') };
}

test('a call that read the plan before it was replaced does not bring the old plan back', async (t) => {
  const { root, ssh, bin } = setup(t);
  ssh.plan(Array.from({ length: 50 }, () => 'refuse' as const));

  const hold = path.join(root, 'hold');
  fs.mkdirSync(hold);
  const held = spawn(bin, ['box', 'true'], { env: { ...process.env, FAKE_SSH_HOLD: hold }, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => held.on('close', resolve));
  await until(() => fs.existsSync(path.join(hold, 'held')), 'the held call to read the plan');

  ssh.plan([]);
  fs.writeFileSync(path.join(hold, 'release'), '');
  assert.equal(await exited, 255, 'the held call takes the step it read: a refusal');

  const next = spawnSync(bin, ['box', 'true'], { encoding: 'utf8' });
  assert.equal(next.status, 0, `the next call follows the new plan, but it said: ${next.stderr}`);
});

test('concurrent calls each take their own step from the plan', async (t) => {
  const { ssh, bin } = setup(t);
  ssh.plan(['refuse', 'refuse', 'refuse', 'refuse']);
  const codes = await Promise.all(
    Array.from({ length: 8 }, () => new Promise<number | null>((resolve) => spawn(bin, ['box', 'true'], { stdio: 'ignore' }).on('close', resolve))),
  );
  assert.deepEqual([...codes].sort(), [0, 0, 0, 0, 255, 255, 255, 255]);
});

test('a plan larger than one write is never read half-written', async (t) => {
  const { ssh, bin } = setup(t);
  // Each rewrite of a long plan would leave a window where a reader sees a truncated file and takes `ok`.
  const refusals = Array.from({ length: 20_000 }, () => 'refuse' as const);
  let stop = false;
  const writer = (async () => {
    while (!stop) {
      ssh.plan(refusals);
      await delay(0);
    }
  })();
  const codes = await Promise.all(
    Array.from({ length: 12 }, () => new Promise<number | null>((resolve) => spawn(bin, ['box', 'true'], { stdio: 'ignore' }).on('close', resolve))),
  );
  stop = true;
  await writer;
  assert.deepEqual(codes.filter((code) => code !== 255), [], 'every call read a whole plan and was refused');
});
