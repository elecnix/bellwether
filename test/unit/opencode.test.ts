// Tier 1: the OpenCode v2 harness. Its session id, its version check, where
// its store is, the MCP configuration a child gets, and the store reads the
// spawn and agent_read rely on, against a fixture database with the tables
// OpenCode 2.4.2 writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OPENCODE_DESIGNED_AGAINST,
  findOpenCodeSession,
  newOpenCodeSessionId,
  openCodeBriefLine,
  openCodeDbPath,
  openCodeLastMessage,
  openCodeMcpConfig,
  openCodeSessionState,
  parseOpenCodeVersion,
  requireOpenCodeV2,
} from '../../src/core/opencode.ts';
import { channelEntry } from '../../src/core/mcp-config.ts';
import { addSession, openCodeStore } from '../fixtures/opencode-db.ts';
import { stablePath } from '../../src/core/stable-path.ts';

function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-opencode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a minted session id has the shape OpenCode 2 mints, and a later one sorts first', () => {
  const older = newOpenCodeSessionId(1_795_771_335_000);
  const newer = newOpenCodeSessionId(1_795_771_336_000);
  assert.match(older, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(newer, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(newer < older, 'OpenCode lists sessions newest first by id, so a newer id sorts lower');
});

test('the version is read through the colour codes OpenCode prints, and only 2.x passes', () => {
  assert.equal(parseOpenCodeVersion('\u001b[1mopencode\u001b[22m \u001b[2mv\u001b[22m\u001b[1m2.4.2\u001b[22m\n'), '2.4.2');
  assert.equal(parseOpenCodeVersion('1.19.6\n'), '1.19.6');
  assert.equal(parseOpenCodeVersion('opencode v0.0.0-dev-202611170722'), '0.0.0-dev-202611170722');
  assert.equal(parseOpenCodeVersion('command not found'), undefined);
  assert.doesNotThrow(() => requireOpenCodeV2({ version: '2.4.2', binary: '/usr/local/bin/opencode' }, 'oc'));
  assert.doesNotThrow(() => requireOpenCodeV2({ version: '2.0.0', binary: 'opencode' }, 'oc'));
  for (const found of ['1.19.6', '0.0.0-dev-202611170722', '3.0.0']) {
    assert.throws(
      () => requireOpenCodeV2({ version: found, binary: '/opt/bin/opencode' }, 'oc'),
      (error: Error) => error.message.includes(`OpenCode ${found}`) && error.message.includes('/opt/bin/opencode') && error.message.includes('OpenCode 2') && error.message.includes(OPENCODE_DESIGNED_AGAINST) && error.message.startsWith('oc was not started'),
    );
  }
  // An opencode this daemon cannot see is left to the store check after the start.
  assert.doesNotThrow(() => requireOpenCodeV2({ missing: 'no opencode on PATH' }, 'oc'));
  // One that answers without a version, as the 2.0 preview's `vlocal` does, is refused with what it printed.
  assert.throws(
    () => requireOpenCodeV2({ unreadable: 'opencode2 vlocal', binary: '/opt/bin/opencode' }, 'oc'),
    (error: Error) => error.message.startsWith('oc was not started') && error.message.includes('/opt/bin/opencode') && error.message.includes('"opencode2 vlocal"') && error.message.includes('OpenCode 2'),
  );
});

test('the store is OPENCODE_DB when set, relative to the data directory, or opencode.db there', () => {
  assert.equal(openCodeDbPath({ OPENCODE_DB: '/var/oc/test.db', HOME: '/home/x' }), '/var/oc/test.db');
  assert.equal(openCodeDbPath({ OPENCODE_DB: 'other.db', XDG_DATA_HOME: '/data' }), '/data/opencode/other.db');
  assert.equal(openCodeDbPath({ XDG_DATA_HOME: '/data' }), '/data/opencode/opencode.db');
  assert.equal(openCodeDbPath({ HOME: '/home/x' }), '/home/x/.local/share/opencode/opencode.db');
});

test('a child gets one local MCP server under mcp.servers, naming its child id', () => {
  const config = openCodeMcpConfig('c-123', { BELLWETHER_PARENT: 'p-1', BELLWETHER_CHILD: 'c-123' });
  const server = config.mcp.servers['bellwether'];
  assert.ok(server, 'no bellwether server in the configuration');
  assert.equal(server.type, 'local');
  assert.deepEqual(server.command, [stablePath(process.execPath), '--disable-warning=ExperimentalWarning', stablePath(channelEntry()), '--child', 'c-123']);
  assert.deepEqual(server.environment, { BELLWETHER_PARENT: 'p-1', BELLWETHER_CHILD: 'c-123' });
});

test('the brief line names the file and has no line break, so herdr takes it as one argument', () => {
  const line = openCodeBriefLine('/work/.bellwether/brief-c-1.md');
  assert.equal(line, 'Your task is in /work/.bellwether/brief-c-1.md. Read it, then do what it says.');
  assert.doesNotMatch(line, /[\n\t]/);
});

test('the lookup finds the top-level session with the id, directory and prompt the spawn gave', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'opencode.db');
  const db = openCodeStore(file);
  const prompt = openCodeBriefLine(path.join(dir, 'brief.md'));
  addSession(db, { id: 'ses_ffff00000001aaaaaaaaaaaaaa', directory: dir, prompt });
  db.close();
  const found = await findOpenCodeSession({ db: file, sessionId: 'ses_ffff00000001aaaaaaaaaaaaaa', cwd: dir, prompt, waitMs: 200, intervalMs: 20 });
  assert.equal(found.id, 'ses_ffff00000001aaaaaaaaaaaaaa');
  assert.equal(found.version, '2.4.2');
});

test('a session that never records the prompt fails after the wait, naming the database', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'opencode.db');
  const db = openCodeStore(file);
  const prompt = openCodeBriefLine(path.join(dir, 'brief.md'));
  // A subagent with the id, a session in another directory, and one without the prompt.
  addSession(db, { id: 'ses_sub', directory: dir, prompt, parentId: 'ses_parent' });
  addSession(db, { id: 'ses_elsewhere', directory: '/somewhere/else', prompt });
  addSession(db, { id: 'ses_silent', directory: dir, prompt: 'something else' });
  db.close();
  // Without the prompt, or without the session, the lookup waits for it, then fails.
  for (const id of ['ses_silent', 'ses_absent']) {
    const started = Date.now();
    await assert.rejects(findOpenCodeSession({ db: file, sessionId: id, cwd: dir, prompt, waitMs: 150, intervalMs: 20 }), (error: Error) => error.message.includes(file) && error.message.includes(id) && /within 150 ms/.test(error.message));
    assert.ok(Date.now() - started >= 150, `the lookup for ${id} waited before it failed`);
  }
  // A subagent or a session elsewhere under the id can never become the child's, so it fails at once.
  await assert.rejects(findOpenCodeSession({ db: file, sessionId: 'ses_sub', cwd: dir, prompt, waitMs: 5_000, intervalMs: 20 }), (error: Error) => error.message.includes(file) && /subagent of ses_parent/.test(error.message));
  await assert.rejects(findOpenCodeSession({ db: file, sessionId: 'ses_elsewhere', cwd: dir, prompt, waitMs: 5_000, intervalMs: 20 }), (error: Error) => error.message.includes(file) && error.message.includes('/somewhere/else'));
});

test('a store without session_v2 is refused as one OpenCode 1.x wrote', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'opencode.db');
  openCodeStore(file, 'v1').close();
  await assert.rejects(findOpenCodeSession({ db: file, sessionId: 'ses_x', cwd: dir, prompt: 'p', waitMs: 100, intervalMs: 20 }), (error: Error) => error.message.includes(file) && /no session_v2 table/.test(error.message) && /OpenCode 1/.test(error.message));
});

test('a session row written by another major version is refused with the version it records', async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'opencode.db');
  const db = openCodeStore(file);
  addSession(db, { id: 'ses_migrated', directory: dir, prompt: 'p', version: '1.19.6' });
  db.close();
  await assert.rejects(findOpenCodeSession({ db: file, sessionId: 'ses_migrated', cwd: dir, prompt: 'p', waitMs: 100, intervalMs: 20 }), (error: Error) => error.message.includes('1.19.6') && error.message.includes('OpenCode 2'));
});

test('a missing store waits and then fails naming the path', async (t) => {
  const file = path.join(scratch(t), 'absent', 'opencode.db');
  await assert.rejects(findOpenCodeSession({ db: file, sessionId: 'ses_x', cwd: '/w', prompt: 'p', waitMs: 100, intervalMs: 20 }), (error: Error) => error.message.includes(file) && /does not exist/.test(error.message));
});

test('the last message is the newest assistant text, or the error that ended the turn', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'opencode.db');
  const db = openCodeStore(file);
  addSession(db, { id: 'ses_done', directory: dir, prompt: 'p', reply: ['First part.', 'Second part.'], busyAt: 10, idleAt: 20, outcome: 'succeeded' });
  addSession(db, { id: 'ses_failed', directory: dir, prompt: 'p', error: 'Free usage limit reached.', busyAt: 10, idleAt: 20, outcome: 'failed' });
  addSession(db, { id: 'ses_quiet', directory: dir, prompt: 'p' });
  db.close();
  assert.equal(openCodeLastMessage(file, 'ses_done'), 'First part.\nSecond part.');
  assert.equal(openCodeLastMessage(file, 'ses_failed'), 'OpenCode ended the turn with an error: Free usage limit reached.');
  assert.equal(openCodeLastMessage(file, 'ses_quiet'), undefined);
  assert.equal(openCodeLastMessage(path.join(dir, 'none.db'), 'ses_done'), undefined);
  assert.deepEqual(openCodeSessionState(file, 'ses_done'), { updatedAt: 20, busy: false, outcome: 'succeeded' });
  assert.equal(openCodeSessionState(file, 'ses_absent'), undefined);
});
