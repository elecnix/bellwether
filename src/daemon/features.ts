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
}

const BASE: readonly Feature[] = [
  // In 0.1.3 or earlier, on protocol 2, the oldest a daemon serves.
  ...['hello', 'call', 'receipt', 'bye', 'drain', 'watch'].map((name) => ({ name, kind: 'request' as const, protocol: 2, version: '0.1.3' })),
  ...['agent_spawn', 'agent_adopt', 'agent_list', 'agent_read', 'agent_send', 'agent_stop', 'parent_report', 'request_retirement'].map((name) => ({ name, kind: 'tool' as const, protocol: 2, version: '0.1.3' })),
  // 0.1.4, protocol 3: `bellwether report` posts without a session.
  { name: 'report', kind: 'request', protocol: 3, version: '0.1.4' },
  // 0.1.5, protocol 4: the relay turned round, and doctor lists sessions.
  ...['relay-subscribe', 'relay-ack', 'relay-read', 'relay-status', 'sessions'].map((name) => ({ name, kind: 'request' as const, protocol: 4, version: '0.1.5' })),
  ...['agent_restart', 'agent_move'].map((name) => ({ name, kind: 'tool' as const, protocol: 4, version: '0.1.5' })),
  // A child at its depth ceiling asks for more, and a parent grants or refuses.
  ...['agent_request_depth', 'agent_grant_depth'].map((name) => ({ name, kind: 'tool' as const, protocol: 4, version: '0.1.5' })),
  // A pi child's extension reports an open dialog; an older daemon refuses it, and the extension ignores the refusal.
  { name: 'child_prompt', kind: 'notice', protocol: 4, version: '0.1.5' },
  // A Claude Code child's Notification hook names its source. An older daemon
  // would record the dialog as pi's, which only pi's own closing notice clears.
  { name: 'child_prompt.source', kind: 'argument', protocol: 4, version: '0.1.5' },
  // After 0.1.5: a parent's daemon adopts a pane on another machine and asks that machine who watches it.
  { name: 'relay-adopt', kind: 'request', protocol: 4, version: '0.1.6' },
  // An older daemon would start the child in the parent's workspace and say nothing.
  ...['agent_spawn.workspace', 'agent_spawn.workspace_label'].map((name) => ({ name, kind: 'argument' as const, protocol: 4, version: '0.1.5' })),
  // An older daemon would start the child bare, off the route it was asked for, and say nothing.
  // 0.1.6: another program asks for the agent tree instead of reading the registry files.
  { name: 'ancestry', kind: 'request', protocol: 4, version: '0.1.6' },
  // A child's adapter acknowledges a parent's message that entered its session, rather than its pane.
  { name: 'message-ack', kind: 'request', protocol: 4, version: '0.1.6' },
  ...['agent_spawn.via', 'agent_spawn.key_file', 'agent_restart.via', 'agent_restart.model', 'agent_restart.key_file', 'agent_restart.provider'].map((name) => ({ name, kind: 'argument' as const, protocol: 4, version: '0.1.5' })),
];

/**
 * One argument per harness kind whose registry entry names the release that
 * first starts it as the entry says, `agent_spawn.kind=<kind>`. An older
 * daemon would start such a child the old way or not at all, so the client
 * refuses the kind by name instead.
 */
export function kindFeatures(entries: readonly HarnessEntry[] = harnesses()): Feature[] {
  return entries.flatMap((entry) => (entry.since ? [{ name: `agent_spawn.kind=${entry.kind}`, kind: 'argument' as const, protocol: entry.since.protocol, version: entry.since.version }] : []));
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
