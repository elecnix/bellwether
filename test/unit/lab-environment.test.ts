// The lab starts real harnesses, and a harness uses whatever credentials its
// environment holds. These cases run the lab's own command line, as
// package.json gives it, over probe files that record the environment a lab
// case sees. A lab run has to start without the shell's provider keys, tokens
// and cloud credentials, print one notice that names what it removed, and keep
// a key only when the person names it in BELLWETHER_LAB_KEYS. A lab pane gets a
// kept key only when the case asks for it by name.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isCredential } from '../lab/credentials.ts';
import { labEnvironment } from '../lab/herdr-lab.ts';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

/** The commands of the test:lab script, with the lab file glob replaced by the given files. */
function labCommands(files: string[]): string[][] {
  const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  return (scripts['test:lab'] ?? '').split('&&').map((command) => {
    const words = command.trim().split(/\s+/).map((word) => word.replace(/^"|"$/g, ''));
    assert.equal(words[0], 'node', `each test:lab command starts with node: ${command}`);
    const args = words.slice(1);
    return args.some((word) => word.startsWith('test/lab/**')) ? [...args.filter((word) => !word.startsWith('test/lab/**')), ...files] : args;
  });
}

const PROBE = `import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
test('record the environment', () => {
  fs.writeFileSync(path.join(process.env.LAB_PROBE_OUT, path.basename(import.meta.filename) + '.json'), JSON.stringify(process.env));
});
`;

const EXPORTED = {
  XAI_API_KEY: 'fake-xai-key',
  ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-token',
  GH_TOKEN: 'fake-gh-token',
  AWS_ACCESS_KEY_ID: 'fake-access-key-id',
  AWS_SECRET_ACCESS_KEY: 'fake-secret-access-key',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/fake-credentials.json',
};

async function runLab(extra: Record<string, string>): Promise<{ output: string; seen: NodeJS.ProcessEnv[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-lab-env-'));
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const files = ['first', 'second'].map((name) => {
      const file = path.join(dir, `${name}.test.mjs`);
      fs.writeFileSync(file, PROBE);
      return file;
    });
    const env: NodeJS.ProcessEnv = { ...process.env, ...EXPORTED, ...extra, LAB_PROBE_OUT: out };
    // This file runs as a child of the unit runner, and a runner that inherits
    // the variable would act as a child too.
    delete env['NODE_TEST_CONTEXT'];
    let output = '';
    for (const command of labCommands(files)) {
      const { stdout, stderr } = await run(process.execPath, command, { cwd: root, env, timeout: 60_000 });
      output += stdout + stderr;
    }
    const seen = fs.readdirSync(out).map((file) => JSON.parse(fs.readFileSync(path.join(out, file), 'utf8')) as NodeJS.ProcessEnv);
    assert.equal(seen.length, 2, 'both probe files ran');
    return { output, seen };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a lab run removes provider keys, auth tokens and cloud credentials before any case starts, and says so once', { timeout: 90_000 }, async () => {
  const { output, seen } = await runLab({});
  for (const env of seen) {
    for (const name of Object.keys(EXPORTED)) assert.equal(env[name], undefined, `a lab case saw ${name}`);
    assert.ok(env['PATH'], 'a lab case keeps PATH');
  }
  const notices = output.split('\n').filter((line) => line.startsWith('lab environment:'));
  assert.equal(notices.length, 1, `one notice for the run, got:\n${output}`);
  for (const name of Object.keys(EXPORTED)) assert.ok(notices[0]?.includes(name), `the notice names ${name}`);
  for (const value of Object.values(EXPORTED)) assert.ok(!output.includes(value), 'the notice never prints a value');
});

test('a key named in BELLWETHER_LAB_KEYS stays, and the notice says it was kept', { timeout: 90_000 }, async () => {
  const { output, seen } = await runLab({ BELLWETHER_LAB_KEYS: 'XAI_API_KEY' });
  for (const env of seen) {
    assert.equal(env['XAI_API_KEY'], EXPORTED.XAI_API_KEY);
    assert.equal(env['GH_TOKEN'], undefined);
  }
  const notice = output.split('\n').find((line) => line.startsWith('lab environment:')) ?? '';
  assert.match(notice, /kept XAI_API_KEY/);
});

test('a lab pane gets no credential unless its case asks for one by name', () => {
  const base = { PATH: '/usr/bin', XAI_API_KEY: 'fake-xai-key', AWS_SECRET_ACCESS_KEY: 'fake-secret' };
  const plain = labEnvironment('/tmp/bw-lab-x', base);
  assert.equal(plain['XAI_API_KEY'], undefined);
  assert.equal(plain['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.equal(plain['PATH'], '/usr/bin');
  const asked = labEnvironment('/tmp/bw-lab-x', base, ['XAI_API_KEY']);
  assert.equal(asked['XAI_API_KEY'], 'fake-xai-key');
  assert.equal(asked['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.throws(() => labEnvironment('/tmp/bw-lab-x', { PATH: '/usr/bin' }, ['XAI_API_KEY']), /BELLWETHER_LAB_KEYS=XAI_API_KEY/);
});

test('the scrub names provider keys, tokens and cloud credentials, and leaves the rest', () => {
  for (const name of ['XAI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'HF_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AZURE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', 'DATABASE_PASSWORD']) {
    assert.ok(isCredential(name), `${name} counts as a credential`);
  }
  for (const name of ['PATH', 'HOME', 'TERM', 'SSH_AUTH_SOCK', 'NODE_COMPILE_CACHE', 'BELLWETHER_HOME', 'BELLWETHER_LAB_KEYS', 'ANTHROPIC_BASE_URL']) {
    assert.ok(!isCredential(name), `${name} is not a credential`);
  }
});
