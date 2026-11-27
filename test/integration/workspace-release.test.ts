// Tier 2: what happens to a child's workspace when the child exits or is
// stopped. Bellwether closes a workspace it made for the child once nothing
// is left in it, keeps one that still holds another tab, and never touches a
// workspace a person made, even an empty one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { runBellwetherTool } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';

const PANE = 'w5:p1';
const TAB = 'w5:t1';
const WORKSPACE = 'w5';

async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface World {
  herdr: FakeHerdr;
  client: HerdrClient;
  parentId: string;
  /** The tabs herdr still lists in the child's workspace once the child's own tab is gone. */
  others: string[];
  watcher(): Watcher;
}

async function world(t: test.TestContext, child: Partial<ChildRecord>, others: string[]): Promise<World> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-release-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  let paneLive = true;
  const list = (): Record<string, unknown>[] => (paneLive ? [{ pane_id: PANE, tab_id: TAB, workspace_id: WORKSPACE, agent: 'codex', agent_status: 'idle' }] : []);
  const herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: list() } };
      if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: list(), agents: list() } } };
      if (request.method === 'tab.close') paneLive = false;
      if (request.method === 'tab.list') return { result: { type: 'tab_list', tabs: [...(paneLive ? [TAB] : []), ...others].map((tab_id) => ({ tab_id, workspace_id: WORKSPACE })) } };
      return undefined;
    },
  });
  const long = new Date(Date.now() - 60_000).toISOString();
  const parent = emptyParent('claude-code', `release-${path.basename(home)}`, '/work', { paneId: 'w1:p1', workspaceId: 'w1' });
  parent.children.push({ id: 'c-room', name: 'roomy', kind: 'codex', harness: 'other', paneId: PANE, tabId: TAB, host: 'local', origin: 'spawn', startedAt: long, lastStatus: 'idle', statusChangedAt: long, lastBusyAt: long, depth: 1, workspaceId: WORKSPACE, ...child });
  saveParent(parent);
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  const watchers: Watcher[] = [];
  t.after(async () => {
    for (const watcher of watchers) watcher.stop();
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    herdr,
    client,
    parentId: parent.id,
    others,
    watcher() {
      const watcher = new Watcher({ client, parentId: parent.id, onEntries: () => {}, tickMs: 60_000, screenPollMs: 0 });
      watchers.push(watcher);
      return watcher;
    },
  };
}

/** herdr closes the child's tab with its pane, then the watcher hears the pane go. */
async function exitsWithTabGone(w: World): Promise<void> {
  await w.client.tabClose(TAB);
  await exits(w);
}

const closes = (herdr: FakeHerdr): unknown[] => herdr.requests.filter((request) => request.method === 'workspace.close').map((request) => request.params['workspace_id']);

/** The child's pane exits, herdr closes its tab, and the watcher marks it exited. */
async function exits(w: World): Promise<void> {
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE } });
  await until('the exit', () => Boolean(readParent(w.parentId)?.children[0]?.exitedAt));
  await watcher.retirements();
}

test('a child that exits leaves its own workspace empty, and Bellwether closes it', async (t) => {
  // herdr would have closed it with the last tab; an empty one left behind is closed here.
  const w = await world(t, { ownsWorkspace: true }, []);
  await exitsWithTabGone(w);
  await until('the workspace close', () => closes(w.herdr).length > 0);
  assert.deepEqual(closes(w.herdr), [WORKSPACE]);
});

test('a workspace Bellwether made that still holds another tab stays open when its child exits', async (t) => {
  const w = await world(t, { ownsWorkspace: true }, ['w5:t2']);
  await exitsWithTabGone(w);
  await until('the tab check', () => w.herdr.requests.some((request) => request.method === 'tab.list'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(closes(w.herdr), []);
});

test('a workspace a person made is never closed, even when it is empty', async (t) => {
  const w = await world(t, {}, []);
  await exitsWithTabGone(w);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(closes(w.herdr), []);
  assert.ok(!w.herdr.requests.some((request) => request.method === 'tab.list'), 'Bellwether looked into a workspace it does not own');
});

test('agent_stop closes the child\'s tab, then the workspace Bellwether made once it is empty, and says when another tab keeps it', async (t) => {
  const alone = await world(t, { ownsWorkspace: true, workspaceLabel: 'roomy' }, []);
  const text = await runBellwetherTool({ client: alone.client, parentId: alone.parentId, watcher: alone.watcher() }, 'agent_stop', { child: 'roomy' });
  assert.equal(text, 'Closed roomy.');
  assert.deepEqual(closes(alone.herdr), [WORKSPACE]);

  const shared = await world(t, { ownsWorkspace: true, workspaceLabel: 'roomy' }, ['w5:t2']);
  const kept = await runBellwetherTool({ client: shared.client, parentId: shared.parentId, watcher: shared.watcher() }, 'agent_stop', { child: 'roomy' });
  assert.equal(kept, 'Closed roomy. Its workspace w5 (roomy) stays open, because it still holds another tab.');
  assert.deepEqual(closes(shared.herdr), []);

  const persons = await world(t, {}, []);
  await runBellwetherTool({ client: persons.client, parentId: persons.parentId, watcher: persons.watcher() }, 'agent_stop', { child: 'roomy' });
  assert.deepEqual(closes(persons.herdr), []);
});

test('agent_list names each child\'s workspace, and marks one Bellwether made for it', async (t) => {
  const w = await world(t, { ownsWorkspace: true, workspaceLabel: 'roomy' }, []);
  const parent = readParent(w.parentId);
  assert.ok(parent);
  parent.children.push({ ...(parent.children[0] as ChildRecord), id: 'c-plain', name: 'plain', paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1', workspaceLabel: undefined, ownsWorkspace: undefined });
  saveParent(parent);
  const text = await runBellwetherTool({ client: w.client, parentId: w.parentId, watcher: w.watcher() }, 'agent_list', {});
  const [header, roomy, plain] = text.split('\n');
  assert.equal(header, 'name\tkind\troute\tstate\tage\thost\tworkspace\tpane\tdepth\tunread\tcwd');
  assert.equal(roomy?.split('\t')[6], 'w5 (roomy) [made for it]');
  assert.equal(plain?.split('\t')[6], 'w1');
});

test('an exit that arrives twice, from the reconcile and then from pane_closed, is handled once', async (t) => {
  const w = await world(t, { ownsWorkspace: true }, []);
  await w.client.tabClose(TAB);
  const watcher = w.watcher();
  watcher.start();
  await w.herdr.waitFor('events.subscribe');
  // The reconcile finds the pane gone first; the event for the same exit lands after it.
  await until('the exit', () => Boolean(readParent(w.parentId)?.children[0]?.exitedAt));
  await until('the workspace close', () => closes(w.herdr).length > 0);
  w.herdr.send({ event: 'pane_closed', data: { pane_id: PANE } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await watcher.retirements();
  assert.deepEqual(closes(w.herdr), [WORKSPACE], 'the workspace was closed once');
  assert.equal(w.herdr.requests.filter((request) => request.method === 'tab.list').length, 1, 'the release ran once');
});
