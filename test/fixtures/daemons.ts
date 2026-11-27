// The daemons a test starts. A Bellwether client starts its daemon detached,
// so the daemon outlives the test process unless the test stops it. These
// helpers find a daemon by the socket path on its command line, which works
// even when the daemon has not written its lock yet.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isAlive } from '../../src/daemon/lock.ts';

export interface DaemonProcess {
  pid: number;
  socket: string;
}

/** Every Bellwether daemon on the machine whose socket sits under `root`. */
export function daemonsUnder(root: string): DaemonProcess[] {
  const prefix = `${path.resolve(root)}${path.sep}`;
  const listing = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const found: DaemonProcess[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2] ?? '';
    if (!/daemon[/\\]main\.(ts|js)\b/.test(args)) continue;
    const socket = /--socket\s+(\S+)/.exec(args)?.[1];
    if (socket?.startsWith(prefix)) found.push({ pid: Number(match[1]), socket });
  }
  return found;
}

/**
 * Stop every daemon under `root` and wait until each has exited. A client that
 * was starting a daemon when the test ended holds `daemon.starting`, so the
 * wait for that marker comes first.
 */
export async function stopDaemonsUnder(root: string, home = root): Promise<void> {
  const marker = path.join(home, 'daemon.starting');
  const markerDeadline = Date.now() + 5_000;
  while (startingClientAlive(marker) && Date.now() < markerDeadline) await delay(20);
  for (const daemon of daemonsUnder(root)) {
    try {
      process.kill(daemon.pid, 'SIGTERM');
    } catch {
      continue;
    }
    const deadline = Date.now() + 5_000;
    while (isAlive(daemon.pid) && Date.now() < deadline) await delay(20);
    if (isAlive(daemon.pid)) process.kill(daemon.pid, 'SIGKILL');
    while (isAlive(daemon.pid)) await delay(20);
  }
}

/** A client killed mid-start leaves its marker behind, so only a live writer counts. */
function startingClientAlive(marker: string): boolean {
  try {
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid?: number };
    return typeof pid === 'number' && isAlive(pid);
  } catch {
    return false;
  }
}
