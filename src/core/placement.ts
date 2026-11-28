// Where a child's run sits: the workspace it opened in, whether Bellwether
// made that workspace, when the record began, and the name herdr gives the
// agent (step 6 of docs/design-matrix.md). This module is the only writer of
// those fields. Every other module reads them and changes them only through
// the transitions below. `test/unit/placement-owner.test.ts` fails on a write
// anywhere else, and `ChildRecord` declares each field `readonly`, so the
// typecheck fails on a write through any alias too.
//
// The rule this module holds: a workspace this parent opened is its to close,
// and one it did not open is never its to close (issue #225). `ownsWorkspace`
// says the first. Only a tab that created its workspace sets it, and a run
// that sits in any other workspace loses it. The watcher and `agent_stop`
// close a workspace only when the record says the child owns it.
//
// The fields stay flat on the child record, where older daemons that take
// over the same registry read them, and where a far daemon's restart answer
// carries them (`RelayRestartRecord`).
//
//   field           means                                set by                        cleared by
//   startedAt       when the record began                firstPlacement                never
//   workspaceId     the herdr workspace the run is in,   firstPlacement, tabLanded,    tabLanded without one, placementLost,
//                   on the child's own machine           workspaceSeen                 workspaceSeen without one
//   workspaceLabel  that workspace's label, which a      firstPlacement, tabLanded     never: a child back in a new workspace
//                   new workspace for the child reuses                                 of its own takes the same label
//   ownsWorkspace   Bellwether made that workspace for   firstPlacement (a far         tabLanded or workspaceSeen in another
//                   this child, so it may close it       daemon's record), tabLanded   workspace
//                                                        given a tab that created it
//   agentName       the name herdr reports for the       agentNamed                    never
//                   agent in the pane
//
// Which path calls which transition:
//
//   spawn.ts            firstPlacement, tabLanded, agentNamed
//   resume.ts           firstPlacement, tabLanded, restorePlacement (a resume that fails)
//   restart.ts          firstPlacement (a far restart's record), tabLanded (local and far)
//   adopt.ts            firstPlacement, workspaceSeen (backInPane)
//   carry.ts            placementLost: a workspace id belongs to the source machine's herdr
//   recover-crossing.ts workspaceSeen: the workspace herdr shows the session in
//   watcher.ts          agentNamed
//   free.ts             firstPlacement
import type { ChildRecord } from './types.ts';

/** The fields this module owns, which the ownership gate reads. */
export const PLACEMENT_FIELDS = ['startedAt', 'workspaceId', 'workspaceLabel', 'ownsWorkspace', 'agentName'] as const;
export type PlacementField = (typeof PLACEMENT_FIELDS)[number];

type Writable = { -readonly [K in PlacementField]: ChildRecord[K] };
function writable(record: ChildRecord): Writable {
  return record as unknown as Writable;
}

/** Where a tab Bellwether opened sits. `ownsWorkspace` is true only for a tab that created its workspace. */
export interface Landing {
  workspaceId?: string | undefined;
  workspaceLabel?: string | undefined;
  ownsWorkspace?: boolean | undefined;
}

/**
 * The placement of a new record. `ownsWorkspace` comes only from a record a
 * placement already decided, such as the parent's record of a child a far
 * daemon restarts.
 */
export function firstPlacement(start: { at: string } & Landing): Pick<ChildRecord, PlacementField> {
  return {
    startedAt: start.at,
    ...(start.workspaceId ? { workspaceId: start.workspaceId } : {}),
    ...(start.workspaceLabel ? { workspaceLabel: start.workspaceLabel } : {}),
    ...(start.ownsWorkspace ? { ownsWorkspace: true } : {}),
  };
}

/** Whether a run keeps a workspace it owned once it sits in `workspaceId`. */
function stillOwned(record: ChildRecord, workspaceId: string | undefined): boolean {
  if (!record.ownsWorkspace) return false;
  return workspaceId === undefined || record.workspaceId === undefined || workspaceId === record.workspaceId;
}

/**
 * A tab Bellwether opened for a run: a spawn's, a resume's or a restart's.
 * The record takes the tab's workspace, or none. The child owns that
 * workspace when the tab created it, or when it owned it already and came
 * back to it. A run in any other workspace never owns it.
 */
export function tabLanded(record: ChildRecord, tab: Landing): void {
  const entry = writable(record);
  const owns = Boolean(tab.ownsWorkspace) || stillOwned(record, tab.workspaceId);
  if (tab.workspaceId) entry.workspaceId = tab.workspaceId;
  else delete entry.workspaceId;
  if (tab.workspaceLabel) entry.workspaceLabel = tab.workspaceLabel;
  if (owns) entry.ownsWorkspace = true;
  else delete entry.ownsWorkspace;
}

/**
 * herdr shows the run in a workspace that no tab of this record's opened:
 * an adopted session back in its pane, or a crossing a stopped daemon left
 * half done. The record takes it, and owns it only if it owned that one.
 */
export function workspaceSeen(record: ChildRecord, workspaceId: string | undefined): void {
  const entry = writable(record);
  if (!stillOwned(record, workspaceId)) delete entry.ownsWorkspace;
  if (workspaceId) entry.workspaceId = workspaceId;
  else delete entry.workspaceId;
}

/**
 * The run left the machine whose herdr numbered its workspace, as a move or a
 * teleport does. A child with a workspace of its own gets a new one at the
 * destination, under the same label.
 */
export function placementLost(record: ChildRecord): void {
  delete writable(record).workspaceId;
}

/** Every placement field of a record as it stands, so a start that fails can put them back. */
export type PlacementSnapshot = Partial<Pick<ChildRecord, PlacementField>>;

export function snapshotPlacement(record: ChildRecord): PlacementSnapshot {
  const snapshot: Record<string, unknown> = {};
  for (const field of PLACEMENT_FIELDS) if (record[field] !== undefined) snapshot[field] = record[field];
  return snapshot as PlacementSnapshot;
}

/** A start failed: the record takes back the workspace it had, field for field. */
export function restorePlacement(record: ChildRecord, snapshot: PlacementSnapshot): void {
  const entry = writable(record) as Record<string, unknown>;
  for (const field of PLACEMENT_FIELDS) {
    if (field === 'startedAt') continue;
    if (snapshot[field] === undefined) delete entry[field];
    else entry[field] = snapshot[field];
  }
}

/** The name herdr reports for the agent in the child's pane. */
export function agentNamed(record: ChildRecord, name: string | undefined): void {
  if (name) writable(record).agentName = name;
}
