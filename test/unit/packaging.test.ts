// The two harnesses load these files by name, so a rename that misses one of
// them fails at session start rather than here. These tests name the contract.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as T;
}

type PluginManifest = {
  name?: string;
  mcpServers?: Record<string, { command?: string }>;
  channels?: { server?: string }[];
};
type MarketplaceManifest = { name?: string; plugins?: { name?: string; source?: string }[] };
type PackageManifest = { pi?: { extensions?: string[] } };

test('the plugin names its MCP server bellwether and runs bin/bellwether-mcp.js', () => {
  const plugin = readJson<PluginManifest>('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'bellwether');

  const server = plugin.mcpServers?.['bellwether'];
  assert.ok(server, 'mcpServers.bellwether is missing');
  assert.match(
    server.command ?? '',
    /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bellwether-mcp\.js$/,
    'the bellwether server must start bin/bellwether-mcp.js from the plugin root',
  );

  const channels = plugin.channels ?? [];
  assert.ok(
    channels.some((channel) => channel.server === 'bellwether'),
    'channels must enable the bellwether server, or Claude Code gets tools without channel delivery',
  );
});

test('the marketplace offers the plugin from the repository root', () => {
  const marketplace = readJson<MarketplaceManifest>('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'bellwether');
  const entry = marketplace.plugins?.find((plugin) => plugin.name === 'bellwether');
  assert.ok(entry, 'the marketplace lists no bellwether plugin');
  assert.equal(entry.source, './');
});

test('the MCP entry point exists and carries its executable bit', () => {
  const entry = path.join(root, 'bin', 'bellwether-mcp.js');
  assert.ok(fs.existsSync(entry), 'bin/bellwether-mcp.js is missing');
  assert.ok(
    fs.statSync(entry).mode & 0o111,
    'bin/bellwether-mcp.js is not executable, and the plugin runs it as a command',
  );
});

test('every pi extension path declared in package.json exists', () => {
  const manifest = readJson<PackageManifest>('package.json');
  const extensions = manifest.pi?.extensions ?? [];
  assert.ok(extensions.length > 0, 'package.json declares no pi extensions');
  for (const entry of extensions) {
    assert.ok(fs.existsSync(path.resolve(root, entry)), `${entry} is missing`);
  }
});

test('the packed tarball carries every entry point and nothing outside the files list', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  const [pack] = JSON.parse(output) as { files: { path: string }[] }[];
  assert.ok(pack, 'npm pack printed no tarball');
  const packed = new Set(pack.files.map((file) => file.path));

  const manifest = readJson<{ bin?: Record<string, string>; pi?: { extensions?: string[] } }>('package.json');
  const entries = [
    'package.json',
    'README.md',
    'LICENSE',
    ...Object.values(manifest.bin ?? {}),
    ...(manifest.pi?.extensions ?? []),
  ].map((entry) => path.posix.normalize(entry));
  for (const entry of entries) {
    assert.ok(packed.has(entry), `the tarball is missing ${entry}, so the package cannot start`);
  }

  // Each binary imports a source file, so the tarball must hold its import target.
  for (const bin of Object.values(manifest.bin ?? {})) {
    const source = fs.readFileSync(path.join(root, bin), 'utf8');
    for (const [, target] of source.matchAll(/import '([^']+)'/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(bin), target!));
      assert.ok(packed.has(resolved), `${bin} imports ${resolved}, which the tarball does not carry`);
    }
  }

  const allowed = /^(package\.json|README\.md|LICENSE|bin\/[^/]+\.js|src\/.+\.ts)$/;
  const stray = [...packed].filter((file) => !allowed.test(file));
  assert.deepEqual(stray, [], 'the tarball carries files outside bin/, src/ and the three top-level files');
});
