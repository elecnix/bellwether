// Tier 2: a Claude Code spawn against a fake herdr whose pane plays Claude
// Code's two startup dialogs, on screens copied from a real pane. A watcher runs on the same fake, as the daemon
// would run it, so the cases show what reaches the parent as well as what the
// spawn does: the questions are answered with deliberate keys, nothing is
// published for them, a question that never goes away fails the spawn by name,
// and a resumed child that asks again is answered without a blocked event.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { OutboxEntry, ParentRecord } from '../../src/core/types.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest, harnessStart } from '../fixtures/fake-herdr.ts';
import { CHANNEL_ACCEPT_SELECTED, CHANNEL_FIVE_EXIT_SELECTED, CLAUDE_PROMPT, PERMISSION_QUESTION, TRUST_NO_SELECTED, TRUST_YES_SELECTED } from '../fixtures/claude-screens.ts';
import { paneReadAnswer } from '../fixtures/ghost-screens.ts';

const PANE = 'w1:p1';
const SESSION = '2ec67aeb-f5b3-4cdc-bedf-eab67f3462ab';

type Screen = 'trust-no' | 'trust-yes' | 'channel' | 'channel-exit' | 'prompt' | 'permission' | 'exited';

const TEXT: Record<Screen, string> = {
  'trust-no': TRUST_NO_SELECTED,
  'trust-yes': TRUST_YES_SELECTED,
  channel: CHANNEL_ACCEPT_SELECTED,
  'channel-exit': CHANNEL_FIVE_EXIT_SELECTED,
  prompt: CLAUDE_PROMPT,
  permission: PERMISSION_QUESTION,
  exited: '$ ',
};

/**
 * One Claude Code pane. It moves between screens the way Claude Code does on
 * the keys it receives, and herdr's status follows: blocked on a question,
 * idle at the prompt. `stubborn` keeps the channel question up whatever key
 * arrives, which is a dialog that never answers.
 */
class ClaudePane {
  screen: Screen;
  status = 'unknown';
  seq = 0;
  readonly keys: { key: string; on: Screen }[] = [];
  fake!: FakeHerdr;
  readonly options: { stubborn?: boolean };

  constructor(first: Screen, options: { stubborn?: boolean } = {}) {
    this.screen = first;
    this.options = options;
  }

  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, TEXT[this.screen], PANE) };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.agentInfo() } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [this.agentInfo()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE }] } };
    if (harnessStart(request) !== undefined) {
      // herdr answers at once and classifies the pane a moment later.
      const onQuestion = this.screen !== 'prompt';
      setTimeout(() => this.setStatus(onQuestion ? 'blocked' : 'idle'), 5);
      return undefined;
    }
    if (request.method === 'agent.send_keys') {
      for (const key of request.params['keys'] as string[]) this.press(key);
      return { result: { type: 'ok' } };
    }
    return undefined;
  };

  private agentInfo(): Record<string, unknown> {
    const session = this.screen === 'prompt' ? { agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: SESSION } } : {};
    return { pane_id: PANE, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term_1', agent: 'claude', agent_status: this.status, state_change_seq: this.seq, ...session };
  }

  private press(key: string): void {
    this.keys.push({ key, on: this.screen });
    if (this.options.stubborn && (this.screen === 'channel' || this.screen === 'channel-exit')) return;
    // The trust question has no numbers and ignores a digit, as Claude Code 2.1.318 does.
    if (this.screen === 'trust-no' && key === 'Down') this.screen = 'trust-yes';
    else if (this.screen === 'trust-no' && key === 'Enter') this.screen = 'exited';
    else if (this.screen === 'trust-yes' && key === 'Enter') this.screen = 'channel';
    // The channel question takes the digit of an option wherever its cursor is.
    else if (this.screen === 'channel' && key === 'Down') this.screen = 'channel-exit';
    else if (this.screen === 'channel-exit' && key === 'Up') this.screen = 'channel';
    else if ((this.screen === 'channel-exit' && key === 'Enter') || ((this.screen === 'channel' || this.screen === 'channel-exit') && key === '2')) this.screen = 'exited';
    else if ((this.screen === 'channel' && key === 'Enter') || ((this.screen === 'channel' || this.screen === 'channel-exit') && key === '1')) {
      this.screen = 'prompt';
      setTimeout(() => this.setStatus('idle'), 5);
    }
  }

  setStatus(status: string): void {
    this.status = status;
    this.seq += 1;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent: 'claude', agent_status: status } });
  }
}

async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Rig {
  fake: FakeHerdr;
  pane: ClaudePane;
  client: HerdrClient;
  parent: ParentRecord;
  watcher: Watcher;
  published: OutboxEntry[];
  stop(): Promise<void>;
}

async function rig(pane: ClaudePane): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-spawn-'));
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parent = saveParent(emptyParent('claude-code', `s-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' }));
  const published: OutboxEntry[] = [];
  const watcher = new Watcher({
    client,
    parentId: parent.id,
    limits: { idleMs: 30, blockedMs: 20, stuckMs: 60_000 },
    tickMs: 15,
    screenPollMs: 0,
    // Each publish carries every unread entry, so keep one copy per receipt.
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  return {
    fake,
    pane,
    client,
    parent,
    watcher,
    published,
    async stop() {
      watcher.stop();
      await fake.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a spawn that meets the trust and channel questions reaches the prompt and publishes nothing', async () => {
  const pane = new ClaudePane('trust-no');
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', redrawMs: 10, startupTimeoutMs: 5_000 });

    // The spawn returned with the child past both questions.
    assert.equal(pane.screen, 'prompt');
    assert.equal(child.lastStatus, 'idle');
    // Down moved off "No, exit" first; Enter never went to it. The channel
    // question took its digit.
    assert.deepEqual(pane.keys.map(({ key }) => key), ['Down', 'Enter', '1']);
    assert.ok(pane.keys.every(({ key, on }) => !(key === 'Enter' && on === 'trust-no')));

    // The registry holds the session and no starting marker.
    const record = readParent(r.parent.id)?.children.find((entry) => entry.id === child.id);
    assert.deepEqual(record?.session, { kind: 'id', value: SESSION });
    assert.equal(record?.startingUntil, undefined);

    // herdr reported the pane blocked while the questions were up, and the
    // watcher saw it. Several blocked settle times later, nothing has reached
    // the parent.
    await sleep(250);
    assert.deepEqual(r.published.map((entry) => entry.event), []);
  } finally {
    await r.stop();
  }
});

test('a channel question with five channels and the cursor on Exit is answered with 1, never Enter (issue #133)', async () => {
  const pane = new ClaudePane('channel-exit');
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', redrawMs: 10, startupTimeoutMs: 5_000 });
    assert.equal(pane.screen, 'prompt');
    assert.equal(child.lastStatus, 'idle');
    // One key, the digit of "I am using this for local development". No arrow
    // depended on where the cursor started, and no Enter went to "Exit".
    assert.deepEqual(pane.keys, [{ key: '1', on: 'channel-exit' }]);
  } finally {
    await r.stop();
  }
});

test('a question that never goes away fails the spawn with a timeout that names it', async () => {
  const pane = new ClaudePane('channel', { stubborn: true });
  const r = await rig(pane);
  try {
    await assert.rejects(
      spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', redrawMs: 10, startupTimeoutMs: 400 }),
      (error: Error) => {
        assert.match(error.message, /still on the development-channel question/);
        assert.match(error.message, /timed out/);
        assert.match(error.message, /I am using this for local development/);
        return true;
      },
    );
    // The spawn is undone: the tab is closed and the record removed, so no
    // exit event follows a failure the caller already has.
    assert.ok(r.fake.requests.some((request) => request.method === 'tab.close'));
    assert.deepEqual(readParent(r.parent.id)?.children, []);
    await sleep(150);
    assert.deepEqual(r.published.map((entry) => entry.event), []);
  } finally {
    await r.stop();
  }
});

test('a resumed child that asks the channel question again is answered without a blocked event', async () => {
  const pane = new ClaudePane('prompt');
  const r = await rig(pane);
  try {
    pane.status = 'idle';
    await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', redrawMs: 10, startupTimeoutMs: 5_000 });
    await sleep(60);
    // The session restarts in the same pane and asks again.
    pane.screen = 'channel';
    pane.setStatus('blocked');
    await sleep(300);
    assert.equal(pane.screen, 'prompt');
    assert.deepEqual(pane.keys.map(({ key }) => key), ['1']);
    assert.deepEqual(r.published.filter((entry) => entry.event === 'blocked'), []);
  } finally {
    await r.stop();
  }
});

test('a question the operator owns is still published as blocked', async () => {
  const pane = new ClaudePane('prompt');
  const r = await rig(pane);
  try {
    pane.status = 'idle';
    await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', redrawMs: 10, startupTimeoutMs: 5_000 });
    await sleep(60);
    pane.screen = 'permission';
    pane.setStatus('blocked');
    // Wait for the event itself: a fixed sleep raced the settle time and the
    // screen read on a loaded CI runner. The pause after it lets a second
    // blocked event show up if one would.
    await until('the blocked event', () => r.published.some((entry) => entry.event === 'blocked'));
    await sleep(150);
    assert.deepEqual(pane.keys, []);
    const blocked = r.published.filter((entry) => entry.event === 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]?.text ?? '', /Do you want to proceed/);
  } finally {
    await r.stop();
  }
});

test('a queued blocked entry is not delivered once the child has moved on', async () => {
  const pane = new ClaudePane('prompt');
  const r = await rig(pane);
  try {
    pane.status = 'idle';
    await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', redrawMs: 10, startupTimeoutMs: 5_000 });
    await sleep(60);
    pane.screen = 'permission';
    pane.setStatus('blocked');
    await sleep(200);
    assert.equal(r.watcher.pendingEntries().length, 1);
    const queued = r.watcher.pendingEntries()[0];

    // Someone answers the question in the pane before the parent reads it.
    pane.screen = 'prompt';
    pane.setStatus('working');
    await sleep(100);
    // A reconnect replays pending entries, and the stale one is not among them.
    assert.deepEqual(r.watcher.pendingEntries(), []);
    const settled = r.watcher.outboxEntries().find((entry) => entry.receipt === queued?.receipt);
    assert.equal(settled?.read, true);
    assert.match(settled?.supersededBy ?? '', /^state:working$/);
  } finally {
    await r.stop();
  }
});

test('the session survives the child exiting', async () => {
  const pane = new ClaudePane('trust-no');
  const r = await rig(pane);
  try {
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', redrawMs: 10, startupTimeoutMs: 5_000 });
    r.fake.send({ event: 'tab_closed', data: { tab_id: 'w1:t1' } });
    await sleep(150);
    const record = readParent(r.parent.id)?.children.find((entry) => entry.id === child.id);
    assert.ok(record?.exitedAt);
    assert.deepEqual(record?.session, { kind: 'id', value: SESSION });
  } finally {
    await r.stop();
  }
});

test('the startup hold ends as activity, so the inactivity clock starts when the answers do', async () => {
  const pane = new ClaudePane('trust-no');
  const r = await rig(pane);
  try {
    // A slow redraw makes the answers take real time, so the hold has a length to measure.
    const { child } = await spawnChild(r.client, r.parent, { kind: 'claude', name: 'kid', prompt: 'go', redrawMs: 150, startupTimeoutMs: 5_000 });
    const record = readParent(r.parent.id)?.children.find((entry) => entry.id === child.id);
    assert.ok(record);
    assert.ok(Date.parse(record.lastBusyAt) - Date.parse(record.startedAt) >= 100, 'the activity time moved past the spawn time');
  } finally {
    await r.stop();
  }
});
