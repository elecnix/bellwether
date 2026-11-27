// Tier 2: what a person reads when a bellwether command fails. The CLI prints
// the message and exits non-zero. A stack trace appears only with --debug or
// BELLWETHER_DEBUG=1, and then it says which of the two turned it on. A
// remote registration that fails quotes the far machine's own error line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { remoteLogDir } from '../../src/core/paths.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { emptyParent } from '../../src/core/registry.ts';
import type { ChildRecord } from '../../src/core/types.ts';

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');

function run(args: string[], env: Record<string, string> = {}): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BELLWETHER_DEBUG: '', ...env },
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr };
}

/** A socket path whose directory cannot be made, because a regular file stands in its way. */
function blockedSocket(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-cli-'));
  fs.writeFileSync(path.join(root, 'file'), '');
  return path.join(root, 'file', 'daemon.sock');
}

const FAILURES: [string, string[]][] = [
  ['list', ['list', '--parent', 'no-such-parent']],
  ['move', ['move', 'some-child', '--parent', 'no-such-parent']],
  ['daemon', ['daemon', '--socket', blockedSocket()]],
];

for (const [command, args] of FAILURES) {
  test(`a failing ${command} prints its message and no stack frame`, () => {
    const { status, stderr } = run(args);
    assert.notEqual(status, 0);
    assert.match(stderr, new RegExp(`^bellwether ${command}: `, 'm'));
    assert.doesNotMatch(stderr, /^ {4}at /m);
    assert.doesNotMatch(stderr, /Node\.js v/);
    assert.match(stderr, /--debug/);
  });
}

test('--debug prints the stack, and says that --debug turned it on', () => {
  const { status, stderr } = run(['list', '--debug', '--parent', 'no-such-parent']);
  assert.notEqual(status, 0);
  assert.match(stderr, /^ {4}at /m);
  assert.match(stderr, /stack trace shown because of --debug/);
});

test('BELLWETHER_DEBUG=1 prints the stack, and says so', () => {
  const { stderr } = run(['daemon', '--socket', blockedSocket()], { BELLWETHER_DEBUG: '1' });
  assert.match(stderr, /^ {4}at /m);
  assert.match(stderr, /stack trace shown because BELLWETHER_DEBUG=1/);
});

test('a registration that crashes on the far machine quotes its Error line, not its last frames', async () => {
  // A far end of its own, rather than the shared fake ssh: it prints what an
  // older bellwether prints when it throws on --brief-stdin, and exits 1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-far-'));
  const ssh = path.join(dir, 'ssh');
  const crash = [
    'file:///opt/bellwether/dist/cli.js:79',
    '    if (!names.includes(name)) throw new Error(`unknown argument ${token}`);',
    '                                     ^',
    '',
    'Error: unknown argument --brief-stdin; expected --child, --name, --kind, --parent, --cwd',
    '    at exactFlags (file:///opt/bellwether/dist/cli.js:79:43)',
    '    at relayRegister (file:///opt/bellwether/dist/cli.js:516:18)',
    '    at async onImport.tracePromise (node:internal/modules/esm/loader:547:26)',
    '',
    'Node.js v22.22.1',
  ].join('\n');
  fs.writeFileSync(ssh, `#!/bin/sh\ncat >/dev/null\ncat >&2 <<'EOF'\n${crash}\nEOF\nexit 1\n`, { mode: 0o755 });
  const ops = remoteOps(async (selector) => ({ id: selector, label: selector, target: selector, session: 'default', enabled: true }), { ssh });
  const child = { id: 'c-far', name: 'far-pi', kind: 'pi', host: 'child-box', cwd: '/work' } as ChildRecord;
  const failure = await ops.register(emptyParent('pi', 'far-parent', '/work'), child, 'the brief').then(() => undefined, (error: Error) => error.message);
  assert.ok(failure, 'the registration should fail');
  assert.match(failure, /Error: unknown argument --brief-stdin/);
  assert.doesNotMatch(failure, /Node\.js v/);
  assert.match(failure, /came with Bellwether 0\.1\.5/);
  // Nothing but frames and the source excerpt followed the cause, so nothing is counted as left out, and the log keeps all of it.
  assert.doesNotMatch(failure, /more line/);
  const logs = fs.readdirSync(remoteLogDir()).map((name) => fs.readFileSync(path.join(remoteLogDir(), name), 'utf8'));
  assert.ok(logs.some((text) => text.includes('at relayRegister') && text.includes('Node.js v22.22.1')), 'the whole output is in the log');
});
