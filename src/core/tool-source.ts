// Which server gives a Claude Code child its Bellwether tools. The spawn
// starts each child with its own server, the one that carries the child id,
// so a parent_report from it reaches the parent. Claude Code also loads
// whatever its own settings name: an enabled Bellwether plugin, or a
// Bellwether server the operator added under user, local or project scope.
// Each of those would give the child a second set of the same tools, under
// another server name, and without the child id. This module finds them, and
// decides how the child's own server displaces each one:
//
// - a plugin is turned off for the child alone, with `enabledPlugins` in the
//   settings file the child starts with (`--settings`);
// - a server named `bellwether` is replaced by the per-child server of the
//   same name, because Claude Code lets `--mcp-config` win a name;
// - a server under another name is replaced by a server of that name in the
//   per-child config, which runs `src/integrations/claude/stand-down.ts` and
//   offers no tools.
//
// The decision is a pure function of what was found. Reading the settings is
// the only side effect, and it never writes to them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The per-child server's name, which the child's channel flag loads as `server:bellwether`. */
export const CHILD_SERVER_NAME = 'bellwether';

/** A Bellwether server that Claude Code would load for a session on its own. */
export interface AmbientServer {
  /** A plugin, or an MCP server from one of Claude Code's scopes. */
  kind: 'plugin' | 'user' | 'local' | 'project';
  /** The plugin id, `name@marketplace`, or the server's name. */
  name: string;
  /** The file that enables or declares it. */
  file: string;
}

/** How the per-child server displaced one ambient server. */
export type Displacement = 'plugin-disabled' | 'replaced-by-name' | 'stood-down';

/** Which server gives a child its Bellwether tools, and what it displaced. Kept on the child record. */
export interface ToolSource {
  /** Always the per-child server: it is the one that carries the child id. */
  server: 'per-child';
  /** Each Bellwether server the child's environment held, and how it was kept out. */
  suppressed: (AmbientServer & { how: Displacement })[];
  /** Why the environment was not checked, when it was not: an older Bellwether on the child's machine. */
  unchecked?: string;
}

/** What the spawn adds to a child's start so the per-child server is its only Bellwether server. */
export interface ToolPlan {
  source: ToolSource;
  /** Plugin ids to turn off in the child's settings. */
  disablePlugins: string[];
  /** Server names the per-child config takes over with a server that offers nothing. */
  standDown: string[];
}

/**
 * Decide how a child's own server displaces each ambient Bellwether server.
 * The child always gets its own server, because only that one carries its id.
 */
export function planToolSource(ambient: readonly AmbientServer[]): ToolPlan {
  const suppressed: ToolSource['suppressed'] = [];
  const disablePlugins: string[] = [];
  const standDown: string[] = [];
  for (const server of ambient) {
    if (server.kind === 'plugin') {
      if (!disablePlugins.includes(server.name)) disablePlugins.push(server.name);
      suppressed.push({ ...server, how: 'plugin-disabled' });
    } else if (server.name === CHILD_SERVER_NAME) {
      suppressed.push({ ...server, how: 'replaced-by-name' });
    } else {
      if (!standDown.includes(server.name)) standDown.push(server.name);
      suppressed.push({ ...server, how: 'stood-down' });
    }
  }
  return { source: { server: 'per-child', suppressed }, disablePlugins, standDown };
}

/** Where Claude Code keeps its user and local MCP servers: beside its config directory when one is set. */
export function claudeStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] ? path.join(env['CLAUDE_CONFIG_DIR'], '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Whether a server definition runs Bellwether's channel: its name, its command or one of its arguments says so. */
export function runsBellwether(name: string, server: unknown): boolean {
  if (name === CHILD_SERVER_NAME) return true;
  const entry = record(server);
  const words = [entry['command'], ...(Array.isArray(entry['args']) ? entry['args'] : [])].filter((word): word is string => typeof word === 'string');
  return words.some((word) => /bellwether-mcp|@elecnix[\\/]bellwether|integrations[\\/]claude[\\/]channel/.test(word));
}

/** Whether a plugin id names Bellwether: its name, before the marketplace. */
export function isBellwetherPlugin(id: string): boolean {
  return id.split('@')[0] === 'bellwether';
}

/**
 * Every Bellwether server a Claude Code session in `cwd` would load on its
 * own: plugins enabled in user, project or local settings, where a later file
 * overrides an earlier one, and servers in the user, local and project scopes.
 */
export function findAmbientServers(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): AmbientServer[] {
  const configDir = env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
  const found: AmbientServer[] = [];
  const settingsFiles = [path.join(configDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])];
  const plugins = new Map<string, string | undefined>();
  for (const file of settingsFiles) {
    for (const [id, enabled] of Object.entries(record(readJson(file)?.['enabledPlugins']))) {
      if (isBellwetherPlugin(id)) plugins.set(id, enabled === true ? file : undefined);
    }
  }
  for (const [name, file] of plugins) if (file) found.push({ kind: 'plugin', name, file });
  const stateFile = claudeStateFile(env);
  const state = readJson(stateFile);
  const scopes: [AmbientServer['kind'], Record<string, unknown>, string][] = [
    ['user', record(state?.['mcpServers']), stateFile],
    ['local', cwd ? record(record(record(state?.['projects'])[path.resolve(cwd)])['mcpServers']) : {}, stateFile],
    ['project', cwd ? record(readJson(path.join(cwd, '.mcp.json'))?.['mcpServers']) : {}, cwd ? path.join(cwd, '.mcp.json') : ''],
  ];
  for (const [kind, servers, file] of scopes) {
    for (const [name, server] of Object.entries(servers)) if (runsBellwether(name, server)) found.push({ kind, name, file });
  }
  return found;
}

function where(server: AmbientServer): string {
  return server.kind === 'plugin' ? `plugin ${server.name}` : `${server.kind} server ${server.name}`;
}

/** One phrase for the record, the spawn reply and doctor: what a child got and what it was spared. */
export function describeToolSource(source: ToolSource): string {
  if (source.unchecked) return `its own server; ${source.unchecked}`;
  if (!source.suppressed.length) return 'its own server; nothing else in its environment offers Bellwether\'s tools';
  const how: Record<Displacement, string> = { 'plugin-disabled': 'turned off for this child', 'replaced-by-name': 'replaced by name', 'stood-down': 'replaced by a server that offers no tools' };
  return `its own server; ${source.suppressed.map((server) => `${where(server)} ${how[server.how]}`).join(', ')}`;
}

/**
 * The doctor line for Claude Code: what a session started by hand gets, and
 * what a spawned child gets instead. Two ambient servers mean a session
 * started by hand has two sets of tools, which Bellwether cannot fix for it.
 */
export function describeClaudeTools(ambient: readonly AmbientServer[]): { level: 'ok' | 'warn'; text: string } {
  const plan = planToolSource(ambient);
  const how: Record<Displacement, string> = {
    'plugin-disabled': 'turned off for it with --settings',
    'replaced-by-name': 'replaced by it, as the two share a name',
    'stood-down': 'replaced by a server of the same name that offers no tools',
  };
  const kept = plan.source.suppressed.map((server) => `${where(server)} ${how[server.how]}`).join(', ');
  const child = `a spawned child gets them from its own server (--mcp-config), which carries its child id${kept ? `, with ${kept}, so it has one set` : ', and nothing else offers them'}`;
  if (ambient.length > 1) return { level: 'warn', text: `tools claude-code: a session started by hand gets two sets of Bellwether tools, from ${ambient.map(where).join(' and ')}; remove all but one. ${child.charAt(0).toUpperCase()}${child.slice(1)}` };
  return { level: 'ok', text: `tools claude-code: a session started by hand gets them from ${ambient.length ? where(ambient[0] as AmbientServer) : 'no Bellwether server'}; ${child}` };
}
