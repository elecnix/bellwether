// The harness registry: one entry per harness Bellwether starts or adopts.
// Adding a harness is writing its entry in a file of its own beside this one
// and naming it in HARNESSES. Nothing else branches on a kind: the spawn,
// resume, restart, the watcher, agent_read, the remote registration, the tool
// list and the daemon's feature list all read the entry. A test that adds a
// fourth entry and spawns it shows that (test/integration/harness-registry.test.ts).
import { claude } from './claude.ts';
import { cline } from './cline.ts';
import { codex } from './codex.ts';
import { kilo } from './kilo.ts';
import { omp } from './omp.ts';
import { opencode } from './opencode.ts';
import { pi } from './pi.ts';
import type { TranscriptLookup } from '../transcript.ts';
import type { HarnessEntry } from './types.ts';

export type { HarnessEntry, HarnessHooks, HerdrRequester, HarnessSession, ChildFiles, LaunchInput, VersionProbe } from './types.ts';

/** The entries, in the order agent_spawn lists its kinds. */
const HARNESSES: HarnessEntry[] = [pi, claude, codex, opencode, kilo, cline, omp];

/** Every harness Bellwether knows, by its herdr kind. */
export function harnesses(): readonly HarnessEntry[] {
  return HARNESSES;
}

/** The kinds agent_spawn and agent_adopt accept. */
export function agentKinds(): string[] {
  return HARNESSES.map((entry) => entry.kind);
}

/** The entry for a herdr kind, or undefined for a kind Bellwether does not know. */
export function harnessFor(kind: string | undefined): HarnessEntry | undefined {
  return kind === undefined ? undefined : HARNESSES.find((entry) => entry.kind === kind);
}

/** The entry for a record's harness name or a kind, such as `claude-code` or `claude`. */
export function harnessNamed(name: string | undefined): HarnessEntry | undefined {
  return name === undefined ? undefined : HARNESSES.find((entry) => entry.harness === name || entry.kind === name);
}

/** The entry for a kind, or an error that lists the kinds Bellwether knows. */
export function requireHarness(kind: string): HarnessEntry {
  const entry = harnessFor(kind);
  if (!entry) throw new Error(`Bellwether knows no ${kind} harness. The kinds it knows are ${agentKinds().join(', ')}.`);
  return entry;
}

/** The harness name a child record carries for a kind. A kind with no entry is `other`. */
export function harnessOf(kind: string): string {
  return harnessFor(kind)?.harness ?? 'other';
}

/** The kind a harness name starts with, such as `claude` for `claude-code`. */
export function kindOfHarness(harness: string): string {
  return harnessNamed(harness)?.kind ?? harness;
}

/**
 * Where a session's transcript is, for a harness named by its record name or
 * its kind, or why there is none on this machine.
 */
export function locateTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): TranscriptLookup {
  const entry = harnessNamed(harness);
  if (!entry) return { missing: `Bellwether reads no transcript for the ${harness} harness` };
  return entry.conversation.locate(sessionId, cwd);
}

/** The transcript's path for a harness session, when the file exists on this machine. */
export function resolveTranscript(harness: string, sessionId: string | undefined, cwd: string | undefined): string | undefined {
  return locateTranscript(harness, sessionId, cwd).path;
}

/**
 * The launch-line prompt that points a harness at its brief file, or
 * undefined for a harness that gets its brief as a message after it starts.
 */
export function briefArgument(kind: string, file: string): string | undefined {
  return requireHarness(kind).brief.launch?.(file);
}

/**
 * Why a spawn of this kind cannot start a child that reports, or undefined
 * when it can. A child nobody can hear is refused, not started.
 */
export function spawnRefusal(entry: HarnessEntry, name: string): string | undefined {
  if (entry.reports.via !== 'none') return undefined;
  return `${name} was not started: ${entry.reports.reason}. A ${entry.kind} child can be adopted with agent_adopt once it runs, and its status changes still reach you; see docs/harnesses.md.`;
}

/**
 * Add an entry for the length of a test. Only tests call this: it shows
 * that a harness needs nothing but its entry. Returns the function that
 * removes it again.
 */
export function registerHarness(entry: HarnessEntry): () => void {
  if (harnessFor(entry.kind)) throw new Error(`a ${entry.kind} harness is already registered`);
  HARNESSES.push(entry);
  return () => {
    const index = HARNESSES.indexOf(entry);
    if (index >= 0) HARNESSES.splice(index, 1);
  };
}
