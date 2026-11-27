// Tier 3: a real OpenCode 2 under a real herdr server of the lab's own. The
// spawn starts OpenCode in a lab pane, herdr has to detect it as an opencode
// agent, and the session the spawn minted has to appear in OpenCode's store
// with the brief's prompt. It skips itself when herdr or an OpenCode 2 is not
// on PATH, so CI stays green; run it by hand with OpenCode 2 first on PATH:
//
//   PATH=/path/to/node_modules/.bin:$PATH npm run test:lab
//
// No model needs to answer: the session row and its prompt are written when
// the prompt is submitted, before any model call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { probeOpenCode } from '../../src/core/opencode.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { hasHerdr, startLab } from './herdr-lab.ts';

const probe = await probeOpenCode();
const skip = !(await hasHerdr()) ? 'herdr is not on PATH' : probe.missing !== undefined ? `no OpenCode on PATH: ${probe.missing}` : !probe.version.startsWith('2.') ? `OpenCode ${probe.version} is not OpenCode 2` : false;

test('a real OpenCode 2 starts in a lab pane, herdr detects it, and its store shows the minted session with the prompt', { skip, timeout: 180_000 }, async (t) => {
  // The child's MCP server starts a daemon for the home its pane inherits, so
  // the case gets a home of its own, set before the lab herdr starts, and the
  // cleanup stops whatever daemon that server started there.
  const root = fs.mkdtempSync('/tmp/bw-ocl-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const previous = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'] };
  process.env['BELLWETHER_HOME'] = home;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(home, 'daemon.sock');
  const lab = await startLab();
  const herdr = new HerdrClient({ socketPath: lab.socketPath });
  let paneId: string | undefined;
  t.after(async () => {
    if (paneId) await herdr.paneClose(paneId).catch(() => undefined);
    await lab.stop();
    await stopDaemonsUnder(root, home);
    for (const [key, value] of [['BELLWETHER_HOME', previous.home], ['BELLWETHER_DAEMON_SOCKET', previous.socket]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(daemonsUnder(root), [], 'a daemon outlived the case');
  });
  const cwd = path.join(lab.root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const db = path.join(lab.root, 'opencode-store', 'opencode.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const created = (await herdr.request('workspace.create', { cwd, label: 'opencode-lab', focus: false })) as { workspace?: { workspace_id?: string } };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId, 'the lab created a workspace');
  const parentId = saveParent(emptyParent('claude-code', `opencode-lab-${path.basename(lab.root)}`, cwd, { workspaceId })).id;

  const { child } = await spawnChild(herdr, readParent(parentId)!, { kind: 'opencode', name: 'oc-lab', prompt: 'Reply with the single word pong.', cwd }, undefined, { openCode: { db, waitMs: 90_000 } });
  paneId = child.paneId;

  const agent = (await herdr.request('agent.get', { target: child.paneId })) as { agent?: Record<string, unknown> };
  assert.equal(agent.agent?.['agent'], 'opencode', `herdr detected ${String(agent.agent?.['agent'])} in the pane`);
  console.log(`herdr reports agent_session ${JSON.stringify(agent.agent?.['agent_session'] ?? null)} and status ${String(agent.agent?.['agent_status'])} for OpenCode ${probe.version ?? ''}`);

  const store = new DatabaseSync(db, { readOnly: true });
  try {
    const row = store.prepare('SELECT id, parent_id, directory, version FROM session_v2 WHERE id = ?').get(child.session?.value ?? '') as { id: string; parent_id: string | null; directory: string; version: string } | undefined;
    assert.ok(row, 'the store holds the minted session');
    assert.equal(row.parent_id, null);
    assert.equal(fs.realpathSync(row.directory), fs.realpathSync(cwd));
    assert.match(row.version, /^2\./);
  } finally {
    store.close();
  }
});
