// What npm publishes, installed the way a user installs it. Node refuses to
// strip types from a file under node_modules, so a package that runs from a
// checkout can still fail to start once installed. Version 0.1.0 shipped that
// way. These cases pack the tarball, install it into an empty directory and
// run what landed in node_modules.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';

const root = path.resolve(import.meta.dirname, '../..');
let scratch = '';
let app = '';
let installed = '';

/** The environment for a command run from the installed package, cut off from the live herdr and daemon. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_SESSION', 'BELLWETHER_PARENT']) {
    delete env[name];
  }
  env['BELLWETHER_HOME'] = path.join(scratch, 'home');
  env['HERDR_SOCKET_PATH'] = path.join(scratch, 'no-herdr.sock');
  return env;
}

function bin(name: string): string {
  return path.join(app, 'node_modules', '.bin', name);
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-installed-'));
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [pack] = JSON.parse(packed) as { filename: string }[];
  assert.ok(pack, 'npm pack printed no tarball');

  app = path.join(scratch, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(scratch, pack.filename)],
    { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  installed = path.join(app, 'node_modules', '@elecnix', 'bellwether');
});

after(async () => {
  // The MCP server starts a daemon in the scratch home. Stop it and wait for it
  // to exit, or it is still writing there while the directory is removed.
  await stopDaemonsUnder(scratch, path.join(scratch, 'home'));
  assert.deepEqual(daemonsUnder(scratch), [], 'a daemon outlived the installed-package cases');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('the installed bellwether command prints its usage', () => {
  const run = spawnSync(bin('bellwether'), ['help'], { env: isolatedEnv(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Usage: bellwether /);
});

test('the installed doctor starts, finds its own entry points and reaches the herdr check', () => {
  const run = spawnSync(bin('bellwether'), ['doctor'], { env: isolatedEnv(), encoding: 'utf8' });
  assert.doesNotMatch(run.stderr, /ERR_/, run.stderr);
  assert.match(run.stdout, /^bellwether home /m);
  assert.match(run.stdout, /ok {4}pi extension: /);
  assert.match(run.stdout, /ok {4}mcp entry: /);
  // No herdr runs at the isolated socket, so doctor ends on that check.
  assert.match(run.stdout, /fail {2}herdr socket: /);
  assert.equal(run.status, 1);
});

test('Node loads every pi extension the installed package declares', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')) as {
    pi?: { extensions?: string[] };
  };
  const extensions = manifest.pi?.extensions ?? [];
  assert.ok(extensions.length > 0, 'the installed package declares no pi extension');
  for (const entry of extensions) {
    const file = path.resolve(installed, entry);
    assert.ok(file.includes(`${path.sep}node_modules${path.sep}`), `${file} is not under node_modules`);
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const m = await import(process.env.EXTENSION); if (typeof m.default !== 'function') process.exit(2);",
      ],
      { env: { ...isolatedEnv(), EXTENSION: file }, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `${entry} did not load: ${run.stderr}`);
  }
});

test('the installed MCP server starts its daemon, reports ready and exits when stdin closes', async () => {
  const child = spawn(bin('bellwether-mcp'), [], { env: isolatedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 20 s: ${stderr}`)), 20_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (/channel ready for /.test(stderr)) {
        clearTimeout(timer);
        resolve();
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code} before it was ready: ${stderr}`));
    });
  });
  await ready;
  // The daemon it started holds a lock in the scratch home, and the cleanup stops it.
  assert.doesNotMatch(stderr, /could not reach its daemon/, stderr);
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
});
