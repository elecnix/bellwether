// Tier 2: one event per turn (issue #77). A child that reports and goes idle
// woke its parent twice, an adopted child sent two identical idle events for
// one turn, and an idle event quoted an older turn's report. Each case runs the
// watcher on a fake herdr in a scratch home and counts what the parent receives,
// across a snapshot that reads the same turn again and a watcher that starts
// again, as a new parent service or a daemon that took over does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptPane } from '../../src/core/adopt.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { writeReport } from '../../src/core/report.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { startFakeHerdr, type FakeHerdr, type RecordedRequest } from '../fixtures/fake-herdr.ts';
import { paneReadAnswer } from '../fixtures/ghost-screens.ts';
import { paneOpened } from '../../src/core/incarnation.ts';

const PANE = 'w1:p1';
const LIMITS = { idleMs: 40, blockedMs: 20, stuckMs: 60_000 };

/** One child pane whose herdr status, turn number and screen a case moves by hand. */
class Pane {
  /** The pane herdr runs the child in. A restart, resume, move or teleport gives it another. */
  paneId = PANE;
  status = 'working';
  seq: number | undefined;
  stateSeq = 1;
  screen = '';
  fake!: FakeHerdr;
  constructor(seq?: number) {
    this.seq = seq;
  }
  respond = (request: RecordedRequest): { result: unknown } | undefined => {
    if (request.method === 'pane.read') return { result: paneReadAnswer(request.params, this.screen, this.paneId) };
    if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: this.info() } };
    if (request.method === 'agent.list') return { result: { type: 'agent_list', agents: [this.info()] } };
    if (request.method === 'session.snapshot') return { result: { type: 'session_snapshot', snapshot: { panes: [], agents: [this.info()] } } };
    if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: this.paneId }] } };
    return undefined;
  };
  private info(): Record<string, unknown> {
    return { pane_id: this.paneId, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term-1', agent: 'pi', name: 'kid', agent_status: this.status, completion_seq: this.seq ?? null, state_change_seq: this.stateSeq };
  }
  /** herdr's status event. A turn that ends carries its number, as herdr 0.9.5 sends it. */
  set(status: string, options: { endsTurn?: boolean; screen?: string } = {}): void {
    if (options.screen !== undefined) this.screen = options.screen;
    if (options.endsTurn && this.seq !== undefined) this.seq += 1;
    this.status = status;
    this.stateSeq += 1;
    this.fake.send({ event: 'pane_agent_status_changed', data: { pane_id: this.paneId, workspace_id: 'w1', agent_status: status, completion_seq: this.seq ?? null, state_change_seq: this.stateSeq } });
  }
  /** An agent event, after which the watcher reads a fresh snapshot of every child. */
  detected(): void {
    this.fake.send({ event: 'pane_agent_detected', data: { pane_id: this.paneId, workspace_id: 'w1', agent: 'pi' } });
  }
}

interface Rig {
  pane: Pane;
  parentId: string;
  childId: string;
  /** Every unread entry the parent was handed, once each, across watchers. */
  published: OutboxEntry[];
  record(): ChildRecord | undefined;
  /** Stop the watcher and start another on the same home, as a new parent service does. */
  restartWatcher(): void;
  /** Wait well past every settle time, so an event that is due has fired. */
  settle(): Promise<void>;
  report(status: 'done' | 'progress', text: string): void;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * A watcher over one child. `adopt` registers the child through agent_adopt's
 * own path rather than writing a spawned child's record.
 */
async function rig(pane: Pane, options: { adopt?: boolean; child?: Partial<ChildRecord> } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-noise-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const fake = await startFakeHerdr({ respond: pane.respond });
  pane.fake = fake;
  const client = new HerdrClient({ socketPath: fake.socketPath });
  const parent = saveParent(emptyParent('claude-code', `noise-${Math.random().toString(36).slice(2)}`, home, { workspaceId: 'w1' }));
  let childId: string;
  if (options.adopt) {
    childId = (await adoptPane(client, parent, { target: PANE })).child.id;
  } else {
    const now = new Date().toISOString();
    const child: ChildRecord = { id: 'c0ffee02', name: 'kid', kind: 'pi', harness: 'pi', paneId: PANE, tabId: 'w1:t1', host: 'local', startedAt: now, lastStatus: pane.status as ChildRecord['lastStatus'], statusChangedAt: now, lastBusyAt: now, depth: 1, harnessSeenAt: now, ...(pane.seq === undefined ? {} : { completionSeq: pane.seq }), ...options.child };
    const record = readParent(parent.id)!;
    record.children.push(child);
    saveParent(record);
    childId = child.id;
  }
  const published: OutboxEntry[] = [];
  const make = (): Watcher =>
    new Watcher({
      client,
      parentId: parent.id,
      limits: LIMITS,
      tickMs: 15,
      screenPollMs: 0,
      onEntries: (entries) => {
        for (const entry of entries) if (!entry.read && !published.some((seen) => seen.receipt === entry.receipt)) published.push(entry);
      },
    });
  let watcher = make();
  watcher.start();
  return {
    pane,
    parentId: parent.id,
    childId,
    published,
    record: () => readParent(parent.id)?.children.find((entry) => entry.id === childId),
    restartWatcher() {
      watcher.stop();
      watcher = make();
      watcher.start();
    },
    settle: () => sleep(400),
    report(status, text) {
      writeReport({ parentId: parent.id, childId, childName: 'kid', paneId: PANE, status, text });
    },
    async stop() {
      watcher.stop();
      await fake.stop();
      if (previous === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const events = (r: Rig): string[] => r.published.map((entry) => entry.event);

test('a final report and the end of its turn reach the parent as one event, whatever reads the turn again', async () => {
  const r = await rig(new Pane(4));
  try {
    await r.settle();
    r.report('done', 'REPORT-ONE: the branch is pushed');
    await until('the report', () => r.published.length === 1);
    // The harness ends the turn that made the report.
    r.pane.set('idle', { endsTurn: true, screen: 'all done\n>' });
    await r.settle();
    // A later snapshot reads the same turn again, as each spawn of a sibling makes the watcher do.
    r.pane.detected();
    await r.settle();
    // A new parent service, or a daemon that took over, starts a watcher from the record.
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['report'], `the parent got ${JSON.stringify(r.published.map((entry) => [entry.event, entry.text]))}`);
    assert.deepEqual(r.record()?.turnNotified, { paneId: PANE, seq: 5 });
    assert.equal(r.record()?.reportPending, undefined);
  } finally {
    await r.stop();
  }
});

test('a progress report leaves the end of its turn to one idle event, which carries the turn, not the report', async () => {
  const r = await rig(new Pane(4));
  try {
    await r.settle();
    r.report('progress', 'PROGRESS-TEXT: halfway');
    await until('the report', () => r.published.length === 1);
    r.pane.set('idle', { endsTurn: true, screen: 'the turn ended on this line\n>' });
    await until('the idle event', () => r.published.length === 2);
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['report', 'idle']);
    const idle = r.published[1]!.text;
    assert.match(idle, /the turn ended on this line/);
    assert.doesNotMatch(idle, /PROGRESS-TEXT/);
  } finally {
    await r.stop();
  }
});

test('an adopted child\'s single turn produces one idle event', async () => {
  // The pane already finished three turns before anyone adopted it.
  const pane = new Pane(3);
  pane.status = 'idle';
  pane.screen = 'an answer from before the adoption\n>';
  const r = await rig(pane, { adopt: true });
  try {
    await r.settle();
    assert.deepEqual(events(r), [], 'the turns before the adoption are not news');
    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'the adopted turn ended here\n>' });
    await until('the idle event', () => r.published.length === 1);
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle'], `the parent got ${JSON.stringify(r.published.map((entry) => [entry.event, entry.text]))}`);
    assert.match(r.published[0]!.text, /the adopted turn ended here/);
  } finally {
    await r.stop();
  }
});

test('a status herdr repeats raises nothing the second time', async () => {
  const r = await rig(new Pane(7));
  try {
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'first and only turn\n>' });
    await until('the idle event', () => r.published.length === 1);
    // herdr says idle again for the same turn, then a snapshot and a new watcher read it.
    r.pane.set('idle');
    await r.settle();
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle']);
  } finally {
    await r.stop();
  }
});

test('a pane herdr does not number still sends one idle per turn, across a new watcher', async () => {
  // A Claude Code pane whose turns screen detection catches can carry no completion_seq at all.
  const r = await rig(new Pane(undefined));
  try {
    await r.settle();
    r.pane.set('idle', { screen: 'turn one\n>' });
    await until('the first idle', () => r.published.length === 1);
    r.restartWatcher();
    await r.settle();
    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { screen: 'turn two\n>' });
    await until('the second idle', () => r.published.length === 2);
    await r.settle();
    assert.deepEqual(events(r), ['idle', 'idle']);
    assert.match(r.published[1]!.text, /turn two/);
  } finally {
    await r.stop();
  }
});

test('an event never carries another event\'s text', async () => {
  const r = await rig(new Pane(1));
  try {
    await r.settle();
    r.report('done', 'REPORT-ONE: first turn, reported');
    await until('the report', () => r.published.length === 1);
    r.pane.set('idle', { endsTurn: true, screen: 'first answer\n>' });
    await r.settle();
    // A second prompt, answered without a report.
    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'SECOND-ANSWER: the newer turn\n>' });
    await until('the idle event', () => r.published.length === 2);
    await r.settle();
    assert.deepEqual(events(r), ['report', 'idle']);
    const [report, idle] = r.published.map((entry) => entry.text);
    assert.match(idle!, /SECOND-ANSWER/);
    assert.doesNotMatch(idle!, /REPORT-ONE/, 'the idle event quoted the report of an older turn');
    assert.doesNotMatch(report!, /SECOND-ANSWER/);
  } finally {
    await r.stop();
  }
});

// Issue #100: an idle event from a child that never called parent_report reads
// like a quiet finish. The idle event says so in its first line, and that line
// rides on the one event the turn already sends.
const SILENT = /has not called parent_report since/;

test('a turn that ends with no report since the start says so in its one idle event', async () => {
  const r = await rig(new Pane(2));
  try {
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'parent_report was refused, giving up\n>' });
    await until('the idle event', () => r.published.length === 1);
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle'], `the parent got ${JSON.stringify(r.published.map((entry) => [entry.event, entry.text]))}`);
    const [first, ...rest] = r.published[0]!.text.split('\n');
    assert.match(first!, /^kid \(w1:p1\) went idle after \d+s, and it has not called parent_report since it started at \S+Z:$/);
    assert.match(rest.join('\n'), /parent_report was refused/);
  } finally {
    await r.stop();
  }
});

test('each silent turn carries the line once, in its own idle event', async () => {
  const r = await rig(new Pane(2));
  try {
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'turn one\n>' });
    await until('the first idle', () => r.published.length === 1);
    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'turn two\n>' });
    await until('the second idle', () => r.published.length === 2);
    await r.settle();
    assert.deepEqual(events(r), ['idle', 'idle']);
    for (const entry of r.published) assert.equal(entry.text.match(new RegExp(SILENT, 'g'))?.length, 1, entry.text);
  } finally {
    await r.stop();
  }
});

test('a child that reported progress and then went idle sends one idle event without the line', async () => {
  const r = await rig(new Pane(2));
  try {
    await r.settle();
    r.report('progress', 'halfway');
    await until('the report', () => r.published.length === 1);
    r.pane.set('idle', { endsTurn: true, screen: 'finished quietly\n>' });
    await until('the idle event', () => r.published.length === 2);
    await r.settle();
    assert.deepEqual(events(r), ['report', 'idle']);
    assert.doesNotMatch(r.published[1]!.text, SILENT);
  } finally {
    await r.stop();
  }
});

test('a report from before the latest resume does not count for the resumed run', async () => {
  const before = new Date(Date.now() - 60_000).toISOString();
  const resumed = new Date(Date.now() - 1_000).toISOString();
  const r = await rig(new Pane(2), { child: { startedAt: before, resumedAt: resumed, lastReport: { status: 'done', text: 'the old run finished', at: before, seq: 1 } } });
  try {
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'resumed turn\n>' });
    await until('the idle event', () => r.published.length === 1);
    assert.match(r.published[0]!.text, new RegExp(`has not called parent_report since it resumed at ${resumed.replace(/[.]/g, '\\.')}:`));
  } finally {
    await r.stop();
  }
});

test('an adopted child that never reported names its adoption as the start', async () => {
  const pane = new Pane(3);
  pane.status = 'idle';
  const r = await rig(pane, { adopt: true });
  try {
    await r.settle();
    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'adopted turn\n>' });
    await until('the idle event', () => r.published.length === 1);
    assert.match(r.published[0]!.text, /has not called parent_report since Bellwether adopted it at \S+Z:/);
  } finally {
    await r.stop();
  }
});

// A crossing gives a child a new pane and keeps its turns (issue #271). The
// record's turn belonged to the old pane, so the watcher of the new one must
// neither announce that turn again nor count the resumed session's first
// settled screen as a turn. Each crossing below moves the record the way
// restart.ts and resume.ts do: the pane and tab change, nothing else.

/** Move the child to another pane, as a restart, resume, move or teleport does, then let herdr show the resumed session. */
async function cross(r: Rig, paneId: string, herdrSays: { status: string; seq?: number }): Promise<void> {
  const { updateChild } = await import('../../src/core/registry.ts');
  r.pane.paneId = paneId;
  r.pane.seq = herdrSays.seq;
  updateChild(r.parentId, r.childId, (entry) => {
    paneOpened(entry, { paneId, tabId: `${paneId.split(':')[0]}:t9` });
  });
  r.pane.detected();
  r.pane.set(herdrSays.status);
}

test('a child restarted into a new pane does not announce the turn its parent already heard, and its next turn gives one idle event (issue #271)', async () => {
  const r = await rig(new Pane(948));
  try {
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'the turn before the restart\n>' });
    await until('the idle event', () => r.published.length === 1);
    assert.deepEqual(r.record()?.turnNotified, { paneId: PANE, seq: 949 });

    // The resumed session shows its last answer; herdr calls it done in the new pane, with no turn there.
    await cross(r, 'w1:p8', { status: 'done', seq: 960 });
    await r.settle();
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle'], `the parent heard the old turn again: ${JSON.stringify(r.published.map((entry) => [entry.event, entry.paneId]))}`);

    r.pane.set('working');
    await r.settle();
    r.pane.set('idle', { endsTurn: true, screen: 'the first turn in the new pane\n>' });
    await until('the idle event of the new turn', () => r.published.length === 2);
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle', 'idle']);
    assert.equal(r.published[1]!.paneId, 'w1:p8');
    assert.match(r.published[1]!.text, /the first turn in the new pane/);
  } finally {
    await r.stop();
  }
});

test('a child resumed into a new pane on a harness herdr does not number stays quiet until it works there (issue #271)', async () => {
  const r = await rig(new Pane(undefined));
  try {
    await r.settle();
    r.pane.set('idle', { screen: 'turn one\n>' });
    await until('the first idle', () => r.published.length === 1);

    await cross(r, 'w1:p9', { status: 'unknown' });
    await r.settle();
    r.pane.set('idle');
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle'], 'the resumed prompt is not a turn');

    r.pane.set('working');
    await r.settle();
    r.pane.set('done', { screen: 'the turn the resume brought\n>' });
    await until('one idle for the new turn', () => r.published.length === 2);
    await r.settle();
    assert.deepEqual(events(r), ['idle', 'idle']);
  } finally {
    await r.stop();
  }
});

test('a turn the watcher counted before herdr numbered it gives one idle event when the number arrives later (issue #271)', async () => {
  const r = await rig(new Pane(undefined));
  try {
    await r.settle();
    // herdr ends the turn without a number, then numbers it a moment later in the same done spell.
    r.pane.set('done', { screen: 'one turn\n>' });
    await until('the idle event', () => r.published.length === 1);
    r.pane.seq = 941;
    r.pane.set('done');
    await r.settle();
    r.pane.detected();
    await r.settle();
    r.restartWatcher();
    await r.settle();
    assert.deepEqual(events(r), ['idle'], `one turn gave ${r.published.length} events`);
  } finally {
    await r.stop();
  }
});
