// Lifecycle.tla, LiveWorkspaceKept (issue #211). Trace: OwnerCloses, RelList,
// SpawnInto, RelClose. herdr keeps the workspace after its last tab closes, and
// a child that comes back to it opens a tab between the release's tab list and
// its close. The close must never reach a workspace that holds that tab.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HerdrApiError, type HerdrClient } from '../../src/core/herdr-client.ts';
import { openReturnTab, releaseWorkspace, returnPlacement } from '../../src/core/workspace.ts';

const WS = 'w5';

/** A herdr that keeps an empty workspace, holds the requests the test gates, and logs each one. */
function keepingHerdr(socketPath: string) {
  const tabs = new Map<string, string[]>([[WS, []]]);
  const calls: string[] = [];
  let nextTab = 1;
  const gate = () => {
    let reach!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { reached, open, wait: async () => { reach(); await opened; } };
  };
  const held = new Map<string, () => Promise<void>>();
  const pass = async (method: string) => {
    const wait = held.get(method);
    if (wait) {
      held.delete(method);
      await wait();
    }
  };
  const client = {
    socketPath,
    async workspaceList() {
      calls.push('workspace.list');
      return [...tabs.keys()].map((id) => ({ workspace_id: id, label: 'feat-x', tab_count: tabs.get(id)!.length }));
    },
    async tabList(workspaceId: string) {
      calls.push(`tab.list ${workspaceId}`);
      // herdr answers what the workspace held when it read it, however late the answer arrives.
      const listed = tabs.get(workspaceId)?.map((tab_id) => ({ tab_id, workspace_id: workspaceId }));
      await pass('tab.list');
      if (!listed) throw new HerdrApiError('workspace_not_found', `no workspace ${workspaceId}`);
      return listed;
    },
    async workspaceClose(workspaceId: string) {
      const holding = tabs.get(workspaceId) ?? [];
      calls.push(`workspace.close ${workspaceId}${holding.length ? ` holding ${holding.join(',')}` : ''}`);
      if (!tabs.has(workspaceId)) throw new HerdrApiError('workspace_not_found', `no workspace ${workspaceId}`);
      tabs.delete(workspaceId);
    },
    async tabCreate(request: { workspaceId?: string }) {
      await pass('tab.create');
      const id = request.workspaceId ?? WS;
      calls.push(`tab.create ${id}`);
      if (!tabs.has(id)) throw new HerdrApiError('workspace_not_found', `no workspace ${id}`);
      const tabId = `${id}:t${nextTab++}`;
      tabs.get(id)!.push(tabId);
      return { tabId, paneId: `${id}:p${nextTab}` };
    },
    async workspaceCreate(request: { label: string }) {
      const id = `w${10 + nextTab}`;
      const tabId = `${id}:t${nextTab++}`;
      tabs.set(id, [tabId]);
      calls.push(`workspace.create ${id}`);
      return { workspaceId: id, tabId, paneId: `${id}:p1`, label: request.label };
    },
    async tabRename() {},
  };
  return {
    client: client as unknown as HerdrClient,
    tabs,
    calls,
    /** Hold the next request of `method` until the returned `open` runs. */
    hold(method: string) {
      const g = gate();
      held.set(method, g.wait);
      return g;
    },
  };
}

const child = { name: 'feat-x', workspaceId: WS, workspaceLabel: 'feat-x', ownsWorkspace: true };
const tab = { cwd: '/work/x', label: 'feat-x', env: {}, focus: false };

test('a child that comes back while its workspace is released opens in a live workspace, and the close never reaches its tab', async () => {
  const herdr = keepingHerdr('/tmp/herdr-turn-a.sock');
  const listing = herdr.hold('tab.list');
  // OwnerCloses has happened: the workspace is empty, and the release lists its tabs.
  const release = releaseWorkspace(herdr.client, child);
  await listing.reached;
  // SpawnInto: a resume reads the workspace as live and opens its tab there.
  const placement = await returnPlacement(herdr.client, child, undefined);
  assert.equal(placement.mode, 'existing', 'herdr still lists the empty workspace');
  const opening = openReturnTab(herdr.client, placement, tab, child.workspaceLabel);
  listing.open();
  const [released, opened] = await Promise.all([release, opening]);

  assert.deepEqual(herdr.calls.filter((call) => call.includes(' holding ')), [], `workspace.close reached a workspace that held a tab: ${herdr.calls.join('; ')}`);
  assert.ok(herdr.tabs.get(opened.workspaceId!)?.includes(opened.tabId!), `the child's tab ${opened.tabId} is not in a live workspace: ${herdr.calls.join('; ')}`);
  assert.equal(released, 'closed');
  assert.equal(opened.ownsWorkspace, true, 'the child came back in a new workspace of its own');
});

test('a tab that opens before the release lists the workspace keeps it', async () => {
  const herdr = keepingHerdr('/tmp/herdr-turn-b.sock');
  const creating = herdr.hold('tab.create');
  const placement = await returnPlacement(herdr.client, child, undefined);
  const opening = openReturnTab(herdr.client, placement, tab, child.workspaceLabel);
  await creating.reached;
  const release = releaseWorkspace(herdr.client, child);
  creating.open();
  const [opened, released] = await Promise.all([opening, release]);

  assert.equal(released, 'kept', herdr.calls.join('; '));
  assert.equal(opened.workspaceId, WS);
  assert.ok(herdr.tabs.get(WS)?.includes(opened.tabId!));
  assert.ok(!herdr.calls.some((call) => call.startsWith('workspace.close')), herdr.calls.join('; '));
});

test('the same workspace id on two herdr servers takes two turns', async () => {
  const here = keepingHerdr('/tmp/herdr-turn-c.sock');
  const there = keepingHerdr('machine:far');
  const listing = here.hold('tab.list');
  const held = releaseWorkspace(here.client, child);
  await listing.reached;
  assert.equal(await releaseWorkspace(there.client, child), 'closed', 'a release on another server waits for no turn here');
  listing.open();
  assert.equal(await held, 'closed');
});
