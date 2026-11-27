// The parent's side of a child on another machine. Both calls are one SSH
// command that runs `bellwether` on the child's machine, through the target
// herdr's saved machine profile names, so the operator's SSH configuration is
// the only credential: register the child there before its tab opens, so that
// machine's daemon carries its reports back, and read its last message from
// the transcript on that machine's disk.
import { resolveMachine, type MachineResolver } from './machine.ts';
import { returnTarget } from './relay-records.ts';
import { describeFailure, runRemoteBellwether, type SshOptions } from './ssh.ts';
import type { ChildRecord, ParentRecord } from './types.ts';

export interface RemoteOps {
  /** Register a child on its machine. Resolves with the MCP config path there for a Claude Code child. */
  register(parent: Pick<ParentRecord, 'id'>, child: ChildRecord): Promise<{ mcpConfig?: string }>;
  /** The child's last assistant message, read on its own machine, or undefined when it has none. */
  lastMessage(child: ChildRecord): Promise<string | undefined>;
}

/** The arguments `bellwether relay-register` takes on the child's machine. */
export function registerFlags(parent: Pick<ParentRecord, 'id'>, child: Pick<ChildRecord, 'id' | 'name' | 'kind' | 'cwd'>, parentHost: string): string[] {
  return ['relay-register', '--child', child.id, '--name', child.name, '--kind', child.kind, '--parent', parent.id, '--parent-host', parentHost, ...(child.cwd ? ['--cwd', child.cwd] : [])];
}

export function remoteOps(resolve: MachineResolver = resolveMachine, options: SshOptions = {}): RemoteOps {
  return {
    async register(parent, child) {
      const profile = await resolve(child.host);
      const result = await runRemoteBellwether(profile.target, registerFlags(parent, child, returnTarget()), options);
      if (result.code !== 0) throw new Error(describeFailure(profile.target, result));
      const line = result.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(line) as { mcpConfig?: unknown };
        return typeof parsed.mcpConfig === 'string' && parsed.mcpConfig ? { mcpConfig: parsed.mcpConfig } : {};
      } catch {
        throw new Error(`bellwether relay-register on ${profile.target} printed no record: ${line || '(nothing)'}`);
      }
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
