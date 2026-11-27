// Codex. herdr detects it but reports no session for it, so the spawn finds
// the session in Codex's rollouts by the child's directory, its start time
// and the brief line (codex-store.ts). Each child gets its own Bellwether
// server through a `-c mcp_servers.bellwether=…` override on its launch line,
// which carries the child id, never through the operator's ~/.codex. Codex
// gates every MCP tool on approval, and refuses one outright under
// `-a never`, so the override pre-approves the three tools a child reports
// with, and only those. Codex's approval policy refuses every other tool. The
// folder-trust question is settled by a per-child `projects` override too,
// so no keystroke answers any Codex dialog.
import { LOCAL_HOST } from '../machine.ts';
import { mcpConfig, MCP_SERVER_NAME } from '../mcp-config.ts';
import { codexActivity, codexHome, codexLastMessage, dirForms, findCodexSession, findRollout } from './codex-store.ts';
import { briefSentence, modelFlag } from './shared.ts';
import type { HarnessEntry } from './types.ts';

/**
 * The only Bellwether tools a Codex child runs without a person's approval:
 * it can report, ask to retire and ask for depth. Codex's approval policy
 * refuses every other Bellwether tool, agent_spawn and agent_send among them,
 * so a Codex child cannot start children or talk to another agent.
 */
export const CODEX_PREAPPROVED_TOOLS = ['parent_report', 'request_retirement', 'agent_request_depth'] as const;

/**
 * The variables the child's Bellwether server needs from the tab. Codex
 * starts an MCP server with HOME, PATH and a few more only, plus the names in
 * `env_vars`. An unset name is skipped.
 */
export const CODEX_SERVER_ENV = ['BELLWETHER_PARENT', 'BELLWETHER_CHILD', 'BELLWETHER_DEPTH', 'BELLWETHER_HOME', 'BELLWETHER_DAEMON_SOCKET', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID'] as const;

/** herdr types the launch line into a shell and cuts it at 1,024 bytes. */
export const HERDR_COMMAND_CAP = 1024;

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * The `-c` value that gives one child its own Bellwether server: this Node,
 * the channel entry, `--child <id>`, the variables it needs, and the three
 * reporting tools pre-approved. It replaces the whole `bellwether` table for
 * this run, so a server of that name in ~/.codex/config.toml does not merge
 * into it.
 */
export function codexServerOverride(childId: string): string {
  const server = mcpConfig(childId).mcpServers[MCP_SERVER_NAME];
  if (!server) throw new Error('Bellwether wrote no server for the child');
  const tools = CODEX_PREAPPROVED_TOOLS.map((name) => `${name}={approval_mode="approve"}`).join(',');
  return `mcp_servers.${MCP_SERVER_NAME}={command=${toml(server.command)},args=[${server.args.map(toml).join(',')}],env_vars=[${CODEX_SERVER_ENV.map(toml).join(',')}],tools={${tools}}}`;
}

/**
 * The `-c` value that trusts the child's directory for this run. Codex asks
 * before it works in a folder it has not seen, and stores the answer in its
 * config.toml. The spawn answers yes for any folder, because the operator
 * approves every spawn, and this says so without a keystroke and without
 * writing the operator's config.
 */
export function codexTrustOverride(cwd: string): string {
  return `projects={${dirForms(cwd).map((dir) => `${toml(dir)}={trust_level="trusted"}`).join(',')}}`;
}

/** Whether the caller's own arguments already set a flag, in either spelling. */
function hasFlag(extra: string[], short: string, long: string): boolean {
  return extra.some((arg) => arg === short || arg === long || arg.startsWith(`${long}=`));
}

export const codex: HarnessEntry = {
  kind: 'codex',
  harness: 'codex',
  label: 'Codex',
  // An older daemon refuses codex, or starts a child without its server.
  since: { protocol: 4, version: '0.1.5' },
  // Codex has no file attachment, so the prompt is a sentence that names the
  // brief. Under -a never it reads the file without asking.
  brief: { where: 'prompts', argument: briefSentence },
  chosenBy: 'flag',
  launchArgs({ model, extra = [], resume = [], files }) {
    const args = [
      // Unattended by default: Codex never stops to ask, and a failed command
      // goes back to the model. A caller's own -a or -s wins, because Codex
      // refuses either flag twice.
      ...(hasFlag(extra, '-a', '--ask-for-approval') ? [] : ['-a', 'never']),
      ...(hasFlag(extra, '-s', '--sandbox') ? [] : ['-s', 'workspace-write']),
      ...modelFlag(model, extra),
      ...(files.launchArgs ?? []),
      // `codex resume <id> [prompt]` takes the same options before it.
      ...resume,
      ...(files.briefFile ? [briefSentence(files.briefFile)] : []),
      ...extra,
    ];
    const line = args.join(' ');
    if (line.length > HERDR_COMMAND_CAP - 16) throw new Error(`the Codex launch line is ${line.length} bytes, and herdr cuts a command at ${HERDR_COMMAND_CAP}; shorten the working directory or the extra arguments`);
    return args;
  },
  /**
   * A child on another machine is refused: its rollouts sit on that machine.
   * The trust override and the store lookup need the working directory.
   */
  async preflight({ name, cwd, host }) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: a codex child runs on this machine only for now, because its session is found in Codex's rollouts where it runs. Omit machine.`);
    if (!cwd) throw new Error(`${name} was not started: a codex child needs cwd, because Bellwether finds its session by the directory it runs in.`);
  },
  session: {
    from: 'store',
    storePath: (hooks) => hooks.store ?? codexHome(),
    async confirm({ store, cwd, briefFile, since }, hooks) {
      return (await findCodexSession({ home: store, cwd, since, prompt: briefSentence(briefFile), waitMs: hooks.waitMs, intervalMs: hooks.intervalMs })).id;
    },
  },
  reports: {
    via: 'harness-config',
    // The server's definition and the folder's trust ride on the launch
    // line, for this child only. The tab names the Codex home, so the child
    // and the lookup read the same rollouts.
    local: (child) => ({
      launchArgs: [...(child.cwd ? ['-c', codexTrustOverride(child.cwd)] : []), '-c', codexServerOverride(child.id)],
      ...(child.store ? { env: { CODEX_HOME: child.store } } : {}),
    }),
    remoteRefusal: "a codex child runs on this machine only for now, because its session is found in Codex's rollouts where it runs",
  },
  conversation: {
    locate(session) {
      const file = session ? findRollout(codexHome(), session) : undefined;
      return file ? { path: file } : { missing: session ? `no Codex rollout for session ${session} under ${codexHome()}` : 'the child has no Codex session yet' };
    },
    lastMessage(child) {
      if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST || !child.session) return undefined;
      const file = child.transcript ?? findRollout(child.store ?? codexHome(), child.session.value);
      return file ? codexLastMessage(file) : undefined;
    },
    pending(child) {
      if (!child.session) return { note: `${child.name} has no Codex session on its record, so there is no rollout to read.`, withScreen: true };
      return { note: `Codex's rollout for session ${child.session.value} holds no answer yet.`, withScreen: !child.exitedAt };
    },
    // A rollout grows with each step the session takes.
    activity(child) {
      if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST || !child.session) return undefined;
      const file = child.transcript ?? findRollout(child.store ?? codexHome(), child.session.value);
      return file ? codexActivity(file) : undefined;
    },
  },
  resume: { args: (session) => ['resume', session.value] },
  // No Codex startup question is answered by a key. The hooks review is
  // refused by name, because trusting a hook lets it run outside the sandbox.
  startup: {
    harness: 'Codex',
    dialogs: [],
    refuse: [
      {
        id: 'hooks',
        name: 'the "Hooks need review" dialog',
        shows: /Hooks need review/,
        why: 'trusting a hook lets it run outside the sandbox, so a person decides. Run `codex` once in a terminal, review the hooks in ~/.codex/hooks.json, then spawn again.',
      },
    ],
  },
  // Codex keeps a pending approval in memory, not in its rollout, so a dialog is read off the screen.
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list marked with ›, or a y/n question (detectModal)' }, activity: 'store' },
  movable: false,
};
