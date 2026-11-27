// The decisions a move makes, as pure functions of what it found, so the
// refusals, the target paths and the rollback can each be tested on their own.
// The orchestrator in move.ts gathers the facts on both machines and asks
// these functions what to do with them.
import crypto from 'node:crypto';
import path from 'node:path';
import { LOCAL_HOST } from './machine.ts';
import { claudeProjectDir } from './transcript.ts';
import type { AgentStatus, ChildRecord } from './types.ts';
import { agentKinds, harnessFor, harnessNamed } from './harnesses/index.ts';

/** The harnesses a move knows how to carry: their session state is a file Bellwether can find. */
/** The harnesses whose session layout this module knows. A harness's entry says `movable` only for these. */
export type MovableHarness = 'pi' | 'claude-code';

/** The herdr agent kind for a movable harness, as a spawn names it. */
export function kindOfHarness(harness: MovableHarness): 'pi' | 'claude' {
  return harness === 'pi' ? 'pi' : 'claude';
}

/** The directories one machine keeps harness state in, read on that machine. */
export interface HarnessDirs {
  /** Claude Code's state root: CLAUDE_CONFIG_DIR, or ~/.claude. */
  claudeConfigDir: string;
  /** Pi's agent directory: PI_CODING_AGENT_DIR, or ~/.pi/agent. */
  piAgentDir: string;
  /** PI_CODING_AGENT_SESSION_DIR, which replaces the per-directory layout when set. */
  piSessionDir?: string;
}

/** Where one harness keeps a session, on the machine and for the working directory it resumes in. */
export interface SessionLayout {
  /** The directory the session file goes in. */
  dir: string;
  /** The session file itself. */
  file: string;
  /** Claude Code keeps tool results and subagent transcripts in a directory named after the session. */
  sideDir?: string;
}

/**
 * Pi's session directory name for a working directory: the absolute path with
 * its leading separator dropped, every separator and colon turned into a
 * dash, and two dashes on each side. Pi resolves the path without following
 * symbolic links.
 */
export function piSessionDirName(cwd: string): string {
  return `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Where a session goes on the target machine. The file keeps its own name:
 * Claude Code names it after the session id, and Pi after its start time and
 * id. The directory comes from the working directory the child resumes in
 * there, computed by each harness's own rule, because the two machines'
 * paths may differ and a copied directory name would put the session where
 * the harness never looks.
 */
export function targetSessionLayout(harness: MovableHarness, sessionFileName: string, cwd: string, dirs: HarnessDirs): SessionLayout {
  if (!sessionFileName.endsWith('.jsonl') || sessionFileName.includes('/') || sessionFileName.includes('\\')) throw new Error(`${sessionFileName} is not a session file name`);
  if (harness === 'claude-code') {
    const dir = path.join(dirs.claudeConfigDir, 'projects', claudeProjectDir(cwd));
    return { dir, file: path.join(dir, sessionFileName), sideDir: path.join(dir, path.basename(sessionFileName, '.jsonl')) };
  }
  const dir = dirs.piSessionDir ? path.resolve(dirs.piSessionDir) : path.join(dirs.piAgentDir, 'sessions', piSessionDirName(cwd));
  return { dir, file: path.join(dir, sessionFileName) };
}

/** Compare two dotted versions, numerically part by part. Undefined when either has no number in it. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (value: string): number[] | undefined => {
    const match = /(\d+(?:\.\d+)*)/.exec(value);
    return match?.[1]?.split('.').map(Number);
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** The newest of several versions, or undefined when none parses. */
export function newestVersion(versions: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const version of versions) {
    if (!version || compareVersions(version, version) === undefined) continue;
    if (!best || (compareVersions(version, best) ?? 0) > 0) best = version;
  }
  return best;
}

/** Whether agent_move is carrying the child to another machine, inside the move's window. */
export function isMoving(child: Pick<ChildRecord, 'moving'>, now = Date.now()): boolean {
  return Boolean(child.moving && Date.parse(child.moving.until) > now);
}

/** A pi provider and model, which pi needs together. */
export interface ModelPair {
  provider: string;
  model: string;
}

export function pairLabel(pair: ModelPair): string {
  return `${pair.provider}/${pair.model}`;
}

/** The model a pi session last used: its newest model change, or the newest assistant message's. */
export function piModelOf(content: string): ModelPair | undefined {
  const lines = content.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry['type'] === 'model_change' && typeof entry['provider'] === 'string' && typeof entry['modelId'] === 'string') return { provider: entry['provider'], model: entry['modelId'] };
    const message = entry['message'] as Record<string, unknown> | undefined;
    if (entry['type'] === 'message' && message?.['role'] === 'assistant' && typeof message['provider'] === 'string' && typeof message['model'] === 'string') {
      return { provider: message['provider'], model: message['model'] };
    }
  }
  return undefined;
}

/** The Claude Code versions a transcript records, one per entry that names one. */
export function claudeVersionsOf(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/"version":"(\d+\.\d+\.\d+[^"]*)"/g)) if (match[1]) found.add(match[1]);
  return [...found];
}

/** Parse `pi --list-models`: a header row, then one row per model with the provider and model first. */
export function parsePiModelList(text: string): ModelPair[] {
  const rows = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const pairs: ModelPair[] = [];
  for (const row of rows) {
    const [provider, model] = row.split(/\s+/);
    if (!provider || !model || (provider === 'provider' && model === 'model')) continue;
    pairs.push({ provider, model });
  }
  return pairs;
}

/**
 * Rewrite a session for the working directory it resumes in. Pi opens a
 * session in the directory its header names, and asks the person what to do
 * when that directory does not exist, so the header has to name the target's.
 * Claude Code resumes in the directory it starts in, so its transcript goes
 * across byte for byte.
 */
export function rewriteForTarget(harness: MovableHarness, content: Buffer, cwd: string): Buffer {
  if (harness !== 'pi') return content;
  const end = content.indexOf(0x0a);
  const first = content.subarray(0, end < 0 ? content.length : end).toString('utf8');
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(first) as Record<string, unknown>;
  } catch {
    throw new Error('the pi session has no header line, so Bellwether cannot tell which directory it belongs to');
  }
  if (header['type'] !== 'session') throw new Error('the pi session does not start with its session header');
  const resolved = path.resolve(cwd);
  if (header['cwd'] === resolved) return content;
  const rewritten = Buffer.from(JSON.stringify({ ...header, cwd: resolved }), 'utf8');
  return end < 0 ? rewritten : Buffer.concat([rewritten, content.subarray(end)]);
}

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** What one machine has of a harness: the binary, its version, or why there is none. */
export interface HarnessProbe {
  path?: string;
  version?: string;
  error?: string;
}

/** Everything a move asks of the target before it touches anything. */
export interface RefusalInput {
  childName: string;
  /** The child's own harness. */
  harness: string;
  /** The harness asked for on the target, when the caller named one. */
  requestedHarness?: string;
  status: AgentStatus;
  exited: boolean;
  source: string;
  target: string;
  /** A move already recorded on the child, still inside its window. */
  moveInFlight?: { to: string; since: string };
  hasSession: boolean;
  /** The harness on the source, for the version that wrote the session. */
  sourceHarness?: HarnessProbe;
  /** The harness on the target. */
  targetHarness?: HarnessProbe;
  /** Versions the session itself records as its writers. */
  recordedVersions?: string[];
  /** The working directory the child resumes in on the target, and whether it exists there. */
  targetCwd?: string;
  targetCwdExists?: boolean;
  /** For pi: the pair the session last used, the pairs the target offers, and the file that would hold it. */
  piModel?: ModelPair;
  targetModels?: ModelPair[];
  targetModelsError?: string;
  targetModelsFile?: string;
}

function machineName(host: string): string {
  return host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
}

/**
 * Every reason the move must not start, each naming what failed and what a
 * person would do about it. An empty list means the move may begin.
 */
export function moveRefusals(input: RefusalInput): string[] {
  const refusals: string[] = [];
  const where = machineName(input.target);
  if (!harnessNamed(input.harness)?.movable) {
    const movable = agentKinds().filter((kind) => harnessFor(kind)?.movable);
    refusals.push(`${input.childName} runs the ${input.harness} harness, and Bellwether moves only ${movable.join(' and ')} children, the ones whose session state it can find and resume.`);
    return refusals;
  }
  if (input.requestedHarness && input.requestedHarness !== input.harness) {
    refusals.push(`${input.childName} runs ${input.harness}, and the move asked for ${input.requestedHarness} on ${where}. A session belongs to the harness that wrote it, so only a move that keeps the same harness exists.`);
  }
  if (input.source === input.target) refusals.push(`${input.childName} already runs on ${where}.`);
  if (input.exited) refusals.push(`${input.childName} is not running. Resume it with agent_spawn and resume, then move it.`);
  else if (input.status === 'working' || input.status === 'blocked') {
    refusals.push(`${input.childName} is ${input.status}. A move stops the child, which would cut its turn short, so wait for it to go idle and move it then.`);
  }
  if (input.moveInFlight) refusals.push(`${input.childName} is already being moved to ${machineName(input.moveInFlight.to)}, since ${input.moveInFlight.since}.`);
  if (!input.hasSession) refusals.push(`${input.childName} has no recorded session, so there is no conversation to carry across.`);
  const kind = input.harness === 'pi' ? 'pi' : 'claude';
  if (input.targetHarness && !input.targetHarness.path) {
    refusals.push(`${kind} is not installed on ${where}${input.targetHarness.error ? ` (${input.targetHarness.error})` : ''}. Install it there, then move the child.`);
  } else if (input.targetHarness) {
    const writer = newestVersion([input.sourceHarness?.version, ...(input.recordedVersions ?? [])]);
    const target = input.targetHarness.version;
    if (!target) refusals.push(`${kind} on ${where} did not report a version, so Bellwether cannot tell whether it reads the session ${input.childName} wrote.`);
    else if (!writer) refusals.push(`Bellwether could not read which ${kind} version wrote ${input.childName}'s session on ${machineName(input.source)}${input.sourceHarness?.error ? ` (${input.sourceHarness.error})` : ''}, so it cannot tell whether ${kind} ${target} on ${where} reads it.`);
    else if ((compareVersions(target, writer) ?? -1) < 0) {
      refusals.push(`${kind} ${target} on ${where} is older than ${kind} ${writer}, which wrote ${input.childName}'s session. An older harness may not read a newer session, and that would lose the conversation. Update ${kind} on ${where} to ${writer} or later.`);
    }
  }
  if (input.targetCwd && input.targetCwdExists === false) {
    refusals.push(`The working directory ${input.targetCwd} does not exist on ${where}. Create it there, such as a worktree of the same repository, or pass cwd with the directory the child should resume in.`);
  }
  if (input.harness === 'pi' && input.piModel) {
    const label = pairLabel(input.piModel);
    const file = input.targetModelsFile ?? '~/.pi/agent/models.json';
    if (input.targetModelsError) refusals.push(`Bellwether could not list pi's models on ${where} (${input.targetModelsError}), so it cannot tell whether ${label} exists there.`);
    else if (input.targetModels && !input.targetModels.some((pair) => pair.provider === input.piModel?.provider && pair.model === input.piModel?.model)) {
      refusals.push(`${input.childName} uses the pi provider and model ${label}, which ${where} does not offer. pi needs both together: add provider ${input.piModel.provider} with model ${input.piModel.model} to ${file} on ${where}, with its key, then move the child.`);
    }
  }
  return refusals;
}

/** How far a move got before something failed. */
export type MoveStage = 'checked' | 'copied' | 'verified' | 'stopped' | 'recopied' | 'started';

/** What to undo for a move that failed at a stage. */
export interface RollbackPlan {
  /** Remove what the import wrote on the target, restoring any file it replaced. */
  discardTarget: boolean;
  /** Start the child again on the source, from the session that is still there. */
  restartSource: boolean;
  /** Close the child's new tab on the target. */
  closeTarget: boolean;
}

/**
 * The rollback for a move that failed after reaching `stage`. Before the
 * source is stopped, the child still runs there, so only the copy goes. Once
 * it is stopped, the child exists nowhere until the source starts it again,
 * from the session file the move never touched there.
 */
export function rollbackPlan(stage: MoveStage): RollbackPlan {
  switch (stage) {
    case 'checked':
      return { discardTarget: false, restartSource: false, closeTarget: false };
    case 'copied':
    case 'verified':
      return { discardTarget: true, restartSource: false, closeTarget: false };
    case 'stopped':
    case 'recopied':
      return { discardTarget: true, restartSource: true, closeTarget: false };
    case 'started':
      return { discardTarget: true, restartSource: true, closeTarget: true };
  }
}

/**
 * The machine to move to: the one named, or the only other known machine.
 * Two candidates or more are ambiguous, and naming none of them is refused.
 */
export function pickTarget(known: string[], source: string, requested?: string): string {
  if (requested) return requested;
  const others = [...new Set(known)].filter((host) => host !== source);
  if (others.length === 1 && others[0]) return others[0];
  if (others.length === 0) throw new Error(`No machine besides ${machineName(source)} is known, so there is nowhere to move to. Save the other machine with herdr machine add.`);
  throw new Error(`agent_move needs a machine: ${others.map((host) => (host === LOCAL_HOST ? 'local' : host)).join(', ')} are all known, so the target is ambiguous.`);
}
