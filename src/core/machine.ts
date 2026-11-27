// Reaching a herdr server on another machine. herdr's own `--machine` prefix
// runs `herdr --session <s> remote-api-bridge` over SSH on the saved profile's
// target, and speaks the socket protocol over that process's stdio. Bellwether
// does the same, so a subscription to a remote pane works like a local one.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HerdrClient, type HerdrConnection, type HerdrDialer } from './herdr-client.ts';
import { shellQuote } from './ssh.ts';

/** The host a child runs on when no machine was named: this machine's herdr. */
export const LOCAL_HOST = 'local';

/** One saved SSH machine, as `herdr machine list --json` prints it. */
export interface MachineProfile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
}

/** The capability string a bridge-capable herdr prints for `remote-api-bridge --check`. */
const BRIDGE_CAPABILITY = 'herdr-api-bridge-v1';

/**
 * The remote side: find a herdr that can bridge, the way herdr's own forwarding
 * does, because a non-interactive SSH shell often has no herdr on its PATH.
 */
const BRIDGE_SCRIPT = [
  'for c in "$(command -v herdr 2>/dev/null)" "$HOME/.local/bin/herdr" /home/linuxbrew/.linuxbrew/bin/herdr /opt/homebrew/bin/herdr /usr/local/bin/herdr; do',
  '  [ -n "$c" ] && [ -x "$c" ] || continue',
  `  if [ "$("$c" --session "$1" remote-api-bridge --check </dev/null 2>/dev/null)" = ${BRIDGE_CAPABILITY} ]; then exec "$c" --session "$1" remote-api-bridge; fi`,
  'done',
  "echo 'no herdr on this machine can bridge the API; update herdr there' >&2",
  'exit 78',
].join('\n');

/** The command line SSH runs on the remote machine. */
export function bridgeCommand(session: string): string {
  return `sh -c ${shellQuote(BRIDGE_SCRIPT)} bellwether-bridge ${shellQuote(session)}`;
}

/** Dial a machine's herdr through an SSH process whose stdio is the connection. */
export function bridgeDialer(profile: Pick<MachineProfile, 'target' | 'session' | 'label'>, ssh = 'ssh'): HerdrDialer {
  return (onReady) => {
    const child = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', profile.target, bridgeCommand(profile.session)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = new EventEmitter();
    let stderr = '';
    let failed = false;
    const fail = (error: Error): void => {
      if (failed) return;
      failed = true;
      events.emit('error', error);
    };
    child.on('spawn', onReady);
    child.on('error', fail);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => events.emit('data', chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    // Wait for the process to close rather than for stdout to end, so a failed
    // bridge reports its stderr instead of a bare closed connection.
    child.on('close', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') events.emit('end');
      else fail(new Error(`the herdr bridge to machine ${profile.label} exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    const connection: HerdrConnection = {
      write: (line) => child.stdin.write(line),
      on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
      destroy: () => {
        if (child.exitCode === null) child.kill('SIGTERM');
      },
      unref: () => {
        child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      },
    };
    return connection;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse `herdr machine list --json`. */
export function parseMachineList(text: string): MachineProfile[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('herdr machine list did not print a list');
  return value.filter(isRecord).flatMap((entry) => {
    const { id, label, target, session, enabled } = entry;
    if (typeof id !== 'string' || typeof label !== 'string' || typeof target !== 'string') return [];
    return [{ id, label, target, session: typeof session === 'string' && session ? session : 'default', enabled: enabled !== false }];
  });
}

/** Pick a profile the way herdr does: by id, or by a unique, case-sensitive label. */
export function pickMachine(profiles: MachineProfile[], selector: string): MachineProfile {
  const byId = profiles.find((profile) => profile.id === selector);
  const byLabel = profiles.filter((profile) => profile.label === selector);
  const profile = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined);
  if (!profile) {
    const known = profiles.map((entry) => entry.label).join(', ') || 'none';
    throw new Error(byLabel.length > 1 ? `more than one saved herdr machine is labelled ${selector}; name it by id` : `herdr has no saved machine ${selector}. Saved machines: ${known}.`);
  }
  if (!profile.enabled) throw new Error(`the herdr machine ${selector} is disabled`);
  return profile;
}

export type MachineResolver = (selector: string) => Promise<MachineProfile>;

/** Ask the local herdr for its saved machines. */
export const resolveMachine: MachineResolver = (selector) =>
  new Promise((resolve, reject) => {
    execFile('herdr', ['machine', 'list', '--json'], { timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error(`herdr machine list failed: ${error.message}`));
      try {
        resolve(pickMachine(parseMachineList(stdout), selector));
      } catch (fault) {
        reject(fault as Error);
      }
    });
  });

/** Hand out one herdr client per host, the local one for LOCAL_HOST. */
export type ClientFor = (host: string) => Promise<HerdrClient>;

export function machineClients(local: HerdrClient, resolve: MachineResolver = resolveMachine): ClientFor {
  const clients = new Map<string, Promise<HerdrClient>>();
  return (host) => {
    if (host === LOCAL_HOST) return Promise.resolve(local);
    let client = clients.get(host);
    if (!client) {
      client = resolve(host).then((profile) => new HerdrClient({ dial: bridgeDialer(profile), label: `machine:${profile.label}` }));
      // A failed lookup is not cached, so a machine saved later still works.
      client.catch(() => clients.delete(host));
      clients.set(host, client);
    }
    return client;
  };
}

/** The host a child record names, with an older record read as local. */
export function hostOf(child: { host?: string }): string {
  return child.host ?? LOCAL_HOST;
}
