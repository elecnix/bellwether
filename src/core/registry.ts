// The registry: one JSON file per parent session, under ~/.bellwether/parents.
// A child record is written before herdr is asked to create anything, so a
// crash mid-spawn still says what was asked for. A resumed parent reads the
// same file, which is why the file is named after the session and not the pid.
import fs from 'node:fs';
import path from 'node:path';
import { parentId, parentsDir, registryPath, slug } from './paths.ts';
import { readsSuggestion } from './reads.ts';
import { REGISTRY_SCHEMA, type ChildRecord, type DialogDecision, type Harness, type ParentRecord } from './types.ts';

/** The host of a child started before the registry recorded one. */
const LOCAL_HOST = 'local';

export { parentId, slug };

function ensure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function emptyParent(harness: Harness, session: string, cwd: string, extra: Partial<ParentRecord> = {}): ParentRecord {
  return {
    schema: REGISTRY_SCHEMA,
    id: parentId(harness, session),
    harness,
    session,
    host: extra.host ?? 'unknown',
    cwd,
    depth: extra.depth ?? 0,
    children: [],
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

export function readParent(id: string): ParentRecord | undefined {
  try {
    const raw = fs.readFileSync(registryPath(id), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return migrateParent(parsed as ParentRecord);
  } catch {
    return undefined;
  }
}

/**
 * Bring a record written by an older Bellwether up to the current layout. It
 * only adds what is missing and never rewrites a field that is set, so it can
 * run on every read. The file changes on the next write, not on the read.
 */
export function migrateParent(record: ParentRecord): ParentRecord {
  if (!Array.isArray(record.children)) record.children = [];
  for (const child of record.children) {
    // Every child before version 2 ran on the parent's own herdr.
    if (typeof child.host !== 'string' || !child.host) child.host = LOCAL_HOST;
  }
  if (typeof record.schema !== 'number' || record.schema < REGISTRY_SCHEMA) record.schema = REGISTRY_SCHEMA;
  return record;
}

export function listParents(): ParentRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(parentsDir());
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => readParent(file.slice(0, -'.json'.length)))
    .filter((record): record is ParentRecord => record !== undefined);
}

/** Write atomically: a reader never sees a half-written registry. */
export function saveParent(record: ParentRecord): ParentRecord {
  ensure(path.dirname(registryPath(record.id)));
  record.updatedAt = new Date().toISOString();
  const target = registryPath(record.id);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temp, target);
  return record;
}

/** Read, change and write one registry in a single step. */
export function mutateParent(id: string, change: (record: ParentRecord) => void): ParentRecord | undefined {
  const record = readParent(id);
  if (!record) return undefined;
  change(record);
  return saveParent(record);
}

export function upsertChild(id: string, child: ChildRecord): ParentRecord | undefined {
  return mutateParent(id, (record) => {
    const index = record.children.findIndex((entry) => entry.id === child.id);
    if (index < 0) record.children.push(child);
    else record.children[index] = child;
  });
}

/** Drop a child's record, for a spawn that never produced a running child. */
export function removeChild(id: string, childId: string): ParentRecord | undefined {
  return mutateParent(id, (record) => {
    record.children = record.children.filter((entry) => entry.id !== childId);
  });
}

export function updateChild(id: string, childId: string, change: (child: ChildRecord) => void): ChildRecord | undefined {
  let updated: ChildRecord | undefined;
  mutateParent(id, (record) => {
    const child = record.children.find((entry) => entry.id === childId);
    if (!child) return;
    change(child);
    updated = child;
  });
  return updated;
}

/**
 * Add the dialogs Bellwether answered to a child's record. `told` marks them
 * as already given to the parent, as a spawn's reply does; otherwise the
 * watcher puts them in the parent's next event about the child.
 */
export function recordDecisions(id: string, childId: string, decisions: readonly DialogDecision[], told = false): void {
  if (!decisions.length) return;
  updateChild(id, childId, (child) => {
    child.decisions = [...(child.decisions ?? []), ...decisions.map((decision) => ({ ...decision, ...(told ? { told: true } : {}) }))];
  });
}

/**
 * Take the decisions the parent has not heard of, and mark them told. The
 * earlier ones come back too, so the text can count a read declined again.
 */
export function takeUntoldDecisions(id: string, childId: string): { taken: DialogDecision[]; earlier: DialogDecision[] } {
  let taken: DialogDecision[] = [];
  let earlier: DialogDecision[] = [];
  updateChild(id, childId, (child) => {
    earlier = (child.decisions ?? []).filter((decision) => decision.told).map((decision) => ({ ...decision }));
    taken = (child.decisions ?? []).filter((decision) => !decision.told);
    for (const decision of taken) decision.told = true;
  });
  return { taken: taken.map(({ told: _told, ...decision }) => decision), earlier };
}

/**
 * One paragraph per answered dialog, for the parent. A declined read says
 * so first, names the path, counts how often that path was declined, and
 * names the field that widens the child's read set, so the parent widens it
 * rather than repeat an instruction that meets the same No.
 */
export function describeDecisions(name: string, decisions: readonly DialogDecision[], earlier: readonly DialogDecision[] = []): string {
  const seen = [...earlier];
  return decisions
    .map((decision) => {
      seen.push(decision);
      const keys = `keys ${decision.keys.join(', ')}`;
      if (decision.outcome !== 'declined') return `Bellwether answered ${decision.name} for ${name}, "${decision.question}", with "${decision.answer}" (${keys}): it ${decision.decided}.`;
      if (!decision.path) return `Bellwether declined for ${name}: ${decision.name}, "${decision.question}", answered "${decision.answer}" (${keys}). It ${decision.decided}. The child was told No and goes on without it; tell it another way with agent_send.`;
      const times = seen.filter((entry) => entry.outcome === 'declined' && entry.path === decision.path).length;
      const again = times > 1 ? ` This is the ${ordinal(times)} time Bellwether declined that path for it, so the brief needs it.` : '';
      return `Bellwether declined ${name}'s read of ${decision.path}: ${decision.name}, answered "${decision.answer}" (${keys}). It ${decision.decided}.${again} If the brief needs that path, widen the child's read set rather than send the instruction again: agent_restart with reads ["${readsSuggestion(decision.path)}"] keeps its session, and agent_spawn takes the same field.`;
    })
    .join('\n');
}

function ordinal(n: number): string {
  return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth'][n] ?? `${n}th`;
}

export function childById(record: ParentRecord, childId: string): ChildRecord | undefined {
  return record.children.find((child) => child.id === childId || child.name === childId || child.paneId === childId);
}

/**
 * The parent that watches a live pane on a host, if any. A child that exited
 * no longer holds its pane, so it does not count.
 */
export function watcherOfPane(host: string, paneId: string): { parent: ParentRecord; child: ChildRecord } | undefined {
  for (const parent of listParents()) {
    const child = parent.children.find((entry) => !entry.exitedAt && entry.paneId === paneId && (entry.host ?? LOCAL_HOST) === host);
    if (child) return { parent, child };
  }
  return undefined;
}
