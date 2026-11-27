// Tier 2: a suggestion in a child's input box is nobody's words. Claude Code
// draws a suggested next message faint, Codex draws its placeholder faint, and
// herdr's text format drops the styling, so before this file Bellwether read
// those words as if somebody had typed them: a faint y/n suggestion became a
// dialog, and an idle event quoted the suggestion as the child's last screen.
// Each case runs the watcher, agent_read or the startup answerer on a fake
// herdr that answers pane.read the way herdr does, ANSI only when asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { StartupDialogTimeout, watchStartup } from '../../src/core/startup-dialogs.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { CLAUDE_DRAFT, CLAUDE_EMPTY, CLAUDE_GHOST, CLAUDE_GHOST_QUESTION, CODEX_GHOST, SUGGESTION, TRUST_FAINT_ACCEPT, TYPED, paneReadAnswer } from '../fixtures/ghost-screens.ts';

const PANE = 'w1:p1';
const INPUT = /send_keys|send_text|send_input|^pane\.run$|^agent\.prompt$/;

class Pane {
  status: string;
  screen: string;
  fake!: FakeHerdr;
  constructor(status: string, screen: string) {
    this.status = status;
    this.screen = screen;
  }
  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, this.screen, PANE) };
    const info = { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t1', agent_status: this.status };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: info } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [info] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE }] } };
    return undefined;
  };
  set(status: string, screen = this.screen): void {
    this.screen = screen;
    this.status = status;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent_status: status } });
  }
}

interface Rig {
  pane: Pane;
  fake: FakeHerdr;
  ctx: ToolContext;
  child: ChildRecord;
  published: OutboxEntry[];
  stop(): Promise<void>;
}

async function rig(t: test.TestContext, pane: Pane, kind = 'claude'): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-ghost-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const now = new Date().toISOString();
  const child: ChildRecord = { id: 'c0ffee02', name: 'kid', kind, harness: kind === 'claude' ? 'claude-code' : kind, paneId: PANE, tabId: 'w1:t1', host: 'local', startedAt: now, statusChangedAt: now, lastBusyAt: now, depth: 1, lastStatus: 'working' };
  const parent = emptyParent('claude-code', `ghost-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' });
  parent.children.push(child);
  saveParent(parent);
  const published: OutboxEntry[] = [];
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const watcher = new Watcher({
    client,
    parentId: parent.id,
    limits: { idleMs: 40, blockedMs: 20, stuckMs: 60_000 },
    tickMs: 15,
    screenPollMs: 0,
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  const stop = async (): Promise<void> => {
    watcher.stop();
    await fake.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  };
  t.after(stop);
  return { pane, fake, child, published, stop, ctx: { client, clientFor: async () => client, parentId: parent.id, watcher } };
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
  assert.deepEqual(r.fake.requests.filter((request) => INPUT.test(request.method)).map((request) => request.method), []);
}

async function idleEvent(r: Rig): Promise<OutboxEntry> {
  await sleep(50);
  r.pane.set('idle');
  await until('the event', () => r.published.length > 0);
  await sleep(150);
  assert.equal(r.published.length, 1);
  return r.published[0] as OutboxEntry;
}

test('an idle child whose box suggests a yes-or-no question goes idle, not blocked on a dialog', async (t) => {
  const r = await rig(t, new Pane('working', CLAUDE_GHOST_QUESTION));
  const event = await idleEvent(r);
  assert.equal(event.event, 'idle', `the suggestion was reported as a dialog: ${event.text}`);
  assert.ok(!event.text.includes('Ship the example release'), event.text);
  assert.equal(readParent(r.ctx.parentId)?.children[0]?.prompt, undefined);
  assertNoInput(r);
});

test('the idle event for a child whose box holds a suggestion does not quote it, and says the box holds one', async (t) => {
  const r = await rig(t, new Pane('working', CLAUDE_GHOST));
  const event = await idleEvent(r);
  assert.ok(!event.text.includes(SUGGESTION), `the parent was handed the suggestion as the child's screen:\n${event.text}`);
  assert.match(event.text, /Input box: GHOST\. The harness shows a suggestion there in faint text\. Nobody typed it/);
  assert.match(event.text, /The example build passed/);
});

test('the idle event for a child whose box holds typed text quotes it as a draft', async (t) => {
  const r = await rig(t, new Pane('working', CLAUDE_DRAFT));
  const event = await idleEvent(r);
  assert.ok(event.text.includes(TYPED), event.text);
  assert.match(event.text, /Input box: DRAFT\./);
});

test('the idle event for a child with an empty box says so', async (t) => {
  const r = await rig(t, new Pane('working', CLAUDE_EMPTY));
  const event = await idleEvent(r);
  assert.match(event.text, /Input box: EMPTY\./);
});

test('agent_read on a screen shows no suggestion and names the box state, for Claude Code and Codex', async (t) => {
  const r = await rig(t, new Pane('idle', CLAUDE_GHOST));
  const claude = await runBellwetherTool(r.ctx, 'agent_read', { child: 'kid', lines: 40 }, {});
  assert.ok(!claude.includes(SUGGESTION), claude);
  assert.match(claude, /Input box: GHOST\./);
  r.pane.screen = CODEX_GHOST;
  const codex = await runBellwetherTool(r.ctx, 'agent_read', { child: 'kid', lines: 40 }, {});
  assert.ok(!codex.includes('Ask Codex to do anything'), codex);
  assert.match(codex, /Input box: GHOST\./);
  r.pane.screen = CLAUDE_DRAFT;
  const draft = await runBellwetherTool(r.ctx, 'agent_read', { child: 'kid', lines: 40 }, {});
  assert.ok(draft.includes(TYPED), draft);
  assert.match(draft, /Input box: DRAFT\./);
  // Every read asked herdr for the styling.
  const reads = r.fake.requests.filter((request) => request.method === 'pane.read');
  assert.ok(reads.length >= 3);
  assert.deepEqual([...new Set(reads.map((request) => request.params['format']))], ['ansi']);
});

test('a startup dialog whose accepting option is drawn faint gets no Enter', async (t) => {
  const pane = new Pane('blocked', TRUST_FAINT_ACCEPT);
  const r = await rig(t, pane);
  const watch = await watchStartup(r.ctx.client, PANE, undefined, { timeoutMs: 600, redrawMs: 20 });
  try {
    await assert.rejects(watch.answer(), StartupDialogTimeout);
  } finally {
    watch.close();
  }
  const keys = r.fake.requests.filter((request) => request.method === 'agent.send_keys').map((request) => request.params['keys']);
  assert.ok(!keys.some((sent) => Array.isArray(sent) && sent.includes('Enter')), `the spawn pressed Enter on a faint option: ${JSON.stringify(keys)}`);
});
