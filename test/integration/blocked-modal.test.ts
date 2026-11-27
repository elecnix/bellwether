// Tier 2: a child waiting on a dialog reaches its parent as blocked, never as
// idle (issue #20). herdr reports such a child idle when its harness does not
// say otherwise, as pi does for an extension's dialog. The watcher runs on a
// fake herdr in a scratch home, and each case reads what the parent receives.
// Every case also checks that nothing typed into the child's pane: Bellwether
// reports a dialog, and approving it is the operator's decision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { PROMPT_NOTICE, notePromptForCaller } from '../../src/core/report.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { startDaemon, type ServiceFactory } from '../../src/daemon/server.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { CLAUDE_PROMPT, PERMISSION_QUESTION } from '../fixtures/claude-screens.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';

const PANE = 'w1:p1';
/** herdr methods that put input into a pane. None may appear on the watcher's path. */
const INPUT = /send_keys|send_text|send_input|^pane\.run$/;

const PI_SCREEN = ' Working in /var/tmp/example\n >\n';

/** One child pane whose herdr status and screen a case moves by hand. */
class Pane {
  status: string;
  screen: string;
  fake!: FakeHerdr;
  constructor(status: string, screen: string) {
    this.status = status;
    this.screen = screen;
  }
  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'pane.read') return { result: { type: 'pane_read', read: { pane_id: PANE, source: request.params['source'], format: 'text', text: this.screen } } };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.info() } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [this.info()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE }] } };
    return undefined;
  };
  private info(): Record<string, unknown> {
    return { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t1', agent_status: this.status };
  }
  set(status: string, screen = this.screen): void {
    this.screen = screen;
    this.status = status;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent_status: status } });
  }
}

interface Rig {
  pane: Pane;
  fake: FakeHerdr;
  parentId: string;
  child: ChildRecord;
  published: OutboxEntry[];
  record(): ChildRecord | undefined;
  stop(): Promise<void>;
}

async function rig(pane: Pane, shape: Pick<ChildRecord, 'kind' | 'harness' | 'lastStatus'>, before?: (rig: Pick<Rig, 'parentId' | 'child'>) => void): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-modal-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const now = new Date().toISOString();
  const child: ChildRecord = { id: 'c0ffee01', name: 'kid', paneId: PANE, tabId: 'w1:t1', host: 'local', startedAt: now, statusChangedAt: now, lastBusyAt: now, depth: 1, ...shape };
  const parent = emptyParent('claude-code', `modal-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' });
  parent.children.push(child);
  saveParent(parent);
  before?.({ parentId: parent.id, child });
  const published: OutboxEntry[] = [];
  const watcher = new Watcher({
    client: new HerdrClient({ socketPath: fake.socketPath }),
    parentId: parent.id,
    limits: { idleMs: 40, blockedMs: 20, stuckMs: 60_000 },
    tickMs: 15,
    screenPollMs: 0,
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  return {
    pane,
    fake,
    parentId: parent.id,
    child,
    published,
    record: () => readParent(parent.id)?.children.find((entry) => entry.id === child.id),
    async stop() {
      watcher.stop();
      await fake.stop();
      if (previous === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function assertNoInput(r: Rig): void {
  assert.deepEqual(
    r.fake.requests.filter((request) => INPUT.test(request.method)).map((request) => request.method),
    [],
    'Bellwether typed into a child that waits on a dialog; approving a prompt is the operator\'s decision',
  );
}

test('a pi child on an extension dialog that herdr calls idle reads blocked, with the dialog line from pi', async () => {
  const title = 'Share anonymous usage totals with the example-tool maintainers?';
  // The dialog opens as pi starts, before any turn, which is how both of today's children met it.
  const r = await rig(new Pane('idle', PI_SCREEN), { kind: 'pi', harness: 'pi', lastStatus: 'idle' }, ({ child }) => {
    notePromptForCaller({ childId: child.id, paneId: PANE }, { open: true, title, kind: 'confirm' });
  });
  try {
    await until('the blocked event', () => r.published.length > 0);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), ['blocked']);
    const [first, second] = (r.published[0]?.text ?? '').split('\n');
    assert.equal(first?.endsWith(`is blocked on a dialog after 0s: ${title}`), true, first);
    assert.match(second ?? '', /Bellwether does not answer it/);
    // pi named the dialog, so the screen was never read for it.
    assert.deepEqual(r.fake.requests.filter((request) => request.method === 'pane.read'), []);
    assertNoInput(r);
  } finally {
    await r.stop();
  }
});

test('a pi child that answers its dialog and works on sends one idle, at the end of its turn', async () => {
  const r = await rig(new Pane('idle', PI_SCREEN), { kind: 'pi', harness: 'pi', lastStatus: 'idle' }, ({ child }) => {
    notePromptForCaller({ childId: child.id, paneId: PANE }, { open: true, title: 'Share usage totals?', kind: 'confirm' });
  });
  try {
    await until('the blocked event', () => r.published.length > 0);
    // Someone answers. pi closes the dialog, starts the task a moment later, and ends it.
    notePromptForCaller({ childId: r.child.id, paneId: PANE }, { open: false });
    await sleep(20);
    r.pane.set('working');
    await sleep(150);
    // Answering the dialog sent nothing: no idle, and no second blocked.
    assert.deepEqual(r.published.map((entry) => entry.event), ['blocked']);
    r.pane.set('idle');
    await until('the idle event', () => r.published.length > 1);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), ['blocked', 'idle']);
    assertNoInput(r);
  } finally {
    await r.stop();
  }
});

test('a Claude Code permission question that herdr calls idle reads blocked, named from the screen', async () => {
  const r = await rig(new Pane('working', CLAUDE_PROMPT), { kind: 'claude', harness: 'claude-code', lastStatus: 'working' });
  try {
    await sleep(50);
    r.pane.set('idle', PERMISSION_QUESTION);
    await until('the blocked event', () => r.published.length > 0);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), ['blocked']);
    assert.match(r.published[0]?.text ?? '', /blocked on a dialog after \d+s: Bash command: Do you want to proceed\?\n/);
    // The line names the dialog; the screen stays out of the event.
    assert.doesNotMatch(r.published[0]?.text ?? '', /rm -rf build/);
    assert.equal(r.record()?.prompt?.source, 'screen');
    // While the dialog is up, the blocked entry stays for the parent.
    assert.equal(r.published[0]?.read, false);

    // The operator answers; the child works and finishes.
    r.pane.set('working', CLAUDE_PROMPT);
    await until('the screen prompt to clear', () => r.record()?.prompt === undefined);
    r.pane.set('idle');
    await until('the idle event', () => r.published.length > 1);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), ['blocked', 'idle']);
    assertNoInput(r);
  } finally {
    await r.stop();
  }
});

test('a child at its prompt after a finished turn reads idle', async () => {
  const r = await rig(new Pane('working', CLAUDE_PROMPT), { kind: 'claude', harness: 'claude-code', lastStatus: 'working' });
  try {
    await sleep(50);
    r.pane.set('idle');
    await until('the idle event', () => r.published.length > 0);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), ['idle']);
    assert.equal(r.record()?.prompt, undefined);
    assertNoInput(r);
  } finally {
    await r.stop();
  }
});

test('a pi child\'s extension tells the daemon when pi opens and closes a dialog', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-modal-pi-'));
  const saved = { home: process.env['BELLWETHER_HOME'], socket: process.env['BELLWETHER_DAEMON_SOCKET'], child: process.env['BELLWETHER_CHILD'], pane: process.env['HERDR_PANE_ID'] };
  process.env['BELLWETHER_HOME'] = root;
  process.env['BELLWETHER_DAEMON_SOCKET'] = path.join(root, 'daemon.sock');
  process.env['BELLWETHER_CHILD'] = 'c0ffee02';
  process.env['HERDR_PANE_ID'] = PANE;
  t.after(() => {
    for (const [key, value] of [['BELLWETHER_HOME', saved.home], ['BELLWETHER_DAEMON_SOCKET', saved.socket], ['BELLWETHER_CHILD', saved.child], ['HERDR_PANE_ID', saved.pane]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const parent = emptyParent('pi', 'modal-parent', root);
  parent.children.push({ id: 'c0ffee02', name: 'kid', kind: 'pi', harness: 'pi', paneId: PANE, host: 'local', startedAt: now, statusChangedAt: now, lastBusyAt: now, lastStatus: 'idle', depth: 1 });
  saveParent(parent);
  const prompt = (): ChildRecord['prompt'] => readParent(parent.id)?.children[0]?.prompt;

  // The daemon routes the notice through the same tool dispatch it gives every session.
  const calls: string[] = [];
  const factory: ServiceFactory = () => ({
    pending: () => [],
    markRead: () => {},
    onEvents: () => {},
    tool: (name, args, caller) => {
      calls.push(name);
      return runBellwetherTool({} as ToolContext, name, args, caller);
    },
    watchPane: () => () => {},
    stop: () => {},
  });
  const daemon = await startDaemon({ socketPath: path.join(root, 'daemon.sock'), home: root, factory });
  t.after(() => daemon.close());

  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: () => {},
    sendMessage: () => {},
  };
  const fire = async (event: string, payload: unknown, ctx: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  bellwether(pi);
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => 'child-session', getCwd: () => '/tmp', getEntries: () => [] } };

  // The first-run question opens while pi starts, before the extension has a daemon.
  await fire('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Share anonymous usage totals?' });
  await fire('session_start', {}, ctx);
  t.after(() => fire('session_shutdown', {}, ctx));
  await until('the open prompt on the record', () => prompt() !== undefined);
  assert.deepEqual({ ...prompt(), since: undefined }, { line: 'Share anonymous usage totals?', source: 'pi', kind: 'confirm', since: undefined });

  await fire('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm' });
  await until('the prompt to clear', () => prompt() === undefined);
  assert.ok(calls.every((name) => name === PROMPT_NOTICE));
});
