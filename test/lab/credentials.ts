// Which environment variables a lab run removes. A lab case starts real
// harnesses, and a harness uses any provider key, token or cloud credential it
// finds in its environment, on the account of whoever exported it. A lab
// reaches only the scripted models, so it needs none of them. A person who
// wants one kept names it in BELLWETHER_LAB_KEYS, and a case that needs it in a
// lab pane asks for it by name through startLab.

/** The variable a person sets to keep named credentials, comma-separated. */
export const KEEP_VARIABLE = 'BELLWETHER_LAB_KEYS';

// A name ending in one of these carries a secret: OPENAI_API_KEY, GH_TOKEN,
// AZURE_CLIENT_SECRET, AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS.
const SECRET_SUFFIX = /_(?:KEY|KEY_ID|TOKEN|TOKEN_FILE|SECRET|PASSWORD|CREDENTIALS?)$/i;
// A cloud SDK reads its account from variables that need not look secret, such
// as AWS_PROFILE or AWS_BEARER_TOKEN_BEDROCK.
const CLOUD_PREFIX = /^(?:AWS|AZURE|ARM|GOOGLE_CLOUD|GCLOUD|CLOUDSDK)_/i;

export function isCredential(name: string): boolean {
  return SECRET_SUFFIX.test(name) || CLOUD_PREFIX.test(name);
}

/** The names the person asked to keep. */
export function keptNames(env: NodeJS.ProcessEnv): string[] {
  return (env[KEEP_VARIABLE] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Remove every credential not in `keep` from `env`, in place, and return the names removed and kept, sorted. */
export function scrubCredentials(env: NodeJS.ProcessEnv, keep: readonly string[]): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isCredential(name)) continue;
    if (keep.includes(name)) kept.push(name);
    else {
      removed.push(name);
      delete env[name];
    }
  }
  return { removed: removed.sort(), kept: kept.sort() };
}

/** The one line a lab run prints about its environment. It names variables, never their values. */
export function scrubNotice(removed: readonly string[], kept: readonly string[]): string {
  const head = removed.length === 0
    ? 'lab environment: the shell exported no provider key, token or cloud credential to remove.'
    : `lab environment: removed ${removed.join(', ')}, so no lab case can use them.`;
  const tail = kept.length === 0
    ? ` To keep one for a case that needs it, name it in ${KEEP_VARIABLE}.`
    : ` It kept ${kept.join(', ')}, which ${KEEP_VARIABLE} names.`;
  return head + tail;
}
