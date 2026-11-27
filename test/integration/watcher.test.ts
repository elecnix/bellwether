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

test('an exit names the child by its pane, and removes its brief and MCP config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-watcher-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr();
  const parent = emptyParent('pi', 'watcher-label', home);
  // The fake herdr lists no panes, so both children count as gone.
  parent.children.push(child('aaaa1111', 'npm-publish', 'w74:pJ'), child('bbbb2222', 'npm-publish', 'w74:pK'));
  saveParent(parent);
  const briefs = parent.children.flatMap((entry) => [writeBrief(entry.id, 'the brief'), writeMcpConfig(entry.id)]);
  let entries: OutboxEntry[] = [];
  const watcher = new Watcher({ client: new HerdrClient({ socketPath: herdr.socketPath }), parentId: parent.id, onEntries: (next) => (entries = next), tickMs: 60_000 });
  try {
    watcher.start();
    await until('two exit events', () => (entries.length === 2 ? entries : undefined));
    const firstLines = entries.map((entry) => entry.text.split('\n')[0]).sort();
    assert.deepEqual(firstLines, ['npm-publish (w74:pJ) exited.', 'npm-publish (w74:pK) exited.']);
    // A child that exits takes its brief with it.
    assert.deepEqual(briefs.filter((file) => fs.existsSync(file)), []);
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
