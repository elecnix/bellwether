// omp (oh-my-pi), a fork of pi with its own directory, ~/.omp. herdr detects
// it as the kind `omp`, but only through the integration that
// `herdr integration install omp` writes into omp's extension directory: that
// extension reports the child's state and the path of its session file. So a
// spawn first asks herdr whether the integration is there.
//
// omp loads pi extensions: it takes `-e <file>`, and its extension API has
// every call the Bellwether pi extension makes (session_start, message_end,
// registerTool, sendMessage with a steer). A child gets its tools from the pi
// extension of the running package, as a pi child does. The extension says
// hello as the pi adapter, which is what it is; the child's record keeps omp.
//
// What each line rests on, in omp 19.2.1's sources (can1357/oh-my-pi):
// - `-e`, `@file`, `--model`, `--session <path>`: packages/coding-agent/src/cli/args.ts
//   and flag-tables.ts, and docs/cli-reference.md.
// - No folder-trust question: omp has no per-directory trust gate
//   (extensibility/extensions/types.ts, `isProjectTrusted`).
// - The first-run setup wizard, which OMP_SKIP_SETUP turns off
//   (modes/view-model/setup/wizard.ts, docs/environment-variables.md).
// - The session file: `<timestamp>_<id>.jsonl` holding `message` entries as
//   pi's do, and `model_change` entries whose `model` is `provider/id`
//   (session/session-manager.ts, session/session-entries.ts).
import fs from 'node:fs';
import { LOCAL_HOST } from '../machine.ts';
import { piExtensionEntry } from '../pi-extension.ts';
import { lastAssistantMessage, locateSessionPath } from '../transcript.ts';
import type { ModelPair } from '../types.ts';
import { modelFlag } from './shared.ts';
import type { HarnessEntry, HerdrRequester } from './types.ts';

/**
 * The variable that turns off omp's first-run setup wizard. The wizard asks
 * the person to log in and pick a theme before the brief runs, so a child
 * started on a machine where omp has not finished its setup would sit on it.
 * The variable skips the wizard without answering any question in it.
 */
export const OMP_SKIP_SETUP = 'OMP_SKIP_SETUP';

/** Why an omp child on another machine is refused, with the issue that tracks the gap. */
const OMP_REMOTE_REFUSAL = 'an omp child runs on this machine only for now: a child on another machine gets no extra environment, so OMP_SKIP_SETUP never reaches it and omp would stop at its first-run setup wizard (elecnix/bellwether#96)';

/** The provider and model an omp session file says it starts on: its first `model_change`, as `provider/id`. */
export function ompSessionModel(file: string): ModelPair | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of content.split('\n')) {
    if (!line.includes('"model_change"')) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const model = entry['model'];
      if (entry['type'] !== 'model_change' || typeof model !== 'string') continue;
      const slash = model.indexOf('/');
      if (slash > 0 && slash < model.length - 1) return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
    } catch {
      // A line cut short by a write in progress is not the entry.
    }
  }
  return undefined;
}

/**
 * Refuse the spawn unless herdr on the child's machine has its omp
 * integration. Without it herdr reports neither the child's state nor its
 * session file, so nobody would hear the child go idle or exit.
 */
export async function requireOmpIntegration(herdr: HerdrRequester | undefined, name: string, host: string): Promise<void> {
  const where = host === LOCAL_HOST ? 'this machine' : `machine ${host}`;
  if (!herdr) throw new Error(`${name} was not started: Bellwether could not ask herdr on ${where} whether its omp integration is installed.`);
  let result: unknown;
  try {
    result = await herdr.request('integration.list', {});
  } catch (error) {
    throw new Error(`${name} was not started: herdr on ${where} did not list its integrations, so Bellwether cannot tell whether herdr would watch an omp child: ${(error as Error).message}`);
  }
  const list = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['integrations'] : undefined;
  const omp = Array.isArray(list) ? list.find((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['target'] === 'omp') : undefined;
  const state = omp ? (omp as Record<string, unknown>)['state'] : undefined;
  if (state === 'current' || state === 'outdated') return;
  throw new Error(`${name} was not started: herdr on ${where} has no omp integration, so it would report neither the child's state nor its session file. Run herdr integration install omp there, then spawn again.`);
}

export const omp: HarnessEntry = {
  kind: 'omp',
  harness: 'omp',
  label: 'omp',
  since: { protocol: 4, version: '0.1.5' },
  // omp reads an @file argument itself at startup and attaches its text, with no question about the directory.
  brief: { where: 'prompts', argument: (file) => `@${file}` },
  // omp takes the model alone, as `provider/id` or a name it matches; --provider is its legacy flag.
  chosenBy: 'flag',
  launchArgs({ model, extra = [], resume = [], files }) {
    return [
      ...modelFlag(model, extra),
      ...(files.piExtension ? ['-e', files.piExtension] : []),
      ...(files.briefFile ? [omp.brief.argument(files.briefFile)] : []),
      ...resume,
      ...extra,
    ];
  },
  async preflight({ name, host, herdr }) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: ${OMP_REMOTE_REFUSAL}. Omit machine.`);
    await requireOmpIntegration(herdr, name, host);
  },
  session: { from: 'herdr', kind: 'path' },
  reports: {
    via: 'extension',
    // omp does not read pi's settings, so the guard against an old copy in them does not apply.
    local: (_child, context) => {
      const entry = (context.piExtension ?? piExtensionEntry)();
      if (!fs.existsSync(entry)) throw new Error(`Bellwether cannot start an omp child: its pi extension ${entry} does not exist, so the child would have no Bellwether tools. Reinstall @elecnix/bellwether on this machine.`);
      return { piExtension: entry, env: { [OMP_SKIP_SETUP]: '1' } };
    },
    remoteRefusal: OMP_REMOTE_REFUSAL,
  },
  conversation: {
    // herdr's omp integration reports the session file's path; an id comes only from a session omp does not save.
    locate: (session) => (session ? locateSessionPath(session) : undefined) ?? { missing: session ? `omp reported session ${session} without a file, so it saves no transcript` : 'herdr has not reported the session yet' },
    lastMessage: (child) => (child.session && fs.existsSync(child.session.value) ? lastAssistantMessage(child.session.value) : undefined),
    modelOf: ompSessionModel,
  },
  resume: { args: (session) => ['--session', session.value], fromTranscript: (file) => ({ value: file, kind: 'path' }) },
  // herdr's omp integration reports working, idle and blocked, and counts a
  // tool approval and omp's ask tool as blocked. omp has no event for another
  // extension's dialog, so that one is read off the screen.
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list with a marked option, or a y/n question (detectModal)' }, activity: 'transcript' },
  movable: false,
};
