// Tier 1: the kilo entry's pure parts. The store lookup and the readers run
// against a fixture store with the tables Kilo CLI 7.8.40 creates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { harnessFor } from '../../src/core/harnesses/index.ts';
import { findKiloSession, isScript, kiloBriefLine, kiloDbPath, kiloLastMessage, kiloMcpConfig, kiloSessionState, parseKiloVersion, requireKilo } from '../../src/core/harnesses/kilo-store.ts';
import { addKiloSession, kiloStore } from '../fixtures/kilo-db.ts';

function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-kilo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the store is KILO_DB, relative to the data directory, or kilo.db there', () => {
  assert.equal(kiloDbPath({ HOME: '/home/example' }), '/home/example/.local/share/kilo/kilo.db');
  assert.equal(kiloDbPath({ HOME: '/home/example', XDG_DATA_HOME: '/data' }), '/data/kilo/kilo.db');
  assert.equal(kiloDbPath({ HOME: '/home/example', KILO_DB: 'other.db' }), '/home/example/.local/share/kilo/other.db');
  assert.equal(kiloDbPath({ HOME: '/home/example', KILO_DB: '/abs/child.db' }), '/abs/child.db');
});

test('the launch line puts the model, the resume and the brief before the caller\'s own arguments', () => {
  const entry = harnessFor('kilo')!;
  assert.deepEqual(entry.launchArgs({ model: 'example/fake-model', files: { briefFile: '/w/.bellwether/brief-1.md' }, extra: ['--agent', 'code'] }), ['--model', 'example/fake-model', '--prompt', kiloBriefLine('/w/.bellwether/brief-1.md'), '--agent', 'code']);
  assert.deepEqual(entry.launchArgs({ files: {}, resume: entry.resume!.args({ kind: 'id', value: 'ses_example' }) }), ['--session', 'ses_example']);
  assert.deepEqual(entry.launchArgs({ model: 'example/a', files: {}, extra: ['--model', 'example/b'] }), ['--model', 'example/b']);
});

test('the child configuration lists one local server, Bellwether\'s, with the child id and its environment', () => {
  const config = kiloMcpConfig('child-1', { BELLWETHER_PARENT: 'p' });
  const server = config.mcp['bellwether'];
  assert.equal(server?.type, 'local');
  assert.deepEqual(server?.command.slice(-2), ['--child', 'child-1']);
  assert.deepEqual(server?.environment, { BELLWETHER_PARENT: 'p' });
  assert.deepEqual(Object.keys(config.mcp), ['bellwether']);
});

test('npm\'s Node launcher is refused, because herdr would never detect the child it starts', (t) => {
  const dir = scratch(t);
  const launcher = path.join(dir, 'kilo');
  fs.writeFileSync(launcher, '#!/usr/bin/env node\nrequire("child_process")\n', { mode: 0o755 });
  const native = path.join(dir, 'native');
  fs.writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  assert.equal(isScript(launcher), true);
  assert.equal(isScript(native), false);
  assert.throws(() => requireKilo({ version: '7.8.40', binary: launcher, launcher }, 'w'), (error: Error) => /herdr detects kilo by its process name/.test(error.message) && error.message.includes('.kilo'));
});

test('a kilo that is not Kilo CLI 7 is refused naming both versions, and a kilo the daemon cannot see is left to the store check', () => {
  assert.throws(() => requireKilo({ version: '6.2.0', binary: '/opt/kilo' }, 'w'), /Kilo CLI 6\.2\.0.*needs Kilo CLI 7/);
  assert.throws(() => requireKilo({ unreadable: 'vlocal', binary: '/opt/kilo' }, 'w'), /names no version/);
  requireKilo({ version: '7.8.40', binary: '/opt/kilo' }, 'w');
  requireKilo({ missing: 'no kilo' }, 'w');
  assert.equal(parseKiloVersion('7.8.40\n'), '7.8.40');
});

test('the lookup finds the top-level session in the child\'s directory, after the spawn, holding the brief line', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'kilo.db');
  const cwd = path.join(dir, 'work');
  const since = Date.now();
  const line = kiloBriefLine(path.join(cwd, '.bellwether', 'brief-abc.md'));
  const db = kiloStore(file);
  addKiloSession(db, { id: 'ses_old', directory: cwd, prompt: line, createdAt: since - 60_000 });
  addKiloSession(db, { id: 'ses_elsewhere', directory: '/other', prompt: line, createdAt: since + 10 });
  addKiloSession(db, { id: 'ses_sub', directory: cwd, prompt: line, parentId: 'ses_x', createdAt: since + 10 });
  addKiloSession(db, { id: 'ses_other_prompt', directory: cwd, prompt: 'something else', createdAt: since + 10 });
  addKiloSession(db, { id: 'ses_child', directory: cwd, prompt: line, createdAt: since + 20 });
  db.close();
  assert.equal(await findKiloSession({ db: file, cwd, prompt: line, since, waitMs: 50, intervalMs: 10 }), 'ses_child');
});

test('a session that never shows fails naming the store and what the last look saw', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'kilo.db');
  await assert.rejects(findKiloSession({ db: file, cwd: dir, prompt: 'x', since: Date.now(), waitMs: 30, intervalMs: 10 }), (error: Error) => error.message.includes(file) && /does not exist/.test(error.message));
  const db = kiloStore(file);
  addKiloSession(db, { id: 'ses_other', directory: dir, prompt: 'not it' });
  db.close();
  await assert.rejects(findKiloSession({ db: file, cwd: dir, prompt: 'the line', since: Date.now() - 1000, waitMs: 30, intervalMs: 10 }), /none holds a user message with the brief's prompt/);
});

test('a session written by another major version does not count', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'kilo.db');
  const db = kiloStore(file);
  addKiloSession(db, { id: 'ses_v8', directory: dir, prompt: 'line', version: '8.0.0' });
  db.close();
  await assert.rejects(findKiloSession({ db: file, cwd: dir, prompt: 'line', since: Date.now() - 1000, waitMs: 30, intervalMs: 10 }), /Kilo CLI 8\.0\.0/);
});

test('the last answer, the error that ended a turn, and whether a turn runs come from the store', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'kilo.db');
  const db = kiloStore(file);
  addKiloSession(db, { id: 'ses_done', directory: dir, prompt: 'p', reply: ['The fix is in.', 'Tests pass.'] });
  addKiloSession(db, { id: 'ses_failed', directory: dir, prompt: 'p', error: 'example rate limit' });
  addKiloSession(db, { id: 'ses_busy', directory: dir, prompt: 'p', busy: true });
  db.close();
  assert.equal(kiloLastMessage(file, 'ses_done'), 'The fix is in.\nTests pass.');
  assert.equal(kiloLastMessage(file, 'ses_failed'), 'Kilo ended the turn with an error: example rate limit');
  assert.equal(kiloLastMessage(file, 'ses_busy'), undefined);
  assert.equal(kiloLastMessage(file, 'ses_none'), undefined);
  assert.equal(kiloLastMessage(path.join(dir, 'absent.db'), 'ses_done'), undefined);
  assert.equal(kiloSessionState(file, 'ses_busy')?.busy, true);
  assert.equal(kiloSessionState(file, 'ses_done')?.busy, false);
  assert.ok((kiloSessionState(file, 'ses_done')?.updatedAt ?? 0) > 0);
  assert.equal(kiloSessionState(file, 'ses_none'), undefined);
});
