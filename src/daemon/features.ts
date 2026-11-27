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

export interface Feature {
  name: string;
  /**
   * A tool a model calls, a request on the wire, a notice an adapter sends as
   * a call that no model sees, or an argument a tool takes that an older
   * daemon would ignore rather than refuse.
   */
  kind: 'tool' | 'request' | 'notice' | 'argument';
  /** The first protocol whose daemons serve it. */
  protocol: number;
  /** The first release that served it. */
  version: string;
}

export const FEATURES: readonly Feature[] = [
  // In 0.1.3 or earlier, on protocol 2, the oldest a daemon serves.
  ...['hello', 'call', 'receipt', 'bye', 'drain', 'watch'].map((name) => ({ name, kind: 'request' as const, protocol: 2, version: '0.1.3' })),
  ...['agent_spawn', 'agent_adopt', 'agent_list', 'agent_read', 'agent_send', 'agent_stop', 'parent_report', 'request_retirement'].map((name) => ({ name, kind: 'tool' as const, protocol: 2, version: '0.1.3' })),
  // 0.1.4, protocol 3: `bellwether report` posts without a session.
  { name: 'report', kind: 'request', protocol: 3, version: '0.1.4' },
  // 0.1.5, protocol 4: the relay turned round, and doctor lists sessions.
  ...['relay-subscribe', 'relay-ack', 'relay-read', 'relay-status', 'sessions'].map((name) => ({ name, kind: 'request' as const, protocol: 4, version: '0.1.5' })),
  ...['agent_restart', 'agent_move'].map((name) => ({ name, kind: 'tool' as const, protocol: 4, version: '0.1.5' })),
  // A pi child's extension reports an open dialog; an older daemon refuses it, and the extension ignores the refusal.
  { name: 'child_prompt', kind: 'notice', protocol: 4, version: '0.1.5' },
  // A daemon without routes would drop `via` and `key_file` and start the child bare, so the client refuses the call first.
  { name: 'via', kind: 'argument', protocol: 4, version: '0.1.5' },
];

/** The arguments that need the `via` feature, which an older daemon would ignore. */
export const ROUTE_ARGUMENTS = ['via', 'key_file'] as const;

/**
 * The refusal for a call that passes a route argument to a daemon that would
 * ignore it, or undefined when the call may go. Without it, the child would
 * start bare and nobody would hear why.
 */
export function routeArgumentRefusal(args: Record<string, unknown>, daemon: DaemonOffer | undefined): string | undefined {
  const routed = ROUTE_ARGUMENTS.some((key) => args[key] !== undefined && args[key] !== null && args[key] !== '');
  const feature = featureNamed('via');
  if (!routed || !feature || !daemon || serves(daemon, feature)) return undefined;
  return missingFeatureMessage('via', daemon);
}

/** What a client knows of the daemon it reached. */
export interface DaemonOffer {
  protocol: number;
  version?: string;
  /** The names the daemon's hello listed, from 0.1.5 on. */
  features?: readonly string[];
}

export function featureNamed(name: string): Feature | undefined {
  return FEATURES.find((feature) => feature.name === name);
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
