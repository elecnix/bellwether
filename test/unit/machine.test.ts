// Saved herdr machines: picking a profile the way herdr does, and speaking the
// socket protocol through the bridge process SSH would start. A stand-in for
// ssh pipes its stdio to a fake herdr socket, so no case leaves this machine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { bridgeCommand, bridgeDialer, machineClients, parseMachineList, pickMachine, type MachineProfile } from '../../src/core/machine.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';

const LIST = JSON.stringify([
  { id: 'aaa', label: 'hawthorne', target: 'hawthorne', session: 'default', enabled: true, selected: false },
  { id: 'bbb', label: 'old box', target: 'old', session: 'work', enabled: false, selected: false },
]);

test('a machine is picked by id or label, and a disabled or unknown one is refused', () => {
  const profiles = parseMachineList(LIST);
  assert.equal(pickMachine(profiles, 'hawthorne').target, 'hawthorne');
  assert.equal(pickMachine(profiles, 'aaa').label, 'hawthorne');
  assert.throws(() => pickMachine(profiles, 'old box'), /disabled/);
  assert.throws(() => pickMachine(profiles, 'nowhere'), /no saved machine nowhere. Saved machines: hawthorne, old box/);
});

test('the bridge command survives a session name with a quote in it', () => {
  const command = bridgeCommand("it's");
  // sh parses the command without error, and the session arrives as one word.
  execFileSync('sh', ['-n', '-c', command]);
  assert.match(command, /bellwether-bridge 'it'\\''s'$/);
});

function fakeSsh(root: string): { ssh: string; argsFile: string } {
  const ssh = path.join(root, 'ssh');
  const argsFile = path.join(root, 'args.json');
  fs.writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      "if (process.env.FAKE_BRIDGE_FAIL) { process.stderr.write('no herdr on this machine can bridge the API'); process.exit(78); }",
      'const socket = net.createConnection(process.env.FAKE_HERDR_SOCKET);',
      'process.stdin.pipe(socket);',
      'socket.pipe(process.stdout);',
      "socket.on('close', () => process.exit(0));",
    ].join('\n'),
  );
  fs.chmodSync(ssh, 0o755);
  return { ssh, argsFile };
}

const PROFILE: MachineProfile = { id: 'aaa', label: 'hawthorne', target: 'user@hawthorne', session: 'default', enabled: true };

test('a machine client speaks the herdr protocol through the bridge process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-ssh-'));
  const fake = await startFakeHerdr();
  t.after(async () => {
    await fake.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { ssh, argsFile } = fakeSsh(root);
  process.env['FAKE_HERDR_SOCKET'] = fake.socketPath;
  const client = new HerdrClient({ dial: bridgeDialer(PROFILE, ssh), label: 'machine:hawthorne' });

  assert.deepEqual(await client.agentList(), []);
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('BatchMode=yes'), 'ssh never prompts');
  assert.equal(args.at(-2), 'user@hawthorne');
  assert.equal(args.at(-1), bridgeCommand('default'));

  // A subscription works over the same transport.
  const events: string[] = [];
  const controller = new AbortController();
  const subscription = await client.subscribe([{ type: 'pane.exited' }], (event) => events.push(event.event), controller.signal);
  fake.send({ event: 'pane_exited', data: { pane_id: 'w1:p1' } });
  const deadline = Date.now() + 2000;
  while (!events.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ['pane_exited']);
  subscription.close();
});

test('a bridge that fails reports its stderr', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-ssh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ssh } = fakeSsh(root);
  process.env['FAKE_BRIDGE_FAIL'] = '1';
  t.after(() => delete process.env['FAKE_BRIDGE_FAIL']);
  const client = new HerdrClient({ dial: bridgeDialer(PROFILE, ssh) });
  await assert.rejects(client.agentList(), /bridge to machine hawthorne exited with 78: no herdr on this machine can bridge the API/);
});

test('the client pool looks a machine up once, and not again after a failure is fixed', async () => {
  let lookups = 0;
  let saved = false;
  const clientFor = machineClients(new HerdrClient({ socketPath: '/nonexistent' }), async (selector) => {
    lookups += 1;
    if (!saved) throw new Error(`herdr has no saved machine ${selector}`);
    return PROFILE;
  });
  await assert.rejects(clientFor('hawthorne'), /no saved machine/);
  saved = true;
  const first = await clientFor('hawthorne');
  const second = await clientFor('hawthorne');
  assert.equal(first, second);
  assert.equal(lookups, 2);
  assert.equal((await clientFor('local')).socketPath, '/nonexistent');
});
