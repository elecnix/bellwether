// The parent's side of a child on another machine. Registering it and
// cleaning up after it are each one SSH command that runs `bellwether` on the
// child's machine, through the target herdr's saved machine profile, so the
// operator's SSH configuration is the only credential. Registration sends the
// brief on standard input, so that machine holds the file the harness is
// pointed at, and tells its daemon which parent the child's reports wait for.
// The child gets no address to call back on, because the parent's daemon
// connects to it. Reading the child's last message goes over that same
// connection, which the daemon's relay links hold.
import { reclaimsFarRecord } from './authority.ts';
import { harnessFor } from './harnesses/index.ts';
import type { DroppedVariable } from './relay-env.ts';
import { resolveMachine, type MachineResolver } from './machine.ts';
import { describeFailure, runRemoteBellwether, type SshOptions } from './ssh.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import type { ToolSource } from './tool-source.ts';
import type { PaneClaim } from './pane-claims.ts';
import type { SessionReach } from './adopted-session.ts';
import { adoptionClaim } from './adopt.ts';
import { hostOf } from './machine.ts';
import type { RelayRestartAnswer, RelayRestartAsk } from './restart.ts';
import type { RelayFreeAsk } from './free.ts';
import type { InboxMessage, RelayMessageAnswer } from '../daemon/protocol.ts';

/** What the child's machine wrote when it registered the child. */
export interface RemoteRegistration {
  /** The MCP config path there, for a Claude Code child. */
  mcpConfig?: string;
  /** The Claude Code settings path there, when the child needs any to keep a second Bellwether server out. */
  claudeSettings?: string;
  /** Which server gives a Claude Code child its tools there. An install from before the check leaves it out. */
  toolSource?: ToolSource;
  /** The brief's path there, when the spawn sent one. */
  brief?: string;
  /** The pi extension of the package there, for a pi child. */
  piExtension?: string;
  /**
   * The variables the harness entry gave the child's tab there, less those
   * that belong to one machine. An install from before it handed them back
   * leaves it out, which differs from an empty set.
   */
  env?: Record<string, string>;
  /** The variables the registration left out, by name and reason, never by value. */
  envDropped?: DroppedVariable[];
  /** The Bellwether version there. An install from before it said leaves it out. */
  version?: string;
  /** The build there, its commit. An install from before builds were named leaves it out. */
  build?: string;
}

export interface RemoteOps {
  /** Register a child on its machine, and copy its brief there when there is one. */
  register(parent: Pick<ParentRecord, 'id'>, child: ChildRecord, brief?: string): Promise<RemoteRegistration>;
  /** Remove the brief and MCP config the registration wrote on the child's machine. */
  cleanup(child: ChildRecord): Promise<void>;
  /** The child's last assistant message, read on its own machine, or undefined when it has none. */
  lastMessage(child: ChildRecord): Promise<string | undefined>;
  /** Ask the pane's machine to record an adoption, or say who already watches the pane there. Absent when the session holds no relay. */
  claim?(host: string, claim: PaneClaim): Promise<{ childId: string; held: boolean; session?: SessionReach; messages?: boolean }>;
  /** Ask the child's machine to restart the child there. Absent when the session holds no relay. */
  restart?(host: string, ask: RelayRestartAsk): Promise<RelayRestartAnswer>;
  /** Ask a freed child's machine to write its record of the freeing (issue #262). Absent when the session holds no relay. */
  free?(host: string, ask: RelayFreeAsk): Promise<void>;
  /** Put a peer's message in a freed child's session on its machine, with the pair's token (issue #262). */
  peerMessage?(host: string, parentId: string, childId: string, message: InboxMessage, peer: { from: string; token: string }): Promise<RelayMessageAnswer>;
}

/** The arguments `bellwether relay-register` takes on the child's machine. */
export function registerFlags(parent: Pick<ParentRecord, 'id'>, child: Pick<ChildRecord, 'id' | 'name' | 'kind' | 'cwd' | 'reads'>, withBrief = false): string[] {
  // A far daemon that predates --reads refuses the flag, so it goes only with a child that names reads.
  return ['relay-register', '--child', child.id, '--name', child.name, '--kind', child.kind, '--parent', parent.id, ...(child.cwd ? ['--cwd', child.cwd] : []), ...(child.reads?.length ? ['--reads', JSON.stringify(child.reads)] : []), ...(withBrief ? ['--brief-stdin', 'yes'] : [])];
}

/**
 * What `bellwether relay-register` printed on the child's machine. A pi child
 * loads the extension that machine names, and a Bellwether there that predates
 * it names none, so the child would start with no tools: that is refused.
 */
export function parseRegistration(target: string, stdout: string, kind?: string): RemoteRegistration {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`bellwether relay-register on ${target} printed no record: ${line || '(nothing)'}`);
  }
  const text = (key: string): string | undefined => (typeof parsed[key] === 'string' && parsed[key] ? (parsed[key] as string) : undefined);
  const registration: RemoteRegistration = {};
  if (text('mcpConfig')) registration.mcpConfig = text('mcpConfig');
  if (text('claudeSettings')) registration.claudeSettings = text('claudeSettings');
  const source = parsed['toolSource'];
  if (typeof source === 'object' && source !== null && Array.isArray((source as ToolSource).suppressed)) registration.toolSource = source as ToolSource;
  if (text('brief')) registration.brief = text('brief');
  if (text('piExtension')) registration.piExtension = text('piExtension');
  if (text('version')) registration.version = text('version');
  if (text('build')) registration.build = text('build');
  const env = parsed['env'];
  if (typeof env === 'object' && env !== null && !Array.isArray(env)) registration.env = Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  const dropped = parsed['envDropped'];
  if (Array.isArray(dropped)) registration.envDropped = dropped.filter((entry): entry is DroppedVariable => typeof entry?.name === 'string' && typeof entry?.why === 'string').map(({ name, why }) => ({ name, why }));
  // Only the per-child server carries the child id, so a child without what its harness needs could not report.
  const needs = harnessFor(kind)?.reports;
  const remote = needs && needs.via !== 'none' ? needs.remote : undefined;
  if (remote === 'mcpConfig' && !registration.mcpConfig) throw new Error(`bellwether relay-register on ${target}, ${installedThere(registration)}, wrote no MCP config for the child. Upgrade @elecnix/bellwether on ${target}.`);
  if (remote === 'piExtension' && !registration.piExtension) throw new Error(`bellwether relay-register on ${target}, ${installedThere(registration)}, named no ${harnessFor(kind)?.label} extension. Upgrade @elecnix/bellwether on ${target}.`);
  // A child whose tab lacks a variable its harness needs would half-start, as omp stops at its setup wizard without OMP_SKIP_SETUP.
  const needed = needs && needs.via !== 'none' ? (needs.remoteEnv ?? []) : [];
  const missing = needed.filter((name) => registration.env?.[name] === undefined);
  if (missing.length) {
    const label = harnessFor(kind)?.label;
    const article = /^[aeiou]/i.test(label ?? '') ? 'an' : 'a';
    const why = registration.env === undefined ? 'handed back no environment' : `left out ${missing.join(', ')}${registration.envDropped?.length ? ` (${registration.envDropped.filter((entry) => missing.includes(entry.name)).map((entry) => entry.why).join('; ')})` : ''}`;
    throw new Error(`bellwether relay-register on ${target}, ${installedThere(registration)}, ${why}, and ${article} ${label} child cannot start without ${missing.join(', ')}. ${registration.env === undefined ? `Upgrade @elecnix/bellwether on ${target}.` : `Fix the ${label} entry, which names a variable that machine cannot use.`}`);
  }
  return registration;
}

/** Which Bellwether a registration ran, in a few words, for an error that tells the operator to upgrade it. */
export function installedThere(registration: Pick<RemoteRegistration, 'version' | 'build'>): string {
  if (!registration.version) return 'an install too old to name its version and build';
  return `version ${registration.version} build ${registration.build ?? 'unknown'}`;
}

/** Reads a remote child's transcript over the connection its machine already has open. */
export interface RemoteReader {
  lastMessage(child: ChildRecord): Promise<string | undefined>;
  /** Record an adoption on the pane's machine, over the same connection. */
  adopt?(host: string, claim: PaneClaim): Promise<{ childId: string; held: boolean; session?: SessionReach; messages?: boolean }>;
  /** Restart a child on its own machine, over the same connection. */
  restart?(host: string, ask: RelayRestartAsk): Promise<RelayRestartAnswer>;
  /** Record a freeing on the child's machine, over the same connection. */
  free?(host: string, ask: RelayFreeAsk): Promise<void>;
  /** A peer's message to a freed child there, over the same connection. */
  message?(host: string, parentId: string, childId: string, message: InboxMessage, options?: { peer?: { from: string; token: string } }): Promise<RelayMessageAnswer>;
}

export function remoteOps(resolve: MachineResolver = resolveMachine, options: SshOptions = {}, reader?: RemoteReader): RemoteOps {
  return {
    async register(parent, child, brief) {
      const profile = await resolve(child.host);
      const withBrief = brief !== undefined;
      const result = await runRemoteBellwether(profile.target, registerFlags(parent, child, withBrief), { ...options, ...(withBrief ? { input: brief } : {}) });
      // The far end's own error leads, with the release that brings what it lacked when that is the cause.
      if (result.code !== 0) throw new Error(describeFailure(profile.target, result));
      const registration = parseRegistration(profile.target, result.stdout, child.kind);
      if (withBrief && !registration.brief) throw new Error(`bellwether relay-register on ${profile.target}, ${installedThere(registration)}, wrote no brief. Upgrade @elecnix/bellwether on that machine.`);
      return registration;
    },
    async cleanup(child) {
      const profile = await resolve(child.host);
      const result = await runRemoteBellwether(profile.target, ['relay-cleanup', '--child', child.id], options);
      if (result.code !== 0) throw new Error(describeFailure(profile.target, result));
    },
    async lastMessage(child) {
      if (!reader) throw new Error(`this session holds no connection to machine ${child.host}`);
      return reader.lastMessage(child);
    },
    async claim(host, claim) {
      if (!reader?.adopt) throw new Error(`this session holds no connection to machine ${host}`);
      return reader.adopt(host, claim);
    },
    ...(reader?.restart ? { restart: (host: string, ask: RelayRestartAsk) => (reader.restart as NonNullable<RemoteReader['restart']>).call(reader, host, ask) } : {}),
    ...(reader?.free ? { free: (host: string, ask: RelayFreeAsk) => (reader.free as NonNullable<RemoteReader['free']>).call(reader, host, ask) } : {}),
    ...(reader?.message ? { peerMessage: (host: string, parentId: string, childId: string, message: InboxMessage, peer: { from: string; token: string }) => (reader.message as NonNullable<RemoteReader['message']>).call(reader, host, parentId, childId, message, { peer }) } : {}),
  };
}

/** The machine of an adopted child holds its session under another child id, so this one cannot stand for it (issue #191). */
export class ClaimHeldElsewhere extends Error {
  readonly host: string;
  readonly childId: string;
  readonly replaced: string;
  constructor(host: string, childId: string, replaced: string) {
    super(`machine ${host} holds that session as child ${childId}, not ${replaced}`);
    this.host = host;
    this.childId = childId;
    this.replaced = replaced;
  }
}

/**
 * Claim an adopted child's pane again on its machine, under the child id the
 * parent already holds, after its harness came back there under the same
 * session. That machine's daemon then offers the session its tools and takes
 * its messages under that id again.
 */
/**
 * The doctor lines for each live child whose machine holds no record of it
 * while this registry does (issue #219): the two disagree, and messages to it
 * are typed until they agree again.
 */
export function farRecordLines(parents: ParentRecord[]): string[] {
  const lines: string[] = [];
  for (const parent of parents) {
    for (const child of parent.children) {
      const lost = child.farRecordLost;
      // A contested record is refused, not typed to, and its authority line names both sources (issue #279).
      if (!lost || lost.contested || child.exitedAt) continue;
      const fix = reclaimsFarRecord(child) ? `Run agent_adopt ${lost.host}:${child.paneId} to claim it there again.` : 'Stop it and resume its session with agent_spawn to register it there again.';
      lines.push(`warn  far record: ${child.name} (child ${child.id} of ${parent.id}) on machine ${lost.host}: that machine has held no record of it since ${lost.at}, so messages to it are typed into its pane (${lost.reason}). ${fix}`);
    }
  }
  return lines;
}

/**
 * The doctor lines for each live child whose machine could not confirm the
 * claim this parent holds there by adoption, once the relay came back (issue
 * #257). The watcher asks again, and the line goes once that machine answers.
 */
export function claimUnconfirmedLines(parents: ParentRecord[]): string[] {
  const lines: string[] = [];
  for (const parent of parents) {
    for (const child of parent.children) {
      const open = child.claimUnconfirmed;
      if (!open || child.exitedAt) continue;
      lines.push(`warn  unconfirmed claim: ${child.name} (child ${child.id} of ${parent.id}) on machine ${open.host}: since ${open.at}, that machine has not confirmed it still holds pane ${child.paneId} for this child, so another parent may watch the pane (${open.reason}). Bellwether asks again; run agent_adopt ${open.host}:${child.paneId} to ask again.`);
    }
  }
  return lines;
}

export async function reclaimRemote(remote: RemoteOps, parentId: string, child: ChildRecord): Promise<void> {
  const host = hostOf(child);
  if (!remote.claim) throw new Error(`this session holds no connection to machine ${host}`);
  const answer = await remote.claim(host, adoptionClaim(parentId, child));
  if (answer.childId !== child.id) throw new ClaimHeldElsewhere(host, answer.childId, child.id);
}
