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
  /**
   * Variables that machine's shell sets for every command, such as a
   * NODE_OPTIONS that loads a harness entry only that machine knows.
   */
  env?: Record<string, string>;
}

/**
 * What one ssh call does: refuse (exit 255, nothing runs), deny (exit 255 on a
 * public-key refusal, as a host does when ssh offers no key it accepts), drop
 * (runs, then exit 255), or ok.
 */
export type SshStep = 'refuse' | 'deny' | 'drop' | 'ok';

export interface FakeSsh {
  dir: string;
  /** Every argv ssh received, in order. */
  calls(): string[][];
  /** The SSH target of every call, in order. */
  targets(): string[];
  /** Every argv the remote bellwether received, in order, with the target that ran it. */
  remoteCalls(): { target: string; argv: string[] }[];
  /**
   * The outcomes for the next calls, replacing any earlier plan, including the
   * steps it had left. Calls past the end are ok.
   */
  plan(steps: SshStep[]): void;
  /** Cut every connection still open, as a dead link would: ssh exits 255. Resolves with how many it cut. */
  drop(): Promise<number>;
  /** How many ssh processes are still running. */
  open(): number;
  /**
   * Freeze the near end of every open connection without closing it, as a dead
   * network link would: ssh stops forwarding in either direction, and the
   * remote command keeps running with its standard input still open. Resolves
   * with the process group of each remote command, so a test can watch it.
   */
  freeze(): Promise<number[]>;
}

const CLI = path.resolve(import.meta.dirname, '../../src/cli.ts');

const SSH_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = __dirname;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'ssh-calls.jsonl'), JSON.stringify(argv) + '\\n');
// The plan file is never written here, only replaced whole by the test, so a
// call that read an older plan cannot bring it back. A call takes the first
// step of its plan that no other call has claimed, and claims it by creating
// a file that only one process can create.
let step = 'ok';
let plan = { generation: 0, steps: [] };
try {
  plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// A test that must replace the plan while a call is between reading it and taking its step holds the call here.
if (process.env.FAKE_SSH_HOLD) {
  fs.writeFileSync(path.join(process.env.FAKE_SSH_HOLD, 'held'), '');
  while (!fs.existsSync(path.join(process.env.FAKE_SSH_HOLD, 'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
for (let at = 0; at < plan.steps.length; at++) {
  try {
    fs.closeSync(fs.openSync(path.join(dir, 'claims', plan.generation + '-' + at), 'wx'));
  } catch (error) {
    if (error.code === 'EEXIST') continue;
    throw error;
  }
  step = plan.steps[at];
  break;
}
const options = new Set(['-o', '-p', '-i', '-l', '-F']);
let index = 0;
while (index < argv.length && argv[index].startsWith('-')) index += options.has(argv[index]) ? 2 : 1;
const target = argv[index];
const command = argv[index + 1];
if (step === 'refuse') { process.stderr.write('ssh: connect to host ' + target + ' port 22: Connection refused\\n'); process.exit(255); }
if (step === 'deny') { process.stderr.write('someone@' + target + ': Permission denied (publickey,password,keyboard-interactive).\\n'); process.exit(255); }
const machines = JSON.parse(fs.readFileSync(path.join(dir, 'machines.json'), 'utf8'));
const machine = machines[target];
if (!machine) { process.stderr.write('ssh: Could not resolve hostname ' + target + '\\n'); process.exit(255); }
// A real ssh carries none of the parent's harness directories to the other machine.
const inherited = { ...process.env };
for (const key of ['CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']) delete inherited[key];
const env = { ...inherited, ...(machine.env || {}), HOME: machine.userHome, BELLWETHER_HOME: machine.home, BELLWETHER_DAEMON_SOCKET: path.join(machine.home, 'daemon.sock'), FAKE_SSH_TARGET: target, PATH: dir + path.delimiter + process.env.PATH };
const liveDir = path.join(dir, 'live');
fs.mkdirSync(liveDir, { recursive: true });
const liveFile = path.join(liveDir, String(process.pid));
// Its own process group, so a dropped link takes the whole remote command down with it.
const remote = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
fs.writeFileSync(liveFile, target + ' ' + remote.pid);
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

/** The remote process group a live ssh recorded, once it has started its command. */
function remoteGroup(dir: string, pid: number): number | undefined {
  try {
    const group = Number(fs.readFileSync(path.join(dir, 'live', String(pid)), 'utf8').trim().split(' ')[1]);
    return Number.isInteger(group) && group > 0 ? group : undefined;
  } catch {
    return undefined;
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
  fs.mkdirSync(path.join(dir, 'claims'), { recursive: true });
  let generation = 0;
  const plan = (steps: SshStep[]): void => {
    // A new generation, written to a side file and renamed into place, so a reader sees one whole plan or the other.
    generation += 1;
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(`${file}.${generation}`, JSON.stringify({ generation, steps }));
    fs.renameSync(`${file}.${generation}`, file);
  };
  const previous = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`;
  const drop = async (): Promise<number> => {
    const pids = livePids(dir).filter(alive);
    for (const pid of pids) {
      try {
        // A frozen ssh must run again to act on the signal.
        process.kill(pid, 'SIGCONT');
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
    plan,
    drop,
    open: () => livePids(dir).filter(alive).length,
    freeze: async () => {
      const groups: number[] = [];
      for (const pid of livePids(dir).filter(alive)) {
        const group = remoteGroup(dir, pid);
        process.kill(pid, 'SIGSTOP');
        if (group) groups.push(group);
      }
      return groups;
    },
  };
}
