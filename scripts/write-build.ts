// Write dist/build.json, which names the commit and the time of this build.
// `npm run build` runs it after the compiler, so every installed copy of the
// package can say which code it runs, not only which version number. Without
// git, the file still records the time, and the commit stays unknown. Its one
// line goes to standard error, because `npm pack --json` runs the build and
// its standard output must stay JSON.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_FILE, type BuildInfo } from '../src/core/version.ts';

const root = path.resolve(import.meta.dirname, '..');

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const commit = git(['rev-parse', 'HEAD']);
const status = commit ? git(['status', '--porcelain', '--untracked-files=no', '--', 'src', 'package.json']) : undefined;
const build: Omit<BuildInfo, 'source'> = {
  ...(commit ? { commit } : {}),
  ...(status ? { dirty: true } : {}),
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const file = path.join(root, 'dist', BUILD_FILE);
fs.writeFileSync(file, `${JSON.stringify(build, null, 2)}\n`);
console.error(`wrote ${path.relative(root, file)}: ${JSON.stringify(build)}`);
