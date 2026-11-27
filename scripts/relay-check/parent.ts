// The parent's side of the second-machine relay checks, in a Bellwether home
// of its own: a daemon whose registry holds one placeholder child on a named
// herdr machine, and whose relay links dial that machine through
// scripts/relay-check/ssh.sh. Nothing here uses the live daemon or the live
// ~/.bellwether on this machine. It logs every relay event to stdout and runs
// until it gets SIGTERM or SIGINT.
//
//   node scripts/relay-check/parent.ts --home DIR --host LABEL
//
// The placeholder child is kind claude, not pi, and runs nowhere: it only
// gives the daemon a reason to dial the machine. A pi child would make
// `bellwether relay-register --kind pi` check that machine's pi settings, and
// it refuses when they load an older Bellwether extension.
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { home: { type: 'string' }, host: { type: 'string' } } });
if (!values.home || !values.host) throw new Error('usage: node scripts/relay-check/parent.ts --home DIR --host LABEL');
const home = path.resolve(values.home);
const host = values.host;
const socketPath = path.join(home, 'daemon.sock');
process.env['BELLWETHER_HOME'] = home;
process.env['BELLWETHER_DAEMON_SOCKET'] = socketPath;

const { emptyParent, saveParent, upsertChild } = await import('../../src/core/registry.ts');
const { RelayLinks } = await import('../../src/daemon/relay-links.ts');
const { startDaemon } = await import('../../src/daemon/server.ts');

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const at = new Date().toISOString();
const parent = saveParent(emptyParent('claude-code', 'relay-check-parent', home, {}));
const childId = 'relay-check-child';
upsertChild(parent.id, { id: childId, name: 'relay-check', kind: 'claude', harness: 'claude-code', paneId: 'none', host, startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 });

const links = new RelayLinks({ ssh: path.join(import.meta.dirname, 'ssh.sh'), log });
const daemon = await startDaemon({ socketPath, home, links, log, idleMs: 24 * 60 * 60_000 });
log(`parent ${parent.id} with child ${childId} on machine ${host}; daemon pid ${daemon.pid} on ${socketPath}`);
log(`register the child on ${host}: bellwether relay-register --child ${childId} --name relay-check --kind claude --parent ${parent.id}`);
const stop = (): void => void daemon.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await daemon.whenClosed();
