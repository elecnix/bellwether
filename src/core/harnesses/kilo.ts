// Kilo CLI 7. herdr detects it as the `kilo` kind and reads its status from
// the screen, or from herdr's own kilo integration when the operator installed
// it. herdr reports a session only through that integration, so the spawn
// finds the session in kilo's store instead. The child's Bellwether server
// comes from the file that KILO_CONFIG names, and its store from KILO_DB.
// kilo-store.ts holds the store and version code and the facts behind them.
import { LOCAL_HOST } from '../machine.ts';
import { briefSentence, modelFlag, noTranscript } from './shared.ts';
import { findKiloSession, kiloBriefLine, kiloDbPath, kiloLastMessage, kiloSessionState, probeKilo, requireKilo, writeKiloMcpConfig } from './kilo-store.ts';
import type { HarnessEntry } from './types.ts';
import type { ChildRecord } from '../types.ts';

/** The store a child's record names, or kilo's own default for a record that names none. */
function storeOf(child: Pick<ChildRecord, 'store' | 'host'>): string | undefined {
  if ((child.host ?? LOCAL_HOST) !== LOCAL_HOST) return undefined;
  return child.store ?? kiloDbPath();
}

export const kilo: HarnessEntry = {
  kind: 'kilo',
  harness: 'kilo',
  label: 'Kilo',
  // An older daemon does not know the kind, so a client refuses it by name.
  since: { protocol: 4, version: '0.1.5' },
  // kilo asks before it reads a file outside its directory, and a question at
  // startup is the interruption the brief exists to avoid.
  brief: { where: 'workdir', argument: briefSentence },
  // The terminal UI takes --model as provider/model.
  chosenBy: 'flag',
  launchArgs: ({ model, files, resume = [], extra = [] }) => [...modelFlag(model, extra), ...resume, ...(files.briefFile ? ['--prompt', kiloBriefLine(files.briefFile)] : []), ...extra],
  /**
   * A child on another machine is not supported yet: its store and version
   * sit on that machine. The brief goes in the working directory, which the
   * spawn needs. herdr must be able to detect the binary.
   */
  async preflight({ name, cwd, model, host }, hooks) {
    if (host !== LOCAL_HOST) throw new Error(`${name} was not started: a kilo child runs on this machine only for now, because its store and its version are read where it runs. Omit machine.`);
    if (!cwd) throw new Error(`${name} was not started: a kilo child needs cwd, because kilo asks before it reads a file outside its directory, and the brief goes inside it.`);
    if (model && !/^[^/]+\/.+$/.test(model)) throw new Error(`${name} was not started: kilo takes a model as provider/model, and "${model}" is not one.`);
    requireKilo(await (hooks.probe ?? (() => probeKilo()))(), name);
  },
  session: {
    from: 'store',
    storePath: (hooks) => hooks.store ?? kiloDbPath(),
    // No mint: kilo refuses a --session id that does not exist yet.
    async confirm({ store, cwd, briefFile, since }, hooks) {
      return findKiloSession({ db: store, cwd, prompt: kiloBriefLine(briefFile), since: Date.parse(since), waitMs: hooks.waitMs, intervalMs: hooks.intervalMs });
    },
  },
  reports: {
    via: 'harness-config',
    // The child reads its own configuration over the global one, and the store this daemon reads.
    local: (child, { env }) => ({
      env: { KILO_CONFIG: writeKiloMcpConfig(child.id, { ...env }), ...(child.store ? { KILO_DB: child.store } : {}) },
    }),
    remoteRefusal: 'a kilo child runs on this machine only for now, because its store and its version are read where it runs',
  },
  // Kilo has no inbound path: it loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session, so a parent's message is typed into its pane.
  inbox: { via: 'none', reason: 'Kilo loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session' },
  conversation: {
    locate: noTranscript('Kilo'),
    lastMessage(child) {
      const store = storeOf(child);
      return store && child.session ? kiloLastMessage(store, child.session.value) : undefined;
    },
    pending(child) {
      const store = storeOf(child);
      if (!store || !child.session) return { note: `${child.name} has no kilo session on its record, so there is no store to read.`, withScreen: true };
      const state = kiloSessionState(store, child.session.value);
      if (state && !child.exitedAt) return { note: `Kilo's store at ${store} holds no answer from session ${child.session.value} yet; it is ${state.busy ? 'mid-turn' : 'idle'}.`, withScreen: true };
      return { note: `Kilo's store at ${store} holds no answer from session ${child.session.value}${state ? '' : ', and no such session'}.`, withScreen: false };
    },
    // Each step writes a part, and the store says so without a screen read.
    activity(child) {
      const store = storeOf(child);
      return store && child.session ? kiloSessionState(store, child.session.value)?.updatedAt : undefined;
    },
  },
  // `kilo --session <id>` reopens a session that exists.
  resume: { args: (session) => ['--session', session.value] },
  // herdr's own rule for kilo reads "Permission required" on the screen as
  // blocked. kilo keeps a pending permission in memory, not in its store, and
  // detectModal does not name its row of buttons.
  classify: { status: 'herdr', dialogs: { from: 'screen', marker: 'herdr\'s kilo rule: "Permission required" on screen reads as blocked' }, activity: 'store' },
  movable: false,
};
