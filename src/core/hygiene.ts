// State hygiene: the daemon removes the state that no live session needs, so
// the Bellwether home does not grow with every session that ever said hello.
//
// Two named rules decide what goes, and both are pure: `parentVerdict` for a
// parent record, `childFileVerdict` for a brief or an MCP configuration. Each
// keeps anything a live session could still read, and says why. `pruneState`
// gathers the facts from the home, applies the rules and removes what they
// condemn, along with the parent's outbox and spool. `rotateLogs` caps each
// append-only log. The daemon runs both from the idle tick it already has,
// once at start and then hourly, and records the outcome for `doctor`.
import fs from 'node:fs';
import path from 'node:path';
import { Outbox } from './outbox.ts';
import { bellwetherHome, mcpDir, outboxDir, outboxPath, promptsDir, registryPath, relayChildPath, spoolDir, spoolPath } from './paths.ts';
import { listParents } from './registry.ts';
import type { ParentRecord } from './types.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a parent record with children waits after its last change. The
 * record is how a resumed session finds its children, and how a child that
 * exited can be resumed by name, so it outlives a weekend. It matches the age
 * at which a brief was already pruned.
 */
export const PARENT_WITH_CHILDREN_IDLE_MS = 7 * DAY_MS;

/**
 * How long a parent record that never had a child waits. Such a record holds
 * only the session's identity, which the session's next hello writes again, so
 * removing it loses nothing. The hour covers a session between two hand-overs.
 */
export const CHILDLESS_PARENT_IDLE_MS = HOUR_MS;

/**
 * How long a brief or an MCP configuration that no record names waits. A spawn
 * can write the file a moment before its record, and a relay child's file has
 * a relay record instead, so only an unclaimed file this old is an orphan.
 */
export const ORPHAN_FILE_GRACE_MS = HOUR_MS;

/** How often the daemon prunes while it runs. */
export const PRUNE_EVERY_MS = HOUR_MS;

/**
 * How long a daemon waits after it starts before its first prune. A session
 * counts as connected once it says hello, and after a hand-over every session
 * says hello again within seconds.
 */
export const PRUNE_DELAY_MS = 60_000;

/** The size at which an append-only log moves to `<name>.1`, replacing the older copy there. */
export const LOG_MAX_BYTES = 1024 * 1024;

/** The append-only logs under the home that `rotateLogs` caps. */
export const ROTATED_LOGS = ['retire.log', 'move.log', 'restart.log'] as const;

export interface Verdict {
  prune: boolean;
  reason: string;
}

/** What the home says about one parent, gathered by `parentFacts`. */
export interface ParentFacts {
  record: ParentRecord;
  /** Whether a session of this parent is connected to the daemon now. */
  connected: boolean;
  /** Outbox entries no delivery has reached. */
  unread: number;
  /** Whether a child appended a report to the spool that the parent has not read. */
  spoolUnread: boolean;
}

/** Each condition that makes a parent record live, with the reason it gives. */
function liveReason(facts: ParentFacts): string | undefined {
  const { record } = facts;
  if (facts.connected) return 'its session is connected';
  const live = record.children.filter((child) => !child.exitedAt).length;
  if (live) return `${live} child${live === 1 ? '' : 'ren'} still running`;
  if (facts.unread) return `${facts.unread} unread event${facts.unread === 1 ? '' : 's'}`;
  if (facts.spoolUnread) return 'an unread report in its spool';
  if (record.restartRequestedAt) return 'a restart it asked for';
  if (record.children.some((child) => child.retireIntent && !child.retiredAt)) return 'a retirement in progress';
  return undefined;
}

/** The newest moment the record shows activity: its last write, or a child's last change. */
function lastActivity(record: ParentRecord): number {
  const times = [record.updatedAt, ...record.children.flatMap((child) => [child.exitedAt, child.statusChangedAt, child.lastBusyAt, child.retiredAt])];
  return Math.max(...times.map((at) => (at ? Date.parse(at) : Number.NaN)).filter((at) => Number.isFinite(at)), 0);
}

/**
 * The rule for a parent record. Never prune a record whose session is
 * connected, whose child still runs, whose outbox or spool holds something
 * unread, or that waits on a restart or a retirement. Otherwise prune it once
 * it has been quiet for its period: an hour for a record that never had a
 * child, a week for one that did.
 */
export function parentVerdict(facts: ParentFacts, now: number): Verdict {
  const live = liveReason(facts);
  if (live) return { prune: false, reason: live };
  const period = facts.record.children.length ? PARENT_WITH_CHILDREN_IDLE_MS : CHILDLESS_PARENT_IDLE_MS;
  const quiet = now - lastActivity(facts.record);
  const kind = facts.record.children.length ? 'with exited children' : 'with no child';
  if (quiet < period) return { prune: false, reason: `quiet for ${duration(quiet)}, under the ${duration(period)} a record ${kind} keeps` };
  return { prune: true, reason: `quiet for ${duration(quiet)}, with nothing live or unread` };
}

/** What the home says about one child's brief or MCP configuration. */
export interface ChildFileFacts {
  childId: string;
  /** The file's last change. */
  mtimeMs: number;
  /** Some parent record lists the child, and it has not exited. */
  live: boolean;
  /** Some parent record lists the child. */
  known: boolean;
  /** This machine carries the child's reports for a parent on another machine. */
  relayed: boolean;
}

/**
 * The rule for a child's brief or MCP configuration. Keep the file of a child
 * that runs, and of a child this machine relays for another machine, whose
 * cleanup belongs to `relay-cleanup`. Remove the file of a child that exited
 * or whose record is gone. A file no record names waits an hour first, because
 * a spawn writes it beside a record that may not be saved yet.
 */
export function childFileVerdict(facts: ChildFileFacts, now: number): Verdict {
  if (facts.live) return { prune: false, reason: 'its child is running' };
  if (facts.relayed) return { prune: false, reason: 'its child runs here for a parent on another machine' };
  if (facts.known) return { prune: true, reason: 'its child exited' };
  const age = now - facts.mtimeMs;
  if (age < ORPHAN_FILE_GRACE_MS) return { prune: false, reason: `no record names its child yet, and it is ${duration(age)} old` };
  return { prune: true, reason: 'no record names its child' };
}

function duration(ms: number): string {
  if (ms >= DAY_MS) return `${Math.round(ms / DAY_MS)} d`;
  if (ms >= HOUR_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.max(0, Math.round(ms / 60_000))} min`;
}

function names(dir: string, extension: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(extension))
      .map((name) => name.slice(0, -extension.length));
  } catch {
    return [];
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The facts for one parent record, read from its outbox and spool. */
export function parentFacts(record: ParentRecord, connected: ReadonlySet<string>): ParentFacts {
  return {
    record,
    connected: connected.has(record.id),
    unread: Outbox.load(record.id).pending().length,
    spoolUnread: fileSize(spoolPath(record.id)) > (record.spoolOffset ?? 0),
  };
}

/** Every child file under the home, as its directory, extension and child id. */
const CHILD_FILES = [
  { kind: 'brief', dir: promptsDir, extension: '.md' },
  { kind: 'mcp', dir: mcpDir, extension: '.json' },
] as const;

/** The facts for each brief and MCP configuration under the home. */
export function childFileFacts(parents: readonly ParentRecord[]): { kind: 'brief' | 'mcp'; file: string; facts: ChildFileFacts }[] {
  const children = parents.flatMap((parent) => parent.children);
  const live = new Set(children.filter((child) => !child.exitedAt).map((child) => child.id));
  const known = new Set(children.map((child) => child.id));
  const out: { kind: 'brief' | 'mcp'; file: string; facts: ChildFileFacts }[] = [];
  for (const { kind, dir, extension } of CHILD_FILES) {
    for (const childId of names(dir(), extension)) {
      const file = path.join(dir(), `${childId}${extension}`);
      const mtimeMs = mtime(file);
      if (mtimeMs === undefined) continue;
      out.push({ kind, file, facts: { childId, mtimeMs, live: live.has(childId), known: known.has(childId), relayed: fs.existsSync(relayChildPath(childId)) } });
    }
  }
  return out;
}

/** What one prune found and removed. */
export interface PruneSummary {
  at: string;
  parents: { total: number; removed: number };
  briefs: { total: number; removed: number };
  mcpConfigs: { total: number; removed: number };
  /** Outbox and spool files removed with their parent, or found with no parent and nothing unread. */
  outboxes: { total: number; removed: number };
  spools: { total: number; removed: number };
  rotated: string[];
}

/** Where the daemon records the last prune, for `doctor`. */
export function hygienePath(): string {
  return path.join(bellwetherHome(), 'hygiene.json');
}

export function readLastPrune(): PruneSummary | undefined {
  try {
    return JSON.parse(fs.readFileSync(hygienePath(), 'utf8')) as PruneSummary;
  } catch {
    return undefined;
  }
}

function remove(file: string): boolean {
  try {
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface PruneOptions {
  /** The parents with a session connected to the daemon now. */
  connected: ReadonlySet<string>;
  now: number;
  /** List what would go and remove nothing. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

/**
 * Remove every parent record the rule condemns, with its outbox and spool,
 * then every brief and MCP configuration whose child is gone, then each
 * outbox and spool file that no record owns and that holds nothing unread.
 * It runs synchronously, so no client call interleaves with it in the daemon.
 */
export function pruneState(options: PruneOptions): PruneSummary {
  const { now, log = () => {} } = options;
  const act = (file: string): boolean => (options.dryRun ? fs.existsSync(file) : remove(file));
  const parents = listParents();
  const kept: ParentRecord[] = [];
  let parentsRemoved = 0;
  let outboxesRemoved = 0;
  let spoolsRemoved = 0;
  for (const record of parents) {
    const verdict = parentVerdict(parentFacts(record, options.connected), now);
    if (!verdict.prune) {
      kept.push(record);
      continue;
    }
    if (act(registryPath(record.id))) parentsRemoved += 1;
    if (act(outboxPath(record.id))) outboxesRemoved += 1;
    if (act(spoolPath(record.id))) spoolsRemoved += 1;
    log(`prune: parent ${record.id}: ${verdict.reason}`);
  }

  const files = childFileFacts(kept);
  let briefsRemoved = 0;
  let mcpRemoved = 0;
  for (const { kind, file, facts } of files) {
    const verdict = childFileVerdict(facts, now);
    if (!verdict.prune || !act(file)) continue;
    if (kind === 'brief') briefsRemoved += 1;
    else mcpRemoved += 1;
    log(`prune: ${kind === 'brief' ? 'brief' : 'MCP configuration'} of child ${facts.childId}: ${verdict.reason}`);
  }

  // An outbox or spool whose parent record is gone, from a removal by hand or an older daemon.
  const owners = new Set(kept.map((record) => record.id));
  const removedIds = new Set(parents.filter((record) => !owners.has(record.id)).map((record) => record.id));
  for (const id of names(outboxDir(), '.json')) {
    if (owners.has(id) || removedIds.has(id)) continue;
    const file = outboxPath(id);
    if (Outbox.load(id).pending().length || now - (mtime(file) ?? now) < DAY_MS) continue;
    if (act(file)) {
      outboxesRemoved += 1;
      log(`prune: outbox ${id}: no parent record, nothing unread`);
    }
  }
  for (const id of names(spoolDir(), '.jsonl')) {
    if (owners.has(id) || removedIds.has(id)) continue;
    const file = spoolPath(id);
    if (now - (mtime(file) ?? now) < DAY_MS) continue;
    if (act(file)) {
      spoolsRemoved += 1;
      log(`prune: spool ${id}: no parent record, untouched for a day`);
    }
  }

  const rotated = options.dryRun ? [] : rotateLogs(now);
  for (const name of rotated) log(`prune: ${name} passed ${LOG_MAX_BYTES} bytes, so its older lines moved to ${name}.1`);
  const summary: PruneSummary = {
    at: new Date(now).toISOString(),
    parents: { total: parents.length, removed: parentsRemoved },
    briefs: { total: files.filter((entry) => entry.kind === 'brief').length, removed: briefsRemoved },
    mcpConfigs: { total: files.filter((entry) => entry.kind === 'mcp').length, removed: mcpRemoved },
    outboxes: { total: names(outboxDir(), '.json').length + (options.dryRun ? 0 : outboxesRemoved), removed: outboxesRemoved },
    spools: { total: names(spoolDir(), '.jsonl').length + (options.dryRun ? 0 : spoolsRemoved), removed: spoolsRemoved },
    rotated,
  };
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(hygienePath()), { recursive: true });
    const temp = `${hygienePath()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(temp, hygienePath());
  }
  return summary;
}

/**
 * Move each append-only log that passed `LOG_MAX_BYTES` to `<name>.1`,
 * replacing the older copy there, and start the log again with one line that
 * says where its older lines went. A log keeps at most twice the cap.
 */
export function rotateLogs(now: number, maxBytes = LOG_MAX_BYTES): string[] {
  const rotated: string[] = [];
  for (const name of ROTATED_LOGS) {
    const file = path.join(bellwetherHome(), name);
    if (fileSize(file) < maxBytes) continue;
    try {
      fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), rotated: `the lines before this one are in ${name}.1` })}\n`);
      rotated.push(name);
    } catch {
      // Another writer moved it first; the next prune looks again.
    }
  }
  return rotated;
}

/** What `doctor` says about the home's size, from the files alone. */
export function describeState(options: { connected: ReadonlySet<string>; now: number; connectedUnknown?: boolean }): string[] {
  const parents = listParents();
  const verdicts = parents.map((record) => parentVerdict(parentFacts(record, options.connected), options.now));
  const stale = verdicts.filter((verdict) => verdict.prune).length;
  const files = childFileFacts(parents);
  const orphan = (kind: 'brief' | 'mcp'): string => {
    const own = files.filter((entry) => entry.kind === kind);
    const gone = own.filter((entry) => childFileVerdict(entry.facts, options.now).prune).length;
    return `${own.length}${gone ? ` (${gone} for children that are gone)` : ''}`;
  };
  const unread = parents.reduce((sum, record) => sum + Outbox.load(record.id).pending().length, 0);
  const outboxes = names(outboxDir(), '.json').length;
  const logs = ROTATED_LOGS.map((name) => ({ name, size: fileSize(path.join(bellwetherHome(), name)) })).filter((log) => log.size > 0);
  const lines = [
    `info  state: ${parents.length} parent record${parents.length === 1 ? '' : 's'}, ${stale} stale${options.connectedUnknown && stale ? ' (no daemon listed its sessions, so a connected session counts as stale here, and the daemon keeps it)' : ''}; ${orphan('brief')} briefs, ${orphan('mcp')} MCP configurations; ${outboxes} outbox file${outboxes === 1 ? '' : 's'} holding ${unread} unread event${unread === 1 ? '' : 's'}; ${names(spoolDir(), '.jsonl').length} spool files`,
  ];
  if (logs.length) lines.push(`info  logs: ${logs.map((log) => `${log.name} ${Math.ceil(log.size / 1024)} KiB`).join(', ')}, each moved to <name>.1 past ${LOG_MAX_BYTES / 1024 / 1024} MiB`);
  const last = readLastPrune();
  if (!last) lines.push('info  prune: none yet. The daemon prunes a minute after it starts, then every hour while it runs.');
  else {
    const removed = [
      [last.parents.removed, 'parent records'],
      [last.briefs.removed, 'briefs'],
      [last.mcpConfigs.removed, 'MCP configurations'],
      [last.outboxes.removed, 'outbox files'],
      [last.spools.removed, 'spool files'],
    ].filter(([count]) => count) as [number, string][];
    lines.push(`info  prune: last ran ${last.at}, removed ${removed.length ? removed.map(([count, what]) => `${count} ${what}`).join(', ') : 'nothing'}${last.rotated.length ? `, rotated ${last.rotated.join(', ')}` : ''}`);
  }
  return lines;
}
