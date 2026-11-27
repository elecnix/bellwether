// A fourth harness, defined here and nowhere in src/: `fake-agent`. Its whole
// definition is this registry entry, so a test that spawns it, reads its
// conversation, resumes it and checks its feature shows that a harness needs
// nothing beyond its entry. Tests that need some spawnable harness with no
// dialogs and no extension use it too, now that codex and cline refuse.
import fs from 'node:fs';
import { harnessFor, registerHarness, type HarnessEntry } from '../../src/core/harnesses/index.ts';
import { writeMcpConfig } from '../../src/core/mcp-config.ts';
import { lastAssistantMessage, locateSessionPath } from '../../src/core/transcript.ts';

export const FAKE_KIND = 'fake-agent';

const sentence = (file: string): string => `Your task is in ${file}. Read it, then do what it says.`;

export const fakeHarness: HarnessEntry = {
  kind: FAKE_KIND,
  harness: 'fake-agent',
  label: 'Fake Agent',
  since: { protocol: 4, version: '0.1.5' },
  brief: { where: 'prompts', argument: sentence },
  chosenBy: 'flag',
  launchArgs: ({ model, extra = [], resume = [], files }) => [
    ...(model ? ['--model', model] : []),
    ...(files.mcpConfigFile ? [`--mcp-config=${files.mcpConfigFile}`] : []),
    ...(files.briefFile ? [sentence(files.briefFile)] : []),
    ...resume,
    ...extra,
  ],
  session: { from: 'herdr', kind: 'path' },
  reports: {
    via: 'mcp-config',
    local: (child) => ({ mcpConfigFile: writeMcpConfig(child.id) }),
    remote: 'mcpConfig',
  },
  inbox: { via: 'none', reason: 'fake-agent is a test harness with no inbound path' },
  conversation: {
    locate: (session) => (session ? locateSessionPath(session) : undefined) ?? { missing: 'fake-agent names its session file as its session' },
    // The transcript is the session file, in the JSONL form Claude Code and pi share.
    lastMessage: (child) => (child.session && fs.existsSync(child.session.value) ? lastAssistantMessage(child.session.value) : undefined),
  },
  resume: { args: (session) => ['--resume-from', session.value] },
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'detectModal' }, activity: 'transcript' },
  movable: false,
};

/** Register the fake harness for this test process. Idempotent, so any number of test modules may import it. */
export function useFakeHarness(): void {
  if (!harnessFor(FAKE_KIND)) registerHarness(fakeHarness);
}

useFakeHarness();
