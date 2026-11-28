// What a child's exit left on another machine when `relay-cleanup` failed
// there (issue #258). An adopted child's claim, or a started child's brief,
// MCP config and relay record, then stays on that machine. A claim that stays
// routes a later run of the same session in that pane to a parent whose child
// exited, and makes a parent there that adopts the pane share its route.
//
// The parent's watcher owns the retry. It tries again on its tick, waiting
// longer after each failure, up to a minute, until `RESTART_DEFER_MS` after the
// first failure, the bound a deferred restart waits too. Past that deadline the
// cleanup has expired: the tick stops trying, and doctor names what stays and
// the command that removes it by hand. Each time the relay to that machine
// comes up, the watcher tries once more, expired or not, because a link that
// is up is when the call can succeed.
//
// The child stays exited whatever happens to the cleanup. Expiry changes no
// record but this one, and never ends an adopted child's wait for its session
// to come back: a return claims the pane again under the same child id, which
// replaces what stayed.
import { RESTART_DEFER_MS } from './restart.ts';
import { updateChild } from './registry.ts';
import type { ChildRecord } from './types.ts';

/** Record a failed cleanup, or a retry that failed again. The first failure sets the deadline. */
export function cleanupLeft(parentId: string, childId: string, host: string, reason: string, now: number): void {
  updateChild(parentId, childId, (entry) => {
    const first = entry.cleanupPending?.host === host ? entry.cleanupPending : undefined;
    const at = first?.at ?? new Date(now).toISOString();
    entry.cleanupPending = { at, host, reason, until: first?.until ?? new Date(Date.parse(at) + RESTART_DEFER_MS).toISOString(), ...(first?.expiredAt ? { expiredAt: first.expiredAt } : {}) };
  });
}

/** The cleanup ran, or what it would have removed belongs to a run of the child there again. */
export function cleanupDone(parentId: string, childId: string): void {
  updateChild(parentId, childId, (entry) => {
    delete entry.cleanupPending;
  });
}

/** The deadline passed: the tick stops trying. */
export function cleanupExpired(parentId: string, childId: string, now: number): void {
  updateChild(parentId, childId, (entry) => {
    if (entry.cleanupPending && !entry.cleanupPending.expiredAt) entry.cleanupPending = { ...entry.cleanupPending, expiredAt: new Date(now).toISOString() };
  });
}

/**
 * Whether what the cleanup would remove now belongs to a live run of the
 * child on the same machine. A resume, a restart or an adoption's return
 * registers the child there again under the same id, which replaces what the
 * failed cleanup left, so removing it would take the live run's files.
 */
export function cleanupSuperseded(child: Pick<ChildRecord, 'exitedAt' | 'host' | 'cleanupPending'>): boolean {
  return Boolean(child.cleanupPending && !child.exitedAt && (child.host ?? 'local') === child.cleanupPending.host);
}
