// The bellwether command. For now it answers one question: is the plumbing in
// place, and what does each parent currently owe?
import fs from 'node:fs';
import path from 'node:path';
import { HerdrClient, resolveSocketPath } from './core/herdr-client.ts';
import { listParents, readParent } from './core/registry.ts';
import { bellwetherHome } from './core/paths.ts';

function ok(label: string, detail: string): void {
  console.log(`  ok    ${label}: ${detail}`);
}
function bad(label: string, detail: string): void {
  console.log(`  fail  ${label}: ${detail}`);
}

/** The package root, found by walking up from this file to its package.json. */
function packageRoot(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

type PackageManifest = {
  pi?: { extensions?: string[] };
};

/** Harnesses load these two paths by name, so a missing one fails at load time.
 *  doctor names it here, before a user meets it inside a session. */
function checkPackaging(): number {
  const root = packageRoot();
  if (!root) {
    bad('package root', 'no package.json above the CLI');
    return 1;
  }
  let failures = 0;
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest;
  } catch (error) {
    bad('package.json', String(error));
    return 1;
  }

  const extensions = manifest.pi?.extensions ?? [];
  if (!extensions.length) {
    bad('pi extension', 'package.json declares none');
    failures += 1;
  }
  for (const entry of extensions) {
    const file = path.resolve(root, entry);
    if (fs.existsSync(file)) {
      ok('pi extension', path.relative(root, file));
    } else {
      bad('pi extension', `${entry} does not exist`);
      failures += 1;
    }
  }

  const mcpEntry = path.join(root, 'bin', 'bellwether-mcp.js');
  const label = path.relative(root, mcpEntry);
  if (!fs.existsSync(mcpEntry)) {
    bad('mcp entry', `${label} does not exist`);
    failures += 1;
  } else if (!(fs.statSync(mcpEntry).mode & 0o111)) {
    bad('mcp entry', `${label} is not executable`);
    failures += 1;
  } else {
    ok('mcp entry', label);
  }
  return failures;
}

async function doctor(): Promise<number> {
  let failures = 0;
  console.log('bellwether doctor');
  console.log(`  home  ${bellwetherHome()}`);

  failures += checkPackaging();

  const socket = resolveSocketPath();
  if (!fs.existsSync(socket)) {
    bad('herdr socket', `${socket} does not exist`);
    failures += 1;
  } else {
    ok('herdr socket', socket);
    const client = new HerdrClient({ socketPath: socket });
    try {
      const panes = await client.paneList();
      ok('herdr api', `${panes.length} panes`);
    } catch (error) {
      bad('herdr api', String(error));
      failures += 1;
    }
  }

  const parents = listParents();
  if (!parents.length) {
    console.log('  note  no parent sessions registered yet');
    return failures;
  }
  for (const parent of parents) {
    const children = parent.children.filter((child) => !child.exitedAt);
    console.log(`\n  ${parent.id} (${parent.harness}, ${parent.cwd})`);
    console.log(`    ${children.length} live of ${parent.children.length} children, updated ${parent.updatedAt}`);
    for (const child of parent.children) {
      const state = child.exitedAt ? `exited ${child.exitCode ?? ''}`.trim() : child.lastStatus;
      console.log(`    ${child.name}\t${child.kind}\t${state}\t${child.paneId}`);
    }
  }
  return failures;
}

function showUsage(): void {
  console.log('Usage: bellwether <doctor|parents|help>');
}

const [command = 'help', ...rest] = process.argv.slice(2);

if (command === 'doctor') {
  process.exitCode = await doctor();
} else if (command === 'parents') {
  for (const id of rest.length ? rest : listParents().map((parent) => parent.id)) {
    const parent = readParent(id);
    console.log(parent ? JSON.stringify(parent, null, 2) : `${id}: not found`);
  }
} else {
  showUsage();
}
