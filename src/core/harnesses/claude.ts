// Claude Code. herdr reports its session id. A child gets its own Bellwether
// server through --mcp-config, its own settings file through --settings, and
// loads the server as a development channel, whose confirmation the spawn
// answers along with the folder-trust question.
import path from 'node:path';
import { LOCAL_HOST } from '../machine.ts';
import { writeChildToolFiles } from '../mcp-config.ts';
import { CLAUDE_STARTUP } from '../startup-dialogs.ts';
import { locateClaudeTranscript } from '../transcript.ts';
import { modelFlag } from './shared.ts';
import type { HarnessEntry } from './types.ts';

/** The flag that loads the child's server as a channel, so its events reach the session. */
export const CLAUDE_CHANNEL_ARG = '--dangerously-load-development-channels=server:bellwether';

export const claude: HarnessEntry = {
  kind: 'claude',
  harness: 'claude-code',
  label: 'Claude Code',
  // The brief arrives through the child's own channel as a message, after the
  // startup dialogs, so the pane shows the task rather than a path to it.
  brief: { where: 'prompts' },
  chosenBy: 'flag',
  launchArgs({ model, extra = [], resume = [], files }) {
    return [
      ...modelFlag(model, extra),
      // --mcp-config is a list flag, so it takes the equals form.
      ...(files.mcpConfigFile ? [`--mcp-config=${files.mcpConfigFile}`] : []),
      // Claude Code merges these settings with every other source, so the child
      // gains its Notification hook, loses a duplicate Bellwether plugin, and
      // keeps the rest of the operator's own settings.
      ...(files.claudeSettingsFile ? [`--settings=${files.claudeSettingsFile}`] : []),
      // Claude Code reads this flag as a list and keeps taking values until the
      // next flag, so the two-argument form swallowed the prompt that follows
      // it. The equals form pins the flag to one value.
      CLAUDE_CHANNEL_ARG,
      ...resume,
      ...extra,
    ];
  },
  // herdr learns the session id from its Claude Code hook, which `herdr integration install claude` writes.
  session: { from: 'herdr', kind: 'id', integration: 'claude' },
  reports: {
    via: 'mcp-config',
    // A server and the hook talk to the daemon on their own machine, so a
    // child on another machine gets the files its own machine writes when the
    // spawn registers it there, without the hook.
    local(child, { farEnd }) {
      const tools = writeChildToolFiles(child.id, child.cwd, { hook: !farEnd && (child.host ?? LOCAL_HOST) === LOCAL_HOST, reads: child.reads });
      return { mcpConfigFile: tools.mcpConfig, ...(tools.claudeSettings ? { claudeSettingsFile: tools.claudeSettings } : {}), toolSource: tools.toolSource };
    },
    remote: 'mcpConfig',
  },
  // The child's own server is a channel, so a parent's message arrives as a
  // channel notification. Claude Code makes a server a channel only at its
  // launch, so a session Bellwether did not start takes no message from it.
  inbox: {
    via: 'claude-channel',
    adopted: {
      adapter: 'server',
      why: "takes no messages: Claude Code puts a server's message in a session only when the session started with that server as a channel",
      reply: "Claude Code puts a server's message in a session only when the session started with that server as a channel, which a session Bellwether did not start never did, so agent_send types into its pane.",
    },
  },
  conversation: { locate: locateClaudeTranscript },
  resume: {
    args: (session) => ['--resume', session.kind === 'path' ? path.basename(session.value, '.jsonl') : session.value],
    // Claude Code names the file after the session id.
    fromTranscript: (file) => ({ value: path.basename(file, '.jsonl'), kind: 'id' }),
  },
  startup: CLAUDE_STARTUP,
  launchReads: true,
  classify: { status: 'herdr', dialogs: { from: 'hook' }, activity: 'transcript' },
  movable: true,
};
