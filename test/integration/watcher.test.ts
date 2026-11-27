// Tier 2: the watcher against the fake herdr socket, in a scratch home. Each
// case seeds a registry, starts the watcher and reads what it put in the
// outbox, which is the text the parent receives.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeBrief } from '../../src/core/brief.ts';
import { writeMcpConfig } from '../../src/core/mcp-config.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { emptyParent, saveParent, updateChild } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, OutboxEntry } from '../../src/core/types.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function child(id: string, name: string, paneId: string): ChildRecord {
  const long = new Date(Date.now() - 60_000).toISOString();
  return { id, name, kind: 'claude', harness: 'claude-code', paneId, host: 'local', startedAt: long, lastStatus: 'working', statusChangedAt: long, lastBusyAt: long, depth: 1 };
}

test('an exit names the child by its pane, removes its MCP config, and keeps a brief only when nothing shows the child read it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-watcher-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr();
  const parent = emptyParent('pi', 'watcher-label', home);
  // The fake herdr lists no panes, so both children count as gone.
  // aaaa1111 reported after its brief, so it read it; bbbb2222 never did (issue #132).
  const reported = { ...child('aaaa1111', 'npm-publish', 'w74:pJ'), lastReport: { status: 'done' as const, text: 'published', at: new Date(Date.now() + 60_000).toISOString(), seq: 1 } };
  parent.children.push(reported, child('bbbb2222', 'npm-publish', 'w74:pK'));
  saveParent(parent);
  const read = writeBrief('aaaa1111', 'the brief');
  const unread = writeBrief('bbbb2222', 'the brief');
  const configs = parent.children.map((entry) => writeMcpConfig(entry.id));
  let entries: OutboxEntry[] = [];
  const watcher = new Watcher({ client: new HerdrClient({ socketPath: herdr.socketPath }), parentId: parent.id, onEntries: (next) => (entries = next), tickMs: 60_000 });
  try {
    watcher.start();
    await until('two exit events', () => (entries.length === 2 ? entries : undefined));
    const firstLines = entries.map((entry) => entry.text.split('\n')[0]).sort();
    assert.deepEqual(firstLines, ['npm-publish (w74:pJ) exited.', 'npm-publish (w74:pK) exited.']);
    // A child that exits takes its MCP config, and its brief once it has read it.
    assert.deepEqual(configs.filter((file) => fs.existsSync(file)), []);
    assert.equal(fs.existsSync(read), false);
    assert.equal(fs.readFileSync(unread, 'utf8'), 'the brief', 'a brief nothing shows the child read stays for a resume');
  } finally {
    watcher.stop();
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an exit of a child on another machine removes its brief and MCP config there', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-watcher-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr();
  const parent = emptyParent('pi', 'watcher-remote', home);
  parent.children.push({ ...child('cccc3333', 'far-child', 'w2:p3'), host: 'remote-box' });
  saveParent(parent);
  const cleaned: string[] = [];
  let entries: OutboxEntry[] = [];
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  const watcher = new Watcher({ client, clientFor: async () => client, parentId: parent.id, onEntries: (next) => (entries = next), tickMs: 60_000, cleanupRemote: async (gone) => void cleaned.push(`${gone.host}:${gone.id}`) });
  try {
    watcher.start();
    await until('the exit event', () => (entries.length === 1 ? entries : undefined));
    assert.deepEqual(cleaned, ['remote-box:cccc3333']);
  } finally {
    watcher.stop();
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a child whose spawn is answering its dialogs produces no blocked event until the hold ends', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-watcher-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr();
  const parent = emptyParent('pi', 'watcher-hold', home);
  const now = new Date().toISOString();
  // Started a moment ago, so the watcher keeps it although herdr lists no pane.
  const held: ChildRecord = { ...child('cccc3333', 'worker', 'w1:p9'), startedAt: now, statusChangedAt: now, lastStatus: 'blocked', startingUntil: new Date(Date.now() + 60_000).toISOString() };
  parent.children.push(held);
  saveParent(parent);
  let entries: OutboxEntry[] = [];
  const watcher = new Watcher({
    client: new HerdrClient({ socketPath: herdr.socketPath }),
    parentId: parent.id,
    onEntries: (next) => (entries = next),
    tickMs: 20,
    screenPollMs: 0,
    limits: { idleMs: 10, blockedMs: 10, stuckMs: 60_000 },
  });
  try {
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(entries, []);
    updateChild(parent.id, held.id, (entry) => {
      delete entry.startingUntil;
    });
    const blocked = await until('the blocked event', () => entries.find((entry) => entry.event === 'blocked'));
    assert.match(blocked.text, /^worker \(w1:p9\) is blocked/);
  } finally {
    watcher.stop();
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A scratch home with a parent that holds one pi child, started a minute ago, that herdr has never seen run. */
function freshChild(session: string, paneId: string): { home: string; parentId: string; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-watcher-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const parent = emptyParent('pi', session, home);
  const long = new Date(Date.now() - 60_000).toISOString();
  parent.children.push({ id: 'dddd4444', name: 'briefless', kind: 'pi', harness: 'pi', paneId, tabId: 'w1:t4', host: 'local', origin: 'spawn', startedAt: long, lastStatus: 'unknown', statusChangedAt: long, lastBusyAt: long, depth: 1 });
  saveParent(parent);
  return {
    home,
    parentId: parent.id,
    restore: () => {
      if (previous === undefined) delete process.env['BELLWETHER_HOME'];
      else process.env['BELLWETHER_HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a child whose harness herdr releases before it reported anything is reported once, as never started', async () => {
  const space = freshChild('watcher-released', 'w1:p4');
  // The pane outlives the harness: herdr lists it, with its shell.
  const herdr = await startFakeHerdr({
    respond: (request) => (request.method === 'pane.list' ? { result: { type: 'pane_list', panes: [{ pane_id: 'w1:p4', tab_id: 'w1:t4', agent_status: 'unknown' }] } } : undefined),
  });
  let entries: OutboxEntry[] = [];
  const watcher = new Watcher({ client: new HerdrClient({ socketPath: herdr.socketPath }), parentId: space.parentId, onEntries: (next) => (entries = next), tickMs: 60_000, screenPollMs: 0, startConfirmMs: 3_600_000 });
  try {
    watcher.start();
    await herdr.waitFor('events.subscribe');
    // What herdr 0.9.5 sends when `pi @<missing file>` exits after its detection.
    herdr.send({ event: 'pane_agent_detected', data: { agent: 'pi', final_status: 'idle', pane_id: 'w1:p4', released: true, type: 'pane_agent_detected', workspace_id: 'w1' } });
    herdr.send({ event: 'pane.agent_status_changed', data: { agent: 'pi', agent_status: 'idle', pane_id: 'w1:p4', workspace_id: 'w1' } });
    const exited = await until('the exit event', () => entries.find((entry) => entry.event === 'exited'));
    assert.match(exited.text, /^briefless \(w1:p4\) never started: its pi process ended before it reported anything, so it did not run its task\./);
    assert.match(exited.text, /Its tab stays open/);
    // The idle status that follows the release, and the tab closing later, add nothing.
    herdr.send({ event: 'tab_closed', data: { tab_id: 'w1:t4' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(entries.map((entry) => entry.event), ['exited']);
  } finally {
    watcher.stop();
    await herdr.stop();
    space.restore();
  }
});

test('a child whose harness ended before herdr detected it is reported as never started, and a live one is not', async () => {
  const space = freshChild('watcher-undetected', 'w1:p4');
  // herdr keeps the launched agent pending with no harness detected, and the
  // pane's foreground process group is its shell's, as `pane.process_info` says.
  let foreground = 7001;
  const herdr = await startFakeHerdr({
    respond: (request) => {
      if (request.method === 'pane.list') return { result: { type: 'pane_list', panes: [{ pane_id: 'w1:p4', tab_id: 'w1:t4', agent_status: 'unknown' }] } };
      if (request.method === 'agent.get') return { result: { type: 'agent_info', agent: { pane_id: 'w1:p4', name: 'briefless', agent_status: 'unknown', launch_pending: true } } };
      if (request.method === 'pane.process_info') return { result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p4', shell_pid: 7000, foreground_process_group_id: foreground, foreground_processes: [] } } };
      return undefined;
    },
  });
  let entries: OutboxEntry[] = [];
  const watcher = new Watcher({ client: new HerdrClient({ socketPath: herdr.socketPath }), parentId: space.parentId, onEntries: (next) => (entries = next), tickMs: 20, screenPollMs: 0, startConfirmMs: 1_000 });
  try {
    // First, a harness still in the foreground: checked once, and left alone.
    watcher.start();
    await herdr.waitFor('pane.process_info');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(entries, []);
    assert.equal(herdr.requests.filter((request) => request.method === 'pane.process_info').length, 1, 'the check runs once, not on every tick');
    watcher.stop();

    // Then a new watcher, as after a daemon restart, on a pane whose shell is back in the foreground.
    foreground = 7000;
    const again = new Watcher({ client: new HerdrClient({ socketPath: herdr.socketPath }), parentId: space.parentId, onEntries: (next) => (entries = next), tickMs: 20, screenPollMs: 0, startConfirmMs: 1_000 });
    again.start();
    try {
      const exited = await until('the exit event', () => entries.find((entry) => entry.event === 'exited'));
      assert.match(exited.text, /^briefless \(w1:p4\) never started: its pi process ended before it reported anything/);
    } finally {
      again.stop();
    }
  } finally {
    watcher.stop();
    await herdr.stop();
    space.restore();
  }
});
