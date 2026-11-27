// Pieces more than one harness entry uses.
import { argValue } from '../args.ts';
import { locateSessionPath, type TranscriptLookup } from '../transcript.ts';

/** `--model <model>`, unless the caller already put a --model in its own arguments. */
export function modelFlag(model: string | undefined, extra: string[] = []): string[] {
  return model && argValue(extra, '--model') === undefined ? ['--model', model] : [];
}

/** The pointer a harness that cannot attach a file reads as its first prompt. */
export function briefSentence(file: string): string {
  return `Your task is in ${file}. Read it, then do what it says.`;
}

/** A lookup for a harness whose transcript Bellwether does not read yet. */
export function noTranscript(label: string): (session: string | undefined) => TranscriptLookup {
  return (session) => (session && locateSessionPath(session)) || { missing: `Bellwether reads no transcript for the ${label} harness` };
}
