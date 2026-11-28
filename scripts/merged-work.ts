// The merged-work guard (issue #296).
//
// A commit can name the current main as its parent and still carry an older
// tree, as e16cc52 did when #289 merged. Its squash merge then writes that
// tree over main and deletes every pull request merged after it. CI passes,
// because the deleted code took its tests with it.
//
// Each merged pull request leaves a record: a note under release-notes/, and
// for a wire change, an entry in FEATURES in src/daemon/features.ts. So this
// check fails a pull request whose diff against its merge base deletes a note
// or removes a FEATURES entry, unless a person applied the
// `removes-merged-work` label and gave the reason in the pull request.
//
// The diff runs against the merge base, never against main, so a branch that
// is merely behind main never trips it. A note the branch added itself can't
// show as deleted in that diff, so deleting your own note passes.
//
//   node scripts/merged-work.ts --base origin/main [--head HEAD]
//
// The labels come from PR_LABELS, a JSON array of label names.
import { execFile } from 'node:child_process';
import { NOTES_DIR } from './release-notes.ts';

export const REMOVES_MERGED_WORK = 'removes-merged-work';
export const FEATURES_FILE = 'src/daemon/features.ts';

export interface MergedWorkResult {
  ok: boolean;
  /** Notes under release-notes/ that the merge base has and the head lacks. */
  deletedNotes: string[];
  /** FEATURES entry names that the merge base has and the head lacks. */
  removedFeatures: string[];
  message: string;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function mustGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The entry names in the BASE table of a features.ts text, sorted. An entry is
 * a key in one of the `brought(...)` records, quoted or bare, whose value is a
 * string. Names built at run time, such as `agent_spawn.kind=<kind>`, come
 * from the harness registry and have no line of their own here.
 */
export function featureNames(text: string): string[] {
  const start = text.search(/^const BASE\b/m);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.search(/^\];/m);
  const table = end < 0 ? rest : rest.slice(0, end);
  const names = new Set<string>();
  for (const match of table.matchAll(/^\s+(['"]?)([A-Za-z_][\w.=-]*)\1:\s*['"`]/gm)) names.add(match[2]!);
  return [...names].sort();
}

async function featuresAt(cwd: string, rev: string): Promise<string[]> {
  const result = await git(cwd, ['show', `${rev}:${FEATURES_FILE}`]);
  return result.code === 0 ? featureNames(result.stdout) : [];
}

export async function checkMergedWork(options: { cwd: string; base: string; head?: string; labels?: readonly string[] }): Promise<MergedWorkResult> {
  const { cwd, base } = options;
  const head = options.head ?? 'HEAD';
  const mergeBase = (await mustGit(cwd, ['merge-base', base, head])).trim();
  // Renames stay renames: a note moved to another version is still there.
  const deletedNotes = (await mustGit(cwd, ['diff', '--find-renames', '--diff-filter=D', '--name-only', mergeBase, head, '--', NOTES_DIR]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const after = new Set(await featuresAt(cwd, head));
  const removedFeatures = (await featuresAt(cwd, mergeBase)).filter((name) => !after.has(name));

  const labelled = (options.labels ?? []).includes(REMOVES_MERGED_WORK);
  const found = deletedNotes.length > 0 || removedFeatures.length > 0;
  const lines: string[] = [];
  if (!found) {
    lines.push(`No release note or FEATURES entry from before ${mergeBase.slice(0, 12)} goes missing.`);
  } else {
    lines.push(`Against its merge base ${mergeBase.slice(0, 12)}, this pull request removes the record of work that already merged:`);
    for (const note of deletedNotes) lines.push(`  deletes ${note}`);
    for (const name of removedFeatures) lines.push(`  removes the FEATURES entry ${name} from ${FEATURES_FILE}`);
    if (labelled) {
      lines.push(`The ${REMOVES_MERGED_WORK} label is on, so the check passes. The pull request states why.`);
    } else {
      lines.push(
        '',
        "A commit whose tree came from an older checkout does this: the branch's tree predates these pull requests, and a squash merge would delete them from main (issue #296).",
        "Compare the branch's tree with main, and take the newer files back.",
        `When the removal is intended, a person applies the ${REMOVES_MERGED_WORK} label and writes the reason in the pull request.`,
      );
    }
  }
  return { ok: !found || labelled, deletedNotes, removedFeatures, message: lines.join('\n') };
}

function labelsFromEnvironment(): string[] {
  const raw = process.env.PR_LABELS;
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((each) => typeof each === 'string')) throw new Error('PR_LABELS holds a JSON array of label names');
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
  };
  const base = value('--base');
  if (!base) {
    console.error('usage: node scripts/merged-work.ts --base <ref> [--head <ref>]');
    process.exit(2);
  }
  const result = await checkMergedWork({ cwd: process.cwd(), base, head: value('--head'), labels: labelsFromEnvironment() });
  (result.ok ? console.log : console.error)(result.message);
  process.exit(result.ok ? 0 : 1);
}
