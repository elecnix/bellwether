// A parent's daemon in a process of its own, for a test that kills it in the
// middle of a move and starts another (issue #226). It serves the parent the
// way remote-restart.test.ts does in process, against the two fake machines
// of two-machines.ts: herdr on each machine is a fake socket the test holds,
// and the far machine is reached through the fake ssh on PATH. Each service
// start finishes or undoes the crossings another daemon process left, as the
// real service does. The test reads `ready` on stdout once the socket listens.
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { moveEndpoints } from '../../src/core/move-endpoint.ts';
import { recoverCrossings } from '../../src/core/recover-crossing.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { startDaemon, type ParentService, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';

interface Config {
  socketPath: string;
  home: string;
  hereHerdr: string;
  boxHerdr: string;
}

const config = JSON.parse(process.env['CROSSING_CONFIG'] ?? '{}') as Config;
const here = new HerdrClient({ socketPath: config.hereHerdr });
const box = new HerdrClient({ socketPath: config.boxHerdr });
const clientFor = async (host: string): Promise<HerdrClient> => {
  if (host === LOCAL_HOST) return here;
  if (host === 'box') return box;
  throw new Error(`herdr has no saved machine ${host}`);
};
const resolve = async (label: string) => {
  if (label !== 'box') throw new Error(`herdr has no saved machine ${label}`);
  return { id: label, label, target: label, session: 'default', enabled: true };
};

const factory: ServiceFactory = (_parent, id): ParentService => {
  const watcher = new Watcher({ client: here, clientFor, parentId: id, onEntries: () => {} });
  watcher.start();
  const remote = remoteOps(resolve);
  const endpointFor = moveEndpoints(resolve);
  const knownHosts = async (): Promise<string[]> => [LOCAL_HOST, 'box'];
  const ctx: ToolContext = { client: here, clientFor, parentId: id, watcher, remote, endpointFor, knownHosts, restart: { startupTimeoutMs: 5_000, redrawMs: 20 } };
  void recoverCrossings({ clientFor, endpointFor, knownHosts, registerRemote: (child, brief) => remote.register({ id }, child, brief), cleanupRemote: (child) => remote.cleanup(child), startupTimeoutMs: 5_000, redrawMs: 20, log: (line) => process.stderr.write(`${line}\n`) }, id);
  return {
    tool: (name, args, caller) => runBellwetherTool(ctx, name, args, caller),
    markRead: () => {},
    onEvents: () => {},
    pending: () => [],
    watchPane: () => () => {},
    stop: () => watcher.stop(),
  };
};

await startDaemon({ socketPath: config.socketPath, home: config.home, factory, pruneEveryMs: false });
process.stdout.write('ready\n');
