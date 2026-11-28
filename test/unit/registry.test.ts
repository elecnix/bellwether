// The registry writes one JSON file per parent session before herdr creates
// anything, so a crash still leaves a trace of what was asked for, and a
// resumed session reads the same file back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newChildId } from '../../src/core/outbox.ts';
import { registryPath } from '../../src/core/paths.ts';
import { childById, emptyParent, listParents, migrateParent, readParent, saveParent, slug, updateChild, upsertChild } from '../../src/core/registry.ts';
import type { ChildRecord } from '../../src/core/types.ts';
import { statusSeen } from '../../src/core/incarnation.ts';

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-registry-'));
  process.env['BELLWETHER_HOME'] = root;
  return root;
}

function child(name: string): ChildRecord {
  const at = new Date(0).toISOString();
  return {
    id: newChildId(),
    name,
    kind: 'pi',
    harness: 'pi',
    paneId: `w1:p-${name}`,
    host: 'local',
    startedAt: at,
    lastStatus: 'unknown',
    statusChangedAt: at,
    lastBusyAt: at,
    depth: 1,
  };
}

test('a parent round-trips through its registry file', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-one', '/work'));
  const read = readParent(parent.id);
  assert.equal(read?.id, parent.id);
  assert.equal(read?.session, 'session-one');
  assert.deepEqual(read?.children, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a child record lands before anything else happens', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-two', '/work'));
  const record = child('reviewer');
  upsertChild(parent.id, record);

  const read = readParent(parent.id);
  assert.equal(read?.children.length, 1);
  assert.equal(read?.children[0]?.name, 'reviewer');
  assert.equal(read?.children[0]?.paneId, record.paneId);
  fs.rmSync(root, { recursive: true, force: true });
});

test('upsert replaces the same child instead of duplicating it', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-three', '/work'));
  const record = child('reviewer');
  upsertChild(parent.id, record);
  upsertChild(parent.id, { ...record, lastStatus: 'working' });

  const read = readParent(parent.id);
  assert.equal(read?.children.length, 1);
  assert.equal(read?.children[0]?.lastStatus, 'working');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a child is found by id, by name and by pane', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-four', '/work'));
  const record = child('reviewer');
  upsertChild(parent.id, record);

  const read = readParent(parent.id);
  assert.ok(read);
  assert.equal(childById(read, record.id)?.name, 'reviewer');
  assert.equal(childById(read, 'reviewer')?.id, record.id);
  assert.equal(childById(read, record.paneId)?.id, record.id);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateChild changes one field and keeps the rest', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-five', '/work'));
  const record = child('reviewer');
  upsertChild(parent.id, record);
  updateChild(parent.id, record.id, (entry) => {
    statusSeen(entry, 'blocked');
  });

  const read = readParent(parent.id);
  assert.equal(read?.children[0]?.lastStatus, 'blocked');
  assert.equal(read?.children[0]?.name, 'reviewer');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a malformed registry file reads as absent rather than throwing', () => {
  const root = scratch();
  const parent = saveParent(emptyParent('pi', 'session-six', '/work'));
  fs.writeFileSync(registryPath(parent.id), '{ this is not json');
  assert.equal(readParent(parent.id), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('listParents returns every parent on disk', () => {
  const root = scratch();
  saveParent(emptyParent('pi', 'session-seven', '/work'));
  saveParent(emptyParent('pi', 'session-eight', '/work'));
  assert.equal(listParents().length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a resumed session writes to the same file, not a new one', () => {
  const root = scratch();
  const first = saveParent(emptyParent('pi', 'session-nine', '/work'));
  const again = saveParent(emptyParent('pi', 'session-nine', '/other'));
  assert.equal(first.id, again.id);
  assert.equal(listParents().length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a slug never carries a path separator', () => {
  assert.equal(slug('a/b'), 'a-b');
  assert.equal(slug('../escape').includes('/'), false);
  assert.notEqual(slug('../escape'), '..');
});

test('an older registry file loads, gains the host and schema, and keeps them on the next write', () => {
  const root = scratch();
  const id = 'pi-old-session';
  const at = new Date(0).toISOString();
  const old = {
    id,
    harness: 'pi',
    session: 'old-session',
    host: 'laptop',
    cwd: '/work',
    depth: 0,
    updatedAt: at,
    children: [{ id: 'c1', name: 'old', kind: 'pi', harness: 'pi', paneId: 'w1:p1', startedAt: at, lastStatus: 'idle', statusChangedAt: at, lastBusyAt: at, depth: 1, transcript: '/t/old.jsonl', exitedAt: at }],
  };
  fs.mkdirSync(path.dirname(registryPath(id)), { recursive: true });
  fs.writeFileSync(registryPath(id), JSON.stringify(old));

  const read = readParent(id);
  assert.equal(read?.schema, 2);
  assert.equal(read?.children[0]?.host, 'local');
  assert.equal(read?.children[0]?.transcript, '/t/old.jsonl', 'existing fields stay as they were');
  assert.equal(read?.children[0]?.exitedAt, at);
  assert.equal(JSON.parse(fs.readFileSync(registryPath(id), 'utf8')).schema, undefined, 'a read does not write the file');

  saveParent(read!);
  const written = JSON.parse(fs.readFileSync(registryPath(id), 'utf8')) as { schema: number; children: { host: string }[] };
  assert.equal(written.schema, 2);
  assert.equal(written.children[0]?.host, 'local');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the migration runs twice without changing a record it already migrated', () => {
  const root = scratch();
  const parent = emptyParent('pi', 'twice', '/work');
  parent.children.push({ ...child('far'), host: 'hawthorne' });
  const once = structuredClone(migrateParent(structuredClone(parent)));
  const twice = migrateParent(structuredClone(once));
  assert.deepEqual(twice, once);
  assert.equal(twice.children[0]?.host, 'hawthorne', 'a recorded host is never rewritten');
  fs.rmSync(root, { recursive: true, force: true });
});
