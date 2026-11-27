// Loaded with --import before every test file, in every tier. It gives the
// test process a Bellwether home and daemon socket of its own under a
// temporary root, and makes any attempt to reach the live daemon socket or
// the live home throw. A test that forgets its own isolation fails here
// instead of talking to the operator's daemon or writing to the real registry.
import fs from 'node:fs';
import module from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Every process a test starts, from a CLI call through the fake ssh to a
// detached daemon, loads the same sources again. Node's compile cache keeps
// each module's compiled code, keyed by its content, so a changed source
// compiles again and an unchanged one loads from the cache. From Node 24 it
// also keeps the result of stripping a TypeScript file's types, which is most
// of a start's CPU time. The processes inherit the directory through the
// environment, and this one turns the cache on for itself.
export const COMPILE_CACHE = process.env['NODE_COMPILE_CACHE'] || path.resolve(import.meta.dirname, '../../node_modules/.cache/bellwether-test-compile');
process.env['NODE_COMPILE_CACHE'] = COMPILE_CACHE;
module.enableCompileCache?.(COMPILE_CACHE);

/** The operator's real Bellwether home, read before any test can move HOME. */
export const LIVE_HOME = path.resolve(path.join(os.userInfo().homedir, '.bellwether'));
export const LIVE_SOCKET = path.join(LIVE_HOME, 'daemon.sock');

/** Whether a path sits in the live home, including the live socket. */
export function isLive(target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === LIVE_HOME || resolved.startsWith(`${LIVE_HOME}${path.sep}`);
}

export class LiveBellwetherError extends Error {
  constructor(what: string, target: string) {
    super(`a test tried to ${what} ${target}, which belongs to the live Bellwether. Give the test its own BELLWETHER_HOME and daemon socket under a temporary root.`);
    this.name = 'LiveBellwetherError';
  }
}

/** The root this process's default home and socket live under. */
export const ISOLATION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-test-'));

process.env['BELLWETHER_HOME'] = path.join(ISOLATION_ROOT, 'home');
process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(ISOLATION_ROOT, 'home', 'daemon.sock');
// pi's agent directory holds the operator's pi settings, which a pi spawn reads.
process.env['PI_CODING_AGENT_DIR'] = path.join(ISOLATION_ROOT, 'pi-agent');
// Claude Code's config directory holds the operator's settings and MCP
// servers, which a Claude Code spawn reads to keep a second Bellwether server
// out of the child. A case that needs some writes its own here.
process.env['CLAUDE_CONFIG_DIR'] = path.join(ISOLATION_ROOT, 'claude-config');
// Cline's directory holds the operator's session store, which agent_read and
// the watcher read for an adopted cline child. A case that needs a store
// writes its own here.
process.env['CLINE_DIR'] = path.join(ISOLATION_ROOT, 'cline');
for (const key of ['CLINE_DATA_DIR', 'CLINE_DB_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH']) delete process.env[key];
// The routes file describes the operator's own launchers. A case that needs
// routes writes its own file here, so none reads ~/.config/bellwether.
process.env['BELLWETHER_ROUTES'] = path.join(ISOLATION_ROOT, 'routes.json');
// The operator may run the suite from inside a Bellwether child. Its identity
// must not leak into the cases or the processes they start.
for (const key of ['BELLWETHER_PARENT', 'BELLWETHER_CHILD', 'BELLWETHER_CHILD_NAME', 'BELLWETHER_DEPTH', 'BELLWETHER_HARNESS', 'BELLWETHER_PI_EXTENSION']) delete process.env[key];

/** The path a net call names, in any of its argument shapes. */
function socketPath(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && typeof (first as { path?: unknown }).path === 'string') return (first as { path: string }).path;
  return undefined;
}

function guardConnect<T extends (...args: any[]) => any>(original: T): T {
  return function (this: unknown, ...args: unknown[]) {
    const target = socketPath(args);
    if (target && isLive(target)) throw new LiveBellwetherError('connect to', target);
    return original.apply(this, args);
  } as T;
}

net.connect = guardConnect(net.connect);
net.createConnection = guardConnect(net.createConnection);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  const target = socketPath(args);
  if (target && isLive(target)) throw new LiveBellwetherError('listen on', target);
  return (listen as (...rest: unknown[]) => net.Server).apply(this, args);
} as typeof listen;

/** The guard is in place: the isolation test reads this to prove the preload ran. */
(globalThis as { __bellwetherIsolation?: string }).__bellwetherIsolation = ISOLATION_ROOT;

process.on('exit', () => {
  try {
    fs.rmSync(ISOLATION_ROOT, { recursive: true, force: true });
  } catch {
    // A detached daemon may still be writing; the temporary directory is cleaned later.
  }
});
