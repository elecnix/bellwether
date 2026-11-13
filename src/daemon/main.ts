// The daemon process entry point. A client starts it detached with the socket
// path, and it exits on drain, on an idle timeout, or on a signal.
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from './server.ts';

const log = (message: string): void => console.error('[bellwether-daemon]', message);

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
  const socketPath = flag(argv, '--socket') ?? process.env['BELLWETHER_DAEMON_SOCKET'] ?? path.join(home, 'daemon.sock');
  const idleMs = Number.parseInt(process.env['BELLWETHER_DAEMON_IDLE_MS'] ?? '', 10);
  const daemon = await startDaemon({
    socketPath,
    home,
    log,
    ...(Number.isFinite(idleMs) ? { idleMs } : {}),
  });
  log(`listening on ${socketPath} with pid ${daemon.pid}`);
  const stop = (): void => {
    void daemon.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await daemon.whenClosed();
  process.exit(0);
}

main().catch((error: Error) => {
  log(error.message);
  process.exit(1);
});
