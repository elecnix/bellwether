// Tier 1: the paths a child's tool files name (issue #266). A Claude Code
// child's MCP configuration and settings file name this Node and this
// package's entry points by absolute path. Under Homebrew both sit in a
// versioned Cellar directory that `brew upgrade` deletes, so a file written
// before an upgrade names a path that no longer exists. The writer prefers
// Homebrew's `opt/` link, which stays, and the repair writes this install's
// path in place of each one that is gone, leaving every other file alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliEntry } from '../../src/core/claude-hooks.ts';
import { channelEntry, mcpConfig } from '../../src/core/mcp-config.ts';
import { claudeSettingsPath, mcpConfigPath } from '../../src/core/paths.ts';
import { inspectToolFile, repairToolFiles, stablePath, toolFileLines } from '../../src/core/tool-files.ts';

/** A Homebrew prefix with one formula at `version`, whose opt link points at that version. */
function brewPrefix(t: test.TestContext, formula: string, version: string, file: string): { prefix: string; cellar: string; opt: string } {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-brew-'));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const cellar = path.join(prefix, 'Cellar', formula, version, file);
  fs.mkdirSync(path.dirname(cellar), { recursive: true });
  fs.writeFileSync(cellar, '');
  fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true });
  fs.symlinkSync(path.join('..', 'Cellar', formula, version), path.join(prefix, 'opt', formula));
  return { prefix, cellar, opt: path.join(prefix, 'opt', formula, file) };
}

function home(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-toolfiles-'));
  const previous = process.env['BELLWETHER_HOME'];
  process.env['BELLWETHER_HOME'] = dir;
  t.after(() => {
    process.env['BELLWETHER_HOME'] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const GONE_NODE = '/gone/brew/Cellar/node/26.13.1_4/bin/node';
const GONE_CHANNEL = '/gone/brew/Cellar/bellwether/0.1.9/libexec/lib/node_modules/@elecnix/bellwether/dist/integrations/claude/channel.js';
const GONE_CLI = '/gone/brew/Cellar/bellwether/0.1.9/libexec/lib/node_modules/@elecnix/bellwether/dist/cli.js';

test("a path in a Homebrew Cellar becomes the formula's opt link, which stays across an upgrade", (t) => {
  const brew = brewPrefix(t, 'node', '26.13.1_4', 'bin/node');
  assert.equal(stablePath(brew.cellar), brew.opt);
});

test('a path outside a Cellar, or one whose opt link points at another version, stays as it is', (t) => {
  assert.equal(stablePath(process.execPath.includes('/Cellar/') ? '/usr/bin/env' : process.execPath), process.execPath.includes('/Cellar/') ? '/usr/bin/env' : process.execPath);
  const brew = brewPrefix(t, 'node', '26.13.1_4', 'bin/node');
  // brew upgrade installed a newer version beside this one and moved the link; this file is the old version's.
  const newer = path.join(brew.prefix, 'Cellar', 'node', '27.0.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(newer, '');
  fs.rmSync(path.join(brew.prefix, 'opt', 'node'));
  fs.symlinkSync(path.join('..', 'Cellar', 'node', '27.0.0'), path.join(brew.prefix, 'opt', 'node'));
  assert.equal(stablePath(brew.cellar), brew.cellar);
  // A formula without an opt link at all.
  fs.rmSync(path.join(brew.prefix, 'opt', 'node'));
  assert.equal(stablePath(brew.cellar), brew.cellar);
});

test("a child's MCP configuration names Node by its opt link when Node runs from a Cellar", (t) => {
  const brew = brewPrefix(t, 'node', '26.13.1_4', 'bin/node');
  const saved = process.execPath;
  process.execPath = brew.cellar;
  t.after(() => {
    process.execPath = saved;
  });
  assert.equal(mcpConfig('example-child').mcpServers['bellwether']?.command, brew.opt);
});

test("the repair writes this install's paths in place of each one that is gone, and keeps the rest of the file", (t) => {
  home(t);
  const mcp = mcpConfigPath('example-child');
  writeJson(mcp, { mcpServers: { bellwether: { type: 'stdio', command: GONE_NODE, args: ['--disable-warning=ExperimentalWarning', GONE_CHANNEL, '--child', 'example-child'] } } });
  const settings = claudeSettingsPath('example-child');
  const hook = [GONE_NODE, '--disable-warning=ExperimentalWarning', GONE_CLI, 'claude-hook', '--child', 'example-child'].map((part) => `'${part}'`).join(' ');
  writeJson(settings, { hooks: { Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: hook }] }] }, permissions: { additionalDirectories: ['/kept/as/is'] } });

  const repaired = repairToolFiles({ childId: 'example-child' });
  assert.deepEqual(repaired.map((item) => [path.basename(path.dirname(item.file)), item.missing]).sort(), [['claude-settings', GONE_CLI], ['claude-settings', GONE_NODE], ['mcp', GONE_CHANNEL], ['mcp', GONE_NODE]].sort());

  const server = (JSON.parse(fs.readFileSync(mcp, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers['bellwether'];
  assert.equal(server?.command, stablePath(process.execPath));
  assert.deepEqual(server?.args, ['--disable-warning=ExperimentalWarning', stablePath(channelEntry()), '--child', 'example-child']);
  assert.equal(fs.statSync(mcp).mode & 0o777, 0o600);
  const written = JSON.parse(fs.readFileSync(settings, 'utf8')) as { hooks: { Notification: { hooks: { command: string }[] }[] }; permissions: { additionalDirectories: string[] } };
  assert.equal(written.hooks.Notification[0]?.hooks[0]?.command, [stablePath(process.execPath), '--disable-warning=ExperimentalWarning', stablePath(cliEntry()), 'claude-hook', '--child', 'example-child'].map((part) => `'${part}'`).join(' '));
  assert.deepEqual(written.permissions.additionalDirectories, ['/kept/as/is'], 'a path that is not an install path is never touched, even when it is missing');
  assert.deepEqual(inspectToolFile(mcp), [], 'the rewritten file names only paths that exist');

  // doctor warns about each rewrite while the file stays.
  const lines = toolFileLines();
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.ok(lines.every((line) => line.startsWith('warn  tool file: child example-child:')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes(GONE_CHANNEL) && line.includes(stablePath(channelEntry()))), lines.join('\n'));
});

test('a tool file whose paths all exist is left alone, byte for byte, and doctor says nothing about it', (t) => {
  home(t);
  const mcp = mcpConfigPath('example-fine');
  writeJson(mcp, mcpConfig('example-fine'));
  const before = fs.readFileSync(mcp);
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(mcp, stamp, stamp);
  assert.deepEqual(repairToolFiles({}), []);
  assert.deepEqual(fs.readFileSync(mcp), before);
  assert.equal(fs.statSync(mcp).mtimeMs, stamp.getTime(), 'the file was not written again');
  assert.deepEqual(toolFileLines(), []);
});

test('a missing path that no file of this install replaces stays, and doctor names it', (t) => {
  home(t);
  const mcp = mcpConfigPath('example-other');
  const foreign = '/gone/somewhere/else/server.py';
  writeJson(mcp, { mcpServers: { other: { type: 'stdio', command: foreign, args: [] } } });
  const before = fs.readFileSync(mcp, 'utf8');
  const found = repairToolFiles({});
  assert.deepEqual(found.map((item) => [item.missing, item.replacement]), [[foreign, undefined]]);
  assert.equal(fs.readFileSync(mcp, 'utf8'), before);
  const lines = toolFileLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^warn {2}tool file: child example-other: .* names \/gone\/somewhere\/else\/server\.py, which no longer exists, and no file of this install takes its place/);
});
