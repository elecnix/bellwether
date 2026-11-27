// Tier 3: the OpenCode drill, against a real OpenCode 2 under a real herdr
// server of the lab's own. The spawn starts OpenCode in a lab pane, and herdr
// has to detect it as an opencode agent. The session the spawn minted has to
// appear in OpenCode's store with the brief's prompt. A model then has to read
// the brief through OpenCode, and call parent_report through the Bellwether
// MCP server the child's configuration starts: the report has to land in the
// parent's spool with the word only the brief holds. Last, agent_read has to
// return the child's answer from the store, without reading the screen.
//
// A model has to answer, and OpenCode 2.4.2's terminal UI picks its own: in
// the lab's empty home, with every provider key stripped from the lab's
// environment, that is OpenCode's free hosted model. A config-defined provider
// pointed at the lab's scripted endpoint answers `opencode run`, but the
// terminal UI does not offer it. So the case calls OpenCode's free service,
// with the brief and a temporary path, and runs only when asked:
//
//   BELLWETHER_OPENCODE_DRILL=1 PATH=/path/to/opencode2/bin:$PATH npm run test:lab
//
// It skips without that variable, without herdr, and without an OpenCode 2 on
// PATH, so CI stays green.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { openCodeLastMessage, openCodeSessionState, probeOpenCode } from '../../src/core/opencode.ts';
import { spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { daemonsUnder, stopDaemonsUnder } from '../fixtures/daemons.ts';
import { hasHerdr, startLab } from './herdr-lab.ts';
import { shownScreen } from '../../src/core/screen.ts';

const probe = await probeOpenCode();
const skip =
  process.env['BELLWETHER_OPENCODE_DRILL'] !== '1'
    ? 'the OpenCode drill calls OpenCode\'s free model; set BELLWETHER_OPENCODE_DRILL=1 to run it'
    : !(await hasHerdr())
      ? 'herdr is not on PATH'
      : probe.version === undefined
        ? `no OpenCode 2 on PATH: ${probe.missing ?? probe.unreadable}`
        : !probe.version.startsWith('2.')
          ? `OpenCode ${probe.version} is not OpenCode 2`
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

test('the OpenCode drill: a real OpenCode 2 gets its brief, reports to its parent, and agent_read returns its answer', { skip, timeout: 300_000 }, async (t) => {
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

  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const db = path.join(root, 'opencode-store', 'opencode.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const created = (await herdr.request('workspace.create', { cwd, label: 'opencode-lab', focus: false })) as { workspace?: { workspace_id?: string } };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId, 'the lab created a workspace');
  const parentId = saveParent(emptyParent('claude-code', `opencode-lab-${path.basename(root)}`, cwd, { workspaceId })).id;

  const prompt = 'The drill word is heron. Call the parent_report tool with status done and the text "The drill word is heron." Then answer with one sentence that says you reported it.';
  const { child } = await spawnChild(herdr, readParent(parentId)!, { kind: 'opencode', name: 'oc-lab', prompt, cwd }, undefined, { harness: { store: db, waitMs: 90_000 } });
  paneId = child.paneId;

  // herdr detects OpenCode 2, and reports no session for it.
  const agent = (await herdr.request('agent.get', { target: child.paneId })) as { agent?: Record<string, unknown> };
  assert.equal(agent.agent?.['agent'], 'opencode', `herdr detected ${String(agent.agent?.['agent'])} in the pane`);
  console.log(`herdr reports agent_session ${JSON.stringify(agent.agent?.['agent_session'] ?? null)} for OpenCode ${probe.version ?? ''}`);

  // The session the spawn minted is in the store, top-level, in the child's directory, from OpenCode 2.
  const store = new DatabaseSync(db, { readOnly: true });
  try {
    const row = store.prepare('SELECT parent_id, directory, version FROM session_v2 WHERE id = ?').get(child.session?.value ?? '') as { parent_id: string | null; directory: string; version: string } | undefined;
    assert.ok(row, 'the store holds the minted session');
    assert.equal(row.parent_id, null);
    assert.equal(fs.realpathSync(row.directory), fs.realpathSync(cwd));
    assert.match(row.version, /^2\./);
  } finally {
    store.close();
  }

  // The brief arrived and the report went through the child's MCP server: the
  // parent's spool holds a done report with the word only the brief holds.
  const report = await until(() => spooled(parentId, child.id), 'the parent_report in the parent\'s spool', 180_000).catch(async (error: unknown) => {
    console.log(`pane:\n${await herdr.paneRead({ paneId: child.paneId, source: 'recent_unwrapped', lines: 40 }).then(shownScreen).catch(() => '')}`);
    throw error;
  });
  assert.equal(report.status, 'done');
  assert.match(report.text ?? '', /heron/);
  console.log(`report: ${report.status}: ${report.text}`);

  // Once the store says the turn ended, agent_read returns the final answer
  // from the store, which mentions the report, and reads no screen for it.
  const ended = await until(() => {
    const state = openCodeSessionState(db, child.session?.value ?? '');
    return state && !state.busy && state.outcome ? state : undefined;
  }, 'the turn to end in the store', 120_000);
  assert.equal(ended.outcome, 'succeeded');
  const ctx = { client: herdr, clientFor: async () => herdr, parentId, watcher: new Watcher({ client: herdr, parentId, onEntries: () => {} }) };
  const read = await runBellwetherTool(ctx, 'agent_read', { child: child.name }, {});
  assert.equal(read, openCodeLastMessage(db, child.session?.value ?? ''));
  assert.match(read, /report/i);
  console.log(`agent_read: ${read}`);
});
