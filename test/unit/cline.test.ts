// Tier 1: the Cline entry's store reads, against a fixture store with the
// `sessions` table Cline 3.0.76 writes: where the store is, the session a
// spawn finds by directory, start time and prompt, the live session of an
// adopted pane, and the last answer and state agent_read and the watcher use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { channelEntry } from '../../src/core/mcp-config.ts';
import { CLINE_OPT_IN_NOTE, clineDbPath, clineLastMessage, clineMcpSettings, clineOptedIn, clineProviderSettingsPath, clineSandboxNote, clineSessionState, clineSettingsDir, findClineSession, liveClineSession } from '../../src/core/harnesses/cline.ts';
import { addClineSession, clineStore } from '../fixtures/cline-db.ts';
import { stablePath } from '../../src/core/stable-path.ts';

function scratch(t: test.TestContext): { dir: string; db: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-cline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  return { dir, db: path.join(dir, 'data', 'db', 'sessions.db'), cwd };
}

const LINE = 'Your task is in /tmp/brief.md. Read it, then do what it says.';

test("the store is where Cline's own rule puts it", () => {
  assert.equal(clineDbPath({ HOME: '/home/u' }), '/home/u/.cline/data/db/sessions.db');
  assert.equal(clineDbPath({ HOME: '/home/u', CLINE_DIR: '/c' }), '/c/data/db/sessions.db');
  assert.equal(clineDbPath({ HOME: '/home/u', CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }), '/d/db/sessions.db');
  assert.equal(clineDbPath({ HOME: '/home/u', CLINE_DATA_DIR: '/d', CLINE_DB_DATA_DIR: '/e' }), '/e/sessions.db');
});

test('a spawn finds the newest top-level session in its directory since its start that holds the brief line', async (t) => {
  const { db, cwd, dir } = scratch(t);
  const store = clineStore(db);
  // An older run in the same directory, a sub-agent, another directory and a session without the prompt do not count.
  addClineSession(store, db, { id: 'old', cwd, prompt: LINE, startedAt: '2026-11-27T10:00:00.000Z' });
  addClineSession(store, db, { id: 'sub', cwd, prompt: LINE, startedAt: '2026-11-27T11:00:02.000Z', subagent: true });
  addClineSession(store, db, { id: 'elsewhere', cwd: dir, prompt: LINE, startedAt: '2026-11-27T11:00:03.000Z' });
  addClineSession(store, db, { id: 'other', cwd, prompt: 'something else', startedAt: '2026-11-27T11:00:04.000Z' });
  addClineSession(store, db, { id: 'mine', cwd, prompt: LINE, startedAt: '2026-11-27T11:00:01.000Z' });
  store.close();
  assert.equal(await findClineSession({ db, cwd, prompt: LINE, since: '2026-11-27T11:00:00.000Z', waitMs: 50, intervalMs: 10 }), 'mine');
});

test('a spawn whose session never shows fails with the store path and what the last look saw', async (t) => {
  const { db, cwd } = scratch(t);
  await assert.rejects(findClineSession({ db, cwd, prompt: LINE, since: '2026-11-27T11:00:00.000Z', waitMs: 40, intervalMs: 10 }), (error: Error) => error.message.includes(db) && /does not exist/.test(error.message));
  const store = clineStore(db);
  addClineSession(store, db, { id: 'other', cwd, prompt: 'something else', startedAt: '2026-11-27T11:00:04.000Z' });
  store.close();
  await assert.rejects(findClineSession({ db, cwd, prompt: LINE, since: '2026-11-27T11:00:00.000Z', waitMs: 40, intervalMs: 10 }), (error: Error) => error.message.includes(db) && /none holds the brief's prompt/.test(error.message));
});

test("an adopted pane's session is the live one its process records, else the newest live one in its directory", (t) => {
  const { db, cwd } = scratch(t);
  const store = clineStore(db);
  addClineSession(store, db, { id: 'ended', cwd, prompt: 'a', startedAt: '2026-11-27T12:00:00.000Z', endedAt: '2026-11-27T12:05:00.000Z', pid: 7 });
  addClineSession(store, db, { id: 'by-pid', cwd, prompt: 'b', startedAt: '2026-11-27T10:00:00.000Z', pid: 7 });
  addClineSession(store, db, { id: 'newest', cwd, prompt: 'c', startedAt: '2026-11-27T11:00:00.000Z', pid: 9 });
  store.close();
  assert.equal(liveClineSession({ db, cwd, pid: 7 }), 'by-pid');
  assert.equal(liveClineSession({ db, cwd }), 'newest');
  assert.equal(liveClineSession({ db, cwd: path.join(cwd, 'nowhere') }), undefined);
  assert.equal(liveClineSession({ db: path.join(cwd, 'missing.db'), cwd }), undefined);
});

test("the last answer and the state come from the session's row and messages file", (t) => {
  const { db, cwd } = scratch(t);
  const store = clineStore(db);
  addClineSession(store, db, { id: 's1', cwd, prompt: LINE, startedAt: '2026-11-27T11:00:00.000Z', updatedAt: '2026-11-27T11:00:09.000Z', status: 'running', replies: ['first', 'second answer'] });
  addClineSession(store, db, { id: 's2', cwd, prompt: LINE, startedAt: '2026-11-27T11:00:00.000Z' });
  store.close();
  assert.equal(clineLastMessage(db, 's1'), 'second answer');
  assert.equal(clineLastMessage(db, 's2'), undefined);
  assert.equal(clineLastMessage(db, 'nope'), undefined);
  assert.deepEqual(clineSessionState(db, 's1'), { updatedAt: Date.parse('2026-11-27T11:00:09.000Z'), status: 'running', ended: false });
  assert.equal(clineSessionState(db, 'nope'), undefined);
});

test("a child's MCP settings name one stdio server, Bellwether's, with the child id", () => {
  const settings = clineMcpSettings('child-1', { BELLWETHER_CHILD: 'child-1' });
  const servers = Object.values(settings.mcpServers);
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0]?.transport, { type: 'stdio', command: stablePath(process.execPath), args: ['--disable-warning=ExperimentalWarning', stablePath(channelEntry()), '--child', 'child-1'], env: { BELLWETHER_CHILD: 'child-1' } });
});

test('only -y or --yolo turns on benchmark mode, and each note names only what belongs to its launch', () => {
  assert.equal(clineOptedIn([]), false);
  assert.equal(clineOptedIn(['--model', 'example-model']), false);
  assert.equal(clineOptedIn(['-y']), true);
  assert.equal(clineOptedIn(['--yolo']), true);
  const sandbox = clineSandboxNote('/b/cline/c-1', '/home/u/.cline/data/settings');
  assert.match(sandbox, /sandbox mode, with its own data directory at \/b\/cline\/c-1/);
  assert.match(sandbox, /outside Cline's shared hub/);
  assert.match(sandbox, /keeps Cline's default mode/);
  assert.match(sandbox, /through a link to \/home\/u\/\.cline\/data\/settings/);
  assert.doesNotMatch(sandbox, /-y|benchmark/);
  assert.match(CLINE_OPT_IN_NOTE, /agent_send reaches it/);
  assert.match(CLINE_OPT_IN_NOTE, /benchmark mode: a different system prompt, six built-in tools .* plus its MCP tools, where the default mode offers 26/);
  assert.match(CLINE_OPT_IN_NOTE, /DANGEROUS: use only in sandboxed environments/);
});

test("the provider settings the sandbox links to follow Cline's own rule, and only a providers.json can be linked", () => {
  assert.equal(clineProviderSettingsPath({ HOME: '/home/u' }), '/home/u/.cline/data/settings/providers.json');
  assert.equal(clineProviderSettingsPath({ HOME: '/home/u', CLINE_DIR: '/c' }), '/c/data/settings/providers.json');
  assert.equal(clineProviderSettingsPath({ HOME: '/home/u', CLINE_DATA_DIR: '/d' }), '/d/settings/providers.json');
  assert.equal(clineSettingsDir({ HOME: '/home/u', CLINE_PROVIDER_SETTINGS_PATH: '/p/providers.json' }), '/p');
  assert.throws(() => clineSettingsDir({ HOME: '/home/u', CLINE_PROVIDER_SETTINGS_PATH: '/p/mine.json' }), /names \/p\/mine\.json, .* only from a file named providers\.json/);
});
