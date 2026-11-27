// Tier 3: the kilo drill, against a real Kilo CLI 7 under a real herdr server
// of the lab's own. The spawn starts kilo in a lab pane, and herdr has to
// detect it as a kilo agent. The spawn has to find the session in kilo's store
// by the child's directory, its start time and the brief's prompt. A model
// then has to read the brief through kilo, and call parent_report through the
// Bellwether MCP server that KILO_CONFIG starts: the report has to land in the
// parent's spool with the word only the brief holds. Last, agent_read has to
// return the child's answer from the store, without reading the screen.
//
// A model has to answer. In the lab's empty home, with every provider key
// stripped from the lab's environment, kilo picks the Kilo Gateway's free
// anonymous model. So the case calls that service, with the brief and a
// temporary path, and runs only when asked, with the native binary first on
// PATH under the name kilo (herdr does not detect npm's Node launcher):
//
//   BELLWETHER_KILO_DRILL=1 PATH=/path/to/native-kilo-dir:$PATH npm run test:lab
//
// It skips without that variable, without herdr, and without a native Kilo
// CLI 7 on PATH, so CI stays green.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { kiloLastMessage, kiloSessionState, probeKilo } from '../../src/core/harnesses/kilo-store.ts';
import { spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { hasHerdr, startLab } from './herdr-lab.ts';

const probe = await probeKilo();
const skip =
  process.env['BELLWETHER_KILO_DRILL'] !== '1'
    ? 'the kilo drill calls the Kilo Gateway\'s free model; set BELLWETHER_KILO_DRILL=1 to run it'
    : !(await hasHerdr())
      ? 'herdr is not on PATH'
      : probe.version === undefined
        ? `no Kilo CLI on PATH: ${probe.missing ?? probe.unreadable}`
        : probe.launcher
          ? `kilo on PATH is npm's launcher ${probe.launcher}, which herdr does not detect`
          : !probe.version.startsWith('7.')
            ? `Kilo CLI ${probe.version} is not Kilo CLI 7`
            : false;

async function until<T>(probeFn: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probeFn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

interface SpoolEntry {
  childId?: string;
  status?: string;
  text?: string;
}

function spooled(parentId: string, childId: string): SpoolEntry | undefined {
  let content: string;
  try {
    content = fs.readFileSync(spoolPath(parentId), 'utf8');
  } catch {
    return undefined;
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpoolEntry)
    .find((entry) => entry.childId === childId);
}

test('the kilo drill: a real Kilo CLI 7 gets its brief, reports to its parent, and agent_read returns its answer', { skip, timeout: 300_000 }, async (t) => {
  // The child's MCP server starts a daemon for the home its pane inherits, so
  // the case gets a home of its own, set before the lab herdr starts, and the
  // cleanup stops whatever daemon that server started there.
  const root = fs.mkdtempSync('/tmp/bw-klo-');
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

  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const db = path.join(root, 'kilo-store', 'kilo.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const created = (await herdr.request('workspace.create', { cwd, label: 'kilo-lab', focus: false })) as { workspace?: { workspace_id?: string } };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId, 'the lab created a workspace');
  const parentId = saveParent(emptyParent('claude-code', `kilo-lab-${path.basename(root)}`, cwd, { workspaceId })).id;

  const prompt = 'The drill word is heron. Call the parent_report tool with status done and the text "The drill word is heron." Then answer with one sentence that says you reported it.';
  const { child } = await spawnChild(herdr, readParent(parentId)!, { kind: 'kilo', name: 'kilo-lab', prompt, cwd }, undefined, { harness: { store: db, waitMs: 90_000 } });
  paneId = child.paneId;

  // herdr detects the native kilo binary.
  const agent = (await herdr.request('agent.get', { target: child.paneId })) as { agent?: Record<string, unknown> };
  assert.equal(agent.agent?.['agent'], 'kilo', `herdr detected ${String(agent.agent?.['agent'])} in the pane`);
  console.log(`herdr reports agent_session ${JSON.stringify(agent.agent?.['agent_session'] ?? null)} for Kilo CLI ${probe.version ?? ''}`);

  // The session the store showed is top-level, in the child's directory, from Kilo CLI 7.
  assert.match(child.session?.value ?? '', /^ses_/);
  const store = new DatabaseSync(db, { readOnly: true });
  try {
    const row = store.prepare('SELECT parent_id, directory, version FROM session WHERE id = ?').get(child.session?.value ?? '') as { parent_id: string | null; directory: string; version: string } | undefined;
    assert.ok(row, 'the store holds the session the spawn recorded');
    assert.equal(row.parent_id, null);
    assert.equal(fs.realpathSync(row.directory), fs.realpathSync(cwd));
    assert.match(row.version, /^7\./);
  } finally {
    store.close();
  }

  // The brief arrived and the report went through the child's MCP server: the
  // parent's spool holds a done report with the word only the brief holds.
  const report = await until(() => spooled(parentId, child.id), 'the parent_report in the parent\'s spool', 180_000).catch(async (error: unknown) => {
    console.log(`pane:\n${await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).catch(() => '')}`);
    throw error;
  });
  assert.equal(report.status, 'done');
  assert.match(report.text ?? '', /heron/);
  console.log(`report: ${report.status}: ${report.text}`);

  // Once the store says the turn ended, agent_read returns the final answer
  // from the store, which mentions the report, and reads no screen for it.
  await until(() => {
    const state = kiloSessionState(db, child.session?.value ?? '');
    return state && !state.busy && kiloLastMessage(db, child.session?.value ?? '') ? state : undefined;
  }, 'the turn to end in the store', 120_000);
  const ctx = { client: herdr, clientFor: async () => herdr, parentId, watcher: new Watcher({ client: herdr, parentId, onEntries: () => {} }) };
  const read = await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {});
  assert.equal(read, kiloLastMessage(db, child.session?.value ?? ''));
  console.log(`agent_read: ${read}`);
});
