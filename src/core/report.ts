// parent_report: a child appends one JSON line to its parent's spool file.
// A file keeps the child and the parent independent: either process can die
// and the report still waits for the other one.
import fs from 'node:fs';
import path from 'node:path';
import { spoolPath } from './paths.ts';
import { readParent } from './registry.ts';
import type { ReportStatus, SpoolReport } from './types.ts';

export function harnessForEnv(): string {
  if (process.env['BELLWETHER_HARNESS']) return process.env['BELLWETHER_HARNESS'];
  if (process.env['CLAUDE_CODE_SESSION_ID']) return 'claude-code';
  return 'pi';
}

/** The parent id this session's environment points at, if any. */
export function parentFromEnv(): string | undefined {
  return process.env['BELLWETHER_PARENT'];
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

/** Report to the parent named in this session's environment. */
export function reportToParent(status: ReportStatus, text: string): SpoolReport | undefined {
  const parentId = parentFromEnv();
  if (!parentId) return undefined;
  const parent = readParent(parentId);
  return writeReport({
    parentId,
    parentPaneId: parent?.paneId,
    childId: childFromEnv(),
    childName: process.env['BELLWETHER_CHILD_NAME'] ?? 'child',
    paneId: process.env['HERDR_PANE_ID'],
    status,
    text,
  });
}
