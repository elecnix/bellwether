// A pi child's Bellwether tools. Each pi child starts with `-e` naming the pi
// extension inside the package that runs the spawn, the way a Claude Code
// child starts with its own MCP config, so the child has its tools whatever
// the host's global pi settings hold. A child on another machine gets the path
// that machine's package resolves, through `bellwether relay-register`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tab variable that names the extension a pi child was started with. A
 * copy of the extension loaded from anywhere else stands down, so a host that
 * also installed Bellwether as a pi package does not register the tools twice.
 */
export const PI_EXTENSION_ENV = 'BELLWETHER_PI_EXTENSION';

/**
 * The packaged pi extension. From the sources this file is pi-extension.ts and
 * the entry is extension.ts; from the build, both end in .js.
 */
export function piExtensionEntry(): string {
  return fileURLToPath(new URL(`../integrations/pi/extension${path.extname(import.meta.url)}`, import.meta.url));
}

/**
 * The pi extension of the package that is running, or an error that names the
 * missing file, or the copy in pi's settings that would make the child exit.
 */
export function resolvePiExtension(entry: string = piExtensionEntry()): string {
  assertNoGuardlessPiCopy();
  if (!fs.existsSync(entry)) throw new Error(`Bellwether cannot start a pi child: its pi extension ${entry} does not exist, so the child would have no Bellwether tools. Reinstall @elecnix/bellwether on this machine.`);
  return entry;
}

/** The same file, compared through symbolic links. A path that does not exist matches nothing. */
export function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Whether this copy of the extension should register nothing: the session was
 * started with `-e` naming another copy of it. A stale variable that names a
 * file this process was not started with does not count.
 */
export function standDown(self: string, env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  const named = env[PI_EXTENSION_ENV];
  if (!named || sameFile(named, self)) return false;
  return argv.some((arg, index) => (arg === '-e' || arg === '--extension') && argv[index + 1] !== undefined && sameFile(argv[index + 1] as string, named));
}

/** pi's agent directory, where its settings and the packages it installed live. */
export function piAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? path.join(os.homedir(), '.pi', 'agent');
}

/** Where pi keeps a package source it installed: npm and git under the agent directory, a local path as written. */
function packageDir(agentDir: string, source: string): string | undefined {
  if (source.startsWith('npm:')) {
    const name = source.slice(4).replace(/(?<=.)@[^/]*$/, '');
    return path.join(agentDir, 'npm', 'node_modules', name);
  }
  if (source.startsWith('git:')) return path.join(agentDir, 'git', source.slice(4).replace(/@[^/]*$/, ''));
  if (/^[a-z]+:/i.test(source)) return undefined;
  return path.resolve(agentDir, source.replace(/^~(?=\/)/, os.homedir()));
}

/** Whether a package directory holds Bellwether: its manifest names it. */
function isBellwether(dir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name === '@elecnix/bellwether';
  } catch {
    return false;
  }
}

/** Whether a Bellwether copy carries the stand-down guard, built or in its sources. */
function hasGuard(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'dist', 'core', 'pi-extension.js')) || fs.existsSync(path.join(dir, 'src', 'core', 'pi-extension.ts'));
}

/**
 * The Bellwether copies pi's user settings load that predate the stand-down
 * guard. pi exits at startup when two extensions register the same tool, so a
 * child started with -e beside such a copy would die before its first turn.
 */
export function guardlessPiCopies(agentDir: string = piAgentDir()): string[] {
  let packages: unknown;
  try {
    packages = (JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  const found: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as { source?: unknown }).source : undefined;
    if (typeof source !== 'string') continue;
    const dir = packageDir(agentDir, source);
    if (dir && isBellwether(dir) && !hasGuard(dir)) found.push(dir);
  }
  return found;
}

/** Throw, with the fix, when pi's settings load a Bellwether copy that would make a pi child exit. */
export function assertNoGuardlessPiCopy(agentDir: string = piAgentDir()): void {
  const stale = guardlessPiCopies(agentDir);
  if (!stale.length) return;
  throw new Error(`Bellwether cannot start a pi child here: pi's settings load Bellwether from ${stale.join(' and ')}, a version without the guard that keeps a second copy from registering its tools, and pi exits when two extensions register the same tool. Run pi install npm:@elecnix/bellwether to update it, or remove it from ${path.join(agentDir, 'settings.json')}.`);
}
