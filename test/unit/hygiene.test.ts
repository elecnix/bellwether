// The keep-or-prune rules for the state under the Bellwether home, and the
// prune that applies them. Each case runs in a scratch home of its own and
// takes its clock as an argument.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHILDLESS_PARENT_IDLE_MS, ORPHAN_FILE_GRACE_MS, PARENT_WITH_CHILDREN_IDLE_MS, childFileVerdict, describeState, parentVerdict, pruneState, readLastPrune, rotateLogs, type ChildFileFacts, type ParentFacts } from '../../src/core/hygiene.ts';
import { Outbox } from '../../src/core/outbox.ts';
import { mcpConfigPath, outboxPath, promptPath, registryPath, relayChildPath, spoolPath } from '../../src/core/paths.ts';
import { emptyParent, saveParent } from '../../src/core/registry.ts';
import type { ChildRecord, ParentRecord } from '../../src/core/types.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function child(id: string, exitedAt?: number): ChildRecord {
  const at = iso(NOW - 10 * DAY);
  return { id, name: id, kind: 'pi', harness: 'pi', paneId: `w1:${id}`, host: 'local', startedAt: at, lastStatus: 'idle', statusChangedAt: at, depth: 1, lastBusyAt: at, ...(exitedAt === undefined ? {} : { exitedAt: iso(exitedAt) }) };
}

function record(session: string, children: ChildRecord[], updatedAt: number): ParentRecord {
  return { ...emptyParent('pi', session, '/tmp'), children, updatedAt: iso(updatedAt) };
}

function facts(parent: ParentRecord, extra: Partial<ParentFacts> = {}): ParentFacts {
  return { record: parent, connected: false, unread: 0, spoolUnread: false, ...extra };
}

function file(extra: Partial<ChildFileFacts>): ChildFileFacts {
  return { childId: 'fake-child', mtimeMs: NOW - 2 * HOUR, live: false, known: false, relayed: false, ...extra };
}

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-hygiene-'));
  process.env['BELLWETHER_HOME'] = root;
  return root;
}

/** Save a record as written at `updatedAt`, which saveParent would stamp with the real clock. */
function persist(parent: ParentRecord): void {
  const updatedAt = parent.updatedAt;
  saveParent(parent);
  fs.writeFileSync(registryPath(parent.id), `${JSON.stringify({ ...parent, updatedAt }, null, 2)}\n`);
}

function write(target: string, text = 'x', mtime?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  if (mtime !== undefined) fs.utimesSync(target, new Date(mtime), new Date(mtime));
}

test('a live parent with a live child is kept, however long ago it last changed', () => {
  const parent = record('live-parent', [child('fake-running')], NOW - 30 * DAY);
  const verdict = parentVerdict(facts(parent), NOW);
  assert.equal(verdict.prune, false);
  assert.match(verdict.reason, /1 child still running/);
});

test('a dead parent with an unread event is kept', () => {
  const parent = record('dead-unread', [child('fake-exited', NOW - 30 * DAY)], NOW - 30 * DAY);
  const verdict = parentVerdict(facts(parent, { unread: 1 }), NOW);
  assert.equal(verdict.prune, false);
  assert.match(verdict.reason, /1 unread event/);
});

test('a dead parent with nothing pending is pruned once its week has passed', () => {
  const parent = record('dead-quiet', [child('fake-exited', NOW - 8 * DAY)], NOW - 8 * DAY);
  assert.equal(parentVerdict(facts(parent), NOW).prune, true);
  // A day short of the week, it stays: a resumed session finds its children by it.
  const recent = record('dead-recent', [child('fake-exited', NOW - 6 * DAY)], NOW - 6 * DAY);
  assert.equal(parentVerdict(facts(recent), NOW).prune, false);
  assert.equal(PARENT_WITH_CHILDREN_IDLE_MS, 7 * DAY);
});

test('a record that never had a child is pruned after an hour, unless its session is connected', () => {
  const parent = record('hello-only', [], NOW - CHILDLESS_PARENT_IDLE_MS - 1);
  assert.equal(parentVerdict(facts(parent), NOW).prune, true);
  assert.equal(parentVerdict(facts(parent, { connected: true }), NOW).prune, false);
  assert.equal(parentVerdict(facts(record('hello-fresh', [], NOW - 10 * 60_000)), NOW).prune, false);
});

test('a pending restart, an unread spool line or a retirement in progress keeps a quiet record', () => {
  const old = NOW - 30 * DAY;
  assert.equal(parentVerdict(facts({ ...record('restart', [], old), restartRequestedAt: iso(old) }), NOW).prune, false);
  assert.equal(parentVerdict(facts(record('spool', [], old), { spoolUnread: true }), NOW).prune, false);
  const retiring = { ...child('fake-retiring', old), retireIntent: { worktree: '/tmp/w', repo: '/tmp/r', branch: 'b', head: 'h' } } as ChildRecord;
  assert.equal(parentVerdict(facts(record('retiring', [retiring], old)), NOW).prune, false);
});

test('a child that exited recently keeps its parent, even when the record itself is older', () => {
  const parent = record('late-exit', [child('fake-exited', NOW - 2 * DAY)], NOW - 30 * DAY);
  assert.equal(parentVerdict(facts(parent), NOW).prune, false);
});

test('a brief whose child is gone is pruned, and one whose child is live is kept', () => {
  assert.equal(childFileVerdict(file({ known: true }), NOW).prune, true);
  assert.equal(childFileVerdict(file({ known: false }), NOW).prune, true);
  assert.equal(childFileVerdict(file({ known: true, live: true }), NOW).prune, false);
});

test('a brief no record names waits an hour, and a relayed child keeps its files', () => {
  assert.equal(childFileVerdict(file({ mtimeMs: NOW - ORPHAN_FILE_GRACE_MS + 60_000 }), NOW).prune, false);
  assert.equal(childFileVerdict(file({ relayed: true, mtimeMs: NOW - 30 * DAY }), NOW).prune, false);
});

test('a prune removes stale records with their outbox and spool, and the files of children that are gone', () => {
  const root = scratch();
  const old = NOW - 8 * DAY;
  const live = record('live-parent', [child('fake-live'), child('fake-done', old)], old);
  // Its spool holds one line the parent has read.
  const dead = { ...record('dead-parent', [child('fake-dead-child', old)], old), spoolOffset: 1 };
  const unread = record('unread-parent', [child('fake-unread-child', old)], old);
  const hello = record('hello-only', [], NOW - 2 * HOUR);
  for (const parent of [live, dead, unread, hello]) persist(parent);
  write(spoolPath(dead.id));
  Outbox.load(dead.id).save(dead.id);
  const box = Outbox.load(unread.id);
  box.offer({ childId: 'fake-unread-child', name: 'fake-unread-child', kind: 'pi', paneId: 'w1:p1', event: 'exited', text: 'exited', at: iso(old) });
  box.save(unread.id);
  for (const id of ['fake-live', 'fake-done', 'fake-dead-child']) {
    write(promptPath(id), 'brief', old);
    write(mcpConfigPath(id), '{}', old);
  }
  write(promptPath('fake-relayed'), 'brief', old);
  write(relayChildPath('fake-relayed'), '{}');
  write(promptPath('fake-spawning'), 'brief', NOW - 60_000);

  const summary = pruneState({ connected: new Set(), now: NOW });

  assert.equal(fs.existsSync(registryPath(live.id)), true);
  assert.equal(fs.existsSync(registryPath(unread.id)), true);
  assert.equal(fs.existsSync(registryPath(dead.id)), false);
  assert.equal(fs.existsSync(registryPath(hello.id)), false);
  assert.equal(fs.existsSync(outboxPath(dead.id)), false);
  assert.equal(fs.existsSync(spoolPath(dead.id)), false);
  assert.equal(fs.existsSync(outboxPath(unread.id)), true);
  assert.equal(fs.existsSync(promptPath('fake-live')), true);
  assert.equal(fs.existsSync(mcpConfigPath('fake-live')), true);
  assert.equal(fs.existsSync(promptPath('fake-done')), false);
  assert.equal(fs.existsSync(mcpConfigPath('fake-dead-child')), false);
  assert.equal(fs.existsSync(promptPath('fake-relayed')), true);
  assert.equal(fs.existsSync(promptPath('fake-spawning')), true);
  assert.deepEqual(summary.parents, { total: 4, removed: 2 });
  assert.deepEqual(summary.briefs, { total: 5, removed: 2 });
  assert.equal(readLastPrune()?.at, iso(NOW));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a dry run reports what would go and removes nothing', () => {
  const root = scratch();
  persist(record('hello-only', [], NOW - 2 * HOUR));
  const summary = pruneState({ connected: new Set(), now: NOW, dryRun: true });
  assert.equal(summary.parents.removed, 1);
  assert.equal(fs.readdirSync(path.join(root, 'parents')).length, 1);
  assert.equal(readLastPrune(), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a log past its cap moves to <name>.1 and starts again with a line that says where', () => {
  const root = scratch();
  const log = path.join(root, 'retire.log');
  write(log, `${'{"line":1}\n'.repeat(20)}`);
  write(path.join(root, 'move.log'), '{"line":1}\n');
  assert.deepEqual(rotateLogs(NOW, 100), ['retire.log']);
  assert.equal(fs.readFileSync(`${log}.1`, 'utf8').split('\n').filter(Boolean).length, 20);
  const fresh = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(fresh.length, 1);
  assert.match(JSON.parse(fresh[0] ?? '{}').rotated, /retire\.log\.1/);
  assert.equal(fs.existsSync(path.join(root, 'move.log.1')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('doctor counts the records, the stale ones, the briefs and the last prune', () => {
  const root = scratch();
  persist(record('live-parent', [child('fake-live')], NOW - 8 * DAY));
  persist(record('hello-only', [], NOW - 2 * HOUR));
  write(promptPath('fake-live'));
  write(promptPath('fake-gone'), 'brief', NOW - 2 * HOUR);
  const before = describeState({ connected: new Set(), now: NOW });
  assert.match(before[0] ?? '', /2 parent records, 1 stale; 2 \(1 for children that are gone\) briefs/);
  assert.match(before.at(-1) ?? '', /prune: none yet/);
  pruneState({ connected: new Set(), now: NOW });
  const after = describeState({ connected: new Set(), now: NOW });
  assert.match(after[0] ?? '', /1 parent record, 0 stale; 1 briefs/);
  assert.match(after.at(-1) ?? '', /prune: last ran 2026-11-27T12:00:00.000Z, removed 1 parent records, 1 briefs/);
  fs.rmSync(root, { recursive: true, force: true });
});
