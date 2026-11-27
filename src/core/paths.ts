import os from 'node:os';
import path from 'node:path';

/** Every Bellwether file lives under one directory, overridable for tests. */
export function bellwetherHome(): string {
  return process.env['BELLWETHER_HOME'] ?? path.join(os.homedir(), '.bellwether');
}

export function parentsDir(): string {
  return path.join(bellwetherHome(), 'parents');
}

export function outboxDir(): string {
  return path.join(bellwetherHome(), 'outbox');
}

export function spoolDir(): string {
  return path.join(bellwetherHome(), 'spool');
}

/** Each child's brief, kept off the command line. */
export function promptsDir(): string {
  return path.join(bellwetherHome(), 'prompts');
}

export function promptPath(childId: string): string {
  return path.join(promptsDir(), `${slug(childId)}.md`);
}

/** Each Claude Code child's MCP configuration, passed with --mcp-config. */
export function mcpDir(): string {
  return path.join(bellwetherHome(), 'mcp');
}

export function mcpConfigPath(childId: string): string {
  return path.join(mcpDir(), `${slug(childId)}.json`);
}

/**
 * Each spawned Cline child's data directory, which Cline's sandbox mode uses
 * in place of ~/.cline/data: its session store and messages. It outlives the
 * child, so agent_read still answers once the child exits.
 */
export function clineDataDir(childId: string): string {
  return path.join(bellwetherHome(), 'cline', slug(childId));
}

/** Each Claude Code child's own settings, passed with --settings: its Notification hook, and a duplicate Bellwether plugin turned off. */
export function claudeSettingsDir(): string {
  return path.join(bellwetherHome(), 'claude-settings');
}

export function claudeSettingsPath(childId: string): string {
  return path.join(claudeSettingsDir(), `${slug(childId)}.json`);
}

/** One registry file per parent session, so a resumed parent reads the same file. */
export function parentId(harness: string, session: string): string {
  return `${harness}-${slug(session)}`;
}

export function registryPath(id: string): string {
  return path.join(parentsDir(), `${slug(id)}.json`);
}

export function outboxPath(id: string): string {
  return path.join(outboxDir(), `${slug(id)}.json`);
}

export function spoolPath(id: string): string {
  return path.join(spoolDir(), `${slug(id)}.jsonl`);
}

/** A herdr-safe handle: no separators, no spaces, nothing that needs quoting. */
export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'unnamed';
}

/** What this machine's daemon holds for children whose parent runs on another machine. */
export function relayDir(): string {
  return path.join(bellwetherHome(), 'relay');
}

/** One record per child whose reports this daemon carries to another machine. */
export function relayChildPath(childId: string): string {
  return path.join(relayDir(), 'children', `${slug(childId)}.json`);
}

/** Reports waiting for a parent's daemon on another machine to collect them, one file each, named by receipt. */
export function relayOutboxDir(): string {
  return path.join(relayDir(), 'outbox');
}

export function relayOutboxPath(receipt: string): string {
  return path.join(relayOutboxDir(), `${slug(receipt)}.json`);
}

/** What a parent's daemon learnt about each remote host it connects to: the last drain, the last error. */
export function relayHostsPath(): string {
  return path.join(relayDir(), 'hosts.json');
}

/** The full output of each remote command that failed, so an error can quote one line and point at the rest. */
export function remoteLogDir(): string {
  return path.join(bellwetherHome(), 'logs', 'ssh');
}
