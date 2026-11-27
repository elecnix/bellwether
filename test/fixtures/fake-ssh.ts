// A fake ssh on PATH. It records the argv each call receives, and plays a
// script of outcomes: refuse before running anything, run the remote command
// and then drop the connection as a dead link would, or run it and pass its
// exit code through. "Run the remote command" means run it on this machine
// with the Bellwether home, daemon socket and HOME the test assigned to that
// target, so two machines are two homes in one temporary root. A `bellwether`
// shim beside it runs this checkout's CLI and records its own argv, which is
// what the remote side of a hop actually received after the shell unquoted it.
// Standard input passes through to the remote command.
import fs from 'node:fs';
import path from 'node:path';

export interface FakeMachine {
  /** The Bellwether home on that machine. */
  home: string;
  /** Its HOME, where a transcript would sit. */
  userHome: string;
}

/** What one ssh call does: refuse (exit 255, nothing runs), drop (runs, then exit 255), or ok. */
export type SshStep = 'refuse' | 'drop' | 'ok';

export interface FakeSsh {
  dir: string;
  /** Every argv ssh received, in order. */
  calls(): string[][];
  /** Every argv the remote bellwether received, in order, with the target that ran it. */
  remoteCalls(): { target: string; argv: string[] }[];
  /** The outcomes for the next calls. Calls past the end are ok. */
  plan(steps: SshStep[]): void;
}

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');

const SSH_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = __dirname;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'ssh-calls.jsonl'), JSON.stringify(argv) + '\\n');
const planFile = path.join(dir, 'plan.json');
let step = 'ok';
try {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (plan.length) { step = plan.shift(); fs.writeFileSync(planFile, JSON.stringify(plan)); }
} catch {}
const options = new Set(['-o', '-p', '-i', '-l', '-F']);
let index = 0;
while (index < argv.length && argv[index].startsWith('-')) index += options.has(argv[index]) ? 2 : 1;
const target = argv[index];
const command = argv[index + 1];
if (step === 'refuse') { process.stderr.write('ssh: connect to host ' + target + ' port 22: Connection refused\\n'); process.exit(255); }
const machines = JSON.parse(fs.readFileSync(path.join(dir, 'machines.json'), 'utf8'));
const machine = machines[target];
if (!machine) { process.stderr.write('ssh: Could not resolve hostname ' + target + '\\n'); process.exit(255); }
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
const env = { ...process.env, HOME: machine.userHome, BELLWETHER_HOME: machine.home, BELLWETHER_DAEMON_SOCKET: path.join(machine.home, 'daemon.sock'), FAKE_SSH_TARGET: target, PATH: dir + path.delimiter + process.env.PATH };
const result = spawnSync('sh', ['-c', command], { env, input, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (step === 'drop') { process.stderr.write('Connection to ' + target + ' closed by remote host.\\n'); process.exit(255); }
process.exit(result.status === null ? 1 : result.status);
`;

function bellwetherShim(): string {
  return `#!/bin/sh
node -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({ target: process.env.FAKE_SSH_TARGET, argv: process.argv.slice(2) }) + "\\n")' "$(dirname "$0")/bellwether-calls.jsonl" "$@"
exec node --disable-warning=ExperimentalWarning ${JSON.stringify(CLI)} "$@"
`;
}

function readLines<T>(file: string): T[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

/**
 * Put a fake ssh and a bellwether shim first on PATH for the rest of the case.
 * `machines` maps an SSH target to the home it stands for.
 */
export function installFakeSsh(t: { after: (fn: () => void) => void }, root: string, machines: Record<string, FakeMachine>): FakeSsh {
  const dir = path.join(root, 'fake-bin');
  fs.mkdirSync(dir, { recursive: true });
  // The script uses require, so it must not sit under a package that says "type": "module".
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(dir, 'ssh'), SSH_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bellwether'), bellwetherShim(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify(machines));
  const previous = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`;
  t.after(() => {
    process.env['PATH'] = previous;
  });
  return {
    dir,
    calls: () => readLines<string[]>(path.join(dir, 'ssh-calls.jsonl')),
    remoteCalls: () => readLines<{ target: string; argv: string[] }>(path.join(dir, 'bellwether-calls.jsonl')),
    plan: (steps) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(steps)),
  };
}
