// Tier 2: agent_spawn's workspace placement against the fake herdr socket.
// A spawn may ask for a new workspace, name an existing one, or name none and
// open in the parent's workspace as before. The child records which
// workspace it is in, and whether Bellwether made it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { parseWorkspaces } from '../../src/core/workspace.ts';
import type { ParentRecord } from '../../src/core/types.ts';
import { startFakeHerdr, type FakeHerdr, type FakeHerdrOptions, type RecordedRequest, harnessStarts, harnessStart } from '../fixtures/fake-herdr.ts';
import { FAKE_KIND } from '../fixtures/fake-harness.ts';

const WORKSPACES = [
  { workspace_id: 'w1', label: 'operator', tab_count: 3 },
  { workspace_id: 'w7', label: 'scratch', tab_count: 1 },
  { workspace_id: 'w8', label: 'twin', tab_count: 1 },
  { workspace_id: 'w9', label: 'twin', tab_count: 1 },
];

/**
 * A fake herdr that keeps its workspaces and tabs, so a test can count what
 * a spawn left behind rather than only the calls it made.
 */
function herdrState(initial = WORKSPACES): { options: FakeHerdrOptions; tabs: Map<string, string[]>; workspaces: Map<string, string> } {
  const workspaces = new Map(initial.map((entry) => [entry.workspace_id, entry.label]));
  const tabs = new Map<string, string[]>(initial.map((entry) => [entry.workspace_id, [`${entry.workspace_id}:t1`]]));
  let next = 20;
  const respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'workspace.list') return { result: { type: 'workspace_list', workspaces: [...workspaces].map(([workspace_id, label]) => ({ workspace_id, label, tab_count: tabs.get(workspace_id)?.length ?? 0 })) } };
    if (request.method === 'workspace.create') {
      const id = `w${next++}`;
      const label = typeof request.params['label'] === 'string' ? request.params['label'] : '1';
      workspaces.set(id, label);
      tabs.set(id, [`${id}:t1`]);
      return { result: { type: 'workspace_created', workspace: { workspace_id: id, label, tab_count: 1 }, tab: { tab_id: `${id}:t1`, workspace_id: id, label: '1' }, root_pane: { pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id } } };
    }
    if (request.method === 'tab.create') {
      const id = typeof request.params['workspace_id'] === 'string' ? request.params['workspace_id'] : 'w1';
      const list = tabs.get(id) ?? [];
      const tab = `${id}:t${list.length + 1}`;
      list.push(tab);
      tabs.set(id, list);
      return { result: { type: 'tab_created', tab: { tab_id: tab, workspace_id: id }, root_pane: { pane_id: `${tab.replace(':t', ':p')}` } } };
    }
    return undefined;
  };
  return { options: { respond }, tabs, workspaces };
}

interface Room {
  herdr: FakeHerdr;
  client: HerdrClient;
  parent: ParentRecord;
  close: () => Promise<void>;
}

async function room(options: FakeHerdrOptions = {}, depth = 0): Promise<Room> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-workspace-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr(options);
  const parent = saveParent(emptyParent('pi', `workspace-${path.basename(home)}`, home, { workspaceId: 'w1', depth }));
  return {
    herdr,
    client: new HerdrClient({ socketPath: herdr.socketPath }),
    parent,
    close: async () => {
      await herdr.stop();
      if (previous === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const methods = (herdr: FakeHerdr): string[] => herdr.requests.map((request) => request.method);

test('workspace "new" creates a workspace labelled after the child, starts the child in its first tab, and leaves no empty shell beside it', async () => {
  const state = herdrState();
  const space = await room(state.options);
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'big-job', workspace: 'new' });
    const create = space.herdr.requests.find((request) => request.method === 'workspace.create');
    assert.ok(create, 'herdr was never asked for a workspace');
    assert.equal(create.params['label'], 'big-job');
    assert.equal((create.params['env'] as Record<string, string>)['BELLWETHER_CHILD'], child.id, 'the root pane carries the child environment');
    assert.ok(!methods(space.herdr).includes('tab.create'), 'a second tab was opened beside the root pane');
    const start = harnessStarts(space.herdr)[0];
    assert.equal(start?.paneId, 'w20:p1', 'the child did not start in the root pane');
    // The shape the operator sees: one tab in the new workspace, and it holds the child.
    assert.deepEqual(state.tabs.get('w20'), ['w20:t1']);
    assert.equal(child.tabId, 'w20:t1');
    const rename = space.herdr.requests.find((request) => request.method === 'tab.rename');
    assert.deepEqual(rename?.params, { tab_id: 'w20:t1', label: 'big-job' });
    const saved = readParent(space.parent.id)?.children[0];
    assert.equal(saved?.workspaceId, 'w20');
    assert.equal(saved?.workspaceLabel, 'big-job');
    assert.equal(saved?.ownsWorkspace, true);
  } finally {
    await space.close();
  }
});

test('workspace "new" takes the label it is given', async () => {
  const state = herdrState();
  const space = await room(state.options);
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'big-job', workspace: 'new', workspaceLabel: 'release train' });
    assert.equal(space.herdr.requests.find((request) => request.method === 'workspace.create')?.params['label'], 'release train');
    assert.equal(child.workspaceLabel, 'release train');
  } finally {
    await space.close();
  }
});

test('a workspace named by id or by label takes a tab there, and Bellwether does not own it', async () => {
  for (const [named, id] of [['w7', 'w7'], ['scratch', 'w7']] as const) {
    const state = herdrState();
    const space = await room(state.options);
    try {
      const { child } = await spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'helper', workspace: named });
      const tab = space.herdr.requests.find((request) => request.method === 'tab.create');
      assert.equal(tab?.params['workspace_id'], id, `${named} did not resolve to ${id}`);
      assert.ok(!methods(space.herdr).includes('workspace.create'));
      assert.equal(child.workspaceId, id);
      assert.equal(child.workspaceLabel, 'scratch');
      assert.equal(child.ownsWorkspace, undefined, `a workspace named ${named} was marked as Bellwether's`);
      // The workspace's own tab is the person's, and stays.
      assert.deepEqual(state.tabs.get(id), [`${id}:t1`, `${id}:t2`]);
    } finally {
      await space.close();
    }
  }
});

test('a workspace that matches nothing, or two by label, is refused by name before anything is written', async () => {
  const state = herdrState();
  const space = await room(state.options);
  try {
    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'helper', workspace: 'nowhere' }), /helper was not started: no workspace on this machine answers to nowhere, by id or by label, and its workspaces are operator \(w1\), scratch \(w7\), twin \(w8\), twin \(w9\)\. Pass workspace "new"/);
    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'helper', workspace: 'twin' }), /2 workspaces on this machine are labelled twin \(w8, w9\)\. Name one by its id\./);
    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'helper', workspace: 'w7', workspaceLabel: 'x' }), /workspace_label names a new workspace/);
    assert.deepEqual(readParent(space.parent.id)?.children, []);
    assert.ok(!methods(space.herdr).some((method) => method === 'tab.create' || method === 'workspace.create' || method === 'agent.start' || method === 'pane.send_input'));
  } finally {
    await space.close();
  }
});

test('with no workspace, the child opens in the parent workspace and herdr is asked nothing new', async () => {
  const space = await room();
  try {
    const { child } = await spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'plain' });
    assert.equal(space.herdr.requests.find((request) => request.method === 'tab.create')?.params['workspace_id'], 'w1');
    assert.ok(!methods(space.herdr).some((method) => method.startsWith('workspace.')), 'a spawn with no workspace asked herdr about workspaces');
    assert.equal(child.workspaceId, 'w1');
    assert.equal(child.ownsWorkspace, undefined);
  } finally {
    await space.close();
  }
});

test('a spawn at max_depth is refused in a new workspace as anywhere else, before herdr is asked anything', async () => {
  const state = herdrState();
  const space = await room(state.options, 2);
  try {
    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'too-deep', workspace: 'new', maxDepth: 2 }), /Bellwether is 2 levels deep already, so too-deep would go one level too far/);
    assert.deepEqual(space.herdr.requests, []);
    assert.deepEqual(readParent(space.parent.id)?.children, []);
  } finally {
    await space.close();
  }
});

test('a spawn that fails in a new workspace closes that workspace, and one that fails in a named workspace closes only its own tab', async () => {
  const refuse = (inner: FakeHerdrOptions): FakeHerdrOptions => ({
    respond: (request) => (harnessStart(request) !== undefined ? { error: { code: 'agent_start_failed', message: 'no such harness' } } : inner.respond?.(request)),
  });
  const state = herdrState();
  const space = await room(refuse(state.options));
  try {
    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'broken', workspace: 'new' }), /no such harness/);
    assert.deepEqual(space.herdr.requests.find((request) => request.method === 'workspace.close')?.params, { workspace_id: 'w20' });
    assert.ok(!methods(space.herdr).includes('tab.close'));

    await assert.rejects(spawnChild(space.client, space.parent, { kind: FAKE_KIND, name: 'broken', workspace: 'scratch' }), /no such harness/);
    const closes = space.herdr.requests.filter((request) => request.method === 'workspace.close');
    assert.equal(closes.length, 1, 'the person\'s workspace was closed');
    assert.deepEqual(space.herdr.requests.find((request) => request.method === 'tab.close')?.params, { tab_id: 'w7:t2' });
  } finally {
    await space.close();
  }
});

test('a remote spawn with "new" creates the workspace on the child\'s machine, and a local workspace id is refused by name', async () => {
  const local = herdrState();
  const remote = herdrState([{ workspace_id: 'w3', label: 'far-scratch', tab_count: 1 }]);
  const space = await room(local.options);
  const far = await startFakeHerdr(remote.options);
  const farClient = new HerdrClient({ socketPath: far.socketPath });
  const localWorkspaces = async (): Promise<ReturnType<typeof parseWorkspaces>> => parseWorkspaces(await space.client.workspaceList());
  // The child's machine writes its server's configuration there.
  const registerRemote = async (): Promise<{ mcpConfig: string }> => ({ mcpConfig: '/far/mcp.json' });
  try {
    const { child } = await spawnChild(farClient, space.parent, { kind: FAKE_KIND, name: 'far-job', host: 'example-box', workspace: 'new' }, undefined, { localWorkspaces, registerRemote });
    assert.ok(methods(far).includes('workspace.create'), 'the workspace was not created on the child\'s machine');
    assert.ok(!methods(space.herdr).includes('workspace.create'), 'a workspace was created on the parent\'s machine');
    assert.equal(child.workspaceId, 'w20');
    assert.equal(child.ownsWorkspace, true);

    await assert.rejects(
      spawnChild(farClient, space.parent, { kind: FAKE_KIND, name: 'far-job-2', host: 'example-box', workspace: 'w7' }, undefined, { localWorkspaces, registerRemote }),
      /far-job-2 was not started: w7 is a workspace on this machine \(scratch\), and a workspace id from this machine means nothing to the herdr on machine example-box, where the child runs\. Pass workspace "new" to give the child a workspace of its own on example-box, or name a workspace there: its workspaces are far-scratch \(w3\), far-job \(w20\)\./,
    );
    // A workspace on the child's machine, by label, is fine.
    const named = await spawnChild(farClient, space.parent, { kind: FAKE_KIND, name: 'far-job-3', host: 'example-box', workspace: 'far-scratch' }, undefined, { localWorkspaces, registerRemote });
    assert.equal(named.child.workspaceId, 'w3');
  } finally {
    await far.stop();
    await space.close();
  }
});
