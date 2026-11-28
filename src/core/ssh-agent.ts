// What Bellwether can tell about the SSH agent a daemon's ssh inherits (issue
// #245). A daemon takes its environment from whichever client started it, so a
// daemon handed over from a non-interactive SSH session has no SSH_AUTH_SOCK,
// and every relay whose key lives only in an agent fails a retry later with a
// public-key refusal that never mentions the daemon. The daemon records
// whether it started with an agent, in its lock and on each relay attempt; a
// hand-over reads each relay host's `ssh -G` to say which relays will fail.
// Nothing here talks to an agent or writes under ~/.ssh.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_HOST, hostOf } from './machine.ts';
import { relayHostsPath } from './paths.ts';
import { listParents } from './registry.ts';
import type { RelayHostState } from './types.ts';

/** Whether an environment names an SSH agent: SSH_AUTH_SOCK set to a path that exists. */
export function hasAgent(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = fs.existsSync): boolean {
  const socket = env['SSH_AUTH_SOCK']?.trim();
  return Boolean(socket && exists(socket));
}

/** The parts of a host's resolved ssh configuration that say where its key comes from. */
export interface SshKeyConfig {
  /** The IdentityAgent ssh resolved, when the configuration names one. */
  identityAgent?: string;
  /** Every IdentityFile ssh would try, defaults included, with ~ expanded. */
  identityFiles: string[];
}

/** Read `ssh -G <target>` output: `identityagent` and each `identityfile`. */
export function parseSshConfig(output: string, home: string = os.homedir()): SshKeyConfig {
  const config: SshKeyConfig = { identityFiles: [] };
  const expand = (value: string): string => (value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'identityagent') config.identityAgent = expand(value);
    else if (key === 'identityfile') config.identityFiles.push(expand(value));
  }
  return config;
}

/**
 * Where ssh finds a host's key, as far as its configuration shows:
 * - `agent`: from whatever agent SSH_AUTH_SOCK names, because the entry names
 *   no IdentityAgent of its own and no key file that exists
 * - `key-file`: from a key file that exists
 * - `identity-agent`: from the agent its IdentityAgent line names, whatever the environment holds
 * - `none`: the entry turns the agent off and names no key file that exists
 */
export type KeySource = 'agent' | 'key-file' | 'identity-agent' | 'none';

export function keySource(config: SshKeyConfig, exists: (file: string) => boolean = fs.existsSync): KeySource {
  const agent = config.identityAgent;
  const fromEnvironment = agent === undefined || agent === 'SSH_AUTH_SOCK' || agent === '$SSH_AUTH_SOCK' || agent === '${SSH_AUTH_SOCK}';
  if (agent !== undefined && !fromEnvironment && agent.toLowerCase() !== 'none') return 'identity-agent';
  if (config.identityFiles.some((file) => exists(file))) return 'key-file';
  return fromEnvironment ? 'agent' : 'none';
}

/** Read one target's key source with `ssh -G`, which resolves the configuration without connecting. Undefined when ssh cannot say. */
export function probeKeySource(target: string, options: { ssh?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<KeySource | undefined> {
  return new Promise((resolve) => {
    execFile(options.ssh ?? 'ssh', ['-G', target], { env: options.env ?? process.env, timeout: options.timeoutMs ?? 5_000, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(undefined);
      resolve(keySource(parseSshConfig(stdout, options.env?.['HOME'] ?? os.homedir())));
    });
  });
}

/** One machine a daemon dials, and where its key comes from when known. */
export interface RelayKeyHost {
  /** The herdr machine, as the child records name it. */
  host: string;
  /** Its SSH target, which a ~/.ssh/config `Host` line matches. */
  target: string;
  source?: KeySource;
}

/**
 * The machines a daemon on this home dials: each host its relay memory names,
 * with the SSH target it last resolved to, and each machine a live child runs
 * on. A host the memory never resolved goes by its own name.
 */
export function relayHosts(): { host: string; target: string }[] {
  const hosts = new Map<string, string>();
  try {
    const memory = JSON.parse(fs.readFileSync(relayHostsPath(), 'utf8')) as unknown;
    if (typeof memory === 'object' && memory !== null && !Array.isArray(memory)) {
      for (const [host, known] of Object.entries(memory as Record<string, { target?: unknown }>)) hosts.set(host, typeof known?.target === 'string' && known.target ? known.target : host);
    }
  } catch {
    // No memory yet: only the live children name machines.
  }
  for (const parent of listParents()) {
    for (const child of parent.children) {
      const host = hostOf(child);
      if (!child.exitedAt && host !== LOCAL_HOST && !hosts.has(host)) hosts.set(host, host);
    }
  }
  return [...hosts].map(([host, target]) => ({ host, target }));
}

/**
 * What a hand-over says about the agent: compare the daemon it replaces with
 * the environment the new one inherits, and read each relay host's ssh
 * configuration only when the new daemon has no agent.
 */
export async function handOverAgentNotice(replacedHadAgent: boolean | undefined, options: { env?: NodeJS.ProcessEnv; ssh?: string } = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (hasAgent(env)) return undefined;
  let hosts: { host: string; target: string }[] = [];
  try {
    hosts = relayHosts();
  } catch {
    // A registry that cannot be read names no machine; the comparison with the old daemon still stands.
  }
  const probed = await Promise.all(hosts.map(async (host): Promise<RelayKeyHost> => {
    const source = await probeKeySource(host.target, { env, ...(options.ssh ? { ssh: options.ssh } : {}) });
    return { ...host, ...(source ? { source } : {}) };
  }));
  return agentLossNotice({ ...(replacedHadAgent === undefined ? {} : { replacedHadAgent }), startsWithAgent: false, hosts: probed });
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The sentence a hand-over prints when the daemon it starts has no agent and a
 * relay depends on one, or undefined when nothing it can see will break.
 * `replacedHadAgent` is undefined for a daemon whose lock predates the field.
 */
export function agentLossNotice(input: { replacedHadAgent?: boolean; startsWithAgent: boolean; hosts: RelayKeyHost[] }): string | undefined {
  if (input.startsWithAgent) return undefined;
  const opening = `The new daemon starts without SSH_AUTH_SOCK${input.replacedHadAgent ? ', though the daemon it replaces had one' : ''}`;
  const needs = input.hosts.filter((host) => host.source === 'agent');
  if (needs.length) {
    return `${opening}, so its relay to ${list(needs.map((host) => host.host))} will fail with Permission denied when it next connects, because ssh finds no IdentityAgent and no key file for ${needs.length === 1 ? 'that host' : 'those hosts'}. Add an IdentityAgent or IdentityFile line under Host ${list(needs.map((host) => host.target))} in ~/.ssh/config, and the next retry connects.`;
  }
  const unknown = input.hosts.filter((host) => host.source === undefined);
  if (unknown.length && input.replacedHadAgent !== false) {
    return `${opening}, so its relay to ${list(unknown.map((host) => host.host))} will fail with Permission denied if its key lives only in an agent. Add an IdentityAgent or IdentityFile line under Host ${list(unknown.map((host) => host.target))} in ~/.ssh/config, and the next retry connects.`;
  }
  if (!input.hosts.length && input.replacedHadAgent) {
    return `${opening}, so a relay it opens finds a key only through an IdentityAgent or IdentityFile line in ~/.ssh/config.`;
  }
  return undefined;
}

/** Doctor's line under a failing relay whose newest ssh ran without an agent, or undefined. */
export function relayAgentLine(state: Pick<RelayHostState, 'host' | 'target' | 'status' | 'sshAgent'>): string | undefined {
  if (state.status === 'connected' || state.sshAgent !== false) return undefined;
  const target = state.target ?? state.host;
  return `relay ${state.host}: the daemon started without SSH_AUTH_SOCK, so its ssh to ${target} ran with no agent. If that key lives in an agent, add an IdentityAgent or IdentityFile line under Host ${target} in ~/.ssh/config, and the next retry connects; or run bellwether drain, then bellwether relay-bridge < /dev/null from a shell that has the agent.`;
}
