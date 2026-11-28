// What each daemon serves, and since when. A client never refuses a daemon on
// its version alone: it tries, and only when the daemon answers that it lacks
// something does this table turn the refusal into a message that names the
// operation and the release that brought it. `bellwether doctor` reads the
// same table to say what a pairing of client and daemon loses.
//
// Each entry records the first release that served it, found with
// `git log -S` on the request's parser or the tool's definition and checked
// against the release commits with `git merge-base --is-ancestor`. A daemon
// from 0.1.5 on lists what it serves in its hello, which this table only
// stands in for when a daemon is older than that.

import { harnesses } from '../core/harnesses/index.ts';
import type { HarnessEntry } from '../core/harnesses/types.ts';

export interface Feature {
  name: string;
  /**
   * A tool a model calls, a request on the wire, a notice an adapter sends as
   * a call that no model sees, or an argument of a tool, named `tool.argument`.
   * An older daemon ignores an argument it does not know rather than refusing
   * it, so the client checks an argument before it sends the call.
   */
  kind: 'tool' | 'request' | 'notice' | 'argument';
  /** The first protocol whose daemons serve it. */
  protocol: number;
  /** The first release that served it. */
  version: string;
  /**
   * One sentence for a person reading the release notes: what the feature
   * lets someone do. The release pull request lists it under its version,
   * so it passes the same Vale rules as the docs.
   */
  summary: string;
  /**
   * The pull requests that brought it. The release script stops on a pull
   * request merged since the last release that no entry names, so a feature
   * from 0.1.8 on names its own.
   */
  prs?: readonly number[];
}

/** The features one release brought on one protocol, each name with its summary. */
function brought(kind: Feature['kind'], protocol: number, version: string, summaries: Record<string, string>, prs?: readonly number[]): Feature[] {
  return Object.entries(summaries).map(([name, summary]) => ({ name, kind, protocol, version, summary, ...(prs ? { prs } : {}) }));
}

const BASE: readonly Feature[] = [
  // In 0.1.3 or earlier, on protocol 2, the oldest a daemon serves.
  ...brought('request', 2, '0.1.3', {
    hello: 'A session connects to the daemon and receives its protocol number.',
    call: 'A session calls a tool through the daemon.',
    receipt: 'An adapter marks an event read once it reaches the parent.',
    bye: 'A session leaves the daemon.',
    drain: 'The daemon stops taking connections and exits once its calls in flight answer.',
    watch: 'A session follows the status of one pane, such as its own.',
  }),
  ...brought('tool', 2, '0.1.3', {
    agent_spawn: 'A parent starts a child agent in a herdr tab.',
    agent_adopt: 'A parent takes on an agent that already runs as its child.',
    agent_list: 'A parent lists its children and their states.',
    agent_read: 'A parent reads what a child shows or wrote.',
    agent_send: 'A parent sends a message to a child.',
    agent_stop: 'A parent stops a child.',
    parent_report: 'A child reports to its parent.',
    request_retirement: 'A child asks the daemon to retire it once its pane exits.',
  }),
  // 0.1.4, protocol 3: `bellwether report` posts without a session.
  ...brought('request', 3, '0.1.4', {
    report: '`bellwether report` posts a report without a session.',
  }),
  // 0.1.5, protocol 4: the relay turned round, and doctor lists sessions.
  ...brought('request', 4, '0.1.5', {
    'relay-subscribe': "A parent's daemon collects the reports waiting on another machine.",
    'relay-ack': "A parent's daemon acknowledges a report, so the other machine deletes its copy.",
    'relay-read': "A parent's daemon reads a child on another machine over the open connection.",
    'relay-status': '`bellwether doctor` shows the state of each relay connection.',
    sessions: '`bellwether doctor` lists the sessions connected to the daemon.',
  }),
  ...brought('tool', 4, '0.1.5', {
    agent_restart: 'A parent restarts a child, or a session restarts itself, under the same child id.',
    agent_move: "A parent moves a child's session to another machine.",
    // A child at its depth ceiling asks for more, and a parent grants or refuses.
    agent_request_depth: 'A child that reached its depth ceiling requests a higher one.',
    agent_grant_depth: 'A parent grants or refuses a request for more depth.',
  }),
  // A pi child's extension reports an open dialog; an older daemon refuses it, and the extension ignores the refusal.
  ...brought('notice', 4, '0.1.5', {
    child_prompt: "A pi child's extension reports an open dialog.",
  }),
  // A Claude Code child's Notification hook names its source. An older daemon
  // would record the dialog as pi's, which only pi's own closing notice clears.
  ...brought('argument', 4, '0.1.5', {
    'child_prompt.source': "A Claude Code child's Notification hook names the harness whose dialog is open.",
  }),
  // An older daemon would start the child in the parent's workspace and say nothing.
  ...brought('argument', 4, '0.1.5', {
    'agent_spawn.workspace': 'A spawn starts the child in a named workspace, or in a new one.',
    'agent_spawn.workspace_label': 'A spawn sets the label of the workspace it creates.',
  }),
  // An older daemon would start the child bare, off the route it was asked for, and say nothing.
  ...brought('argument', 4, '0.1.5', {
    'agent_spawn.via': 'A spawn starts the child through a route from the routes file.',
    'agent_spawn.key_file': "A spawn passes a key file to the route, and the record keeps only the file's path.",
    'agent_restart.via': 'A restart starts the child again through a route from the routes file.',
    'agent_restart.model': 'A restart starts the child again on another model.',
    'agent_restart.key_file': 'A restart passes a key file to the route.',
    'agent_restart.provider': 'A restart starts the child again on another provider.',
  }),
  // 0.1.6: another program asks for the agent tree instead of reading the registry files.
  ...brought('request', 4, '0.1.6', {
    ancestry: "`bellwether ancestry <agent> --json` answers an agent's tree from the daemon, so another program no longer reads the registry files.",
  }),
  // After 0.1.5: a parent's daemon adopts a pane on another machine and asks that machine who watches it.
  ...brought('request', 4, '0.1.6', {
    'relay-adopt': "`agent_adopt` takes a pane on another machine, and that machine's daemon answers who already watches it.",
  }),
  // An older daemon would start the child without the paths, and its read of them would be asked about.
  ...brought('argument', 4, '0.1.7', {
    'agent_spawn.reads': "A spawn adds paths to the child's read set, which its launch settings list.",
    'agent_restart.reads': "A restart replaces the paths in the child's read set.",
  }, [150]),
  // A child's adapter acknowledges a parent's message that entered its session, rather than its pane.
  ...brought('request', 4, '0.1.7', {
    'message-ack': "A parent's message enters a Claude Code, pi or omp child's session, where herdr used to type it into the pane, and the child's adapter acknowledges it.",
  }, [136]),
  // A far daemon that predates it answers unknown_type, and the parent types the message.
  ...brought('request', 4, '0.1.7', {
    'relay-message': "The daemon on a child's machine puts a parent's message in that child's session, where herdr used to type it into the far pane.",
  }, [144]),
];

/**
 * A change in what a release does that adds nothing to the wire: a person
 * would want to read about it, and no client negotiates it. It sits apart from
 * FEATURES, which feeds the hello, `serves` and doctor, because a behavior has
 * no name an older daemon could refuse and no protocol a client could compare.
 */
export interface Behavior {
  /** The first release that behaves this way. */
  version: string;
  /** The pull requests that brought it, which the release script matches against what merged. */
  prs: readonly number[];
  /**
   * One sentence for a person reading the release notes: what someone can now
   * do, or what now happens. The release pull request lists it under its
   * version, ahead of the protocol, so it passes the same Vale rules as the docs.
   */
  summary: string;
}

/**
 * Every change in behavior since 0.1.7, oldest first. A pull request that
 * changes nothing a person would read about, such as a test, a typo or a
 * dependency bump, carries the `release-note: none` label instead.
 */
export const BEHAVIORS: readonly Behavior[] = [
  { version: '0.1.7', prs: [137], summary: 'A resume that brings a prompt keeps the brief a child never read, and puts that brief ahead of the prompt.' },
  { version: '0.1.7', prs: [147], summary: "A bare child starts behind `command`, so a shell function or alias of the harness's name no longer changes its launch, and the spawn answers Claude Code's channel question by its digit." },
  { version: '0.1.7', prs: [148], summary: "A pi child that exits or stops on a fatal error at startup fails its spawn, and the error quotes pi's own line." },
  { version: '0.1.7', prs: [151], summary: 'Retirement removes a child\'s worktree once its tab closes, and `agent_stop` retires the child it closes.' },
  { version: '0.1.7', prs: [152], summary: 'An adopted session that runs a Bellwether adapter gains `parent_report` over the daemon connection it opened at its start.' },
  { version: '0.1.7', prs: [153, 154], summary: "An alert can end with one line that counts the parent's other live children by state, sent only when it changed and at most once in 10 minutes." },
  { version: '0.1.8', prs: [158], summary: 'A suggestion that a harness draws faint in its input box no longer reads as typed text: `agent_read` and `idle` events leave it out and say whether the box holds a suggestion, a draft or nothing.' },
  { version: '0.1.8', prs: [161], summary: 'A dialog that dims the options it has not selected counts as a dialog again, so the parent hears `blocked` rather than `idle`, and the startup answerer can select a dimmed accepting option.' },
  { version: '0.1.8', prs: [163], summary: "The spawn reads a startup dialog's options from the block under the dialog's own line, so a shell prompt that starts with `❯` above it never passes for the selected option." },
  { version: '0.1.8', prs: [170], summary: "A claude, pi or omp child takes its brief as a message in its session once its startup dialogs close, and the spawn waits for the adapter's acknowledgement. The pane shows the task rather than a path. A harness that exits first fails the spawn with its line, and the record says whether the session took the brief or herdr typed it, with the reason." },
  { version: '0.1.8', prs: [172], summary: "A parent's message to an adopted pi session enters the session through the extension it loaded, and the adoption's reply and a typed message's reason name each case where an adopted session takes no message." },
  { version: '0.1.8', prs: [171], summary: 'A refusal for a missing session gives the `herdr integration install` command when herdr on the child\'s machine lacks the integration, and `agent_spawn` warns.' },
  { version: '0.1.9', prs: [177], summary: "Doctor reads pi's models only from the model table. When pi has no provider, doctor says pi doesn't offer a pair, and other output makes the models unknown." },
  { version: '0.1.9', prs: [178], summary: 'Doctor gives each SSH call of its move check 6 s, and reports a machine that does not answer in time as unknown.' },
  { version: '0.1.9', prs: [179], summary: "Doctor's move line for each machine says whether herdr there has its claude and pi integrations, with the install command for a missing one." },
  { version: '0.1.9', prs: [181], summary: "A spawn counts a brief taken once the child's model begins a turn on it or reads it, rather than when its adapter receives it. It sends the brief once more when the model doesn't begin a turn, and fails with `BriefNotTaken` when the second copy doesn't start one either." },
  { version: '0.1.9', prs: [192], summary: "The new tab of a restart opens before the old pane closes, so a session alone in its herdr workspace comes back in that workspace, or in a new one under the old label once herdr has closed it. When the start fails after the close, the record keeps `restartFailed`, a child's parent receives an `exited` event, and doctor prints the session and its last pane." },
  { version: '0.1.9', prs: [196], summary: "A session's restart of itself waits at most 5 minutes for its turn to end. The daemon keeps the session's own events unread while it waits, so they don't start another turn, and the new session receives them. A second call and doctor report the pane, the status herdr gives for it and the events held. A wait that runs out closes nothing and records the cause as `restartStalled`." },
];

/**
 * One argument per harness kind whose registry entry names the release that
 * first starts it as the entry says, `agent_spawn.kind=<kind>`. An older
 * daemon would start such a child the old way or not at all, so the client
 * refuses the kind by name instead.
 */
export function kindFeatures(entries: readonly HarnessEntry[] = harnesses()): Feature[] {
  return entries.flatMap((entry) => (entry.since ? [{ name: `agent_spawn.kind=${entry.kind}`, kind: 'argument' as const, protocol: entry.since.protocol, version: entry.since.version, summary: `A spawn starts a child that runs ${entry.label}.`, ...(entry.since.prs ? { prs: entry.since.prs } : {}) }] : []));
}

export const FEATURES: readonly Feature[] = [...BASE, ...kindFeatures()];

/**
 * The first argument of a call that the daemon would ignore or misread,
 * because it predates it, or undefined when the daemon serves every argument
 * passed. A feature named `tool.argument=value` covers one value of an
 * argument the daemon already knows, such as a harness kind.
 */
export function unservedArgument(daemon: DaemonOffer, tool: string, args: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const names = [`${tool}.${key}`, ...(typeof value === 'string' ? [`${tool}.${key}=${value.trim()}`] : [])];
    for (const name of names) {
      const feature = featureNamed(name);
      if (feature && !serves(daemon, feature)) return feature.name;
    }
  }
  return undefined;
}

/** What a client knows of the daemon it reached. */
export interface DaemonOffer {
  protocol: number;
  version?: string;
  /** The names the daemon's hello listed, from 0.1.5 on. */
  features?: readonly string[];
}

export function featureNamed(name: string): Feature | undefined {
  return FEATURES.find((feature) => feature.name === name) ?? kindFeatures().find((feature) => feature.name === name);
}

/**
 * Whether a daemon serves a feature. Its own list decides when it sent one.
 * Without a list, its protocol decides, never its version: a build between
 * two releases carries the number of the release before it, so a version
 * cannot say which features such a build has.
 */
export function serves(daemon: DaemonOffer, feature: Feature): boolean {
  if (daemon.features) return daemon.features.includes(feature.name);
  return daemon.protocol >= feature.protocol;
}

/** The features this install offers that a daemon does not serve, tools first. */
export function missingFrom(daemon: DaemonOffer, kind?: Feature['kind']): Feature[] {
  return FEATURES.filter((feature) => (!kind || feature.kind === kind) && !serves(daemon, feature));
}

/** The names a daemon lists that this install does not know: what updating this install would gain. */
export function unknownTo(daemon: DaemonOffer): string[] {
  return (daemon.features ?? []).filter((name) => !featureNamed(name));
}

function described(daemon: DaemonOffer): string {
  return `protocol ${daemon.protocol}${daemon.version ? ` (Bellwether ${daemon.version})` : ''}`;
}

/**
 * The error a client gives for an operation the daemon refused as unknown:
 * the operation, the protocol and release that brought it, and what this
 * daemon serves. The session keeps working, so the upgrade can wait.
 */
export function missingFeatureMessage(name: string, daemon: DaemonOffer): string {
  const feature = featureNamed(name);
  // A daemon already on the feature's protocol is a build from before the release that added it.
  const needs = !feature ? 'is not served by the running daemon' : daemon.protocol >= feature.protocol ? `needs Bellwether ${feature.version} (protocol ${feature.protocol}); this daemon is an earlier build on` : `needs protocol ${feature.protocol} (Bellwether ${feature.version}); this daemon serves`;
  return `\`${name}\` ${needs}${feature ? '' : '; this daemon serves'} ${described(daemon)}. Upgrade the machine holding the daemon when convenient. Every other tool keeps working.`;
}
