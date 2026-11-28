// Rebuild the design matrix of docs/design-matrix.md from the sources, and
// print its coupled sets: the design parameters that depend on each other
// through some chain of imports and child record fields. A matrix with no
// coupled set is lower-triangular under some ordering of its rows, so no cell
// sits above the diagonal.
//
//   node scripts/design-matrix.ts [--route field,field,...] [--edges]
//
// `--route` gives each named field an owner of its own that depends on
// nothing, to show which fields still couple the modules. `--edges` lists the
// edges inside each coupled set with the reason for each: I for a runtime
// import, D:<field> for a field the row reads and the column writes.
//
// The method is the one docs/design-matrix.md describes. A read is
// `child.field`, `entry.field` or `record.field`. A write is any write the
// ownership scanner in test/fixtures/field-owner.ts flags, less the writes
// the ownership gates exempt as another kind of object.
import fs from 'node:fs';
import path from 'node:path';
import { LIFETIMES } from '../src/core/incarnation.ts';
import { codeOnly, ownerScanner } from '../test/fixtures/field-owner.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Each design parameter and its files, in the order the refactor makes lower-triangular. */
const PARAMETERS: [string, string[]][] = [
  ['record', ['core/types.ts', 'core/registry.ts']],
  ['incarnation', ['core/incarnation.ts']],
  ['requests', ['core/requests.ts']],
  ['delivery', ['core/delivery.ts']],
  ['authority', ['core/authority.ts']],
  ['placement', ['core/placement.ts']],
  ['turn', ['core/turn.ts']],
  ['relayrec', ['core/relay-records.ts']],
  ['proto', ['daemon/features.ts', 'daemon/protocol.ts']],
  ['departures', ['core/departures.ts']],
  ['send', ['core/send.ts']],
  ['brief', ['core/brief-delivery.ts']],
  ['spawn', ['core/spawn.ts']],
  ['report', ['core/report.ts']],
  ['retire', ['core/retire.ts']],
  ['claims', ['core/pane-claims.ts']],
  ['resume', ['core/resume.ts', 'core/spawn-resume.ts']],
  ['list', ['core/pane-fate.ts', 'core/hygiene.ts']],
  ['restart', ['core/restart.ts']],
  ['carry', ['core/carry.ts']],
  ['recover', ['core/recover-crossing.ts']],
  ['move', ['core/move.ts']],
  ['teleport', ['core/teleport.ts']],
  ['adopt', ['core/adopt.ts']],
  ['watcher', ['core/watcher.ts']],
  ['links', ['daemon/relay-links.ts']],
  ['server', ['daemon/server.ts']],
];

/** Fields every object carries, or that a start copies from its caller, which the method skips. */
const SKIPPED = new Set(['id', 'name', 'kind', 'harness', 'host', 'cwd', 'session', 'depth', 'model', 'route', 'store', 'reads', 'prompt']);

/** Receivers the code gives a parent, relay or link record, which the method does not count as a child record. */
const OTHER_RECORDS = ['parentRecord', 'kept', 'link', 'info'];

export interface Matrix {
  parameters: string[];
  edges: Map<string, Map<string, Set<string>>>;
  coupled: string[][];
  /** Each field that more than one design parameter writes, with its writers. */
  shared: Map<string, string[]>;
}

function gateExemptions(): Record<string, string> {
  const exempt: Record<string, string> = {};
  const dir = path.join(ROOT, 'test', 'unit');
  for (const gate of fs.readdirSync(dir).filter((file) => file.endsWith('-owner.test.ts'))) {
    for (const match of fs.readFileSync(path.join(dir, gate), 'utf8').matchAll(/^ {2}'(src\/[^']+ [^']+)':/gm)) exempt[match[1] as string] = gate;
  }
  return exempt;
}

/** Whether an import line brings in a value at runtime, not only types. */
function runtimeImport(clause: string): boolean {
  if (/^type\s/.test(clause)) return false;
  const named = /\{([^}]*)\}/.exec(clause);
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
  if (rest) return true;
  return Boolean(named?.[1]?.split(',').some((spec) => spec.trim() && !spec.trim().startsWith('type ')));
}

export function buildMatrix(routed: readonly string[] = []): Matrix {
  const parameters = PARAMETERS.filter(([, files]) => files.every((file) => fs.existsSync(path.join(ROOT, 'src', file))));
  const parameterOf = new Map<string, string>();
  for (const [name, files] of parameters) for (const file of files) parameterOf.set(`src/${file}`, name);
  const notMine = gateExemptions();
  for (const file of parameterOf.keys()) for (const receiver of OTHER_RECORDS) notMine[`${file} ${receiver}`] ??= 'another kind of record';

  const edges = new Map<string, Map<string, Set<string>>>();
  const add = (from: string, to: string, why: string): void => {
    if (from === to) return;
    const row = edges.get(from) ?? new Map<string, Set<string>>();
    edges.set(from, row);
    const reasons = row.get(to) ?? new Set<string>();
    row.set(to, reasons);
    reasons.add(why);
  };

  const fields = Object.keys(LIFETIMES).filter((field) => !SKIPPED.has(field));
  const writers = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const finding of ownerScanner({ owner: '-', fields: [field], notMine, literalTypes: ['ChildRecord'] }).scanAll()) {
      const writer = parameterOf.get(finding.file);
      if (!writer) continue;
      const set = writers.get(field) ?? new Set<string>();
      writers.set(field, set);
      set.add(routed.includes(field) ? `owner of ${field}` : writer);
    }
  }

  for (const [file, name] of parameterOf) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of raw.matchAll(/^import\s+([^;]*?)\s*from\s+'([^']+)'/gm)) {
      if (!runtimeImport(match[1] ?? '')) continue;
      const target = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), match[2] ?? ''));
      const to = parameterOf.get(target);
      if (to) add(name, to, 'I');
    }
    const code = codeOnly(raw);
    for (const field of fields) {
      if (!new RegExp(`\\b(child|entry|record)\\??\\.\\s*${field}\\b`).test(code)) continue;
      for (const writer of writers.get(field) ?? []) add(name, writer, `D:${field}`);
    }
  }

  // The coupled sets are the strongly connected components with more than one member.
  const nodes = [...new Set([...parameters.map(([name]) => name), ...[...edges.values()].flatMap((row) => [...row.keys()])])];
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const coupled: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node)?.keys() ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
    }
    if (low.get(node) !== index.get(node)) return;
    const set: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      set.push(member);
    } while (member !== node);
    if (set.length > 1) coupled.push(set);
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  const shared = new Map([...writers].filter(([, set]) => set.size > 1).map(([field, set]) => [field, [...set]]));
  return { parameters: parameters.map(([name]) => name), edges, coupled, shared };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--route');
  const routed = at >= 0 ? (args[at + 1] ?? '').split(',').filter(Boolean) : [];
  const matrix = buildMatrix(routed);
  console.log(`${matrix.parameters.length} design parameters, ${matrix.coupled.length} coupled set${matrix.coupled.length === 1 ? '' : 's'}${routed.length ? `, with ${routed.join(', ')} routed to owners of their own` : ''}`);
  for (const set of matrix.coupled) {
    console.log(`  ${set.length} coupled: ${set.join(', ')}`);
    const binding = [...matrix.shared].filter(([, writers]) => writers.some((writer) => set.includes(writer)));
    console.log(`  fields more than one of them writes: ${binding.map(([field, writers]) => `${field} (${writers.join(', ')})`).join('; ')}`);
    if (args.includes('--edges')) for (const from of set) for (const [to, why] of matrix.edges.get(from) ?? []) if (set.includes(to)) console.log(`    ${from} -> ${to}: ${[...why].join(' ')}`);
  }
}
