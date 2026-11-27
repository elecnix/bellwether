// Tier 1: no test can reach the live Bellwether. The preload in
// test/fixtures/isolation.ts gives each test process its own home and daemon
// socket and refuses the live ones; these cases fail when the preload is
// missing from a test script, or when a default resolves to the live daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bellwetherHome } from '../../src/core/paths.ts';
import { defaultDaemonSocket } from '../../src/daemon/client.ts';
import { LIVE_HOME, LIVE_SOCKET, LiveBellwetherError } from '../fixtures/isolation.ts';

test('every test script loads the isolation preload', () => {
  assert.ok((globalThis as { __bellwetherIsolation?: string }).__bellwetherIsolation, 'run the tests with --import ./test/fixtures/isolation.ts');
  const scripts = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const name of ['test:unit', 'test:integration', 'test:lab']) {
    assert.match(scripts[name] ?? '', /--import[= ]\.\/test\/fixtures\/isolation\.ts/, `${name} does not load the isolation preload`);
  }
});

test('the default home and daemon socket sit under a temporary root, never the live ones', () => {
  const home = path.resolve(bellwetherHome());
  assert.ok(home.startsWith(path.resolve(os.tmpdir())), `the default home is ${home}`);
  assert.notEqual(home, LIVE_HOME);
  const socket = path.resolve(defaultDaemonSocket(home));
  assert.ok(socket.startsWith(path.resolve(os.tmpdir())), `the default daemon socket is ${socket}`);
  assert.notEqual(socket, LIVE_SOCKET);
});

test('a connection to the live daemon socket is refused before it leaves the process', () => {
  assert.throws(() => net.createConnection(LIVE_SOCKET), LiveBellwetherError);
  assert.throws(() => net.connect({ path: LIVE_SOCKET }), LiveBellwetherError);
  const server = net.createServer();
  assert.throws(() => server.listen(LIVE_SOCKET), LiveBellwetherError);
});
