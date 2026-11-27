// Tier 2: parent_report as the daemon runs it. The daemon serves every session
// on the machine, so it resolves the reporting child from the caller identity
// a call carries and the child record it holds, never from its own environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { mcpDir, spoolPath } from '../../src/core/paths.ts';
import { emptyParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { ChildRecord, SpoolReport } from '../../src/core/types.ts';
import { runBellwetherTool, type ToolContext } from '../../src/integrations/tools.ts';

const IDENTITY = ['BELLWETHER_PARENT', 'BELLWETHER_CHILD', 'BELLWETHER_CHILD_NAME', 'BELLWETHER_DEPTH', 'BELLWETHER_HARNESS', 'HERDR_PANE_ID'];

/** A scratch home, and a daemon environment that names somebody else entirely. */
function scratch(t: test.TestContext): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-report-'));
  const saved = Object.fromEntries(['BELLWETHER_HOME', ...IDENTITY].map((key) => [key, process.env[key]]));
  process.env['BELLWETHER_HOME'] = root;
  // Whatever session started the daemon left its own identity behind.
  process.env['BELLWETHER_PARENT'] = 'claude-code-impostor';
  process.env['BELLWETHER_CHILD'] = 'impostor-child';
  process.env['BELLWETHER_CHILD_NAME'] = 'impostor';
  process.env['HERDR_PANE_ID'] = 'w0:p0';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function child(id: string, name: string, paneId: string): ChildRecord {
  const at = new Date().toISOString();
  return { id, name, kind: 'claude', harness: 'claude-code', paneId, host: LOCAL_HOST, startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth: 1 };
}

/** The tool context of the child's own session, which is a parent in its own right. */
function childSession(session: string): ToolContext {
  const parentId = saveParent(emptyParent('claude-code', session, '/work', { depth: 1 })).id;
  const client = new HerdrClient({ socketPath: '/nonexistent/herdr.sock' });
  return { client, clientFor: async () => client, parentId, watcher: new Watcher({ client, parentId, onEntries: () => {} }) };
}

function spool(parentId: string): SpoolReport[] {
  const file = spoolPath(parentId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpoolReport);
}

test('a report goes to the parent that holds the child record, whatever the daemon environment says', async (t) => {
  scratch(t);
  const parent = saveParent(emptyParent('claude-code', 'the-parent', '/work', { paneId: 'w1:p1' }));
  upsertChild(parent.id, child('c-real', 'reporter', 'w1:p5'));
  const text = await runBellwetherTool(childSession('child-session'), 'parent_report', { status: 'done', text: 'shipped' }, { childId: 'c-real', paneId: 'w1:p5' });
  assert.match(text, /Reported done to the parent/);
  const [report, ...rest] = spool(parent.id);
  assert.equal(rest.length, 0);
  assert.equal(report?.childId, 'c-real');
  assert.equal(report?.childName, 'reporter', 'the name comes from the record, not the environment');
  assert.equal(report?.paneId, 'w1:p5');
  assert.equal(report?.parentPaneId, 'w1:p1');
  assert.deepEqual(spool('claude-code-impostor'), [], 'nothing reaches the parent the daemon environment names');
});

test('a caller with only its pane is resolved to the child that holds that pane', async (t) => {
  scratch(t);
  const parent = saveParent(emptyParent('pi', 'pane-parent', '/work'));
  upsertChild(parent.id, child('c-pane', 'by-pane', 'w2:p8'));
  await runBellwetherTool(childSession('pane-child'), 'parent_report', { status: 'progress', text: 'halfway' }, { paneId: 'w2:p8' });
  assert.equal(spool(parent.id)[0]?.childId, 'c-pane');
});

test('two clients of one child reach the same parent', async (t) => {
  scratch(t);
  const parent = saveParent(emptyParent('claude-code', 'two-clients', '/work'));
  upsertChild(parent.id, child('c-two', 'twice', 'w3:p2'));
  // One server came from the spawn's MCP file, the other from a user-level entry.
  await runBellwetherTool(childSession('two-a'), 'parent_report', { status: 'progress', text: 'from the spawn server' }, { childId: 'c-two', paneId: 'w3:p2' });
  await runBellwetherTool(childSession('two-b'), 'parent_report', { status: 'done', text: 'from the user server' }, { paneId: 'w3:p2' });
  assert.deepEqual(spool(parent.id).map((entry) => [entry.childId, entry.text]), [['c-two', 'from the spawn server'], ['c-two', 'from the user server']]);
});

test('a report with no child identity names the pane and the file the spawn should have provided', async (t) => {
  scratch(t);
  await assert.rejects(runBellwetherTool(childSession('lost'), 'parent_report', { status: 'done', text: 'x' }, { paneId: 'w9:pZ' }), (error: Error) => {
    assert.match(error.message, /pane w9:pZ/);
    assert.ok(error.message.includes(path.join(mcpDir(), '<child id>.json')), error.message);
    assert.ok(!error.message.includes('impostor'), 'the daemon environment plays no part');
    return true;
  });
  await assert.rejects(runBellwetherTool(childSession('nowhere'), 'parent_report', { status: 'done', text: 'x' }, {}), /not in a herdr pane/);
});

test('a child id and a pane that disagree are refused, naming both', async (t) => {
  scratch(t);
  const parent = saveParent(emptyParent('claude-code', 'disagree', '/work'));
  upsertChild(parent.id, child('c-one', 'one', 'w4:p1'));
  await assert.rejects(runBellwetherTool(childSession('disagree-child'), 'parent_report', { status: 'done', text: 'x' }, { childId: 'c-one', paneId: 'w4:p7' }), /c-one.*w4:p1.*w4:p7/s);
  assert.deepEqual(spool(parent.id), []);
});
