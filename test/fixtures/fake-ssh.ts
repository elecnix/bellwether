// A fake ssh on PATH. It records the argv each call receives, and plays a
// script of outcomes: refuse before running anything, run the remote command
// and then drop the connection as a dead link would, or run it and pass its
// exit code through. "Run the remote command" means run it on this machine
// with the Bellwether home, daemon socket and HOME the test assigned to that
// target, so two machines are two homes in one temporary root. A `bellwether`
// shim beside it runs this checkout's CLI and records its own argv, which is
// what the remote side of a hop actually received after the shell unquoted it.
//
// Standard input and output are streamed both ways for as long as the remote
// command runs, so a one-shot command gets its standard input and a
// long-lived `bellwether relay-bridge` works through it, and `drop()` cuts
// every open connection the way a dead network link would.
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
  /** The SSH target of every call, in order. */
  targets(): string[];
  /** Every argv the remote bellwether received, in order, with the target that ran it. */
  remoteCalls(): { target: string; argv: string[] }[];
  /** The outcomes for the next calls. Calls past the end are ok. */
  plan(steps: SshStep[]): void;
  /** Cut every connection still open, as a dead link would: ssh exits 255. Resolves with how many it cut. */
  drop(): Promise<number>;
  /** How many ssh processes are still running. */
  open(): number;
}

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');

const SSH_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
// A real ssh carries none of the parent's harness directories to the other machine.
const inherited = { ...process.env };
for (const key of ['CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']) delete inherited[key];
const env = { ...inherited, HOME: machine.userHome, BELLWETHER_HOME: machine.home, BELLWETHER_DAEMON_SOCKET: path.join(machine.home, 'daemon.sock'), FAKE_SSH_TARGET: target, PATH: dir + path.delimiter + process.env.PATH };
const liveDir = path.join(dir, 'live');
fs.mkdirSync(liveDir, { recursive: true });
const liveFile = path.join(liveDir, String(process.pid));
fs.writeFileSync(liveFile, target);
// Its own process group, so a dropped link takes the whole remote command down with it.
const remote = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
process.stdin.pipe(remote.stdin);
remote.stdin.on('error', () => {});
remote.stdout.pipe(process.stdout);
remote.stderr.pipe(process.stderr);
// Writes to a pipe are asynchronous on macOS, so flush stdout before exiting or a short reply is lost.
const finish = (code) => { try { fs.rmSync(liveFile, { force: true }); } catch {} process.stdout.write('', () => process.exit(code)); };
process.on('SIGTERM', () => {
  try { process.kill(-remote.pid, 'SIGKILL'); } catch {}
  process.stderr.write('Connection to ' + target + ' closed by remote host.\\n', () => finish(255));
});
remote.on('close', (code) => {
  if (step === 'drop') { process.stderr.write('Connection to ' + target + ' closed by remote host.\\n', () => finish(255)); return; }
  finish(code === null ? 1 : code);
});
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

function targetOf(argv: string[]): string {
  const options = new Set(['-o', '-p', '-i', '-l', '-F']);
  let index = 0;
  while (index < argv.length && (argv[index] as string).startsWith('-')) index += options.has(argv[index] as string) ? 2 : 1;
  return argv[index] ?? '';
}

function livePids(dir: string): number[] {
  try {
    return fs.readdirSync(path.join(dir, 'live')).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a fake ssh and a bellwether shim first on PATH for the rest of the case.
 * `machines` maps an SSH target to the home it stands for.
 */
export function installFakeSsh(t: { after: (fn: () => void | Promise<void>) => void }, root: string, machines: Record<string, FakeMachine>): FakeSsh {
  const dir = path.join(root, 'fake-bin');
  fs.mkdirSync(dir, { recursive: true });
  // The script uses require, so it must not sit under a package that says "type": "module".
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(dir, 'ssh'), SSH_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bellwether'), bellwetherShim(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify(machines));
  const previous = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`;
  const drop = async (): Promise<number> => {
    const pids = livePids(dir).filter(alive);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // It exited on its own between the listing and the signal.
      }
    }
    const deadline = Date.now() + 5_000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return pids.length;
  };
  t.after(async () => {
    await drop();
    process.env['PATH'] = previous;
  });
  return {
    dir,
    calls: () => readLines<string[]>(path.join(dir, 'ssh-calls.jsonl')),
    targets: () => readLines<string[]>(path.join(dir, 'ssh-calls.jsonl')).map(targetOf),
    remoteCalls: () => readLines<{ target: string; argv: string[] }>(path.join(dir, 'bellwether-calls.jsonl')),
    plan: (steps) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(steps)),
    drop,
    open: () => livePids(dir).filter(alive).length,
  };
}
