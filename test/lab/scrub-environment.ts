// `npm run test:lab` uses this file twice. It first runs it as a command,
// which prints the one notice for the run: which provider keys, tokens and
// cloud credentials the shell exported, and which of them the person kept.
// Each lab file's process then loads it with --import, after the isolation
// preload, and it removes the same variables from that process before any
// case runs, so neither the case nor anything it starts can use them.
import path from 'node:path';
import { keptNames, scrubCredentials, scrubNotice } from './credentials.ts';

const { removed, kept } = scrubCredentials(process.env, keptNames(process.env));
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) console.error(scrubNotice(removed, kept));
