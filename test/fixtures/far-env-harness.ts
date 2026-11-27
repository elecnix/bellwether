// A harness entry whose tab needs environment, for the relay cases: `env-agent`.
// A test loads this file in its own process, and the fake ssh loads it in the
// child machine's `bellwether` with NODE_OPTIONS, so both ends know the kind,
// as both ends know a real one from the same release.
//
// Its entry returns four variables. One the harness needs, one that names a
// key file by its path, one that only means something on the machine that
// computed it, and one under a home directory no machine in the tests has.
import path from 'node:path';
import { harnessFor, registerHarness, type HarnessEntry } from '../../src/core/harnesses/index.ts';
import { writeMcpConfig } from '../../src/core/mcp-config.ts';

export const ENV_KIND = 'env-agent';
/** The file this fixture loads, for a NODE_OPTIONS that registers it on a fake machine. */
export const ENV_HARNESS_FILE = import.meta.filename;
/** The variable the harness cannot start without. */
export const READY = 'ENV_AGENT_READY';
/** The variable that names a key file, inside the child's working directory. */
export const KEY_FILE = 'ENV_AGENT_KEY_FILE';
/** A home directory that no test machine has. */
export const ABSENT_HOME = '/home/example-absent-user';

export const envHarness: HarnessEntry = {
  kind: ENV_KIND,
  harness: 'env-agent',
  label: 'Env Agent',
  since: { protocol: 4, version: '0.1.5' },
  brief: { where: 'prompts' },
  chosenBy: 'flag',
  launchArgs: ({ extra = [], resume = [], files }) => [...(files.mcpConfigFile ? [`--mcp-config=${files.mcpConfigFile}`] : []), ...resume, ...extra],
  session: { from: 'herdr', kind: 'path' },
  reports: {
    via: 'mcp-config',
    local: (child) => ({
      mcpConfigFile: writeMcpConfig(child.id),
      env: {
        [READY]: '1',
        ...(child.cwd ? { [KEY_FILE]: path.join(child.cwd, 'example-key') } : {}),
        HERDR_SOCKET_PATH: '/tmp/example-herdr.sock',
        ENV_AGENT_STATE: `${ABSENT_HOME}/.env-agent`,
      },
    }),
    remote: 'mcpConfig',
    remoteEnv: [READY],
  },
  inbox: { via: 'none', reason: 'env-agent is a test harness with no inbound path' },
  conversation: { locate: () => ({ missing: 'env-agent keeps no transcript' }) },
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'detectModal' }, activity: 'transcript' },
  movable: false,
};

if (!harnessFor(ENV_KIND)) registerHarness(envHarness);
