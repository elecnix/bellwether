// Authority over a child: who may act on it, and on what evidence (issue
// #279). This module is the only writer of the fields that answer "may this
// daemon speak for this child?", and the only reader that turns them into a
// decision. Every other module asks it a named question, `mayAct` for a
// parent's act and a predicate such as `answersDialogs` for the daemon's own
// policies, so one field no longer decides five policies in eight modules.
// `test/unit/authority-owner.test.ts` fails on a write to one of these fields
// anywhere else, and on a comparison of `origin` anywhere else, and
// `ChildRecord` declares each field `readonly`, so the typecheck fails on a
// write through any alias too.
//
// The fields:
//
//   origin         How the child came under its parent: spawn, resume or adopt.
//   adoptInDoubt   An adoption on another machine whose answer the relay lost.
//   claimUnconfirmed  The relay came back, and the child's machine has not
//                  confirmed the claim this parent holds there (issue #257).
//   farRecordLost  The child's machine holds no record of it. With `contested`,
//                  that machine holds the pane for someone else.
//   replacedBy     The child id that now stands for this child's session.
//
// Three sources of authority can stand behind a child: a parent's registry on
// this machine, the claim a parent on another machine left in this machine's
// relay records, and a freed child's peer book (issue #262).
// When two of them name one pane, or one child, and the code cannot tell which
// is right, the answer is a refusal that names both. Nothing here picks one.
//
// The decision table, rows by standing and columns by act. The same table is
// in docs/authority.md for an operator, and test/unit/authority.test.ts pins
// every cell:
//
//   standing     message  restart  resume  move    teleport  retire  free
//   started      yes      yes      yes     yes     yes       yes     yes
//                (a spawn, a resume, or an adopted child a resume relaunched)
//   adopted      yes      no       yes     no      no        no      no
//   claimed      yes      no       yes     no      no        no      no
//   stale        as the child's holding row (started, adopted or claimed)
//   unconfirmed  no       no       no      no      no        no      no
//   contested    no       no       no      no      no        no      no
//   replaced     no       no       no      no      no        no      no
//   freed        no       no       no      no      no        no      no
//
// A "yes" is this module's answer only. The act's own module still refuses
// for its own reasons, such as a child that is moving or has no session.
import { LOCAL_HOST } from './machine.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import type { RelayRecord } from './relay-records.ts';

/** The fields this module owns, each with what it records. */
export const AUTHORITY_FIELDS = {
  origin: 'how the child came under its parent: spawn, resume or adopt',
  adoptInDoubt: "an adoption on another machine whose answer the relay lost, so that machine's claim is unconfirmed",
  farRecordLost: "the child's machine holds no record of it; with contested, that machine holds its pane for someone else",
  claimUnconfirmed: "the relay came back, and the child's machine has not confirmed it still holds the pane for this parent (issue #257)",
  replacedBy: "the child id that now stands for this child's session, on the machine that runs it",
} as const satisfies { [K in keyof ChildRecord]?: string };

export type AuthorityField = keyof typeof AUTHORITY_FIELDS;
export const AUTHORITY_FIELD_NAMES = Object.keys(AUTHORITY_FIELDS) as readonly AuthorityField[];

/** How a parent holds a child, before any doubt about the evidence. */
export type Holding = 'started' | 'adopted' | 'claimed';

/** The row of the decision table a child sits on. */
export type Standing = Holding | 'stale' | 'unconfirmed' | 'contested' | 'replaced' | 'freed';

/** The acts a parent asks for, the columns of the decision table. */
export type Act = 'message' | 'restart' | 'resume' | 'move' | 'teleport' | 'retire' | 'free';

export const STANDINGS: readonly Standing[] = ['started', 'adopted', 'claimed', 'stale', 'unconfirmed', 'contested', 'replaced', 'freed'];
export const ACTS: readonly Act[] = ['message', 'restart', 'resume', 'move', 'teleport', 'retire', 'free'];

/** What an act needs beyond the record: where a carry goes. */
export interface ActContext {
  target?: string;
}

type Facts = Pick<ChildRecord, 'id' | 'name' | 'paneId' | 'host' | 'launchedAt' | AuthorityField>;
type Refusal = (child: Facts, context: ActContext) => string;
/** A cell: the act may go ahead, the child's holding row decides, or a refusal with its reason. */
type Rule = 'permit' | 'as-held' | Refusal;

/** Where an issue that a refusal waits on is tracked. */
export const ADOPTED_TELEPORT_ISSUE = 'https://github.com/elecnix/bellwether/issues/219';

function machine(host: string | undefined): string {
  return !host || host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

function who(child: Facts): string {
  return `${child.name} (child ${child.id})`;
}

const VERB: Record<Act, string> = {
  message: 'a message',
  restart: 'agent_restart',
  resume: 'a resume',
  move: 'agent_move',
  teleport: 'agent_teleport',
  retire: 'retirement',
  free: 'agent_free',
};

const notStarted = {
  restart: (child: Facts) => `${who(child)} was adopted, not started by Bellwether, so agent_restart will not close pane ${child.paneId}: it closes only panes Bellwether started.`,
  move: (child: Facts) => `${who(child)} was adopted, not started by Bellwether, so agent_move will not close pane ${child.paneId}: a move closes the pane it leaves, and Bellwether closes only panes it started.`,
  teleport: (child: Facts, context: ActContext) =>
    `${child.name} is an adopted child. Bellwether did not start it, and its parent's record and the daemon that holds its pane can disagree about it, so a teleport would carry that disagreement to ${machine(context.target)}. Teleporting an adopted child waits on ${ADOPTED_TELEPORT_ISSUE}.`,
  retire: (child: Facts) => `${child.name} was adopted, not spawned by Bellwether, so Bellwether never removes its worktree. Remove it by hand with \`git worktree remove\` once its work is safe.`,
  free: (child: Facts) => `${child.name} is an adopted child: Bellwether did not start it, so its session holds no record of a parent to leave. Stop watching it with agent_stop instead.`,
} satisfies Partial<Record<Act, Refusal>>;

/** Every act refused for one reason, which names the act. */
function refuseAll(reason: (child: Facts, act: Act) => string): Record<Act, Rule> {
  const rule = (act: Act): Refusal => (child) => reason(child, act);
  return { message: rule('message'), restart: rule('restart'), resume: rule('resume'), move: rule('move'), teleport: rule('teleport'), retire: rule('retire'), free: rule('free') };
}

const adoptedRow: Record<Act, Rule> = { message: 'permit', restart: notStarted.restart, resume: 'permit', move: notStarted.move, teleport: notStarted.teleport, retire: notStarted.retire, free: notStarted.free };

/** The decision table. A cell that refuses gives its reason, so a refusal never reads as a bug. */
export const DECISIONS = {
  started: { message: 'permit', restart: 'permit', resume: 'permit', move: 'permit', teleport: 'permit', retire: 'permit', free: 'permit' },
  adopted: adoptedRow,
  claimed: adoptedRow,
  // The child's machine lost its record, as after a reboot, and nobody else holds the pane there: the parent's own record still stands.
  stale: { message: 'as-held', restart: 'as-held', resume: 'as-held', move: 'as-held', teleport: 'as-held', retire: 'as-held', free: 'as-held' },
  unconfirmed: refuseAll((child, act) => {
    const doubt = child.adoptInDoubt;
    const open = child.claimUnconfirmed;
    const why = doubt
      ? `the relay lost ${machine(doubt.host)}'s answer to its adoption at ${doubt.at} (${doubt.reason})`
      : `since ${open?.at ?? 'an unknown time'}, ${machine(open?.host)} has not confirmed it still holds the pane for this parent (${open?.reason ?? 'no reason recorded'})`;
    return `${who(child)} is unconfirmed: ${why}, so this parent does not know whether it holds pane ${child.paneId} or another parent does. The watcher asks that machine again, and ${VERB[act]} waits for its answer.`;
  }),
  contested: refuseAll((child, act) => `${conflictOf(child)} Bellwether does not pick one, so it refuses ${VERB[act]} for ${child.name}. Stop the child under the parent that should not hold it, or adopt the pane again once the other holder lets it go.`),
  replaced: refuseAll((child, act) => `${who(child)} was replaced: ${machine(child.host)} holds its session as child ${child.replacedBy}, so ${VERB[act]} goes to ${child.replacedBy}, not to this record.`),
  freed: refuseAll((child, act) => `freed: no parent holds ${who(child)}, so ${VERB[act]} has no parent to act for. Reach it with peer_send at its address.`),
} as const satisfies Record<Standing, Record<Act, Rule>>;

/** The two sources that disagree about a contested child, in one sentence. */
function conflictOf(child: Facts): string {
  const lost = child.farRecordLost;
  return `Two sources of authority disagree about ${who(child)}: this parent's registry holds it in pane ${child.paneId} on ${machine(lost?.host ?? child.host)}, and that machine's claims answer otherwise since ${lost?.at ?? 'an unknown time'}: ${(lost?.reason ?? 'no reason recorded').replace(/\.$/, '')}.`;
}

/**
 * Whether the parent holds the child by adoption now, rather than as one it
 * started. Every policy that differs between the two reads this one line.
 * Adoption is how the child first came, and it stays in `origin` as
 * provenance. A resume starts a new harness in a tab Bellwether opens and
 * sets `launchedAt`, so from then on the parent holds the child as one it
 * started, until its session comes back under an adoption (issue #256).
 */
export function heldByAdoption(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return child.origin === 'adopt' && !child.launchedAt;
}

/** How the child first came under this parent, for a sentence that says so. An older record means spawn. */
export function acquiredBy(child: Pick<ChildRecord, 'origin'>): NonNullable<ChildRecord['origin']> {
  return child.origin ?? 'spawn';
}

export function holdingOf(child: Pick<ChildRecord, 'origin' | 'launchedAt' | 'host'>): Holding {
  if (!heldByAdoption(child)) return 'started';
  return (child.host ?? LOCAL_HOST) === LOCAL_HOST ? 'adopted' : 'claimed';
}

/** The row of the decision table the child sits on, from its record alone. */
export function standingOf(child: Pick<ChildRecord, 'origin' | 'launchedAt' | 'host' | AuthorityField>): Standing {
  if (child.replacedBy) return 'replaced';
  if (child.farRecordLost?.contested) return 'contested';
  if (child.adoptInDoubt || child.claimUnconfirmed) return 'unconfirmed';
  if (child.farRecordLost) return 'stale';
  return holdingOf(child);
}

/** The reason this parent may not do the act, or undefined when it may. */
export function refusal(child: Facts, act: Act, context: ActContext = {}, standing: Standing = standingOf(child)): string | undefined {
  let rule: Rule = DECISIONS[standing][act];
  if (rule === 'as-held') rule = DECISIONS[holdingOf(child)][act];
  if (rule === 'permit' || rule === 'as-held') return undefined;
  return rule(child, context);
}

/**
 * The refusal for an act on a child whose machine has just named another
 * holder for its pane, for the answer that found it out, before the record
 * that says so is read again.
 */
export function contestedRefusal(child: Facts, act: Act, lost: { host: string; reason: string }, now = new Date()): string {
  return refusal({ ...child, farRecordLost: { at: now.toISOString(), host: lost.host, reason: lost.reason, contested: true } }, act, {}, 'contested') ?? lost.reason;
}

/** The refusal as a field of a carry's facts, which `teleportRefusals` and the move policy read. */
export function authorityFor(child: Facts, act: 'move' | 'teleport', target: string): { authority?: string } {
  const why = refusal(child, act, { target });
  return why ? { authority: why } : {};
}

/** A parent's act that authority refuses. */
export class AuthorityRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityRefused';
  }
}

/** Throw the refusal, as the caller's own error class, when the parent may not do the act. */
export function requireAuthority(child: Facts, act: Act, context: ActContext = {}, make: (message: string) => Error = (message) => new AuthorityRefused(message)): void {
  const why = refusal(child, act, context);
  if (why) throw make(why);
}

// The daemon's own policies, each a named question. Each reads the holding,
// so the answers for an adopted child stay together.

/** Whether Bellwether answers the child's startup dialogs: only in a session it started under its own settings. */
export function answersDialogs(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return !heldByAdoption(child);
}

/** Whether a start window applies: a harness Bellwether started and has not seen yet may have failed to start. */
export function checksStart(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return !heldByAdoption(child);
}

/**
 * Whether another session in the pane ends the child. An adopted child
 * stands for the session it was adopted on, since no child id rides in that
 * session, so another session there is another agent.
 */
export function endsOnNewSession(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return heldByAdoption(child);
}

/** Whether a harness that quit in its open pane may come back there as the same child (issue #191). */
export function awaitsReturn(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return heldByAdoption(child);
}

/** Whether this parent may make the child's claim on its machine again, as only an adoption's claim can be (issue #219). */
export function reclaimsFarRecord(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return heldByAdoption(child);
}

/** Whether a session that says hello from the child's pane with no child id is this child: an adopted one, by pane and session. */
export function answersByPane(child: Pick<ChildRecord, 'origin' | 'launchedAt'>): boolean {
  return heldByAdoption(child);
}

/** Whether an exited record may come back when its adopted session runs again, rather than a new child (issue #191). */
export function resumesAdoption(child: Pick<ChildRecord, 'origin' | 'replacedBy'>): boolean {
  return heldByAdoption(child) && !child.replacedBy;
}

// The transitions, the only writes to the authority fields.

type Writable = { -readonly [K in AuthorityField]: ChildRecord[K] };
function writable(record: ChildRecord): Writable {
  return record as Writable;
}

/** The authority fields of a new record. */
export function acquired(origin: NonNullable<ChildRecord['origin']>, doubt?: ChildRecord['adoptInDoubt']): Pick<ChildRecord, 'origin' | 'adoptInDoubt'> {
  return { origin, ...(doubt ? { adoptInDoubt: doubt } : {}) };
}

/** The relay lost the far machine's answer to an adoption. */
export function adoptionInDoubt(entry: ChildRecord, doubt: NonNullable<ChildRecord['adoptInDoubt']>): void {
  writable(entry).adoptInDoubt = doubt;
}

/** The far machine answered the adoption, either way. */
export function adoptionSettled(entry: ChildRecord): void {
  delete writable(entry).adoptInDoubt;
}

/** The relay came back, and the child's machine could not confirm the claim this parent holds there. The first time stays. */
export function claimUnconfirmed(entry: ChildRecord, open: { host: string; reason: string }, now = new Date()): void {
  writable(entry).claimUnconfirmed = { at: entry.claimUnconfirmed?.at ?? now.toISOString(), host: open.host, reason: open.reason };
}

/** The child's machine confirmed the claim, or refused it. */
export function claimSettled(entry: ChildRecord): void {
  delete writable(entry).claimUnconfirmed;
}

/** A copy of the record with its adoption settled, for code that acts on the record it just settled. */
export function settledCopy(child: ChildRecord): ChildRecord {
  const copy: ChildRecord = { ...child };
  adoptionSettled(copy);
  claimSettled(copy);
  return copy;
}

/** The child's session now stands under another child id. */
export function replaced(entry: ChildRecord, by: string): void {
  writable(entry).replacedBy = by;
}

/**
 * The child's machine answered that it holds no record of the child. With
 * `contested`, it holds the pane for someone else: another parent, or this
 * parent under another child id. The first time stays.
 */
export function farRecordLost(entry: ChildRecord, lost: { host: string; reason: string; contested?: boolean }, now = new Date()): void {
  writable(entry).farRecordLost = { at: entry.farRecordLost?.at ?? now.toISOString(), host: lost.host, reason: lost.reason, ...(lost.contested ? { contested: true } : {}) };
}

/** The child's machine holds the child again, so its record and this one agree. */
export function farRecordHeld(entry: ChildRecord): void {
  delete writable(entry).farRecordLost;
}

// Who holds a pane, across the sources that can say.

/** One source that says it holds a pane. */
export interface PaneHolder {
  source: 'registry' | 'claim';
  parentId: string;
  childId: string;
  name: string;
  /** The harness session the source holds the pane for, when it knows. */
  session?: string;
  /** For a claim: whether it is an adoption's claim, which a session change makes stale. */
  adopted?: boolean;
}

export type PaneJudgement = { kind: 'none' } | { kind: 'one'; holder: PaneHolder } | { kind: 'contested'; holders: [PaneHolder, PaneHolder, ...PaneHolder[]]; reason: string };

/** Two sources of authority name one pane, and the code cannot tell which is right. */
export class AuthorityConflict extends Error {
  readonly holders: readonly PaneHolder[];
  constructor(message: string, holders: readonly PaneHolder[]) {
    super(message);
    this.name = 'AuthorityConflict';
    this.holders = holders;
  }
}

function describeHolder(holder: PaneHolder): string {
  const as = `as child ${holder.childId} (${holder.name})${holder.session ? ` on session ${holder.session}` : ''}`;
  return holder.source === 'registry' ? `the registry of parent ${holder.parentId} on this machine, ${as}` : `the ${holder.adopted ? 'adoption claim' : 'relay record'} of parent ${holder.parentId} on another machine, ${as}`;
}

/**
 * Who holds a pane, from every source that names it. One source holding it
 * twice is one holder. An adoption's claim for a session other than the one
 * another source holds the pane for is stale: herdr reused the pane id after
 * the adopted session ended, and the claim stands for nothing. Any other pair
 * is a conflict, and the answer names both sources.
 */
export function judgeHolders(host: string, paneId: string, sources: readonly PaneHolder[]): PaneJudgement {
  const seen = new Map<string, PaneHolder>();
  for (const holder of sources) seen.set(`${holder.parentId}\0${holder.childId}`, holder);
  let holders = [...seen.values()];
  const sessions = new Set(holders.filter((holder) => !(holder.source === 'claim' && holder.adopted)).flatMap((holder) => (holder.session ? [holder.session] : [])));
  if (sessions.size) holders = holders.filter((holder) => !(holder.source === 'claim' && holder.adopted && holder.session && !sessions.has(holder.session)));
  const [first, second, ...rest] = holders;
  if (!first) return { kind: 'none' };
  if (!second) return { kind: 'one', holder: first };
  const reason = `Pane ${paneId} on ${machine(host)} is held by two sources of authority that disagree: ${describeHolder(first)}, and ${describeHolder(second)}${rest.length ? `, and ${rest.length} more` : ''}. Bellwether does not pick one.`;
  return { kind: 'contested', holders: [first, second, ...rest], reason };
}

// What doctor prints.

/** The evidence behind a child's standing, in the words a doctor line uses. */
function evidence(parent: Pick<ParentRecord, 'id'>, child: ChildRecord): string {
  const host = child.host ?? LOCAL_HOST;
  const registry = `the registry of parent ${parent.id} on this machine`;
  const pane = child.paneId ? `pane ${child.paneId}` : 'no pane yet';
  switch (standingOf(child)) {
    case 'started':
      return `${registry}, which ${acquiredBy(child) === 'resume' ? 'resumed' : 'started'} it in ${pane}${host === LOCAL_HOST ? '' : `, and the relay record on ${machine(host)} that its start wrote`}`;
    case 'adopted':
      return `${registry}, which adopted ${pane}`;
    case 'claimed':
      return `${registry}, which adopted ${pane}, and the claim it left on ${machine(host)}`;
    case 'stale':
      return `${registry} alone: ${machine(child.farRecordLost?.host)} has held no record of it since ${child.farRecordLost?.at} (${child.farRecordLost?.reason.replace(/\.$/, '')})`;
    case 'unconfirmed': {
      const open = child.adoptInDoubt ?? child.claimUnconfirmed;
      return `${registry} alone: ${machine(open?.host)} has not confirmed the claim since ${open?.at}`;
    }
    case 'contested':
      return conflictOf(child);
    case 'replaced':
      return `${registry}, which says child ${child.replacedBy} now stands for its session`;
    case 'freed':
      return 'no registry: its former parent freed it';
  }
}

const LEVEL: Record<Standing, 'ok' | 'warn' | 'fail'> = { started: 'ok', adopted: 'ok', claimed: 'ok', stale: 'warn', unconfirmed: 'warn', contested: 'fail', replaced: 'warn', freed: 'ok' };

/**
 * One doctor line per live child, saying who holds it, on which machine and
 * by what evidence, then one line per pane on this machine that a parent on
 * another machine holds here, and one fail line per pane whose sources
 * disagree.
 */
export function authorityLines(parents: readonly ParentRecord[], claims: readonly RelayRecord[]): string[] {
  const lines: string[] = [];
  const local = new Map<string, PaneHolder[]>();
  // A pane a parent here started was opened by Bellwether after any claim on its id, so that claim is stale, as claimantOf counts it.
  const startedHere = new Set<string>();
  for (const parent of parents) {
    for (const child of parent.children) {
      if (child.exitedAt) continue;
      const standing = standingOf(child);
      lines.push(`${LEVEL[standing].padEnd(5)} authority: ${child.name} (child ${child.id}) on ${machine(child.host)} is ${standing}, held by parent ${parent.id}; evidence: ${evidence(parent, child).replace(/\.$/, '')}.`);
      if ((child.host ?? LOCAL_HOST) === LOCAL_HOST && child.paneId && !heldByAdoption(child)) startedHere.add(child.paneId);
      if ((child.host ?? LOCAL_HOST) === LOCAL_HOST && child.paneId) local.set(child.paneId, [...(local.get(child.paneId) ?? []), { source: 'registry', parentId: parent.id, childId: child.id, name: child.name, ...(child.session ? { session: child.session.value } : {}) }]);
    }
  }
  for (const claim of claims) {
    if (claim.retiredAt || !claim.paneId || !claim.adopted || startedHere.has(claim.paneId)) continue;
    const holder: PaneHolder = { source: 'claim', parentId: claim.parentId, childId: claim.childId, name: claim.name, adopted: true, ...(claim.session ? { session: claim.session } : {}) };
    local.set(claim.paneId, [...(local.get(claim.paneId) ?? []), holder]);
  }
  for (const [paneId, sources] of local) {
    const judged = judgeHolders(LOCAL_HOST, paneId, sources);
    if (judged.kind === 'contested') lines.push(`fail  authority: ${judged.reason}`);
    else if (judged.kind === 'one' && judged.holder.source === 'claim') lines.push(`ok    authority: pane ${paneId} on this machine is held by parent ${judged.holder.parentId} on another machine, as child ${judged.holder.childId} (${judged.holder.name}); evidence: its adoption claim in this machine's relay records.`);
  }
  return lines;
}
