// Cline, declared but not built. herdr detects it and Bellwether adopts it, but
// a spawn does not yet give a cline child its own Bellwether server, so the
// child could not call parent_report, and the spawn refuses it. herdr reports
// no agent_session for Cline, so the entry that builds it also needs a lookup
// in Cline's own store.
import { modelFlag, briefSentence, noTranscript } from './shared.ts';
import type { HarnessEntry } from './types.ts';

export const cline: HarnessEntry = {
  kind: 'cline',
  harness: 'cline',
  label: 'Cline',
  brief: { where: 'prompts', argument: briefSentence },
  chosenBy: 'flag',
  launchArgs: ({ model, extra = [], files }) => [...modelFlag(model, extra), ...(files.briefFile ? [briefSentence(files.briefFile)] : []), ...extra],
  session: { from: 'herdr', kind: 'id' },
  reports: { via: 'none', reason: 'Bellwether does not give a cline child its own Bellwether server yet, so the child could not call parent_report' },
  conversation: { locate: noTranscript('Cline') },
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list with a marked option, or a y/n question (detectModal)' }, activity: 'screen' },
  movable: false,
};
