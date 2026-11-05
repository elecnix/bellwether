// The bellwether command. For now it answers one question: is the plumbing in
// place, and what does each parent currently owe?
import fs from 'node:fs';
import { HerdrClient, resolveSocketPath } from './core/herdr-client.ts';
import { listParents, readParent } from './core/registry.ts';
import { bellwetherHome } from './core/paths.ts';

function ok(label: string, detail: string): void {
  console.log(`  ok    ${label}: ${detail}`);
}
function bad(label: string, detail: string): void {
  console.log(`  fail  ${label}: ${detail}`);
}

async function doctor(): Promise<number> {
  let failures = 0;
  console.log('bellwether doctor');
  console.log(`  home  ${bellwetherHome()}`);

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
