// The parent's side of a child on another machine. Registering it and
// cleaning up after it are each one SSH command that runs `bellwether` on the
// child's machine, through the target herdr's saved machine profile, so the
// operator's SSH configuration is the only credential. Registration sends the
// brief on standard input, so that machine holds the file the harness is
// pointed at, and tells its daemon which parent the child's reports wait for.
// The child gets no address to call back on, because the parent's daemon
// connects to it. Reading the child's last message goes over that same
// connection, which the daemon's relay links hold.
import { harnessFor } from './harnesses/index.ts';
import type { DroppedVariable } from './relay-env.ts';
import { resolveMachine, type MachineResolver } from './machine.ts';
import { describeFailure, runRemoteBellwether, type SshOptions } from './ssh.ts';
import type { ChildRecord, ParentRecord } from './types.ts';
import type { ToolSource } from './tool-source.ts';
import type { PaneClaim } from './pane-claims.ts';

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
  claim?(host: string, claim: PaneClaim): Promise<{ childId: string; held: boolean }>;
}

/** The arguments `bellwether relay-register` takes on the child's machine. */
export function registerFlags(parent: Pick<ParentRecord, 'id'>, child: Pick<ChildRecord, 'id' | 'name' | 'kind' | 'cwd'>, withBrief = false): string[] {
  return ['relay-register', '--child', child.id, '--name', child.name, '--kind', child.kind, '--parent', parent.id, ...(child.cwd ? ['--cwd', child.cwd] : []), ...(withBrief ? ['--brief-stdin', 'yes'] : [])];
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
  adopt?(host: string, claim: PaneClaim): Promise<{ childId: string; held: boolean }>;
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
  };
}
