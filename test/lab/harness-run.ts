// Tier 3: start a real Pi or Claude Code session in a lab pane. The lab owns
// the herdr server and the temp root; this module owns the harness's own
// configuration, the herdr integration and the wait until herdr sees the
// agent. The four-pair matrix drives these sessions from matrix.test.ts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HerdrClient, type HerdrPane } from '../../src/core/herdr-client.ts';
import { claudeProjectDir } from '../../src/core/transcript.ts';
import type { Lab } from './herdr-lab.ts';

const run = promisify(execFile);

/** The package root, where the Claude plugin manifest and the MCP entry live. */
const repoRoot = path.resolve(import.meta.dirname, '../..');

export type LabHarnessKind = 'pi' | 'claude';

export interface LabHarnessOptions {
  lab: Lab;
  kind: LabHarnessKind;
  label: string;
  /** The scripted endpoint this session's model calls reach. */
  scriptedUrl: string;
  /** The Bellwether registry and outbox root for this run. */
  bellwetherHome: string;
  cwd?: string;
  workspaceId?: string;
  /** Extra Pi extensions, by absolute path. */
  extraExtensions?: string[];
  /** A Pi agent directory whose bin and herdr integration can be reused. */
  baseAgentDir?: string;
  /** A Claude permission mode, such as "manual", for the session. */
  permissionMode?: string;
  /** Claude permission rules to pre-approve, such as an MCP tool name. */
  allowedTools?: string[];
  /** A first prompt, delivered with agent.prompt once the harness is ready. */
  prompt?: string;
  extraEnv?: Record<string, string>;
}

export interface LabHarness {
  kind: LabHarnessKind;
  client: HerdrClient;
  paneId: string;
  tabId: string | undefined;
  workspaceId: string;
  agentDir: string;
  /** The session's own JSONL transcript, once herdr knows the session. */
  transcript(): Promise<string | undefined>;
  close(): Promise<void>;
}

/** The executable a harness is started with. */
export function harnessBinary(kind: LabHarnessKind): string {
  return kind === 'pi' ? 'pi' : 'claude';
}

/** Whether the harness binary exists, so a pair can skip instead of fail. */
export async function hasHarness(kind: LabHarnessKind): Promise<boolean> {
  try {
    await run(harnessBinary(kind), ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function labEnv(lab: Lab): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...lab.env };
  delete env['HERDR_ENV'];
  delete env['HERDR_PANE_ID'];
  delete env['HERDR_SOCKET_PATH'];
  delete env['HERDR_SESSION'];
  return env;
}

/** Install herdr's own integration into this harness's config directory. */
export async function installHerdrIntegration(lab: Lab, kind: LabHarnessKind, agentDir: string): Promise<void> {
  const env = labEnv(lab);
  if (kind === 'pi') {
    fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
    env['PI_CODING_AGENT_DIR'] = agentDir;
  } else {
    env['CLAUDE_CONFIG_DIR'] = agentDir;
  }
  await run('herdr', ['integration', 'install', kind === 'pi' ? 'pi' : 'claude'], { env, timeout: 20_000 });
}

/** A lab Pi directory whose only provider is the scripted endpoint. */
export async function createPiAgentDir(options: {
  lab: Lab;
  dir: string;
  scriptedUrl: string;
  extraExtensions?: string[];
  baseAgentDir?: string;
}): Promise<string> {
  const { lab, dir, scriptedUrl } = options;
  fs.mkdirSync(path.join(dir, 'extensions'), { recursive: true });
  if (options.baseAgentDir) {
    const baseIntegration = path.join(options.baseAgentDir, 'extensions', 'herdr-agent-state.ts');
    if (fs.existsSync(baseIntegration)) fs.copyFileSync(baseIntegration, path.join(dir, 'extensions', 'herdr-agent-state.ts'));
    const baseBin = path.join(options.baseAgentDir, 'bin');
    if (fs.existsSync(baseBin) && !fs.existsSync(path.join(dir, 'bin'))) fs.symlinkSync(baseBin, path.join(dir, 'bin'));
  } else {
    await installHerdrIntegration(lab, 'pi', dir);
  }
  const extensions = [path.resolve(import.meta.dirname, '../../src/integrations/pi/extension.ts'), ...(options.extraExtensions ?? [])];
  fs.writeFileSync(
    path.join(dir, 'models.json'),
    `${JSON.stringify({ providers: { scripted: { baseUrl: scriptedUrl, api: 'openai-completions', apiKey: 'lab', models: [{ id: 'scripted-model', name: 'Scripted', contextWindow: 100_000, maxTokens: 4_096 }] } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    `${JSON.stringify({ defaultProvider: 'scripted', defaultModel: 'scripted-model', extensions, theme: 'dark', defaultProjectTrust: 'always' }, null, 2)}\n`,
  );
  return dir;
}

/**
 * A lab Claude config directory with herdr's hook installed. The seeds skip
 * the login-method picker and the project-trust dialog, which a TUI lab
 * cannot answer through herdr's own agent API.
 */
export async function createClaudeConfigDir(options: { lab: Lab; dir: string; cwd: string; permissionMode?: string; allowedTools?: string[] }): Promise<string> {
  const { lab, dir, cwd } = options;
  fs.mkdirSync(dir, { recursive: true });
  await installHerdrIntegration(lab, 'claude', dir);
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    `${JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoDefaultNotice: true, hasResetAutoModeOptInForDefaultOffer: true, projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } } }, null, 2)}\n`,
  );
  const settings: Record<string, unknown> = { apiKeyHelper: 'echo lab', enableAllProjectMcpServers: true };
  const permissions: Record<string, unknown> = {};
  if (options.permissionMode) permissions['defaultMode'] = options.permissionMode;
  if (options.allowedTools?.length) permissions['allow'] = options.allowedTools;
  if (Object.keys(permissions).length) settings['permissions'] = permissions;
  fs.writeFileSync(path.join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  // The Bellwether MCP server, loaded with --strict-mcp-config so no project
  // server approval dialog stands between the lab and the child.
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    `${JSON.stringify({ mcpServers: { bellwether: { command: 'node', args: [path.join(repoRoot, 'bin', 'bellwether-mcp.js')] } } }, null, 2)}\n`,
  );
  return dir;
}

/** The lab has no active workspace until one is created. */
export async function ensureWorkspace(client: HerdrClient, cwd: string): Promise<string> {
  const workspaces = await client.workspaceList();
  const first = workspaces[0]?.['workspace_id'];
  if (typeof first === 'string' && first.length > 0) return first;
  const result = (await client.request('workspace.create', { cwd, label: 'bellwether-lab', focus: false })) as Record<string, unknown>;
  const workspace = result['workspace'];
  const id = typeof workspace === 'object' && workspace !== null ? (workspace as Record<string, unknown>)['workspace_id'] : undefined;
  if (typeof id !== 'string' || id.length === 0) throw new Error('herdr created no workspace for the lab');
  return id;
}

/** Wait until Claude's TUI has its input box, past the boot notices. */
export async function waitForClaudeReady(client: HerdrClient, paneId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await client.paneRead({ paneId, source: 'recent_unwrapped', lines: 80 }).catch(() => '');
    // Starting in manual mode offers to switch back to auto mode first.
    if (/Make auto mode your default permission mode/.test(text)) {
      await client.request('pane.send_keys', { pane_id: paneId, keys: ['down', 'enter'] }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 600));
      continue;
    }
    if (/shift\+tab to cycle|auto mode on|manual mode on|accept edits on|plan mode on/.test(text)) return;
    if (Date.now() > deadline) throw new Error(`Claude's TUI in ${paneId} was not ready in time`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Send literal text and Enter to a pane's shell. */
async function typeCommand(client: HerdrClient, paneId: string, text: string): Promise<void> {
  await client.request('pane.send_text', { pane_id: paneId, text });
  await client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
}

function findAgent(panes: HerdrPane[], paneId: string): HerdrPane | undefined {
  return panes.find((pane) => pane.paneId === paneId);
}

/** The newest JSONL under a Pi session root whose name ends in the session id. */
function newestFile(dir: string, session: string): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(`${session}.jsonl`)) {
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { file: full, mtime };
      }
    }
  };
  walk(dir);
  return best?.file;
}

/** Wait until herdr recognises the harness in the pane. */
export async function waitForHarness(client: HerdrClient, paneId: string, kind: LabHarnessKind, timeoutMs = 40_000): Promise<HerdrPane> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = findAgent(await client.agentList(), paneId);
    if (pane && pane.agent === kind && pane.agentStatus !== 'unknown') return pane;
    if (Date.now() > deadline) throw new Error(`herdr did not detect a ${kind} agent in ${paneId}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Pi's TUI installs fd and ripgrep on its first run, and herdr reports the
 * agent idle while those downloads are still running. The TUI keeps the word
 * "Downloading" in its scrollback after the files land, so readiness is the
 * footer naming the model together with the two binaries existing on disk.
 */
export async function waitForPiReady(client: HerdrClient, paneId: string, agentDir: string, timeoutMs = 60_000): Promise<void> {
  const downloaded = (): boolean => {
    const bin = path.join(agentDir, 'bin');
    if (!fs.existsSync(bin)) return true;
    return fs.existsSync(path.join(bin, 'fd')) && fs.existsSync(path.join(bin, 'rg'));
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = (await client.agentList().catch(() => [] as HerdrPane[])).find((entry) => entry.paneId === paneId);
    const text = await client.paneRead({ paneId, source: 'recent_unwrapped', lines: 80 }).catch(() => '');
    const idle = pane?.agentStatus === 'idle' || pane?.agentStatus === 'done';
    if (idle && downloaded() && /scripted-model|Scripted/.test(text)) return;
    if (Date.now() > deadline) {
      // A pair must not fail on a slow first-run download or a footer that
      // reads differently; herdr already said the agent is up.
      if (idle) return;
      throw new Error(`Pi's TUI in ${paneId} was not ready in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Start a harness in its own tab and wait until herdr sees it. */
export async function startHarness(options: LabHarnessOptions): Promise<LabHarness> {
  const client = new HerdrClient({ socketPath: options.lab.socketPath });
  const workspaceId = options.workspaceId ?? (await ensureWorkspace(client, options.cwd ?? options.lab.root));
  const cwd = options.cwd ?? options.lab.root;
  const agentDir = options.kind === 'pi' ? path.join(options.lab.root, `pi-${options.label.replace(/[^A-Za-z0-9_-]+/g, '-')}`) : path.join(options.lab.root, `claude-${options.label.replace(/[^A-Za-z0-9_-]+/g, '-')}`);

  if (options.kind === 'pi') {
    await createPiAgentDir({ lab: options.lab, dir: agentDir, scriptedUrl: options.scriptedUrl, extraExtensions: options.extraExtensions, baseAgentDir: options.baseAgentDir });
  } else {
    await createClaudeConfigDir({ lab: options.lab, dir: agentDir, cwd, permissionMode: options.permissionMode, allowedTools: options.allowedTools });
  }

  // A lab pane inherits the ambient environment, which can still carry the
  // BELLWETHER_* variables of the session that started the lab. Clear the two
  // that decide whether this session is itself a child.
  const env: Record<string, string> = { BELLWETHER_PARENT: '', BELLWETHER_DEPTH: '0', ...options.extraEnv, BELLWETHER_HOME: options.bellwetherHome };
  if (options.kind === 'pi') env['PI_CODING_AGENT_DIR'] = agentDir;
  else {
    env['CLAUDE_CONFIG_DIR'] = agentDir;
    env['ANTHROPIC_BASE_URL'] = options.scriptedUrl;
    // Claude Code's background traffic (titles, topics) would otherwise take a
    // scripted reply before the prompt's own turn.
    env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
  }

  const tab = await client.tabCreate({ workspaceId, cwd, label: options.label, env, focus: false });
  if (!tab.paneId) throw new Error(`herdr created no pane for ${options.label}`);
  const paneId = tab.paneId;
  const tabId = tab.tabId;

  if (options.kind === 'pi') {
    await typeCommand(client, paneId, 'pi');
    await waitForHarness(client, paneId, 'pi');
    await waitForPiReady(client, paneId, agentDir);
  } else {
    // --strict-mcp-config loads only this file's server, so the child reaches
    // parent_report with no project-approval dialog. The same build reports
    // channel notifications as unavailable, so no plugin flag can wake a
    // Claude parent here.
    const flags = [
      `--mcp-config ${path.join(agentDir, 'mcp.json')}`,
      '--strict-mcp-config',
      options.permissionMode ? `--permission-mode ${options.permissionMode}` : '',
    ].filter(Boolean).join(' ');
    await typeCommand(client, paneId, `claude ${flags}`);
    await waitForHarness(client, paneId, 'claude');
    await waitForClaudeReady(client, paneId);
  }

  if (options.prompt) await client.agentPrompt(paneId, options.prompt).catch(() => undefined);

  return {
    kind: options.kind,
    client,
    paneId,
    tabId,
    workspaceId,
    agentDir,
    async transcript(): Promise<string | undefined> {
      const pane = findAgent(await client.agentList(), paneId);
      const session = pane?.agentSessionId;
      if (!session) return undefined;
      if (options.kind === 'pi') {
        const sessions = path.join(agentDir, 'sessions');
        return newestFile(sessions, session);
      }
      return path.join(agentDir, 'projects', claudeProjectDir(cwd), `${session}.jsonl`);
    },
    async close(): Promise<void> {
      await client.tabClose(tabId ?? paneId).catch(() => undefined);
    },
  };
}
