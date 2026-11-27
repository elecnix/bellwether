// The agent tree, as `bellwether ancestry` answers it. Another program holds
// an agent as `<harness>:<session>`, such as `claude:<id>` from a card, and
// asks which of its ancestors still run. This is a query over what the daemon
// already holds: the registry, the sessions connected to it, and the parents
// whose children it watches. It keeps no state of its own.
//
// The answer is a published interface (docs/tools.md, "The agent tree"). A
// field keeps its name and meaning; a change that would break a reader bumps
// ANCESTRY_SCHEMA. test/unit/ancestry.test.ts fails on a renamed field.
import path from 'node:path';
import { kindOfHarness } from './harnesses/index.ts';
import type { ChildRecord, ParentRecord } from './types.ts';

/** The layout of the answer. A reader checks it before trusting the fields. */
export const ANCESTRY_SCHEMA = 1;

/**
 * Why `alive` says what it says:
 * - `connected`: the session holds a connection to the daemon now, so it runs.
 * - `watched`: its parent's service in the daemon watches its pane through herdr, and herdr has not reported it gone.
 * - `exited`: its record says it exited, at `since`.
 * - `disconnected`: a session that is nobody's child here, with no connection to the daemon.
 * - `unwatched`: a child whose record shows no exit, but whose parent's service is not running, so nothing would have recorded one.
 * - `stale`: the daemon did not answer, and the registry alone cannot say.
 */
export type AliveEvidence = 'connected' | 'watched' | 'exited' | 'disconnected' | 'unwatched' | 'stale';

/**
 * How the answer chose a record when more than one names the same session, as
 * after a resume under another parent: `single` when one did, `alive` when the
 * winner was the one not known to have stopped, `latest-start` when the most
 * recent start decided, and `child-id` when only the lower child id did.
 */
export type MatchRule = 'single' | 'alive' | 'latest-start' | 'child-id';

export interface AncestryLevel {
  /** `<harness>:<session>`, in the notation the query takes, or null while the harness has not reported a session. */
  agent: string | null;
  /** The harness, such as `claude-code` or `pi`, or the child's kind for another harness. */
  harness: string;
  /** The harness session id. For a pi session, the id inside its file name. */
  session: string | null;
  /** The child id the parent's spawn gave it, or null for a session that is nobody's child here. */
  childId: string | null;
  /** The name the parent gave it, or null for a session that is nobody's child here. */
  childName: string | null;
  /** The session's own registry id, `<harness>-<session>`, once it has said hello to a daemon; null otherwise. */
  registryId: string | null;
  /** `local` for this machine, or the herdr machine label the child runs on. */
  host: string;
  /** Bellwether generations from the root, which is 0. */
  depth: number;
  /** Whether the daemon knows the session runs: true, false, or null when it cannot know. `evidence` says why. */
  alive: boolean | null;
  evidence: AliveEvidence;
  /** When the state `alive` names began: the start for a running child, the connection for a running root, the exit for an exited child. Null when unknown. */
  since: string | null;
  /** When Bellwether finished retiring the child's worktree and branch, or null. */
  retiredAt: string | null;
  /** Which record this level came from, and the rule that chose it. */
  match: { rule: MatchRule; records: { childId: string; parentId: string; startedAt: string }[] };
}

export interface AncestryAnswer {
  schema: number;
  /** The query as given. */
  query: string;
  /** `unknown` when no record names the agent: it is not in the tree, which is not the same as having no living ancestor. */
  status: 'known' | 'unknown';
  /** True when the daemon did not answer and the registry files were read in its place. */
  stale: boolean;
  /** Why the answer is stale. Present only when it is. */
  staleReason?: string;
  /** `daemon` when the daemon answered, `registry` when the files were read without it. */
  source: 'daemon' | 'registry';
  /** The agent asked about, or null when unknown. */
  agent: AncestryLevel | null;
  /** Its ancestors, nearest first. Empty for a root. */
  chain: AncestryLevel[];
  /** The index in `chain` of the nearest ancestor with `alive: true`, or null when none is. */
  nearestAlive: number | null;
  /** Why the chain stops: `root` at a session with no parent, `outside` at one whose parent's registry is on another machine. Null when unknown. */
  top: 'root' | 'outside' | null;
}

/** What the daemon knows beyond the registry, or why it could not be asked. */
export type Liveness =
  | { connected: readonly { parentId: string; childId?: string; connectedAt: string }[]; watched: readonly string[] }
  | { stale: string };

/** A query: a harness prefix and a session, or a bare value that is a child id or a session. */
export interface AgentQuery {
  prefix?: string;
  session: string;
}

/** The prefix an agent goes by: its kind in the harness registry, such as `claude` for `claude-code`. */
function prefixOf(harnessOrKind: string): string {
  return kindOfHarness(harnessOrKind);
}

/** A session id from a session value: a pi session file names its id after the last underscore. */
export function sessionIdOf(value: string): string {
  if (!value.includes('/') && !value.endsWith('.jsonl')) return value;
  const base = path.basename(value, '.jsonl');
  const underscore = base.lastIndexOf('_');
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

export function parseAgent(query: string): AgentQuery | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return { session: sessionIdOf(trimmed) };
  const session = sessionIdOf(trimmed.slice(colon + 1).trim());
  if (!session) return undefined;
  return { prefix: prefixOf(trimmed.slice(0, colon).trim()), session };
}

interface Held {
  child: ChildRecord;
  parent: ParentRecord;
}

function latestStart(child: ChildRecord): string {
  return [child.startedAt, child.resumedAt, child.restartedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? child.startedAt;
}

export function ancestry(query: string, parents: readonly ParentRecord[], liveness: Liveness): AncestryAnswer {
  const stale = 'stale' in liveness ? liveness.stale : undefined;
  const base = { schema: ANCESTRY_SCHEMA, query, ...(stale === undefined ? { stale: false } : { stale: true, staleReason: stale }), source: stale === undefined ? ('daemon' as const) : ('registry' as const) };
  const unknown: AncestryAnswer = { ...base, status: 'unknown', agent: null, chain: [], nearestAlive: null, top: null };
  const parsed = parseAgent(query);
  if (!parsed) return unknown;

  const held: Held[] = parents.flatMap((parent) => parent.children.map((child) => ({ child, parent })));
  const records = new Map(parents.map((parent) => [parent.id, parent]));
  const connected = 'stale' in liveness ? [] : liveness.connected;
  const watched = new Set('stale' in liveness ? [] : liveness.watched);

  const sessionMatches = (child: ChildRecord, prefix: string | undefined, session: string): boolean =>
    Boolean(child.session) && sessionIdOf(child.session!.value) === session && (!prefix || prefixOf(child.kind) === prefix || prefixOf(child.harness) === prefix);

  /** The session's own registry: the one its hello wrote, found by child id or by session. */
  const ownRecord = (child: ChildRecord | undefined, prefix: string | undefined, session: string | undefined): ParentRecord | undefined => {
    const byChild = child ? parents.filter((parent) => parent.childId === child.id) : [];
    if (byChild.length) return byChild.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
    if (!session) return undefined;
    return parents.find((parent) => parent.session === session && (!prefix || prefixOf(parent.harness) === prefix));
  };

  const judge = (child: ChildRecord | undefined, own: ParentRecord | undefined, container: ParentRecord | undefined): Pick<AncestryLevel, 'alive' | 'evidence' | 'since'> => {
    const link = connected.find((entry) => (own && entry.parentId === own.id) || (child && entry.childId === child.id));
    if (link) return { alive: true, evidence: 'connected', since: child ? latestStart(child) : link.connectedAt };
    if (child?.exitedAt) return { alive: false, evidence: 'exited', since: child.exitedAt };
    if (stale !== undefined) return { alive: null, evidence: 'stale', since: null };
    if (child && container && watched.has(container.id)) return { alive: true, evidence: 'watched', since: latestStart(child) };
    if (child) return { alive: null, evidence: 'unwatched', since: null };
    return { alive: false, evidence: 'disconnected', since: null };
  };

  const rank = (candidate: Held): number => {
    const { alive } = judge(candidate.child, ownRecord(candidate.child, undefined, undefined), candidate.parent);
    return alive === true ? 0 : alive === null ? 1 : 2;
  };

  /** Pick one record among those naming a session, by the documented rule. */
  const choose = (candidates: Held[]): { winner: Held; rule: MatchRule; ordered: Held[] } | undefined => {
    const ordered = candidates
      .map((candidate) => ({ candidate, rank: rank(candidate), start: latestStart(candidate.child) }))
      .sort((a, b) => a.rank - b.rank || b.start.localeCompare(a.start) || a.candidate.child.id.localeCompare(b.candidate.child.id) || a.candidate.parent.id.localeCompare(b.candidate.parent.id));
    const [first, second] = ordered;
    if (!first) return undefined;
    const rule: MatchRule = !second ? 'single' : first.rank !== second.rank ? 'alive' : first.start !== second.start ? 'latest-start' : 'child-id';
    return { winner: first.candidate, rule, ordered: ordered.map((entry) => entry.candidate) };
  };

  const level = (choice: ReturnType<typeof choose>, own: ParentRecord | undefined): AncestryLevel => {
    const child = choice?.winner.child;
    const container = choice?.winner.parent;
    const harness = own?.harness ?? child?.harness ?? 'unknown';
    const session = own?.session ?? (child?.session ? sessionIdOf(child.session.value) : null);
    const prefix = prefixOf(own?.harness ?? child?.kind ?? harness);
    return {
      agent: session ? `${prefix}:${session}` : null,
      harness,
      session,
      childId: child?.id ?? own?.childId ?? null,
      childName: child?.name ?? null,
      registryId: own?.id ?? null,
      host: child?.host ?? own?.host ?? 'unknown',
      depth: child?.depth ?? own?.depth ?? 0,
      ...judge(child, own, container),
      retiredAt: child?.retiredAt ?? null,
      match: { rule: choice?.rule ?? 'single', records: (choice?.ordered ?? []).map(({ child: record, parent }) => ({ childId: record.id, parentId: parent.id, startedAt: latestStart(record) })) },
    };
  };

  // The agent itself: a child record by session or child id, else a session's own registry.
  let candidates = held.filter(({ child }) => sessionMatches(child, parsed.prefix, parsed.session) || (!parsed.prefix && child.id === parsed.session));
  let own = ownRecord(undefined, parsed.prefix, parsed.session) ?? (parsed.prefix ? undefined : records.get(parsed.session));
  if (!candidates.length && own?.childId) candidates = held.filter(({ child }) => child.id === own!.childId);
  if (!candidates.length && !own) return unknown;
  let choice = choose(candidates);
  if (choice) own = ownRecord(choice.winner.child, prefixOf(choice.winner.child.kind), choice.winner.child.session ? sessionIdOf(choice.winner.child.session.value) : undefined) ?? own;
  const agent = level(choice, own);

  // Each step up: the parent that holds the record, then that parent's own place as a child.
  const chain: AncestryLevel[] = [];
  const seen = new Set<string>([...(own ? [own.id] : [])]);
  let top: AncestryAnswer['top'] = own?.childId || (own?.depth ?? 0) > 0 ? 'outside' : 'root';
  while (choice) {
    const up = choice.winner.parent;
    if (seen.has(up.id)) break;
    seen.add(up.id);
    const upCandidates = up.childId ? held.filter(({ child }) => child.id === up.childId) : held.filter(({ child }) => sessionMatches(child, prefixOf(up.harness), up.session));
    choice = choose(upCandidates);
    chain.push(level(choice, up));
    top = choice ? top : up.childId || up.depth > 0 ? 'outside' : 'root';
  }

  const nearest = chain.findIndex((entry) => entry.alive === true);
  return { ...base, status: 'known', agent, chain, nearestAlive: nearest >= 0 ? nearest : null, top };
}
