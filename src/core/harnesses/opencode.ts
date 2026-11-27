// OpenCode 2. herdr reports no session for it, so the spawn mints the session
// id, passes it with --session, and finds the session in OpenCode's SQLite
// store by that id, the child's directory and the brief line. The child's
// private server (--standalone) reads its own configuration, named in
// OPENCODE_CONFIG, which lists the child's Bellwether server, and the store
// named in OPENCODE_DB. src/core/opencode.ts holds the store and version code.
import { LOCAL_HOST } from '../machine.ts';
import { findOpenCodeSession, newOpenCodeSessionId, openCodeArgs, openCodeBriefLine, openCodeDbPath, openCodeLastMessage, openCodeSessionState, probeOpenCode, requireOpenCodeV2, writeOpenCodeMcpConfig } from '../opencode.ts';
import { briefSentence, noTranscript } from './shared.ts';
import type { HarnessEntry } from './types.ts';

export const opencode: HarnessEntry = {
  kind: 'opencode',
  harness: 'opencode',
  label: 'OpenCode',
  // An older daemon lists opencode as a kind but starts it with a sentence
  // that OpenCode 2 reads as a directory, so the child never gets its brief.
  since: { protocol: 4, version: '0.1.5' },
  // OpenCode reads outside its directory only after a question, and a
  // question at startup is the interruption the brief exists to avoid.
  brief: { where: 'workdir', launch: briefSentence },
  // The terminal UI takes no --model: the model rides in the child's
  // configuration file, as provider/model.
  chosenBy: 'config',
  launchArgs: ({ session, files, extra = [] }) => (session ? openCodeArgs(session.value, files.briefFile, extra) : extra),
  /**
   * A child on another machine is not supported yet: its store and version
   * sit on that machine. The brief goes in the working directory, which the
   * spawn needs. The terminal UI takes a model only from configuration.
   */
  async preflight({ name, cwd, model, host }, hooks) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: an opencode child runs on this machine only for now, because its store and its version are read where it runs. Omit machine.`);
    if (!cwd) throw new Error(`${name} was not started: an opencode child needs cwd, because OpenCode asks before it reads a file outside its directory, and the brief goes inside it.`);
    if (model && !/^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(model)) throw new Error(`${name} was not started: OpenCode 2 takes a model as provider/model, optionally with #variant, and "${model}" is not one.`);
    requireOpenCodeV2(await (hooks.probe ?? (() => probeOpenCode()))(), name);
  },
  session: {
    from: 'store',
    storePath: (hooks) => hooks.store ?? openCodeDbPath(),
    mint: () => newOpenCodeSessionId(),
    async confirm({ store, session, cwd, briefFile }, hooks) {
      if (!session) throw new Error('the spawn minted no OpenCode session id');
      return (await findOpenCodeSession({ db: store, sessionId: session, cwd, prompt: openCodeBriefLine(briefFile), waitMs: hooks.waitMs, intervalMs: hooks.intervalMs })).id;
    },
  },
  reports: {
    via: 'harness-config',
    // The child's private server reads its own configuration and the store.
    local: (child, { env, model }) => ({
      env: { OPENCODE_CONFIG: writeOpenCodeMcpConfig(child.id, { ...env }, model), ...(child.store ? { OPENCODE_DB: child.store } : {}) },
    }),
    remoteRefusal: 'an opencode child runs on this machine only for now, because its store and its version are read where it runs',
  },
  // OpenCode has no inbound path: it loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session, so a parent's message is typed into its pane.
  inbox: { via: 'none', reason: 'OpenCode loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session' },
  conversation: {
    locate: noTranscript('OpenCode'),
    lastMessage: (child) => (child.store && child.session && (child.host ?? LOCAL_HOST) === LOCAL_HOST ? openCodeLastMessage(child.store, child.session.value) : undefined),
    pending(child) {
      if (!child.store || !child.session) return { note: `${child.name} has no OpenCode session on its record, so there is no store to read.`, withScreen: true };
      const state = child.store && child.session ? openCodeSessionState(child.store, child.session.value) : undefined;
      if (state && !child.exitedAt) {
        return { note: `OpenCode's store at ${child.store} holds no answer from session ${child.session?.value} yet; it is ${state.busy ? 'mid-turn' : `idle${state.outcome ? ` after a turn that ${state.outcome}` : ''}`}.`, withScreen: true };
      }
      return { note: `OpenCode's store at ${child.store} holds no answer from session ${child.session?.value}${state ? '' : ', and no such session'}.`, withScreen: false };
    },
    // A session's row changes with each step it takes, and the store says so without a screen read.
    activity: (child) => (child.store && child.session && (child.host ?? LOCAL_HOST) === LOCAL_HOST ? openCodeSessionState(child.store, child.session.value)?.updatedAt : undefined),
  },
  // OpenCode keeps a pending permission or question in memory, not in its
  // store, so a dialog is read off the screen.
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'a selection list with a marked option, or a y/n question (detectModal)' }, activity: 'store' },
  movable: false,
};
