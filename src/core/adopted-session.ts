// The parent of a session Bellwether did not start. Such a session can still
// hold a Bellwether adapter, loaded at its start: a pi extension from pi's
// settings, or a Claude Code server from a plugin or a user-level entry. The
// adapter says hello with its herdr pane and no child id. Once a parent adopts
// that pane, the session answers to that parent, and this machine's daemon is
// the one place that knows it: from its registry when the parent runs here,
// and from the claim a parent on another machine left in its relay records.
//
// A pane id alone is not enough, because herdr reuses a pane id after the
// agent in it ends. The adoption recorded the harness session herdr reported
// in the pane, and the adapter names its own session in its hello, so a
// session that is not the adopted one is never handed a parent.
import { AuthorityConflict, answersByPane } from './authority.ts';
import { harnessNamed } from './harnesses/index.ts';
import { LOCAL_HOST } from './machine.ts';
import { claimantOf } from './pane-claims.ts';
import { listParents } from './registry.ts';

/**
 * How an adopted session can reach the parent that adopted it: `tools` when a
 * Bellwether adapter from its pane is connected and takes a new tool list, so
 * it now offers parent_report; `older` when one is connected whose adapter
 * predates that push, so it gains parent_report at its next hello; `none`
 * when no Bellwether adapter from the pane is connected to the daemon.
 */
export type SessionReach = 'tools' | 'older' | 'none';

/** What an adapter says about its session in its hello. */
export interface SessionHello {
  paneId?: string;
  /** The harness session id the adapter knows: Claude Code's session id, or pi's. */
  session?: string;
  childId?: string;
  reportsTo?: string;
}

/** The parent an adopted session answers to, and the child id the adoption gave it. */
export interface AdoptedParent {
  parentId: string;
  childId: string;
  name: string;
  /** Where the parent runs: here, or on another machine, which collects the report over its relay connection. */
  where: 'here' | 'away';
}

/**
 * Whether the session an adapter names is the one an adoption recorded.
 * Claude Code records its session id as herdr reports it, and pi records the
 * path of its session file, which ends in the session id. An adapter that
 * could not learn its session, such as a Claude Code server started outside
 * Claude Code (`pid-…`), and an adoption whose pane reported none, cannot be
 * compared, and the pane decides.
 */
export function sameSession(hello: string | undefined, recorded: string | undefined): boolean {
  if (!hello || !recorded || hello.startsWith('pid-')) return true;
  return recorded === hello || recorded.includes(hello);
}

/**
 * The parent that adopted the pane a session says hello from, or undefined.
 * A session that carries a child id or a parent from its start keeps those,
 * and this returns nothing for it.
 */
export function adoptedParentOf(hello: SessionHello): AdoptedParent | undefined {
  if (hello.childId || hello.reportsTo || !hello.paneId) return undefined;
  // Two holders that disagree give the session no parent, so its report goes
  // to neither: the pane's holders are judged before either one answers (issue #279).
  let holder: ReturnType<typeof claimantOf>;
  try {
    holder = claimantOf(hello.paneId);
  } catch (error) {
    if (error instanceof AuthorityConflict) return undefined;
    throw error;
  }
  for (const parent of listParents()) {
    const child = parent.children.find((entry) => answersByPane(entry) && !entry.exitedAt && entry.paneId === hello.paneId && (entry.host ?? LOCAL_HOST) === LOCAL_HOST);
    if (child && sameSession(hello.session, child.session?.value)) return { parentId: parent.id, childId: child.id, name: child.name, where: 'here' };
  }
  if (holder?.where !== 'away' || !holder.record.adopted) return undefined;
  if (!sameSession(hello.session, holder.record.session)) return undefined;
  return { parentId: holder.record.parentId, childId: holder.record.childId, name: holder.record.name, where: 'away' };
}

/**
 * Why the Bellwether adapter connected from an adopted pane takes no message,
 * from its harness's entry, in the words a typed message's reason uses.
 */
export function adoptedInboxGap(harness: string): { adapter: string; why: string } {
  const inbox = harnessNamed(harness)?.inbox;
  return inbox && inbox.via !== 'none' ? inbox.adopted : { adapter: 'server or extension', why: 'takes no messages' };
}
