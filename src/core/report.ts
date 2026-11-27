// parent_report: a child appends one JSON line to its parent's spool file.
// A file keeps the child and the parent independent: either process can die
// and the report still waits for the other one.
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_HOST } from './machine.ts';
import { mcpDir, spoolPath } from './paths.ts';
import { listParents, readParent } from './registry.ts';
import type { CallerIdentity, ChildRecord, ParentRecord, ReportStatus, SpoolReport } from './types.ts';

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
        throw new Error(`parent_report was called for child ${child.id}, whose record holds pane ${child.paneId}, from pane ${caller.paneId}. One of the two is stale, so nothing was reported. Resume the child with agent_resume, which writes a new MCP config for its new pane.`);
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
        'A server loaded from a user-level mcpServers entry in a pane Bellwether did not start, or a child on another machine, has no record here.',
    );
  }
  const { parent, child } = found;
  return writeReport({ parentId: parent.id, parentPaneId: parent.paneId, childId: child.id, childName: child.name, paneId: child.paneId || caller.paneId, status, text });
}

/** Report to the parent named in this session's environment. The CLI uses it from a child's own shell. */
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
