// A pi child is started with -e naming one copy of the Bellwether extension.
// When the host also installed Bellwether as a pi package, pi loads a second
// copy, and that copy must register nothing, or each tool and each event
// handler runs twice.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PI_EXTENSION_ENV, assertNoGuardlessPiCopy, guardlessPiCopies, piExtensionEntry, resolvePiExtension, standDown } from '../../src/core/pi-extension.ts';
import { parseRegistration } from '../../src/core/remote.ts';

function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellwether-pi-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Point pi's agent directory at an empty scratch one for the case, so the operator's pi settings play no part. */
function emptyPiAgent(t: test.TestContext): void {
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = scratch(t);
  t.after(() => {
    if (saved === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = saved;
  });
}

test('the packaged extension resolves to a file that exists', (t) => {
  emptyPiAgent(t);
  assert.equal(resolvePiExtension(), piExtensionEntry());
  assert.ok(fs.existsSync(piExtensionEntry()));
});

test('a missing extension is an error that names the file', (t) => {
  emptyPiAgent(t);
  assert.throws(() => resolvePiExtension('/nowhere/extension.js'), /\/nowhere\/extension\.js/);
});

test('a second copy stands down when the session was started with -e naming the first', (t) => {
  const dir = scratch(t);
  const given = path.join(dir, 'given.js');
  const global = path.join(dir, 'global.js');
  fs.writeFileSync(given, '');
  fs.writeFileSync(global, '');
  const env = { [PI_EXTENSION_ENV]: given };
  const argv = ['node', 'pi', '-e', given, '@brief'];
  assert.equal(standDown(global, env, argv), true);
  assert.equal(standDown(given, env, argv), false, 'the copy the spawn named loads');
  assert.equal(standDown(global, env, ['node', 'pi', '--extension', given]), true);
});

test('every copy loads in a session Bellwether did not start, or with a stale variable', (t) => {
  const dir = scratch(t);
  const given = path.join(dir, 'given.js');
  const global = path.join(dir, 'global.js');
  fs.writeFileSync(given, '');
  fs.writeFileSync(global, '');
  assert.equal(standDown(global, {}, ['node', 'pi']), false);
  // A variable inherited from elsewhere, for a session started without that -e.
  assert.equal(standDown(global, { [PI_EXTENSION_ENV]: given }, ['node', 'pi']), false);
});

test('the extension registers nothing when it stands down, and otherwise waits for its session to take the daemon\'s tools', async () => {
  const { default: bellwether } = (await import('../../src/integrations/pi/extension.ts')) as { default: (pi: unknown) => void };
  const fakePi = (): { tools: string[]; events: string[] } & Record<string, unknown> => {
    const tools: string[] = [];
    const events: string[] = [];
    return { tools, events, on: (event: string) => events.push(event), registerTool: (tool: { name: string }) => tools.push(tool.name), sendMessage: () => {} };
  };
  const saved = { env: process.env[PI_EXTENSION_ENV], argv: process.argv };
  try {
    const loaded = fakePi();
    delete process.env[PI_EXTENSION_ENV];
    bellwether(loaded);
    // The tools come from the daemon's hello at session start, not from this install's own list.
    assert.deepEqual(loaded.tools, []);
    assert.ok(loaded.events.includes('session_start'));

    const other = path.join(os.tmpdir(), `bellwether-other-${process.pid}.js`);
    fs.writeFileSync(other, '');
    try {
      process.env[PI_EXTENSION_ENV] = other;
      process.argv = ['node', 'pi', '-e', other];
      const silent = fakePi();
      bellwether(silent);
      assert.deepEqual(silent.tools, []);
      assert.deepEqual(silent.events, []);
    } finally {
      fs.rmSync(other, { force: true });
    }
  } finally {
    if (saved.env === undefined) delete process.env[PI_EXTENSION_ENV];
    else process.env[PI_EXTENSION_ENV] = saved.env;
    process.argv = saved.argv;
  }
});

test('a registration names the pi extension on the remote machine, and an older remote is refused', () => {
  assert.deepEqual(parseRegistration('far', '{"record":"/r/c.json","piExtension":"/opt/bw/dist/integrations/pi/extension.js"}', 'pi'), { piExtension: '/opt/bw/dist/integrations/pi/extension.js' });
  assert.throws(() => parseRegistration('far', '{"record":"/r/c.json"}', 'pi'), /far.*pi extension/);
  assert.deepEqual(parseRegistration('far', '{"record":"/r/c.json","mcpConfig":"/r/mcp/c.json"}', 'claude'), { mcpConfig: '/r/mcp/c.json' });
  // Only the per-child server carries the child id, so a Claude Code child without one is refused.
  assert.throws(() => parseRegistration('far', '{"record":"/r/c.json"}', 'claude'), /far.*wrote no MCP config for the child/);
});

/** A pi agent directory whose settings list `source`, with a Bellwether copy installed at `dir`. */
function piAgent(t: test.TestContext, source: string, relative: string, guarded: boolean): { agentDir: string; copy: string } {
  const agentDir = path.join(scratch(t), 'agent');
  const copy = path.join(agentDir, relative);
  fs.mkdirSync(path.join(copy, 'dist', 'core'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: '@elecnix/bellwether', version: guarded ? '0.1.5' : '0.1.4' }));
  if (guarded) fs.writeFileSync(path.join(copy, 'dist', 'core', 'pi-extension.js'), '');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-intercom', source] }));
  return { agentDir, copy };
}

test('a Bellwether copy in the pi settings without the stand-down guard is found', (t) => {
  const { agentDir, copy } = piAgent(t, 'npm:@elecnix/bellwether', 'npm/node_modules/@elecnix/bellwether', false);
  assert.deepEqual(guardlessPiCopies(agentDir), [copy]);
  assert.throws(() => assertNoGuardlessPiCopy(agentDir), (error: Error) => error.message.includes(copy) && error.message.includes('pi install npm:@elecnix/bellwether'));
});

test('a guarded copy, a git copy with the guard, and settings with no Bellwether pass', (t) => {
  assert.deepEqual(guardlessPiCopies(piAgent(t, 'npm:@elecnix/bellwether', 'npm/node_modules/@elecnix/bellwether', true).agentDir), []);
  assert.deepEqual(guardlessPiCopies(piAgent(t, { source: 'git:github.com/elecnix/bellwether@main' } as unknown as string, 'git/github.com/elecnix/bellwether', true).agentDir), []);
  const none = path.join(scratch(t), 'empty-agent');
  fs.mkdirSync(none);
  assert.deepEqual(guardlessPiCopies(none), []);
});

test('a guardless git copy is found too', (t) => {
  const { agentDir, copy } = piAgent(t, 'git:github.com/elecnix/bellwether', 'git/github.com/elecnix/bellwether', false);
  assert.deepEqual(guardlessPiCopies(agentDir), [copy]);
});
