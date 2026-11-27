// parent_report: a child appends one JSON line to its parent's spool file.
// A file keeps the child and the parent independent: either process can die
// and the report still waits for the other one.
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_HOST } from './machine.ts';
import { mcpDir, registryPath, relayChildPath, spoolPath } from './paths.ts';
import { listParents, readParent } from './registry.ts';
import { readRelayRecord, type RelayRecord } from './relay-records.ts';
import type { CallerIdentity, ChildRecord, ParentRecord, ReportStatus, SpoolReport } from './types.ts';

export function harnessForEnv(): string {
  if (process.env['BELLWETHER_HARNESS']) return process.env['BELLWETHER_HARNESS'];
  if (process.env['CLAUDE_CODE_SESSION_ID']) return 'claude-code';
  return 'pi';
}

export function childFromEnv(): string | undefined {
  return process.env['BELLWETHER_CHILD'];
}

export function depthFromEnv(): number {
  const value = Number.parseInt(process.env['BELLWETHER_DEPTH'] ?? '0', 10);
  return Number.isFinite(value) ? value : 0;
}

/** Append one report to the parent's spool, creating the directory if needed. */
export function writeReport(report: Omit<SpoolReport, 'at' | 'seq'> & { at?: string; seq?: number }): SpoolReport {
  const target = spoolPath(report.parentId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const seq = report.seq ?? Date.now();
  const entry: SpoolReport = { ...report, at: report.at ?? new Date().toISOString(), seq };
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * Find the child a caller speaks for, from the records this machine holds: by
 * the child id its spawn handed it, or by the live pane it runs in. A child id
 * whose record holds another pane is refused, because one of the two is wrong.
 */
export function childOfCaller(caller: CallerIdentity): { parent: ParentRecord; child: ChildRecord } | undefined {
  const parents = listParents();
  if (caller.childId) {
    for (const parent of parents) {
      const child = parent.children.find((entry) => entry.id === caller.childId);
      if (!child) continue;
      if (caller.paneId && child.paneId && child.paneId !== caller.paneId) {
        throw new Error(`parent_report was called for child ${child.id}, whose record holds pane ${child.paneId}, from pane ${caller.paneId}. One of the two is stale, so nothing was reported. Resume the child with agent_spawn and resume, which writes a new MCP config for its new pane.`);
      }
      return { parent, child };
    }
  }
  if (!caller.paneId) return undefined;
  for (const parent of parents) {
    const child = parent.children.find((entry) => !entry.exitedAt && entry.paneId === caller.paneId && (entry.host ?? LOCAL_HOST) === LOCAL_HOST);
    if (child) return { parent, child };
  }
  return undefined;
}

/**
 * Report for the child a daemon call came from. The daemon serves every
 * session on the machine, so the parent comes from the child record the
 * daemon holds, never from an environment variable.
 */
export function reportForCaller(caller: CallerIdentity, status: ReportStatus, text: string): SpoolReport {
  const found = childOfCaller(caller);
  if (!found) {
    const where = caller.paneId ? `pane ${caller.paneId}` : 'a session that is not in a herdr pane';
    const asked = caller.childId ? `child id ${caller.childId}, which no registry on this machine holds` : 'no child id';
    throw new Error(
      `parent_report has nobody to report to: it was called from ${where} with ${asked}, and no Bellwether child runs in that pane. ` +
        `A spawn starts each Claude Code child with --mcp-config=${path.join(mcpDir(), '<child id>.json')}, which names the child to its server. ` +
        `A server loaded from a user-level mcpServers entry in a pane Bellwether did not start has no record here, and neither does a child on another machine whose spawn could not register it at ${relayChildPath('<child id>')}.`,
    );
  }
  const { parent, child } = found;
  return writeReport({ parentId: parent.id, parentPaneId: parent.paneId, childId: child.id, childName: child.name, paneId: child.paneId || caller.paneId, status, text });
}

/** What a report names: who sent it, to whom, and the receipt that makes it unique. */
export interface ReportInput {
  /** The parent the sender says the report is for. Checked against the record, never trusted alone. */
  parentId?: string;
  childId?: string;
  paneId?: string;
  receipt?: string;
  status: ReportStatus;
  text: string;
}

/** Where a report goes: into a parent this daemon holds, or across to another machine. */
export type ReportRoute = { kind: 'local'; parent: ParentRecord; child: ChildRecord } | { kind: 'relay'; record: RelayRecord };

/**
 * Decide where a report goes. A parent this daemon holds always wins, so a
 * report the local daemon can serve is never forwarded. Only a child with a
 * relay record that names the parent's machine is forwarded, and a relay
 * record without one is refused with its path.
 */
export function routeReport(input: Pick<ReportInput, 'parentId' | 'childId' | 'paneId'>): ReportRoute {
  if (input.parentId) {
    const parent = readParent(input.parentId);
    const child = parent?.children.find((entry) => entry.id === input.childId);
    if (parent && child) return { kind: 'local', parent, child };
    if (parent) throw new Error(`The parent registry ${registryPath(input.parentId)} holds no child ${input.childId ?? '(none named)'}, so the report was refused.`);
  } else {
    // A child id this machine has a relay record for is authoritative: a pane
    // id alone could match some other local child, so it is tried only after.
    const byId = input.childId ? localParentOf(input.childId) : undefined;
    if (byId) return { kind: 'local', ...byId };
    if (!input.childId || !readRelayRecord(input.childId)) {
      const found = childOfCaller({ childId: input.childId, paneId: input.paneId });
      if (found) return { kind: 'local', ...found };
    }
  }
  const record = input.childId ? readRelayRecord(input.childId) : undefined;
  if (record) {
    if (input.parentId && record.parentId !== input.parentId) {
      throw new Error(`The relay record ${relayChildPath(record.childId)} sends child ${record.childId} to parent ${record.parentId}, not ${input.parentId}, so the report was refused.`);
    }
    const host = typeof record.parentHost === 'string' ? record.parentHost.trim() : '';
    if (!host || host === LOCAL_HOST) {
      throw new Error(`The relay record ${relayChildPath(record.childId)} names no remote host for parent ${record.parentId}, so the report for child ${record.childId} was not sent anywhere.`);
    }
    return { kind: 'relay', record };
  }
  if (input.parentId) throw new Error(`No parent registry ${registryPath(input.parentId)} on this machine, and no relay record ${relayChildPath(input.childId ?? '<child id>')}, so the report was refused.`);
  const asked = input.childId ? `child ${input.childId}` : input.paneId ? `pane ${input.paneId}` : 'no child';
  throw new Error(`No parent on this machine holds ${asked}, and no relay record names it, so the report was refused.`);
}

/** The parent on this machine whose registry lists a child id, if any. */
export function localParentOf(childId: string): { parent: ParentRecord; child: ChildRecord } | undefined {
  for (const parent of listParents()) {
    const child = parent.children.find((entry) => entry.id === childId);
    if (child) return { parent, child };
  }
  return undefined;
}

/** Whether the parent's spool already holds a report with this receipt. */
export function spoolHasReceipt(parentId: string, receipt: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(spoolPath(parentId), 'utf8');
  } catch {
    return false;
  }
  const needle = JSON.stringify(receipt);
  for (const line of content.split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      if ((JSON.parse(line) as SpoolReport).receipt === receipt) return true;
    } catch {
      // An unreadable line holds no receipt.
    }
  }
  return false;
}

/**
 * Write a report into a parent this daemon holds, once per receipt. The daemon
 * is the only writer, so the check and the append cannot interleave.
 */
export function acceptLocalReport(parent: ParentRecord, child: ChildRecord, input: ReportInput): { report?: SpoolReport; duplicate: boolean } {
  if (input.receipt && spoolHasReceipt(parent.id, input.receipt)) return { duplicate: true };
  const report = writeReport({
    parentId: parent.id,
    parentPaneId: parent.paneId,
    childId: child.id,
    childName: child.name,
    paneId: child.paneId || input.paneId,
    status: input.status,
    text: input.text,
    ...(input.receipt ? { receipt: input.receipt } : {}),
  });
  return { report, duplicate: false };
}

export const REPORT_STATUSES: readonly ReportStatus[] = ['done', 'needs-input', 'progress'];

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}
