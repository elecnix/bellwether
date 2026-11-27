// The version of the installed package, read from the package.json above this
// file. From the sources that is ../../package.json of src/core, and from the
// build it is the same path above dist/core, so one lookup serves both.
import fs from 'node:fs';
import path from 'node:path';

function readVersion(): string {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (manifest.name === '@elecnix/bellwether' && manifest.version) return manifest.version;
    }
    dir = path.dirname(dir);
  }
  return 'unknown';
}

export const BELLWETHER_VERSION = readVersion();
