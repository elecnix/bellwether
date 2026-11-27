// A Claude Code child's own Bellwether MCP server. The spawn writes a private
// configuration that names this package's channel entry point and the child
// id, and starts the child with --mcp-config pointing at it. The server is a
// client of the machine's one daemon: it sends the child id and its pane with
// every call, and the daemon resolves them against the child record it holds.
// Nothing about the child's identity rides in the server's environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeBrief } from './brief.ts';
import { removeClaudeSettings, writeClaudeSettings } from './claude-settings.ts';
import { mcpConfigPath, mcpDir } from './paths.ts';
import { CHILD_SERVER_NAME, findAmbientServers, planToolSource, type ToolSource } from './tool-source.ts';

/** The name the child's channel flag loads, `server:bellwether`. */
export const MCP_SERVER_NAME = CHILD_SERVER_NAME;

/**
 * The packaged channel entry point. From the sources this file is
 * mcp-config.ts and the entry is channel.ts; from the build, both end in .js.
 */
export function channelEntry(): string {
  return fileURLToPath(new URL(`../integrations/claude/channel${path.extname(import.meta.url)}`, import.meta.url));
}

/** The server that takes over a duplicate Bellwether server's name in a child's config, and offers no tools. */
export function standDownEntry(): string {
  return fileURLToPath(new URL(`../integrations/claude/stand-down${path.extname(import.meta.url)}`, import.meta.url));
}

/**
 * The configuration that starts one child's server: this Node, the channel
 * entry, the child id. Each name in `standDown` belongs to another Bellwether
 * server the child's environment holds; the config takes that name over with
 * a server that offers no tools, because Claude Code lets --mcp-config win a
 * name, and the child keeps one set of tools.
 */
export function mcpConfig(childId: string, standDown: readonly string[] = []): { mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }> } {
  const entry = (script: string, args: string[] = []): { type: 'stdio'; command: string; args: string[] } => ({ type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', script, ...args] });
  return {
    mcpServers: {
      ...Object.fromEntries(standDown.filter((name) => name !== MCP_SERVER_NAME).map((name) => [name, entry(standDownEntry())])),
      [MCP_SERVER_NAME]: entry(channelEntry(), ['--child', childId]),
    },
  };
}

/** Write the child's configuration with mode 0600 in a 0700 directory, and return its path. */
export function writeMcpConfig(childId: string, standDown: readonly string[] = []): string {
  const dir = mcpDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = mcpConfigPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(mcpConfig(childId, standDown), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove a child's configuration. One that is already gone is not an error. */
export function removeMcpConfig(childId: string): void {
  fs.rmSync(mcpConfigPath(childId), { force: true });
}

/** The files that give a Claude Code child its Bellwether tools, and which server that is. */
export interface ChildToolFiles {
  mcpConfig: string;
  /** The settings that turn a Bellwether plugin off for the child, when one is enabled. */
  claudeSettings?: string;
  toolSource: ToolSource;
}

/**
 * Write a Claude Code child's tool files on this machine: its own server, and
 * whatever keeps each other Bellwether server in its environment from adding
 * a second set of tools. `cwd` is where the child runs, whose project settings
 * Claude Code also reads.
 */
export function writeChildToolFiles(childId: string, cwd: string | undefined): ChildToolFiles {
  const plan = planToolSource(findAmbientServers(cwd));
  const mcp = writeMcpConfig(childId, plan.standDown);
  const settings = writeClaudeSettings(childId, { disablePlugins: plan.disablePlugins });
  return { mcpConfig: mcp, ...(settings ? { claudeSettings: settings } : {}), toolSource: plan.source };
}

/** Remove every file a spawn wrote for a child: its brief, its MCP configuration and its Claude Code settings. */
export function removeChildFiles(childId: string): void {
  removeBrief(childId);
  removeMcpConfig(childId);
  removeClaudeSettings(childId);
}
