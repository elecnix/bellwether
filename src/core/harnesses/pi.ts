// Pi. herdr reports its session as the path of its session file. A child
// loads the Bellwether extension of the package that spawned it with -e, and
// runs on a provider and model pair, which it inherits from its parent unless
// the caller names both.
import { argValue } from '../args.ts';
import { LOCAL_HOST } from '../machine.ts';
import { piExtensionEntry, piFallback, piSavedDefault, resolvePiExtension } from '../pi-extension.ts';
import { locatePiTranscript, piSessionModel } from '../transcript.ts';
import type { ModelPair } from '../types.ts';
import { modelFlag } from './shared.ts';
import type { HarnessEntry } from './types.ts';

export const pi: HarnessEntry = {
  kind: 'pi',
  harness: 'pi',
  label: 'pi',
  // The brief arrives through the child's Bellwether extension as a message.
  brief: { where: 'prompts' },
  chosenBy: 'pair',
  launchArgs({ model, provider, extra = [], resume = [], files }) {
    return [
      // pi needs both flags. A flag the caller already put in its arguments is not repeated.
      ...(provider && argValue(extra, '--provider') === undefined ? ['--provider', provider] : []),
      ...modelFlag(model, extra),
      // A pi child loads the extension it is given, whatever the host's pi settings hold.
      ...(files.piExtension ? ['-e', files.piExtension] : []),
      ...resume,
      ...extra,
    ];
  },
  // herdr learns the session from its pi extension, which `herdr integration install pi` writes.
  session: { from: 'herdr', kind: 'path', integration: 'pi' },
  reports: {
    via: 'extension',
    // Resolved before anything else is written, so a missing extension writes nothing.
    local: (_child, context) => ({ piExtension: resolvePiExtension((context.piExtension ?? piExtensionEntry)()) }),
    remote: 'piExtension',
  },
  // The child's extension hands a parent's message to pi.sendMessage. From
  // 0.1.8 on, it does so in any session, so an adopted one takes messages too.
  inbox: {
    via: 'pi-message',
    adopted: { adapter: 'extension', why: 'predates 0.1.8 and takes no message in a session Bellwether did not start', reply: 'Its Bellwether extension predates 0.1.8 and takes no message in a session Bellwether did not start, so agent_send types into its pane until pi starts again with 0.1.8 or later.' },
  },
  conversation: { locate: (session) => locatePiTranscript(session), modelOf: piSessionModel },
  resume: { args: (session) => ['--session', session.value], fromTranscript: (file) => ({ value: file, kind: 'path' }) },
  classify: { status: 'herdr', dialogs: { from: 'extension' }, activity: 'transcript' },
  // pi 1.6 prints `Error: No API key found for <provider>.` for a provider it
  // has no key for, then waits at its prompt without taking the brief.
  startupFatal: /^\s*Error: \S/,
  movable: true,
  // With no pair from the caller or the parent, the spawn passes pi's saved
  // default, so the child never lands on the first entry of enabledModels by accident (issue #189).
  savedPair: (cwd) => piSavedDefault(cwd),
  /**
   * Which provider account and model a pi child runs on, since the account is
   * what pays. With no pair passed and no session file yet, it names the
   * default pi's settings point to, where they set it, and that the pair is
   * unverified.
   */
  modelNote(child) {
    const model = child.model;
    const on = (pair: ModelPair): string => `provider account ${pair.provider}, model ${pair.id}`;
    if (model?.source === 'caller') return `${child.name} runs on ${on(model)}, as the spawn named.`;
    if (model?.source === 'parent') return `${child.name} runs on ${on(model)}, the same account and model as this session.`;
    if (model?.source === 'saved') {
      const where = model.setting ? `, defaultProvider and defaultModel in ${model.setting}` : '';
      const instead = model.over ? ` Without those flags pi would have started it on ${model.over}.` : '';
      return `This session did not say which provider and model it runs on, so Bellwether passed pi's saved default${where}: ${child.name} runs on ${on(model)}.${instead}`;
    }
    const head = 'This session did not say which provider and model it runs on, so Bellwether passed none.';
    if (model) return `${head} ${child.name} runs on ${on(model)}, pi's own default, read from its session file.`;
    const tail = 'This is unverified until pi writes its session file, and agent_list shows the pair pi chose once it does.';
    if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST) return `${head} ${child.name} starts on pi's own default on machine ${child.host}, set in that machine's ~/.pi/agent/settings.json, which Bellwether cannot read from here. The pair is unverified, and its session file stays on that machine.`;
    const fallback = piFallback(child.cwd);
    const target = fallback.provider && fallback.id ? on({ provider: fallback.provider, id: fallback.id }) : undefined;
    return `${head} ${child.name} starts on pi's own default${target ? `, ${target}` : ''}: ${fallback.reason}. ${tail}`;
  },
};
