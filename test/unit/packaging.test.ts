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

/** The source under src/ that the build compiles to a dist/ path. */
function sourceOf(entry: string): string {
  const relative = path.posix.normalize(entry);
  assert.match(relative, /^dist\/.+\.js$/, `${entry} is not a build output under dist/`);
  return relative.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

test('every bin and pi extension in package.json is the build output of a source in src/', () => {
  const manifest = readJson<{ bin?: Record<string, string>; pi?: { extensions?: string[] } }>('package.json');
  const extensions = manifest.pi?.extensions ?? [];
  assert.ok(extensions.length > 0, 'package.json declares no pi extensions');
  for (const entry of [...Object.values(manifest.bin ?? {}), ...extensions]) {
    const source = sourceOf(entry);
    assert.ok(fs.existsSync(path.join(root, source)), `${entry} has no source at ${source}`);
  }
});

test('the packed tarball carries the compiled entry points and no TypeScript', () => {
  // Packing runs the prepare script, which builds dist/ first.
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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

  // Node will not strip types under node_modules, so a .ts file in the tarball cannot run.
  const allowed = /^(package\.json|README\.md|LICENSE|dist\/.+\.js)$/;
  const stray = [...packed].filter((file) => !allowed.test(file));
  assert.deepEqual(stray, [], 'the tarball carries files outside dist/ and the three top-level files');
});
