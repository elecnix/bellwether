// What Bellwether knows about one harness, as data. The spawn, the resume and
// restart, the watcher, agent_read and the remote registration read a
// harness's entry instead of branching on its kind, so adding a harness means
// writing its entry and naming it in the registry (`index.ts`).
import type { StartupDialogSet } from '../startup-dialogs.ts';
import type { ToolSource } from '../tool-source.ts';
import type { TranscriptLookup } from '../transcript.ts';
import type { ChildRecord, ChildSession, ModelPair } from '../types.ts';

/** A harness session, as herdr names it: an id, or the path of its file. */
export interface HarnessSession {
  value: string;
  kind: 'id' | 'path';
}

/** What a version check found for a harness's executable on this machine. */
export type VersionProbe =
  | { version: string; binary: string; missing?: undefined; unreadable?: undefined }
  | { missing: string; version?: undefined; unreadable?: undefined }
  | { unreadable: string; binary: string; version?: undefined; missing?: undefined };

/**
 * What a test or a lab swaps in for a harness that keeps its session in a
 * store of its own: the version check, the store's path, and how long the
 * spawn waits for the store to show the session.
 */
export interface HarnessHooks {
  probe?: () => Promise<VersionProbe>;
  store?: string;
  waitMs?: number;
  intervalMs?: number;
}

/** The files and settings a child starts with, written before its tab opens. */
export interface ChildFiles {
  /** The brief's path on the child's machine. */
  briefFile?: string;
  /** A per-child MCP configuration the harness takes on its command line. */
  mcpConfigFile?: string;
  /** A Claude Code child's own settings file. */
  claudeSettingsFile?: string;
  /** Which server gives the child its Bellwether tools, for its record. */
  toolSource?: ToolSource;
  /** The Bellwether extension a pi-style child loads, on its own machine. */
  piExtension?: string;
  /** Variables the child's tab carries beyond Bellwether's own. */
  env?: Record<string, string>;
}

/** What a harness's launch line is built from. */
export interface LaunchInput {
  /** The model the harness itself takes, on a bare start. On a route the tier goes to the launcher instead. */
  model?: string;
  /** The provider, for a harness that takes the model as a pair. */
  provider?: string;
  /** The caller's own extra arguments, which go last. */
  extra?: string[];
  /** The session the spawn named, for a harness whose session the spawn picks. */
  session?: ChildSession;
  /** The arguments that reopen a session, on a resume or restart. */
  resume?: string[];
  files: ChildFiles;
}

/** What a spawn knows when it checks a harness before writing anything. */
export interface PreflightInput {
  name: string;
  cwd?: string;
  /** The model the harness itself gets. */
  model?: string;
  host: string;
}

/** What a harness's tool files are written from. */
export interface LocalContext {
  /** The Bellwether variables the child's tab carries, which a harness-run server needs too. */
  env: Record<string, string>;
  /** The model the harness itself gets. */
  model?: string;
  /** Where this package's pi extension is. Tests point it at a missing file. */
  piExtension?: () => string;
  /**
   * Set by `bellwether relay-register`, which writes the files on the child's
   * machine for a parent on another one. A hook that talks to this machine's
   * daemon is left out there, because the child's record lives in the
   * parent's daemon.
   */
  farEnd?: boolean;
}

/**
 * How a child of this harness calls parent_report: through a per-child
 * server or extension that carries its child id, or not at all. A harness
 * that cannot take one is declared here with the reason, and the spawn
 * refuses it, because nobody would hear the child.
 */
export type ReportPath =
  | {
      via: 'mcp-config' | 'extension' | 'harness-config';
      /** Write the files that give a child on this machine its tools. */
      local(child: Pick<ChildRecord, 'id' | 'cwd' | 'host' | 'store'>, context: LocalContext): ChildFiles;
      /**
       * What `bellwether relay-register` on another machine must hand back for
       * the child to report from there. Without it, a child on another machine
       * is refused before anything is written.
       */
      remote?: 'mcpConfig' | 'piExtension';
      /** Why a child on another machine is refused, when `remote` is absent. */
      remoteRefusal?: string;
    }
  | { via: 'none'; reason: string };

/** Where a child's session id comes from. */
export type SessionSource =
  /** herdr's agent_session for the pane, as an id or a path. */
  | { from: 'herdr'; kind: 'id' | 'path' }
  /**
   * The harness's own store, by a session id the spawn picks and passes on
   * the launch line. herdr reports no agent_session for such a harness.
   */
  | {
      from: 'store';
      /** The store's path on this machine, as the harness itself resolves it. */
      storePath(hooks: HarnessHooks): string;
      /** A new session id in the harness's own form. */
      mint(): string;
      /** Wait until the store shows the session with the brief line, or throw naming the store. */
      confirm(input: { store: string; session: string; cwd: string; briefFile: string }, hooks: HarnessHooks): Promise<void>;
    };

/** How Bellwether reads what a child said, and whether it moved. */
export interface Conversation {
  /** Where the transcript of a session is, or why there is none. */
  locate(session: string | undefined, cwd: string | undefined): TranscriptLookup;
  /** The child's last answer, read from its store, for a harness whose conversation is not a transcript file. */
  lastMessage?(child: ChildRecord): string | undefined;
  /** What agent_read says when the store holds no answer yet: a note, and whether the screen should follow it. */
  pending?(child: ChildRecord): { note: string; withScreen: boolean };
  /** A stamp that grows each time the child takes a step, read from its store, or undefined when the store has no such session. */
  activity?(child: ChildRecord): number | undefined;
  /** The provider and model a session file says the child runs on. */
  modelOf?(file: string): ModelPair | undefined;
}

/**
 * Which of a child's states Bellwether reads from an API, and which from its
 * screen. herdr's status covers working, idle, blocked and done for every
 * kind herdr detects. A dialog that herdr reports as idle is named by the
 * harness itself when it can, and otherwise read off the screen by
 * `detectModal`, whose marker is a selection list or a y/n question.
 */
export interface Classification {
  status: 'herdr';
  dialogs: { from: 'extension' | 'hook' } | { from: 'screen'; marker: string };
  activity: 'transcript' | 'store' | 'screen';
}

export interface HarnessEntry {
  /** herdr's agent kind, which agent_spawn takes. */
  kind: string;
  /** The name a child record and a parent's hello carry. */
  harness: string;
  /** The harness's name for a person. */
  label: string;
  /**
   * The first release whose daemon starts this kind as this entry says. A
   * client checks it as the argument `agent_spawn.kind=<kind>`, so an older
   * daemon is refused by name instead of starting a child nobody hears.
   */
  since?: { protocol: number; version: string };
  /** The one argument that hands the brief to the harness, and where the brief file goes. */
  brief: { where: 'prompts' | 'workdir'; argument(file: string): string };
  /** The arguments after the executable. */
  launchArgs(input: LaunchInput): string[];
  /**
   * How the harness is told which model to run: `flag` passes `--model`, `pair` needs a
   * provider and a model together, `config` writes it into the harness's
   * configuration.
   */
  chosenBy: 'flag' | 'pair' | 'config';
  /** Refuse a spawn that cannot work, before the record is written. */
  preflight?(input: PreflightInput, hooks: HarnessHooks): Promise<void>;
  session: SessionSource;
  reports: ReportPath;
  conversation: Conversation;
  /** How the harness reopens a session. Absent for a harness Bellwether cannot resume. */
  resume?: {
    args(session: HarnessSession): string[];
    /** The session a transcript path names, for a record written before Bellwether kept the session. */
    fromTranscript?(file: string): HarnessSession;
  };
  /** The startup dialogs a spawn answers for the person, which no API reaches. */
  startup?: StartupDialogSet;
  classify: Classification;
  /** Whether agent_move can copy and resume this harness's session on another machine. */
  movable: boolean;
  /** A line for the spawn reply about which model the child runs on. */
  modelNote?(child: Pick<ChildRecord, 'name' | 'kind' | 'model' | 'host' | 'cwd'>): string | undefined;
}
