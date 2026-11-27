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
import { removeClaudeSettings } from './claude-hooks.ts';
import { mcpConfigPath, mcpDir } from './paths.ts';

/** The name the child's channel flag loads, `server:bellwether`. */
export const MCP_SERVER_NAME = 'bellwether';

/**
 * The packaged channel entry point. From the sources this file is
 * mcp-config.ts and the entry is channel.ts; from the build, both end in .js.
 */
export function channelEntry(): string {
  return fileURLToPath(new URL(`../integrations/claude/channel${path.extname(import.meta.url)}`, import.meta.url));
}

/** The configuration that starts one child's server: this Node, the channel entry, the child id. */
export function mcpConfig(childId: string): { mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }> } {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', channelEntry(), '--child', childId] },
    },
  };
}

/** Write the child's configuration with mode 0600 in a 0700 directory, and return its path. */
export function writeMcpConfig(childId: string): string {
  const dir = mcpDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = mcpConfigPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(mcpConfig(childId), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove a child's configuration. One that is already gone is not an error. */
export function removeMcpConfig(childId: string): void {
  fs.rmSync(mcpConfigPath(childId), { force: true });
}

/** Remove every file a spawn wrote for a child: its brief, its MCP configuration and its Claude Code settings. */
export function removeChildFiles(childId: string): void {
  removeBrief(childId);
  removeMcpConfig(childId);
  removeClaudeSettings(childId);
}
