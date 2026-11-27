// A Claude Code child's own hooks. The spawn writes a private settings file
// for the child, as it writes the child's MCP configuration, and starts the child with --settings
// pointing at it. The file holds one hook: Claude Code's `Notification`, for
// the notification types that mean a dialog waits on the person. The hook runs
// `bellwether claude-hook`, which tells the daemon, as a pi child's extension
// does on pi's ui_prompt_start, so the watcher names the dialog without
// reading the child's screen.
//
// Claude Code's own schema for the hook's input, from its 2.1.332 build:
// `hook_event_name: "Notification"`, `message`, an optional `title`, and
// `notification_type`, beside the common `session_id`, `transcript_path` and
// `cwd`. A permission dialog sends "Claude needs your permission to use
// <tool>" with `notification_type: "permission_prompt"`, about 6 s after the
// dialog opens, and only if nobody answered it first.
//
// The operator's own ~/.claude/settings.json is never touched: Claude Code
// merges the hooks of every settings source, so this file adds one hook to
// the child's session and nothing else.
//
// This hook reports a dialog. It never answers one. A Notification hook
// cannot approve anything, and `bellwether claude-hook` writes nothing to
// standard output, where a decision hook would put one. Approving a
// permission question is the operator's decision: do not move this hook to
// PermissionRequest, and do not make it print a decision.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSettingsDir, claudeSettingsPath } from './paths.ts';

/** The notification types that mean a dialog waits on the person. */
export const DIALOG_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'] as const;

/** The command name the hook runs. */
export const HOOK_COMMAND = 'claude-hook';

/** The hook's time limit, in seconds. The hook connects to a local socket and exits. */
const HOOK_TIMEOUT_S = 10;

/**
 * The packaged command entry point. From the sources this file is
 * claude-hooks.ts and the entry is cli.ts; from the build, both end in .js.
 */
export function cliEntry(): string {
  return fileURLToPath(new URL(`../cli${path.extname(import.meta.url)}`, import.meta.url));
}

/** One argument quoted for the POSIX shell that Claude Code runs a hook command in. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command line the child's hook runs: this Node, the command entry, the child id. */
export function hookCommand(childId: string): string {
  return [process.execPath, '--disable-warning=ExperimentalWarning', cliEntry(), HOOK_COMMAND, '--child', childId].map(shellQuote).join(' ');
}

/** The settings one Claude Code child starts with. */
export function claudeChildSettings(childId: string): { hooks: { Notification: { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }[] } } {
  return {
    hooks: {
      Notification: [{ matcher: DIALOG_NOTIFICATIONS.join('|'), hooks: [{ type: 'command', command: hookCommand(childId), timeout: HOOK_TIMEOUT_S }] }],
    },
  };
}

/** Write the child's settings with mode 0600 in a 0700 directory, and return the path. */
export function writeClaudeSettings(childId: string): string {
  const dir = claudeSettingsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = claudeSettingsPath(childId);
  fs.writeFileSync(file, `${JSON.stringify(claudeChildSettings(childId), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove a child's settings. A file that is already gone is not an error. */
export function removeClaudeSettings(childId: string): void {
  fs.rmSync(claudeSettingsPath(childId), { force: true });
}

/** What the daemon records for one hook input. */
export interface HookDialog {
  open: true;
  title: string;
  kind: string;
}

/**
 * The dialog a Notification hook's input names, or undefined for any other
 * input: another hook event, a notification that is not a dialog, such as
 * `idle_prompt`, or text that is not the JSON Claude Code sends.
 */
export function dialogFromHook(input: string): HookDialog | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object') return undefined;
  const { hook_event_name: event, notification_type: kind, message, title } = payload as Record<string, unknown>;
  if (event !== 'Notification' || typeof kind !== 'string' || !(DIALOG_NOTIFICATIONS as readonly string[]).includes(kind)) return undefined;
  const text = typeof message === 'string' && message.trim() ? message.trim() : typeof title === 'string' && title.trim() ? title.trim() : `a Claude Code ${kind.replace(/_/g, ' ')} with no message`;
  return { open: true, title: text, kind };
}
