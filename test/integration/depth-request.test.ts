// Tier 2: a child at its depth ceiling asks for more, up the chain. Three
// sessions share one daemon home: the depth-0 session R, its child A, and A's
// child B. Each test drives the tools as the daemon runs them, against the
// fake herdr, which records the prompts that carry each answer down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { LOCAL_HOST } from '../../src/core/machine.ts';
import { spoolPath } from '../../src/core/paths.ts';
import { emptyParent, readParent, saveParent, upsertChild } from '../../src/core/registry.ts';
import { Watcher } from '../../src/core/watcher.ts';
import type { CallerIdentity, ChildRecord, SpoolReport } from '../../src/core/types.ts';
import { runBellwetherTool, toolsFor, type ToolContext } from '../../src/integrations/tools.ts';
import { startFakeHerdr, type FakeHerdr } from '../fixtures/fake-herdr.ts';

interface Session {
  ctx: ToolContext;
  caller: CallerIdentity;
}

interface Tree {
  herdr: FakeHerdr;
  root: Session;
  a: Session;
  b: Session;
}

function child(id: string, name: string, paneId: string, depth: number, maxDepth: number): ChildRecord {
  const at = new Date().toISOString();
  return { id, name, kind: 'claude', harness: 'claude-code', paneId, host: LOCAL_HOST, startedAt: at, lastStatus: 'working', statusChangedAt: at, lastBusyAt: at, depth, maxDepth };
}

/**
 * R at depth 0 with tree ceiling `tree`, A at depth 1 with ceiling `a`, and B
 * at depth 2 with ceiling 2, so B sits at its ceiling and cannot spawn.
 */
async function tree(t: test.TestContext, ceilings: { tree: number; a: number }): Promise<Tree> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-depth-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = home;
  const herdr = await startFakeHerdr();
  const client = new HerdrClient({ socketPath: herdr.socketPath });
  t.after(async () => {
    await herdr.stop();
    if (previous === undefined) delete process.env['BELLWETHER_HOME'];
    else process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const session = (id: string, depth: number, childId?: string, paneId?: string): Session => {
    const record = saveParent(emptyParent('claude-code', id, home, { depth, paneId, ...(childId ? { childId } : {}), ...(depth === 0 ? { maxDepth: ceilings.tree } : {}) }));
    const ctx: ToolContext = { client, clientFor: async () => client, parentId: record.id, watcher: new Watcher({ client, parentId: record.id, onEntries: () => {} }) };
    return { ctx, caller: { ...(childId ? { childId } : {}), ...(paneId ? { paneId } : {}) } };
  };
  const root = session('root-session', 0, undefined, 'w1:p0');
  const a = session('a-session', 1, 'child-a', 'w1:pA');
  const b = session('b-session', 2, 'child-b', 'w1:pB');
  upsertChild(root.ctx.parentId, child('child-a', 'orchestrator', 'w1:pA', 1, ceilings.a));
  upsertChild(a.ctx.parentId, child('child-b', 'reviewer', 'w1:pB', 2, 2));
  return { herdr, root, a, b };
}

function spool(parentId: string): SpoolReport[] {
  const file = spoolPath(parentId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpoolReport);
}

/** The answers herdr was asked to type into one pane. */
function prompts(herdr: FakeHerdr, paneId: string): string[] {
  return herdr.requests.filter((request) => request.method === 'agent.prompt' && request.params['target'] === paneId).map((request) => String(request.params['text']));
}

function record(session: Session, childId: string): ChildRecord {
  const found = readParent(session.ctx.parentId)?.children.find((entry) => entry.id === childId);
  assert.ok(found, `no child ${childId} in ${session.ctx.parentId}`);
  return found;
}

const spawnGrandchild = (b: Session): Promise<string> => runBellwetherTool(b.ctx, 'agent_spawn', { kind: 'codex', name: 'grandchild', cwd: os.tmpdir() }, b.caller);

test('a child at the limit asks, its parent grants, and the grandchildren spawn', async (t) => {
  const { herdr, a, b } = await tree(t, { tree: 3, a: 3 });
  await assert.rejects(spawnGrandchild(b), /2 levels deep already.*agent_request_depth/s);

  const asked = await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'The review splits into four parts, one reviewer each.' }, b.caller);
  const id = /request (dq-[0-9a-f]+)/.exec(asked)?.[1];
  assert.ok(id, asked);
  assert.match(asked, /Carry on/);
  const [event] = spool(a.ctx.parentId);
  assert.equal(event?.childId, 'child-b');
  assert.equal(event?.status, 'needs-input', 'the request reaches the parent as a report');
  assert.match(event?.text ?? '', /reviewer asks for 1 level more depth, to depth 3: The review splits into four parts/);
  assert.match(event?.text ?? '', /agent_grant_depth child reviewer levels 1/);

  const granted = await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 1 }, a.caller);
  assert.match(granted, /Granted: reviewer may now spawn down to depth 3/);
  assert.equal(record(a, 'child-b').maxDepth, 3);
  assert.match(prompts(herdr, 'w1:pB').join('\n'), new RegExp(`granted your depth request ${id}.*depth 3`, 's'));

  const started = await spawnGrandchild(b);
  assert.match(started, /grandchild started as a codex agent/);
  const grandchild = readParent(b.ctx.parentId)?.children.find((entry) => entry.name === 'grandchild');
  assert.equal(grandchild?.depth, 3);
  assert.equal(grandchild?.maxDepth, 3, 'a grandchild inherits the ceiling its parent was granted, and no more');
});

test('a grant never passes the tree ceiling, and a request at the ceiling is refused by name', async (t) => {
  const { herdr, a, b } = await tree(t, { tree: 2, a: 2 });
  const asked = await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'A third part of the task appeared.' }, b.caller);
  assert.match(asked, /refused at once/);
  assert.match(asked, /ceiling of depth 2 by its depth-0 session claude-code-root-session/);
  assert.match(asked, /Only the person can change that/);
  assert.match(asked, /fewer children/);
  assert.match(asked, /ask the person/);
  assert.deepEqual(spool(a.ctx.parentId), [], 'a request nobody can grant never bothers the parent');
  assert.equal(record(a, 'child-b').depthRequests?.[0]?.state, 'refused');

  // A parent cannot hand out what the tree was never given, even unasked.
  const pushed = await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 4, reason: 'go deep' }, a.caller);
  assert.match(pushed, /past the tree's ceiling of 2/);
  assert.equal(record(a, 'child-b').maxDepth, 2);
  assert.match(prompts(herdr, 'w1:pB').join('\n'), /ceiling of depth 2/);
});

test('a parent with no allowance forwards upward, and the depth-0 grant reaches down and works', async (t) => {
  const { herdr, root, a, b } = await tree(t, { tree: 4, a: 2 });
  const asked = await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'Each module needs its own test writer.' }, b.caller);
  const id = /request (dq-[0-9a-f]+)/.exec(asked)?.[1];
  assert.match(spool(a.ctx.parentId)[0]?.text ?? '', /You can grant up to depth 2 yourself/);

  const forwarded = await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 1 }, a.caller);
  assert.match(forwarded, /went on to this session's parent/);
  assert.equal(record(a, 'child-b').depthRequests?.[0]?.state, 'forwarded');
  assert.equal(record(a, 'child-b').maxDepth, 2, 'nothing lands before the grandparent answers');
  const [up] = spool(root.ctx.parentId);
  assert.equal(up?.childId, 'child-a');
  assert.match(up?.text ?? '', /orchestrator forwards a depth request from its child reviewer \(depth 2\), who needs depth 3: Each module needs its own test writer\./);
  assert.match(up?.text ?? '', /This tree's ceiling is depth 4/);
  const upstream = record(root, 'child-a').depthRequests?.[0];
  assert.equal(upstream?.onBehalfOf?.requestId, id);
  assert.match(upstream?.reason ?? '', /^orchestrator asks on behalf of reviewer: /);

  const granted = await runBellwetherTool(root.ctx, 'agent_grant_depth', { child: 'orchestrator', levels: 2 }, root.caller);
  assert.match(granted, /Granted: orchestrator may now spawn down to depth 3/);
  assert.equal(record(root, 'child-a').maxDepth, 3);
  assert.equal(record(a, 'child-b').maxDepth, 3, 'the grant reaches down to the child that asked');
  assert.equal(record(a, 'child-b').depthRequests?.[0]?.state, 'granted');
  assert.match(prompts(herdr, 'w1:pA').join('\n'), /granted your depth request/);
  assert.match(prompts(herdr, 'w1:pB').join('\n'), new RegExp(`granted your depth request ${id}`));
  assert.match(await spawnGrandchild(b), /grandchild started/);
});

test('a refusal leaves the child working and tells it what to do instead', async (t) => {
  const { herdr, a, b } = await tree(t, { tree: 3, a: 3 });
  await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'Fan out four reviewers.' }, b.caller);
  const refused = await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 0 }, a.caller);
  assert.match(refused, /Refused reviewer's request/);
  const told = prompts(herdr, 'w1:pB').join('\n');
  assert.match(told, /was refused/);
  assert.match(told, /Carry on at the depth you have: do the work with fewer children, or ask the person/);
  const after = record(a, 'child-b');
  assert.equal(after.maxDepth, 2);
  assert.equal(after.exitedAt, undefined);
  assert.equal(after.depthRequests?.[0]?.state, 'refused');
  assert.ok(!herdr.requests.some((request) => ['tab.close', 'pane.close', 'agent.send_keys'].includes(request.method)), 'a refusal never stops or types keys into the child');
});

test('a refusal at the top of the chain reaches the child that asked', async (t) => {
  const { herdr, root, a, b } = await tree(t, { tree: 4, a: 2 });
  await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'Split the migration.' }, b.caller);
  await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 1 }, a.caller);
  await runBellwetherTool(root.ctx, 'agent_grant_depth', { child: 'orchestrator', levels: 0 }, root.caller);
  assert.equal(record(a, 'child-b').depthRequests?.[0]?.state, 'refused');
  assert.match(prompts(herdr, 'w1:pB').join('\n'), /orchestrator forwarded it up the chain, and it went no further.*fewer children/s);
});

test('the audit line records who granted what and why', async (t) => {
  const { a, b } = await tree(t, { tree: 3, a: 3 });
  await runBellwetherTool(b.ctx, 'agent_request_depth', { levels: 1, reason: 'Four reviewers, one per package.' }, b.caller);
  await runBellwetherTool(a.ctx, 'agent_grant_depth', { child: 'reviewer', levels: 1 }, a.caller);
  const [grant, ...rest] = record(a, 'child-b').depthGrants ?? [];
  assert.equal(rest.length, 0);
  assert.equal(grant?.by, 'orchestrator');
  assert.equal(grant?.from, 2);
  assert.equal(grant?.to, 3);
  assert.equal(grant?.levels, 1);
  assert.equal(grant?.reason, 'Four reviewers, one per package.');
  assert.ok(grant && !Number.isNaN(Date.parse(grant.at)));
  const list = await runBellwetherTool(a.ctx, 'agent_list', {}, a.caller);
  assert.match(list, /\t2\/3\t/);
  assert.match(list, /reviewer: ceiling raised from depth 2 to 3 by orchestrator at .* \(request dq-[0-9a-f]+\): Four reviewers, one per package\./);
});

test('a depth-0 session has no one to ask, and the call says so rather than hanging', async (t) => {
  const { root } = await tree(t, { tree: 2, a: 2 });
  assert.ok(!toolsFor({}).some((tool) => tool.name === 'agent_request_depth'), 'the top session is not offered the tool');
  assert.ok(toolsFor({ parent: 'p', child: 'c' }).some((tool) => tool.name === 'agent_request_depth'));
  assert.ok(toolsFor({}).some((tool) => tool.name === 'agent_grant_depth'));
  const answer = await runBellwetherTool(root.ctx, 'agent_request_depth', { levels: 1, reason: 'more' }, root.caller);
  assert.match(answer, /depth-0 session of its tree.*no parent to ask/s);
});

test('a non-root spawn holds max_depth to its own ceiling, and the top session sets the tree', async (t) => {
  const { root, a } = await tree(t, { tree: 2, a: 2 });
  const held = await runBellwetherTool(a.ctx, 'agent_spawn', { kind: 'codex', name: 'deep', cwd: os.tmpdir(), max_depth: 9 }, a.caller);
  assert.match(held, /max_depth 9 is past this session's own ceiling of 2, so the child got 2/);
  assert.equal(readParent(a.ctx.parentId)?.children.find((entry) => entry.name === 'deep')?.maxDepth, 2);
  await runBellwetherTool(root.ctx, 'agent_spawn', { kind: 'codex', name: 'wide', cwd: os.tmpdir(), max_depth: 5 }, root.caller);
  assert.equal(readParent(root.ctx.parentId)?.maxDepth, 5);
});
