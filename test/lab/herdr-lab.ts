// Tier 3: a real herdr server, isolated from the operator's. The environment
// is built from scratch under a temp root, so nothing here can reach the live
// socket, and a guard refuses to start if the resolved path ever is the live
// one. The full four-pair matrix with scripted model replies builds on this.
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The lab servers this process started. A killed test run never reaches
 * stop(), so an exit or signal handler kills them and removes their roots. A
 * leaked server per killed run is what made CI hosts accumulate them.
 */
const liveLabs = new Map<ChildProcess, string>();
let cleanupInstalled = false;

function installLabCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const clean = (): void => {
    for (const [child, root] of liveLabs) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The server is already gone.
      }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // A root that cannot be removed is better left than crashing the exit.
      }
    }
    liveLabs.clear();
  };
  process.once('exit', clean);
  process.once('SIGTERM', () => {
    clean();
    process.exit(143);
  });
  process.once('SIGINT', () => {
    clean();
    process.exit(130);
  });
}

/** The socket the operator's own herdr server owns. Nothing here may touch it. */
export function liveSocketPath(): string {
  return path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
}

/** Refuse a socket path that is the live one, before anything binds it. */
export function assertNotLiveSocket(socketPath: string): void {
  if (path.resolve(socketPath) === path.resolve(liveSocketPath())) {
    throw new Error(`refusing to start a lab against the live herdr socket at ${socketPath}`);
  }
}

export function herdrBinary(): string {
  return process.env['HERDR_BIN'] ?? 'herdr';
}

/** Whether a real herdr binary is available, so the lab can skip rather than fail. */
export async function hasHerdr(): Promise<boolean> {
  try {
    await run(herdrBinary(), ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface Lab {
  readonly root: string;
  readonly session: string;
  readonly socketPath: string;
  readonly pid: number | undefined;
  /** The environment the server and its panes inherit. */
  readonly env: NodeJS.ProcessEnv;
  /** Stop the server, confirm the process is gone, then remove the temp root. */
  stop(): Promise<void>;
}

export interface LabOptions {
  /** Keep the temp root and print the attach command, instead of cleaning up. */
  keep?: boolean;
}

function labEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    HERDR_CONFIG_PATH: path.join(root, 'config', 'herdr', 'config.toml'),
    SHELL: '/bin/sh',
  };
  // Values inherited from a pane point at the live server.
  delete env['HERDR_ENV'];
  delete env['HERDR_PANE_ID'];
  delete env['HERDR_SOCKET_PATH'];
  delete env['HERDR_SESSION'];
  return env;
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error(`the lab herdr never created ${socketPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) throw new Error('the lab herdr server did not exit');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Start a real herdr server in its own config root and session. */
export async function startLab(options: LabOptions = {}): Promise<Lab> {
  // A Unix socket path is capped at 104 bytes on macOS, and the default temp
  // directory is already long there, so the lab root goes directly under /tmp.
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'bw-lab-'));
  const session = `bw-${Math.random().toString(36).slice(2, 10)}`;
  const env = labEnvironment(root);
  const socketPath = path.join(String(env['XDG_CONFIG_HOME']), 'herdr', 'sessions', session, 'herdr.sock');
  assertNotLiveSocket(socketPath);

  const child = spawn(herdrBinary(), ['--session', session, 'server'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await waitForSocket(socketPath, 20_000);
  if (options.keep) console.log(`lab kept: herdr --session ${session} (root ${root})`);
  if (!options.keep) {
    installLabCleanup();
    liveLabs.set(child, root);
  }

  return {
    root,
    session,
    socketPath,
    pid: child.pid,
    env,
    async stop(): Promise<void> {
      await run(herdrBinary(), ['--session', session, 'server', 'stop'], { env, timeout: 15_000 }).catch(() => undefined);
      child.kill('SIGTERM');
      await waitForExit(child, 10_000);
      liveLabs.delete(child);
      if (!options.keep) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
