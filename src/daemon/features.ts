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
//
// A change in behavior that adds nothing to the wire has no entry here: its
// release note is a file of its own under release-notes/<version>/, which no
// daemon reads (scripts/release-notes.ts, issue #182).

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
   * request merged since the last release that no entry and no note under
   * release-notes/ names, so a feature from 0.1.8 on names its own, or its
   * pull request adds a note.
   */
  prs?: readonly number[];
}

/** The features one release brought on one protocol, each name with its summary. */
function brought(kind: Feature['kind'], protocol: number, version: string, summaries: Record<string, string>, prs?: readonly number[]): Feature[] {
  return Object.entries(summaries).map(([name, summary]) => ({ name, kind, protocol, version, summary, ...(prs ? { prs } : {}) }));
}

/** The pull request that brought freeing (issue #262). */
const PR_FREE = 0;

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
  // An older daemon ignores the argument, and moves without checking what stays behind.
  ...brought('argument', 4, '0.1.10', {
    'agent_move.accept_loss': 'A move goes ahead even though the child would leave a background job or unpushed worktree work behind, and the reply lists them.',
  }, [232]),
  // A far daemon that predates it answers unknown_type, and the parent refuses the restart by name.
  ...brought('request', 4, '0.1.10', {
    'relay-restart': "`agent_restart` restarts a child on another machine: the daemon there closes its pane, opens a new tab and resumes the same session under the same child id.",
  }, [203]),
  // A far daemon that predates it ignores the field and answers only the request, as before.
  ...brought('argument', 4, '0.1.10', {
    'relay-restart.requestId': "When a connection ends before a restart's answer arrives, the parent's daemon takes that answer from the far machine's relay outbox once the connection returns.",
  }, [214]),
  // A far daemon that predates it answers unknown_type, and the parent keeps the message in doubt rather than type a second copy.
  ...brought('request', 4, '0.1.10', {
    'relay-message-again': "When a connection ends before a message's answer arrives, the parent's daemon sends the message again once the connection returns, and the far machine pushes it only if it never did.",
  }, [221]),
  // A parent's daemon that predates it takes the entry as a needs-input report, and the child's daemon tells the child so.
  ...brought('argument', 4, '0.1.10', {
    'relay-report.retire': "A child on another machine calls request_retirement, and the request waits in that machine's relay outbox for the parent's daemon, which retires the worktree a moved child left on its own machine.",
    'relay-ack.answer': "The acknowledgement of a retirement request from another machine brings the parent daemon's reply back to the child.",
  }, [239]),
  // A parent's daemon that predates it takes the entry as a needs-input report, and the child's daemon tells the child so.
  ...brought('argument', 4, '0.1.10', {
    'relay-report.teleport': "A child on another machine calls agent_teleport for itself, and the request waits in that machine's relay outbox for the parent's daemon, which teleports the child once its turn ends.",
  }),
  // A daemon that predates it answers unknown_type, and `bellwether resume` names the release that brought it.
  ...brought('request', 4, '0.1.10', {
    resume: '`bellwether resume <session>` brings back a session that has lost its pane, from its own record, and reports the pane and tab it opened.',
  }, [208]),
  // A daemon that predates it does not list the tool, and the client refuses agent_teleport by name.
  ...brought('tool', 4, '0.1.10', {
    agent_teleport: "A parent moves a live or stopped child to another machine, and the child's first input there is a notice that gives where it came from and where it is now.",
  }, [240]),
  // Freeing a child (issue #262). A daemon that predates them does not list the tools, and a client refuses them by name.
  ...brought('tool', 4, '0.1.11', {
    agent_free: 'A parent frees a child, which leaves its registry and becomes a peer with an address: its turns no longer wake the parent, and its briefs and reports are no longer the parent\'s.',
    peer_send: "A parent and the child it freed send each other messages, and the target's own daemon checks each message's token against the target's record.",
  }, [PR_FREE]),
  // A far daemon that predates relay-free answers unknown_type, and the freeing is refused with nothing changed.
  ...brought('request', 4, '0.1.11', {
    'relay-free': "The daemon on a freed child's machine writes the child's own record of the freeing, with its former parent as a peer.",
  }, [PR_FREE]),
  ...brought('argument', 4, '0.1.11', {
    'relay-message.peer': "A message to a freed child on another machine carries the pair's token, which that machine's daemon checks.",
    'relay-report.peer': "A freed child's message to its former parent waits in its machine's relay outbox, and the parent's daemon checks the pair's token.",
  }, [PR_FREE]),
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
