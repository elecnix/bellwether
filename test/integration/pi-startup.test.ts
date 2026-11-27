// Tier 2: a pi child that fails at startup fails its spawn (issue #130). A
// scripted pane plays four pi starts on screens shaped like a real pi 1.6
// pane: one that exits at once, one that stays up on a missing key and goes
// idle, one that is slow to show any status, and one that takes its brief.
// A watcher runs on the same fake, as the daemon would run it, so the cases
// show that a failed start reaches the parent as the spawn's error and as
// nothing else.
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
import { harnessStart, startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { paneReadAnswer } from '../fixtures/ghost-screens.ts';

const PANE = 'w1:p1';
const SHELL_PID = 4100;
const PI_PID = 4200;

type Script = 'exits' | 'no-key' | 'slow' | 'takes-brief';

const BANNER = [' ▀▀█  v1.6.1', ' Pi can explain its own features and look up its docs.'];

/** One pi pane, which follows its script once the launch line is typed. */
class PiPane {
  screen = '$ ';
  foreground = SHELL_PID;
  status = 'unknown';
  detected = false;
  fake!: FakeHerdr;
  readonly script: Script;
  constructor(script: Script) {
    this.script = script;
  }

  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (harnessStart(request)?.via === 'typed') {
      this.start(String(request.params['text']));
      return { result: { type: 'ok' } };
    }
    if (request.method === 'pane.process_info') return { result: { type: 'pane_process_info', process_info: { pane_id: PANE, shell_pid: SHELL_PID, foreground_process_group_id: this.foreground } } };
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, this.screen, PANE) };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.detected ? { pane_id: PANE, agent: 'pi', agent_status: this.status, name: null } : { pane_id: PANE, agent_status: 'unknown', launch_pending: true } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: PANE }] } };
    return undefined;
  };

  private start(line: string): void {
    this.screen = `$ ${line}\n`;
    this.foreground = PI_PID;
    const later = (ms: number, step: () => void): void => {
      setTimeout(step, ms);
    };
    if (this.script === 'exits') {
      // pi refuses the provider and exits before herdr has seen it.
      later(600, () => {
        this.screen += 'Error: Unknown provider "example-provider". Use --list-models to see available providers/models.\n$ ';
        this.foreground = SHELL_PID;
      });
      return;
    }
    later(20, () => this.detect());
    if (this.script === 'no-key') {
      later(40, () => {
        this.screen += [...BANNER, ' Error: No API key found for example-provider.', ' Use /login to log into a provider via OAuth or API key.', '', ' 0.0%/200k (auto)'].join('\n');
        this.setStatus('idle');
      });
    } else if (this.script === 'takes-brief') {
      later(40, () => {
        this.screen += [...BANNER, ' Reading the brief…'].join('\n');
        this.setStatus('working');
      });
    }
    // A slow pi shows no status at all within the wait.
  }

  private detect(): void {
    this.detected = true;
    this.fake.send({ event: 'pane_agent_detected', data: { pane_id: PANE, workspace_id: 'w1', agent: 'pi' } });
  }

  private setStatus(status: string): void {
    this.status = status;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: PANE, workspace_id: 'w1', agent: 'pi', agent_status: status } });
  }
}

interface Rig {
  fake: FakeHerdr;
  client: HerdrClient;
  parent: ParentRecord;
  published: OutboxEntry[];
  stop(): Promise<void>;
}

async function rig(pane: PiPane): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-pi-startup-'));
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parent = saveParent(emptyParent('pi', `s-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' }));
  const published: OutboxEntry[] = [];
  const watcher = new Watcher({
    client,
    parentId: parent.id,
    limits: { idleMs: 30, blockedMs: 20, stuckMs: 60_000 },
    tickMs: 15,
    screenPollMs: 0,
    onEntries: (entries) => {
      for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
    },
  });
  watcher.start();
  return {
    fake,
    client,
    parent,
    published,
    async stop() {
      watcher.stop();
      await fake.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const PAIR = { provider: 'example-provider', model: 'example-model' };

test('a pi that exits at startup fails the spawn with its own error line, before herdr ever detects it', async () => {
  const pane = new PiPane('exits');
  const r = await rig(pane);
  try {
    const began = Date.now();
    await assert.rejects(spawnChild(r.client, r.parent, { kind: 'pi', name: 'kid', prompt: 'go', ...PAIR }), (error: Error) => {
      assert.match(error.message, /pi in pane w1:p1 exited at startup, before herdr detected it, and printed: Error: Unknown provider "example-provider"/);
      return true;
    });
    // It failed on the exit, not on the 30 s detection deadline.
    assert.ok(Date.now() - began < 5_000, `the spawn took ${Date.now() - began} ms`);
    assert.deepEqual(readParent(r.parent.id)?.children, [], 'the record is gone');
    assert.ok(r.fake.requests.some((request) => request.method === 'tab.close'), 'the tab is closed');
    const prompts = path.join(process.env['BELLWETHER_HOME'] as string, 'prompts');
    assert.deepEqual(fs.existsSync(prompts) ? fs.readdirSync(prompts) : [], [], 'the brief is gone');
  } finally {
    await r.stop();
  }
});

test('a pi that stays up on a missing key and goes idle fails the spawn with that line, and the parent hears no idle event', async () => {
  const pane = new PiPane('no-key');
  const r = await rig(pane);
  try {
    await assert.rejects(spawnChild(r.client, r.parent, { kind: 'pi', name: 'kid', prompt: 'go', ...PAIR }), (error: Error) => {
      assert.match(error.message, /pi in pane w1:p1 stopped at startup without taking its prompt, and printed: Error: No API key found for example-provider\./);
      return true;
    });
    assert.deepEqual(readParent(r.parent.id)?.children, []);
    await sleep(200);
    assert.deepEqual(r.published.map((entry) => entry.event), [], 'nothing about the child reached the parent');
  } finally {
    await r.stop();
  }
});

test('a pi that shows no status within the wait is reported as started but unconfirmed, and stays watched', async () => {
  const pane = new PiPane('slow');
  const r = await rig(pane);
  try {
    const result = await spawnChild(r.client, r.parent, { kind: 'pi', name: 'kid', prompt: 'go', ...PAIR, confirmMs: 300 });
    assert.match(result.startNote ?? '', /kid's pi was running but had not started a turn or reached its prompt 0 s after the start, so Bellwether could not confirm that it took its brief\. It may be slow rather than stuck/);
    const saved = readParent(r.parent.id)?.children.find((entry) => entry.id === result.child.id);
    assert.ok(saved, 'the child stays on the record, so the watcher reports its exit');
    assert.equal(saved?.startingUntil, undefined, 'the hold ends with the spawn');
  } finally {
    await r.stop();
  }
});

test('a pi that takes its brief starts with no note', async () => {
  const pane = new PiPane('takes-brief');
  const r = await rig(pane);
  try {
    const result = await spawnChild(r.client, r.parent, { kind: 'pi', name: 'kid', prompt: 'go', ...PAIR });
    assert.equal(result.startNote, undefined);
    assert.ok(r.fake.requests.some((request) => request.method === 'agent.rename' && request.params['name'] === 'kid'), 'the agent got its name');
  } finally {
    await r.stop();
  }
});
