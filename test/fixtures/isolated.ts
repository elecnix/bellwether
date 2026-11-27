// A root of its own for one test case. The preload in isolation.ts already
// gives the test process a Bellwether home and daemon socket away from the live
// ones; this goes one step further for a case that writes registries or reads
// transcripts. HOME, XDG_CONFIG_HOME, BELLWETHER_HOME and
// BELLWETHER_DAEMON_SOCKET move under the case's own root, and every herdr
// variable an outer session sets is removed. assertIsolated fails the case
// when the herdr socket still resolves to the live one, which the preload does
// not guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSocketPath } from '../../src/core/herdr-client.ts';
import { bellwetherHome } from '../../src/core/paths.ts';
import { defaultDaemonSocket } from '../../src/daemon/client.ts';
import { LIVE_SOCKET } from './isolation.ts';

/** The live herdr socket, from the password database, so a changed HOME cannot hide it. */
export const LIVE_HERDR_SOCKET = path.join(os.userInfo().homedir, '.config', 'herdr', 'herdr.sock');

const HERDR_VARIABLES = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_SESSION'];
const OWNED = ['HOME', 'BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'XDG_CONFIG_HOME', ...HERDR_VARIABLES];

/** Throw when the herdr or daemon socket this process would use is a live one, or sits outside `root`. */
export function assertIsolated(root: string): void {
  const home = bellwetherHome();
  const resolved = [resolveSocketPath(), process.env['BELLWETHER_DAEMON_SOCKET'] ?? defaultDaemonSocket(home)];
  for (const socket of resolved) {
    if (socket === LIVE_HERDR_SOCKET || socket === LIVE_SOCKET) throw new Error(`This test resolves to the live socket ${socket}. Isolate it with isolate(t).`);
    if (!socket.startsWith(`${root}${path.sep}`)) throw new Error(`This test resolves to ${socket}, outside its own root ${root}.`);
  }
}

export interface Isolated {
  root: string;
  home: string;
}

/** Give the case its own root, restored and removed when the case ends. */
export function isolate(t: { after: (fn: () => void) => void }, prefix = 'bellwether-'): Isolated {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const saved = new Map(OWNED.map((name) => [name, process.env[name]]));
  for (const name of HERDR_VARIABLES) delete process.env[name];
  const home = path.join(root, '.bellwether');
  process.env['HOME'] = root;
  process.env['XDG_CONFIG_HOME'] = path.join(root, '.config');
  process.env['BELLWETHER_HOME'] = home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(home, 'daemon.sock');
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  assertIsolated(root);
  return { root, home };
}
