// Tier 2: a harness whose session sits in a store of its own and that takes
// no session id on its launch line. Its entry has a store source with no
// mint: the harness picks its own id, and the store finds that session by the
// child's directory, its start time and the brief line, and hands the id
// back. The spawn records it and locates the transcript from it, as it does
// for a session herdr reports. The entry is defined here and nowhere in src/,
// so the next harness that cannot be given an id needs only its entry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerHarness, type HarnessEntry } from '../../src/core/harnesses/index.ts';
import { HerdrClient } from '../../src/core/herdr-client.ts';
import { writeMcpConfig } from '../../src/core/mcp-config.ts';
import { emptyParent, readParent, saveParent } from '../../src/core/registry.ts';
import { spawnChild } from '../../src/core/spawn.ts';
import { startFakeHerdr } from '../fixtures/fake-herdr.ts';
import { fakeWorld, type FakePane } from '../fixtures/fake-world.ts';
import { isolate } from '../fixtures/isolated.ts';

const KIND = 'fake-store-agent';
const sentence = (file: string): string => `Your task is in ${file}. Read it, then do what it says.`;

/** The store: one JSON file per session, named after the id the harness picked. */
interface StoredSession {
  cwd: string;
  prompt: string;
  startedAt: string;
}

let storeDir = '';

function sessions(store: string): { id: string; session: StoredSession }[] {
  if (!fs.existsSync(store)) return [];
  return fs
    .readdirSync(store)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ id: path.basename(name, '.json'), session: JSON.parse(fs.readFileSync(path.join(store, name), 'utf8')) as StoredSession }));
}

const entry: HarnessEntry = {
  kind: KIND,
  harness: KIND,
  label: 'Fake Store Agent',
  brief: { where: 'prompts', argument: sentence },
  chosenBy: 'flag',
  launchArgs: ({ extra = [], files }) => [...(files.mcpConfigFile ? [`--mcp-config=${files.mcpConfigFile}`] : []), ...(files.briefFile ? [sentence(files.briefFile)] : []), ...extra],
  session: {
    from: 'store',
    storePath: (hooks) => hooks.store ?? storeDir,
    // No mint: this harness picks its own session id.
    async confirm({ store, session, cwd, briefFile, since }, hooks) {
      assert.equal(session, undefined, 'a store source without mint is given no session id');
      const deadline = Date.now() + (hooks.waitMs ?? 1_000);
      for (;;) {
        const found = sessions(store).find(({ session: stored }) => stored.cwd === cwd && stored.prompt === sentence(briefFile) && Date.parse(stored.startedAt) >= Date.parse(since));
        if (found) return found.id;
        if (Date.now() > deadline) throw new Error(`no session with the brief's prompt in ${store}`);
        await new Promise((resolve) => setTimeout(resolve, hooks.intervalMs ?? 20));
      }
    },
  },
  reports: { via: 'mcp-config', local: (child) => ({ mcpConfigFile: writeMcpConfig(child.id) }) },
  conversation: {
    locate: (session) => {
      const file = session ? path.join(storeDir, `${session}.json`) : undefined;
      return file && fs.existsSync(file) ? { path: file } : { missing: `no session ${session ?? ''} in ${storeDir}` };
    },
  },
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'detectModal' }, activity: 'store' },
  movable: false,
};

test('a store source with no mint hands back the session the harness picked, and the spawn records it with its transcript', async (t) => {
  const { root } = isolate(t, 'bellwether-store-session-');
  t.after(registerHarness(entry));
  storeDir = path.join(root, 'store');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const world = fakeWorld('w1');
  const fake = await startFakeHerdr({ respond: (request) => world.respond(request) });
  world.emit = (frame) => fake.send(frame);
  t.after(() => fake.stop());
  // The harness's part: herdr reports no session, and the harness writes its own, under an id it picked.
  world.onStart = (pane: FakePane) => {
    delete pane.agent_session;
    fs.mkdirSync(storeDir, { recursive: true });
    // An older session in the same directory with the same prompt does not count.
    const prompt = (pane.args ?? []).at(-1) ?? '';
    fs.writeFileSync(path.join(storeDir, 'picked-earlier.json'), JSON.stringify({ cwd, prompt, startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
    fs.writeFileSync(path.join(storeDir, 'picked-by-harness.json'), JSON.stringify({ cwd, prompt, startedAt: new Date().toISOString() }));
  };
  const parentId = saveParent(emptyParent('claude-code', `store-${path.basename(root)}`, root, { workspaceId: 'w1' })).id;
  const client = new HerdrClient({ socketPath: fake.socketPath });

  const { child } = await spawnChild(client, readParent(parentId)!, { kind: KIND, name: 'picker', prompt: 'the brief', cwd }, undefined, { harness: { store: storeDir, waitMs: 1_000, intervalMs: 20 } });

  assert.deepEqual(child.session, { kind: 'id', value: 'picked-by-harness' });
  const saved = readParent(parentId)?.children.find((record) => record.id === child.id);
  assert.deepEqual(saved?.session, { kind: 'id', value: 'picked-by-harness' });
  assert.equal(saved?.store, storeDir);
  assert.equal(saved?.transcript, path.join(storeDir, 'picked-by-harness.json'));
});
