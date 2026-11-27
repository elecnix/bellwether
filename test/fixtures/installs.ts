// A second Bellwether install on the same machine: a copy of these sources
// under a scratch directory, with its own package.json version and, when a
// case asks, an older DAEMON_PROTOCOL. Its daemon runs as a real process from
// that copy, and its client loads from that copy, so a case can put an older
// release and this one side by side on one home.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Install {
  root: string;
  version: string;
  protocol: number;
  /** The daemon entry point of this install. */
  entry: string;
  /** This install's client module, loaded from the copy. */
  client(): Promise<typeof import('../../src/daemon/client.ts')>;
}

/** Copy the sources to `<parent>/<name>`, as release `version` speaking `protocol`. */
export function makeInstall(parent: string, name: string, version: string, protocol: number): Install {
  const root = path.join(parent, name);
  fs.cpSync(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'));
  const protocolFile = path.join(root, 'src', 'daemon', 'protocol.ts');
  const source = fs.readFileSync(protocolFile, 'utf8');
  const changed = source.replace(/export const DAEMON_PROTOCOL = \d+;/, `export const DAEMON_PROTOCOL = ${protocol};`);
  if (changed === source && !source.includes(`export const DAEMON_PROTOCOL = ${protocol};`)) throw new Error('the protocol constant moved; update test/fixtures/installs.ts');
  fs.writeFileSync(protocolFile, changed);
  const entry = path.join(root, 'src', 'daemon', 'main.ts');
  return {
    root,
    version,
    protocol,
    entry,
    client: () => import(pathToFileURL(path.join(root, 'src', 'daemon', 'client.ts')).href) as Promise<typeof import('../../src/daemon/client.ts')>,
  };
}
