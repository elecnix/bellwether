// The environment a harness entry gives a child on another machine. The entry
// runs on that machine, inside `bellwether relay-register`, so the values it
// returns are that machine's own: the pi extension it resolves, the config it
// writes there. They travel back to the parent in the same JSON line as the
// brief and MCP config paths, and the parent hands them to the tab.
//
// Some variables belong to the one machine that computed them. herdr sets
// its own socket and pane in every pane, and Bellwether's home and daemon
// socket name one machine's files. A path under a home directory that the
// child's machine does not have points at nothing there. The registration
// leaves such a variable out and names it, so the spawn reply can say so.
//
// Nothing here reads a file a value names. A credential file stays a path,
// and only the harness reads it, in the child's tab. The environment goes in
// no record: the relay record and the child record never carry it.
import fs from 'node:fs';

/** A variable the registration left out, and why, without its value. */
export interface DroppedVariable {
  name: string;
  why: string;
}

/** Variables that always name something on one machine, with the reason each is left out. */
export const MACHINE_LOCAL_VARIABLES: Readonly<Record<string, string>> = {
  HERDR_SOCKET_PATH: "it names herdr's socket on one machine, and herdr sets its own in each pane",
  HERDR_PANE_ID: 'it names a pane on one machine, and herdr sets its own in each pane',
  HERDR_ENV: 'herdr sets it in each pane on its own machine',
  BELLWETHER_HOME: "it names one machine's Bellwether home",
  BELLWETHER_DAEMON_SOCKET: "it names one machine's Bellwether daemon socket",
};

/** The home directory a path sits under, as `/home/<user>` or `/Users/<user>`, or undefined for any other path. */
export function homeOf(value: string): string | undefined {
  const match = /^\/(home|Users)\/[^/]+/.exec(value);
  return match ? match[0] : undefined;
}

/**
 * Split an entry's environment into what the child's tab on this machine can
 * use and what it cannot. `exists` checks a home directory, never the file a
 * value names, so a credential file is never opened.
 */
export function farEnvironment(env: Record<string, string> | undefined, exists: (dir: string) => boolean = fs.existsSync): { env: Record<string, string>; dropped: DroppedVariable[] } {
  const kept: Record<string, string> = {};
  const dropped: DroppedVariable[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    const local = MACHINE_LOCAL_VARIABLES[name];
    if (local) {
      dropped.push({ name, why: local });
      continue;
    }
    const home = homeOf(value);
    if (home && !exists(home)) {
      dropped.push({ name, why: 'it names a path under a home directory this machine does not have' });
      continue;
    }
    kept[name] = value;
  }
  return { env: kept, dropped };
}

/** The line of a spawn reply that names the variables a registration left out, or undefined when it left none out. */
export function droppedNote(childName: string, host: string, dropped: readonly DroppedVariable[] | undefined): string | undefined {
  if (!dropped?.length) return undefined;
  const list = dropped.map((entry) => `${entry.name}, because ${entry.why}`).join('; ');
  return `${childName}'s tab on machine ${host} starts without ${dropped.length === 1 ? 'a variable' : `${dropped.length} variables`} its harness entry set: ${list}.`;
}
