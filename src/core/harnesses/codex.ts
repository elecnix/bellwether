// Codex, declared but not built. herdr detects it and Bellwether adopts it, but
// a spawn does not yet give a codex child its own Bellwether server, so the
// child could not call parent_report, and the spawn refuses it. herdr reports
// no agent_session for Codex, so the entry that builds it also needs a lookup
// in Codex's own store.
import { modelFlag, briefSentence, noTranscript } from './shared.ts';
import type { HarnessEntry } from './types.ts';

export const codex: HarnessEntry = {
  kind: 'codex',
  harness: 'codex',
  label: 'Codex',
  brief: { where: 'prompts', argument: briefSentence },
  chosenBy: 'flag',
  launchArgs: ({ model, extra = [], files }) => [...modelFlag(model, extra), ...(files.briefFile ? [briefSentence(files.briefFile)] : []), ...extra],
  session: { from: 'herdr', kind: 'id' },
  reports: { via: 'none', reason: 'Bellwether does not give a codex child its own Bellwether server yet, so the child could not call parent_report' },
  conversation: { locate: noTranscript('Codex') },
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list with a marked option, or a y/n question (detectModal)' }, activity: 'screen' },
  movable: false,
};
