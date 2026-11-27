// The parent's side of a child on another machine. Each call is one SSH
// command that runs `bellwether` on the child's machine, through the target
// herdr's saved machine profile names, so the operator's SSH configuration is
// the only credential: register the child there before its tab opens, with
// its brief on standard input, so that machine holds the file the harness is
// pointed at and its daemon carries the child's reports back; remove those
// files when the child is gone; and read its last message from the transcript
// on that machine's disk.
import { resolveMachine, type MachineResolver } from './machine.ts';
import { returnTarget } from './relay-records.ts';
import { describeFailure, runRemoteBellwether, type SshOptions } from './ssh.ts';
import type { ChildRecord, ParentRecord } from './types.ts';

/** What the child's machine wrote when it registered the child. */
export interface RemoteRegistration {
  /** The MCP config path there, for a Claude Code child. */
  mcpConfig?: string;
  /** The brief's path there, when the spawn sent one. */
  brief?: string;
}

export interface RemoteOps {
  /** Register a child on its machine, and copy its brief there when there is one. */
  register(parent: Pick<ParentRecord, 'id'>, child: ChildRecord, brief?: string): Promise<RemoteRegistration>;
  /** Remove the brief and MCP config the registration wrote on the child's machine. */
  cleanup(child: ChildRecord): Promise<void>;
  /** The child's last assistant message, read on its own machine, or undefined when it has none. */
  lastMessage(child: ChildRecord): Promise<string | undefined>;
}

/** The arguments `bellwether relay-register` takes on the child's machine. */
export function registerFlags(parent: Pick<ParentRecord, 'id'>, child: Pick<ChildRecord, 'id' | 'name' | 'kind' | 'cwd'>, parentHost: string, withBrief = false): string[] {
  return ['relay-register', '--child', child.id, '--name', child.name, '--kind', child.kind, '--parent', parent.id, '--parent-host', parentHost, ...(child.cwd ? ['--cwd', child.cwd] : []), ...(withBrief ? ['--brief-stdin', 'yes'] : [])];
}

function parseRegistration(target: string, stdout: string): RemoteRegistration {
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
  if (text('brief')) registration.brief = text('brief');
  return registration;
}

export function remoteOps(resolve: MachineResolver = resolveMachine, options: SshOptions = {}): RemoteOps {
  return {
    async register(parent, child, brief) {
      const profile = await resolve(child.host);
      const withBrief = brief !== undefined;
      const result = await runRemoteBellwether(profile.target, registerFlags(parent, child, returnTarget(), withBrief), { ...options, ...(withBrief ? { input: brief } : {}) });
      if (result.code !== 0) {
        // An older bellwether there cannot take the brief.
        const upgrade = /unknown argument --brief-stdin/.test(result.stderr) ? ` Upgrade @elecnix/bellwether on ${profile.target}.` : '';
        throw new Error(`${describeFailure(profile.target, result)}${upgrade}`);
      }
      const registration = parseRegistration(profile.target, result.stdout);
      if (withBrief && !registration.brief) throw new Error(`bellwether relay-register on ${profile.target} wrote no brief. Upgrade @elecnix/bellwether on that machine.`);
      return registration;
    },
    async cleanup(child) {
      const profile = await resolve(child.host);
      const result = await runRemoteBellwether(profile.target, ['relay-cleanup', '--child', child.id], options);
      if (result.code !== 0) throw new Error(describeFailure(profile.target, result));
    },
    async lastMessage(child) {
      if (!child.session?.value) return undefined;
      const profile = await resolve(child.host);
      const args = ['last-message', '--harness', child.harness, '--session', child.session.value, ...(child.cwd ? ['--cwd', child.cwd] : [])];
      const result = await runRemoteBellwether(profile.target, args, options);
      if (result.code === 0) return result.stdout.trim() ? result.stdout : undefined;
      if (result.code === 1) return undefined;
      throw new Error(describeFailure(profile.target, result));
    },
  };
}
