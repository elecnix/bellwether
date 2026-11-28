// Two fake machines for a case that carries a child between them. This
// process is the parent's machine, with its own Bellwether home and harness
// directories, and `box` is a second home in the same temporary root, reached
// through the fake ssh, which runs this checkout's CLI there. Each machine has
// its own fake herdr socket, and fake `claude` and `pi` binaries that answer
// from that machine's harness directory, so each machine can have its own
// versions and models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST, type ClientFor } from '../../src/core/machine.ts';
import { moveEndpoints, type EndpointFor } from '../../src/core/move-endpoint.ts';
import { emptyParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { remoteOps } from '../../src/core/remote.ts';
import { findBinaries } from '../../src/core/session-state.ts';
import type { RegisterRemote } from '../../src/core/spawn.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from './fake-herdr.ts';
import { fakeWorld, type FakeWorld } from './fake-world.ts';
import { installFakeSsh, type FakeSsh } from './fake-ssh.ts';
import { LIVE_HOME } from './isolation.ts';

export interface Machine {
  /** That machine's HOME. */
  user: string;
  /** Its Bellwether home. */
  home: string;
  /** Its Claude Code and pi state roots. */
  claude: string;
  pi: string;
  herdr: FakeHerdr;
  world: FakeWorld;
  client: HerdrClient;
}

/** What a carry between the two machines needs from them, as agent_move and agent_teleport take it. */
export interface MachineDeps {
  clientFor: ClientFor;
  endpointFor: EndpointFor;
  knownHosts: () => Promise<string[]>;
  registerRemote: RegisterRemote;
  cleanupRemote: (child: ChildRecord) => Promise<void>;
  startupTimeoutMs: number;
  redrawMs: number;
}

export interface TwoMachines {
  root: string;
  here: Machine;
  box: Machine;
  ssh: FakeSsh;
  parentId: string;
  deps: MachineDeps;
}

const FAKE_CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ ! -f "$dir/fake-version" ]; then echo "claude: not installed on this machine" >&2; exit 127; fi
echo "$(cat "$dir/fake-version") (Claude Code)"
`;

const FAKE_PI = `#!/bin/sh
dir="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ ! -f "$dir/fake-version" ]; then echo "pi: not installed on this machine" >&2; exit 127; fi
case "$1" in
  --version) cat "$dir/fake-version" ;;
  --list-models) printf 'provider  model  context\\n'; cat "$dir/fake-models" 2>/dev/null ;;
esac
`;

export type Respond = (world: FakeWorld, request: RecordedRequest) => ReturnType<FakeWorld['respond']>;

/** Run `fn` with this process's Bellwether home pointed at another machine's. */
export function inHome<T>(home: string, fn: () => T): T {
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['BELLWETHER_HOME'] = previous;
  }
}

async function machine(t: test.TestContext, root: string, name: string, workspace: string, respond?: Respond): Promise<Machine> {
  const user = path.join(root, name);
  const home = path.join(user, '.bellwether');
  fs.mkdirSync(home, { recursive: true });
  const world = fakeWorld(workspace);
  const herdr = await startFakeHerdr({ respond: (request) => respond?.(world, request) ?? world.respond(request) });
  world.emit = (frame) => herdr.send(frame);
  t.after(() => herdr.stop());
  return { user, home, claude: path.join(user, '.claude'), pi: path.join(user, '.pi', 'agent'), herdr, world, client: new HerdrClient({ socketPath: herdr.socketPath }) };
}

/** This machine and `box`, joined by the fake ssh, with a parent on this machine. */
export async function twoMachines(t: test.TestContext, respond: { here?: Respond; box?: Respond } = {}): Promise<TwoMachines> {
  // Under /tmp, because macOS caps a Unix socket path at 104 bytes.
  const root = fs.mkdtempSync('/tmp/bw-two-');
  assert.ok(!root.startsWith(LIVE_HOME));
  const here = await machine(t, root, 'here', 'w1', respond.here);
  const box = await machine(t, root, 'box', 'w9', respond.box);
  const ssh = installFakeSsh(t, root, { box: { home: box.home, userHome: box.user } });
  const bin = path.join(root, 'harness-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pi'), FAKE_PI, { mode: 0o755 });
  // node alone, not the directory it was installed in: npm puts a global
  // claude or pi beside node, and that real harness would answer the probe.
  const nodeBin = path.join(root, 'node-bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const keys = ['HOME', 'BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PATH', 'BELLWETHER_HARNESS_DIRS'] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env['BELLWETHER_HOME'] = here.home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(here.home, 'daemon.sock');
  process.env['CLAUDE_CONFIG_DIR'] = here.claude;
  process.env['PI_CODING_AGENT_DIR'] = here.pi;
  delete process.env['PI_CODING_AGENT_SESSION_DIR'];
  // Only the fake harnesses, the fake ssh and node: a real claude or pi on this
  // machine would answer for both fake machines, which share one filesystem.
  process.env['HOME'] = here.user;
  process.env['PATH'] = [bin, ssh.dir, nodeBin, '/usr/bin', '/bin'].join(path.delimiter);
  // The probe also tries the usual install places, such as Homebrew's, which PATH does not reach. Ask it for none.
  process.env['BELLWETHER_HARNESS_DIRS'] = '';
  for (const name of ['claude', 'pi']) {
    const found = findBinaries(name);
    assert.deepEqual(found, [path.join(bin, name)], `a ${name} outside the test's own fakes is reachable, so a case that needs it missing cannot pass: ${found.join(', ')}`);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const parentId = saveParent(emptyParent('claude-code', 'mover', '/work', { workspaceId: 'w1' })).id;
  const resolve = async (label: string) => {
    if (label !== 'box') throw new Error(`herdr has no saved machine ${label}`);
    return { id: label, label, target: label, session: 'default', enabled: true };
  };
  const remote = remoteOps(resolve);
  const deps: MachineDeps = {
    clientFor: async (host) => {
      if (host === LOCAL_HOST) return here.client;
      if (host === 'box') return box.client;
      throw new Error(`herdr has no saved machine ${host}`);
    },
    endpointFor: moveEndpoints(resolve),
    knownHosts: async () => [LOCAL_HOST, 'box'],
    registerRemote: (child, brief) => remote.register({ id: parentId }, child, brief),
    cleanupRemote: (child) => remote.cleanup(child),
    startupTimeoutMs: 5_000,
    redrawMs: 20,
  };
  return { root, here, box, ssh, parentId, deps };
}

/** Install the fake harnesses on a machine, at the versions given, with pi's models. */
export function harness(m: Machine, versions: { claude?: string; pi?: string; models?: string[] }): void {
  if (versions.claude) {
    fs.mkdirSync(m.claude, { recursive: true });
    fs.writeFileSync(path.join(m.claude, 'fake-version'), versions.claude);
  }
  if (versions.pi) {
    fs.mkdirSync(m.pi, { recursive: true });
    fs.writeFileSync(path.join(m.pi, 'fake-version'), versions.pi);
    fs.writeFileSync(path.join(m.pi, 'fake-models'), (versions.models ?? []).map((pair) => `${pair.replace('/', '  ')}  1.0M\n`).join(''));
  }
}

export function dir(...parts: string[]): string {
  const full = path.join(...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

export function childRecord(extra: Partial<ChildRecord>): ChildRecord {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'child-worker', name: 'worker', kind: 'claude', harness: 'claude-code', paneId: 'w1:p3', tabId: 'w1:t3', host: LOCAL_HOST, startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, ...extra };
}

export const TRANSCRIPT = ['{"type":"user","version":"2.1.300","message":{"role":"user","content":"start"}}', '{"type":"assistant","version":"2.1.300","message":{"role":"assistant","content":"working on it"}}', ''].join('\n');

/**
 * A Claude Code child on this machine with a transcript and a tool result
 * beside it: idle in pane w1:p3, or stopped, with its pane gone, when `stopped`.
 */
export function claudeHere(w: TwoMachines, cwd: string, options: { stopped?: boolean; extra?: Partial<ChildRecord> } = {}): { file: string; side: string } {
  const project = path.join(w.here.claude, 'projects', claudeProjectDir(fs.realpathSync(cwd)));
  const file = path.join(project, 'sess-1.jsonl');
  fs.mkdirSync(path.join(project, 'sess-1', 'tool-results'), { recursive: true });
  fs.writeFileSync(file, TRANSCRIPT);
  const side = path.join(project, 'sess-1', 'tool-results', 'out.txt');
  fs.writeFileSync(side, 'a long tool result\n');
  if (!options.stopped) w.here.world.add({ pane_id: 'w1:p3', tab_id: 'w1:t3', agent: 'claude', name: 'worker', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-1' } });
  const stopped = options.stopped ? { exitedAt: new Date(Date.now() - 60_000).toISOString(), lastStatus: 'done' as const } : {};
  upsertChild(w.parentId, childRecord({ cwd, session: { kind: 'id', value: 'sess-1' }, transcript: file, ...stopped, ...options.extra }));
  return { file, side };
}
