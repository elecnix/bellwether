// The registry: one JSON file per parent session, under ~/.bellwether/parents.
// A child record is written before herdr is asked to create anything, so a
// crash mid-spawn still says what was asked for. A resumed parent reads the
// same file, which is why the file is named after the session and not the pid.
import fs from 'node:fs';
import path from 'node:path';
import { parentId, parentsDir, registryPath, slug } from './paths.ts';
import type { ChildRecord, Harness, ParentRecord } from './types.ts';

export { parentId, slug };

function ensure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function emptyParent(harness: Harness, session: string, cwd: string, extra: Partial<ParentRecord> = {}): ParentRecord {
  return {
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
    const record = parsed as ParentRecord;
    if (!Array.isArray(record.children)) record.children = [];
    return record;
  } catch {
    return undefined;
  }
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

export function childById(record: ParentRecord, childId: string): ChildRecord | undefined {
  return record.children.find((child) => child.id === childId || child.name === childId || child.paneId === childId);
}
