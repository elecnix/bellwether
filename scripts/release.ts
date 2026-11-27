// Release Bellwether from this machine, up to the one step a person must take.
//
//   npm run release -- 0.1.5
//
// Each run reads where the release stands and carries it one stage further, so a
// second run after an interruption continues from the stage that stopped:
//
//   1. The version is on npm: bump the Homebrew formula in the tap, and stop.
//   2. The version is staged on npm: wait out `validating`, then print the
//      `npm stage approve` command for a person to run with a one-time code.
//   3. origin/main carries the version: build that commit and stage it.
//   4. An open pull request from release/<version>: merge it once CI is green.
//   5. Nothing yet: refuse a dirty tree or a red main, run the gates in a
//      worktree of origin/main, bump the version fields, push, open the pull
//      request and merge it once CI is green.
//
// The script never approves a staged version. Approval needs the operator's
// one-time code, so it prints the command and exits.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PACKAGE = '@elecnix/bellwether';
export const REPO = 'elecnix/bellwether';
export const TAP = 'elecnix/homebrew-tap';
export const FORMULA = 'Formula/bellwether.rb';
const NPM12 = ['-y', 'npm@12'];

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd?: string; inherit?: boolean }

export interface ReleaseDeps {
  run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>;
  fetchBytes(url: string): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  cwd: string;
}

export interface ReleaseOptions {
  version: string;
  /** How often to read `npm stage list` while the review runs. */
  pollMs?: number;
  /** How long the registry's review may stay in `validating`. */
  validateTimeoutMs?: number;
  /** Skip the Homebrew tap once the version is on npm. */
  skipTap?: boolean;
}

export type Outcome =
  | { state: 'awaiting-approval'; stageId: string; approve: string; protocolChange?: ProtocolChange }
  | { state: 'published'; formula: 'current' | 'merged' | 'skipped'; tapPr?: string };

export interface ProtocolChange { from: number; to: number }

interface StageItem { id: string; packageName: string; version: string; status: string }
interface PullRequest { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string }

export class ReleaseError extends Error {}

const VERSION = /^\d+\.\d+\.\d+$/;

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Point the formula at a new tarball. The url and sha256 lines are the only ones a release changes. */
/** The Claude Code plugin manifest, which declares the same version as package.json. */
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** The plugin manifest with its version set to `version`, and every other field kept. */
export function bumpPluginManifest(text: string, version: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  if (typeof manifest['version'] !== 'string') throw new ReleaseError(`${PLUGIN_MANIFEST} declares no version`);
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
}

export function bumpFormula(text: string, url: string, sha256: string): string {
  const urlLine = /^(\s*)url "https:\/\/registry\.npmjs\.org\/[^"]+"$/m;
  const shaLine = /^(\s*)sha256 "[0-9a-f]{64}"$/m;
  if (!urlLine.test(text) || !shaLine.test(text)) {
    throw new ReleaseError(`${FORMULA} has no npm url line or no sha256 line to replace`);
  }
  return text.replace(urlLine, `$1url "${url}"`).replace(shaLine, `$1sha256 "${sha256}"`);
}

export function protocolOf(source: string): number | undefined {
  const match = /DAEMON_PROTOCOL\s*=\s*(\d+)/.exec(source);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Where the release and upgrade docs live, for a pull request body that GitHub renders. */
const DOCS_URL = 'https://github.com/elecnix/bellwether/blob/main/docs';

/** The line printed beside the approve command when the daemon protocol moves. */
export function approvalNotice(change: ProtocolChange): string {
  return `The daemon protocol moves from ${change.from} to ${change.to}. Before you approve, follow the protocol-change steps in docs/releasing.md#a-release-that-changes-the-daemon-protocol.`;
}

/** The line printed once the version is on npm. */
export function installNotice(version: string, formula: string): string {
  return `${PACKAGE}@${version} is on npm, and ${formula}. Install it on each machine with the steps in docs/upgrading.md#what-you-run-on-each-machine.`;
}

export function prBody(version: string, previous: string | undefined, change: ProtocolChange | undefined): string {
  const since = previous ? ` since ${previous}` : '';
  const lines = [
    `The version in \`package.json\`, \`package-lock.json\` and \`.claude-plugin/plugin.json\` moves to ${version}, so the next publish includes every change merged${since}. \`npm run release\` opened the pull request and merges it once CI passes.`,
    '',
  ];
  if (change) {
    lines.push(`The daemon protocol moves from ${change.from} to ${change.to}. The first session on the new install hands the old daemon over, and a session still on the old install keeps working, because a daemon serves the protocol before its own. A session two protocols behind fails its tool calls until it restarts. Before approving, follow [the steps for a protocol change](${DOCS_URL}/releasing.md#a-release-that-changes-the-daemon-protocol). [docs/upgrading.md](${DOCS_URL}/upgrading.md#daemon-protocol-changes) says what each session sees.`);
  } else {
    lines.push('The daemon protocol stays the same, so a running daemon keeps serving sessions after the upgrade.');
  }
  return lines.join('\n') + '\n';
}

export async function release(options: ReleaseOptions, deps: ReleaseDeps): Promise<Outcome> {
  return new Release(options, deps).run();
}

class Release {
  private readonly version: string;
  private readonly branch: string;
  private readonly pollMs: number;
  private readonly validateTimeoutMs: number;
  private readonly options: ReleaseOptions;
  private readonly deps: ReleaseDeps;

  constructor(options: ReleaseOptions, deps: ReleaseDeps) {
    this.options = options;
    this.deps = deps;
    if (!VERSION.test(options.version)) throw new ReleaseError(`version must look like 1.2.3, not ${JSON.stringify(options.version)}`);
    this.version = options.version;
    this.branch = `release/${options.version}`;
    this.pollMs = options.pollMs ?? 15_000;
    this.validateTimeoutMs = options.validateTimeoutMs ?? 30 * 60_000;
  }

  async run(): Promise<Outcome> {
    if (await this.isPublished()) return this.afterPublish();

    const latest = await this.latest();
    if (latest && compareVersions(this.version, latest) <= 0) {
      throw new ReleaseError(`${this.version} is not newer than ${latest}, the version npm serves as latest`);
    }

    const staged = await this.stageItem();
    if (staged) return this.awaitReview(staged, undefined);

    const top = (await this.must('git', ['rev-parse', '--show-toplevel'], { cwd: this.deps.cwd })).trim();
    await this.must('git', ['fetch', '--quiet', 'origin'], { cwd: top });

    let commit = await this.releaseCommit(top);
    if (!commit) {
      const pr = await this.findPr(REPO, this.branch);
      if (pr?.state === 'CLOSED') {
        throw new ReleaseError(`${pr.url} was closed without a merge. Reopen it, or delete ${this.branch} on origin, then run again.`);
      }
      if (pr?.state === 'OPEN') {
        this.deps.log(`resuming ${pr.url}`);
        await this.mergeWhenGreen(REPO, pr);
      } else if (!pr) {
        await this.openReleasePr(top, latest);
      }
      await this.must('git', ['fetch', '--quiet', 'origin'], { cwd: top });
      commit = await this.releaseCommit(top);
      if (!commit) throw new ReleaseError(`origin/main has no commit that sets the version to ${this.version}, although the pull request merged`);
    }

    const tree = await this.worktree(top, commit);
    await this.must('npm', ['ci'], { cwd: tree, inherit: true });
    const manifest = JSON.parse(await readFile(path.join(tree, 'package.json'), 'utf8')) as { version?: string };
    if (manifest.version !== this.version) throw new ReleaseError(`${commit} declares ${manifest.version}, not ${this.version}`);
    const change = await this.protocolChange(tree, latest);
    this.deps.log(`staging ${PACKAGE}@${this.version} from ${commit}`);
    await this.must('npx', [...NPM12, 'stage', 'publish'], { cwd: tree, inherit: true });
    const item = await this.stageItem();
    if (!item) throw new ReleaseError(`npm stage publish finished, but npm stage list shows no ${this.version}`);
    return this.awaitReview(item, change);
  }

  // --- npm ---------------------------------------------------------------

  private async isPublished(): Promise<boolean> {
    const result = await this.deps.run('npm', ['view', `${PACKAGE}@${this.version}`, 'version']);
    // npm answers a version it has never seen with E404. Anything else is a failure to ask.
    if (result.code !== 0 && !result.stderr.includes('E404')) throw new ReleaseError(`npm view failed:\n${result.stderr.trim()}`);
    return result.code === 0 && result.stdout.trim() === this.version;
  }

  private async latest(): Promise<string | undefined> {
    const result = await this.deps.run('npm', ['view', PACKAGE, 'dist-tags.latest']);
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  private async stageItem(): Promise<StageItem | undefined> {
    const out = await this.must('npx', [...NPM12, 'stage', 'list', PACKAGE, '--json']);
    const items = JSON.parse(out) as StageItem[];
    return items.find((item) => item.version === this.version);
  }

  private async awaitReview(first: StageItem, change: ProtocolChange | undefined): Promise<Outcome> {
    let item: StageItem | undefined = first;
    let waited = 0;
    while (item?.status === 'validating') {
      if (waited >= this.validateTimeoutMs) {
        throw new ReleaseError(`stage ${item.id} is still validating after ${Math.round(waited / 60_000)} minutes. Run again later.`);
      }
      this.deps.log(`stage ${item.id} is validating; reading it again in ${Math.round(this.pollMs / 1000)} s`);
      await this.deps.sleep(this.pollMs);
      waited += this.pollMs;
      item = await this.stageItem();
    }
    if (!item) {
      if (await this.isPublished()) return this.afterPublish();
      throw new ReleaseError(`the staged ${this.version} left npm stage list without being published. It was rejected; stage it again.`);
    }
    if (item.status !== 'staged') throw new ReleaseError(`stage ${item.id} is ${item.status}, so it cannot be approved`);
    const outcome: Outcome = { state: 'awaiting-approval', stageId: item.id, approve: `npx -y npm@12 stage approve ${item.id} --otp <code>` };
    if (change) outcome.protocolChange = change;
    return outcome;
  }

  private async protocolChange(tree: string, latest: string | undefined): Promise<ProtocolChange | undefined> {
    const to = protocolOf(await readFile(path.join(tree, 'src/daemon/protocol.ts'), 'utf8'));
    if (!latest || to === undefined) return undefined;
    const from = protocolOf(await this.publishedFile(latest, 'package/dist/daemon/protocol.js'));
    return from !== undefined && from !== to ? { from, to } : undefined;
  }

  private async publishedFile(version: string, member: string): Promise<string> {
    const url = (await this.must('npm', ['view', `${PACKAGE}@${version}`, 'dist.tarball'])).trim();
    const dir = await mkdtemp(path.join(tmpdir(), 'bellwether-release-'));
    try {
      const file = path.join(dir, 'package.tgz');
      await writeFile(file, await this.deps.fetchBytes(url));
      return await this.must('tar', ['-xzOf', file, member]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // --- git and the release pull request ----------------------------------

  /** The commit on origin/main that set package.json to this version. */
  private async releaseCommit(top: string): Promise<string | undefined> {
    const current = await this.deps.run('git', ['show', 'origin/main:package.json'], { cwd: top });
    if (current.code !== 0) return undefined;
    const declared = (JSON.parse(current.stdout) as { version?: string }).version;
    if (declared !== this.version) return undefined;
    const sha = await this.must('git', ['log', '-1', '--format=%H', `-S"version": "${this.version}"`, 'origin/main', '--', 'package.json'], { cwd: top });
    return sha.trim() || undefined;
  }

  private worktreePath(top: string): string {
    return path.join(path.dirname(top), `release-${this.version}`);
  }

  /** A clean worktree beside this one, at `commit`, or on the release branch when no commit is given. */
  private async worktree(top: string, commit?: string): Promise<string> {
    const tree = this.worktreePath(top);
    if (existsSync(tree)) {
      await this.refuseDirty(tree);
      if (commit) await this.must('git', ['checkout', '--quiet', '--detach', commit], { cwd: tree });
      return tree;
    }
    if (commit) {
      await this.must('git', ['worktree', 'add', '--detach', tree, commit], { cwd: top });
    } else {
      const local = await this.deps.run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${this.branch}`], { cwd: top });
      const args = local.code === 0 ? [tree, this.branch] : ['-b', this.branch, tree, 'origin/main'];
      await this.must('git', ['worktree', 'add', ...args], { cwd: top });
    }
    return tree;
  }

  private async refuseDirty(dir: string): Promise<void> {
    const status = await this.must('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir });
    if (status.trim()) throw new ReleaseError(`${dir} has uncommitted changes:\n${status.trimEnd()}\nCommit or discard them, then run again.`);
  }

  private async refuseRedMain(top: string): Promise<void> {
    const sha = (await this.must('git', ['rev-parse', 'origin/main'], { cwd: top })).trim();
    const read = async () => JSON.parse(await this.must('gh', ['run', 'list', '-R', REPO, '--workflow', 'ci.yml', '--commit', sha, '--json', 'databaseId,status,conclusion', '--limit', '1'])) as Array<{ databaseId: number; status: string; conclusion: string }>;
    let run = (await read())[0];
    if (!run) throw new ReleaseError(`origin/main (${sha.slice(0, 7)}) has no ci run, so its build is unknown`);
    if (run.status !== 'completed') {
      this.deps.log(`waiting for ci run ${run.databaseId} on origin/main`);
      await this.must('gh', ['monitor', '-R', REPO, '--run-id', String(run.databaseId)]);
      run = (await read())[0];
    }
    if (run?.conclusion !== 'success') {
      throw new ReleaseError(`ci on origin/main (${sha.slice(0, 7)}) ended ${run?.conclusion ?? 'unknown'}. Fix main before a release.`);
    }
  }

  private async openReleasePr(top: string, latest: string | undefined): Promise<void> {
    await this.refuseDirty(this.deps.cwd);
    await this.refuseRedMain(top);
    const tree = await this.worktree(top);
    for (const args of [['ci'], ['run', 'typecheck'], ['test'], ['run', 'doctor']]) {
      await this.must('npm', args, { cwd: tree, inherit: true });
    }
    const manifest = JSON.parse(await readFile(path.join(tree, 'package.json'), 'utf8')) as { version?: string };
    if (manifest.version !== this.version) {
      await this.must('npm', ['version', this.version, '--no-git-tag-version'], { cwd: tree });
      const plugin = path.join(tree, PLUGIN_MANIFEST);
      await writeFile(plugin, bumpPluginManifest(await readFile(plugin, 'utf8'), this.version));
      await this.must('git', ['commit', '--quiet', '-m', `release: ${this.version}`, '--', 'package.json', 'package-lock.json', PLUGIN_MANIFEST], { cwd: tree });
    }
    await this.must('git', ['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${this.branch}`], { cwd: tree });
    const change = await this.protocolChange(tree, latest);
    const body = await this.tempFile('pr-body.md', prBody(this.version, latest, change));
    try {
      const url = (await this.must('gh', ['pr', 'create', '-R', REPO, '--base', 'main', '--head', this.branch, '--title', `release: ${this.version}`, '--body-file', body.file])).trim();
      this.deps.log(`opened ${url}`);
      const pr = await this.findPr(REPO, this.branch);
      if (!pr) throw new ReleaseError(`gh opened ${url}, but no pull request lists ${this.branch} as its head`);
      await this.mergeWhenGreen(REPO, pr);
    } finally {
      await body.remove();
    }
  }

  private async findPr(repo: string, head: string): Promise<PullRequest | undefined> {
    const out = await this.must('gh', ['pr', 'list', '-R', repo, '--head', head, '--state', 'all', '--json', 'number,state,url', '--limit', '5']);
    const prs = JSON.parse(out) as PullRequest[];
    return prs.find((pr) => pr.state === 'OPEN') ?? prs.find((pr) => pr.state === 'MERGED') ?? prs[0];
  }

  /** Wait for CI with gh monitor, which exits on the first verdict, then squash-merge. */
  private async mergeWhenGreen(repo: string, pr: PullRequest): Promise<void> {
    if (pr.state === 'MERGED') return;
    const out = await this.must('gh', ['monitor', String(pr.number), '-R', repo, '--until', 'ci-all-green,new-failing-checks,merged,closed', '--interval', '30', '--timeout', '3600']);
    const kinds = out.split('\n').flatMap((line) => {
      try { return [(JSON.parse(line) as { type?: string }).type ?? '']; } catch { return []; }
    });
    const verdict = kinds.reverse().find((kind) => ['ci-all-green', 'new-failing-checks', 'merged', 'closed'].includes(kind));
    if (verdict === 'merged') return;
    if (verdict === 'ci-all-green') {
      // Run outside any checkout, so --delete-branch removes the remote branch only.
      await this.must('gh', ['pr', 'merge', String(pr.number), '-R', repo, '--squash', '--delete-branch'], { cwd: tmpdir() });
      this.deps.log(`merged ${pr.url}`);
      return;
    }
    if (verdict === 'new-failing-checks') throw new ReleaseError(`${pr.url} has failing checks. Fix them, then run again.`);
    throw new ReleaseError(`${pr.url} ended ${verdict ?? 'without a CI verdict within an hour'}. Run again once it is settled.`);
  }

  // --- the Homebrew tap --------------------------------------------------

  private async afterPublish(): Promise<Outcome> {
    if (this.options.skipTap) return { state: 'published', formula: 'skipped' };
    const latest = await this.latest();
    if (latest && compareVersions(this.version, latest) < 0) {
      this.deps.log(`${this.version} is older than ${latest}, the version npm serves as latest, so the tap formula stays where it is`);
      return { state: 'published', formula: 'skipped' };
    }
    const formula = await this.readFormula('main');
    const tarball = (await this.must('npm', ['view', `${PACKAGE}@${this.version}`, 'dist.tarball'])).trim();
    if (formula.text.includes(`url "${tarball}"`)) return { state: 'published', formula: 'current' };

    const tapBranch = `bellwether-${this.version}`;
    let pr = await this.findPr(TAP, tapBranch);
    if (pr?.state === 'CLOSED') throw new ReleaseError(`${pr.url} was closed without a merge. Reopen it, or delete ${tapBranch} in ${TAP}, then run again.`);
    if (!pr) {
      const sha256 = createHash('sha256').update(await this.deps.fetchBytes(tarball)).digest('hex');
      const text = bumpFormula(formula.text, tarball, sha256);
      const exists = await this.deps.run('gh', ['api', `repos/${TAP}/git/ref/heads/${tapBranch}`]);
      if (exists.code !== 0) {
        const base = (await this.must('gh', ['api', `repos/${TAP}/git/ref/heads/main`, '--jq', '.object.sha'])).trim();
        await this.must('gh', ['api', '-X', 'POST', `repos/${TAP}/git/refs`, '-f', `ref=refs/heads/${tapBranch}`, '-f', `sha=${base}`]);
      }
      const onBranch = await this.readFormula(tapBranch);
      if (onBranch.text !== text) {
        await this.must('gh', ['api', '-X', 'PUT', `repos/${TAP}/contents/${FORMULA}`,
          '-f', `message=bellwether ${this.version}`, '-f', `branch=${tapBranch}`, '-f', `sha=${onBranch.sha}`,
          '-f', `content=${Buffer.from(text).toString('base64')}`]);
      }
      const body = await this.tempFile('tap-body.md', `The bellwether formula moves to ${this.version}, the tarball npm now serves, with its sha256.\n`);
      try {
        await this.must('gh', ['pr', 'create', '-R', TAP, '--base', 'main', '--head', tapBranch, '--title', `bellwether ${this.version}`, '--body-file', body.file]);
      } finally {
        await body.remove();
      }
      pr = await this.findPr(TAP, tapBranch);
      if (!pr) throw new ReleaseError(`no pull request in ${TAP} lists ${tapBranch} as its head`);
      this.deps.log(`opened ${pr.url}`);
    }
    await this.mergeWhenGreen(TAP, pr);
    return { state: 'published', formula: 'merged', tapPr: pr.url };
  }

  private async readFormula(ref: string): Promise<{ text: string; sha: string }> {
    const out = await this.must('gh', ['api', `repos/${TAP}/contents/${FORMULA}?ref=${ref}`]);
    const file = JSON.parse(out) as { content: string; sha: string };
    return { text: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
  }

  // --- plumbing ----------------------------------------------------------

  private async must(cmd: string, args: string[], options?: RunOptions): Promise<string> {
    const result = await this.deps.run(cmd, args, options);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new ReleaseError(`${cmd} ${args.join(' ')} exited ${result.code}${detail ? `:\n${detail}` : ''}`);
    }
    return result.stdout;
  }

  private async tempFile(name: string, text: string): Promise<{ file: string; remove: () => Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'bellwether-release-'));
    const file = path.join(dir, name);
    await writeFile(file, text, { mode: 0o600 });
    return { file, remove: () => rm(dir, { recursive: true, force: true }) };
  }
}

// --- command line --------------------------------------------------------

function runCommand(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_EDITOR: 'false', HOMEBREW_NO_AUTO_UPDATE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function main(argv: string[]): Promise<number> {
  const version = argv.find((arg) => !arg.startsWith('-'));
  if (!version || argv.includes('--help')) {
    console.log('Usage: npm run release -- <version> [--skip-tap]');
    return version ? 0 : 2;
  }
  const deps: ReleaseDeps = {
    run: runCommand,
    fetchBytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new ReleaseError(`GET ${url} answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(`release: ${line}`),
    cwd: process.cwd(),
  };
  try {
    const outcome = await release({ version, skipTap: argv.includes('--skip-tap') }, deps);
    if (outcome.state === 'awaiting-approval') {
      console.log(`\n${PACKAGE}@${version} is staged as ${outcome.stageId} and passed the registry's review.`);
      if (outcome.protocolChange) {
        console.log(approvalNotice(outcome.protocolChange));
      }
      console.log(`Approve it with your one-time code:\n\n  ${outcome.approve}\n\nThen run \`npm run release -- ${version}\` again to bump the Homebrew formula.`);
    } else {
      const formula = outcome.formula === 'merged' ? `the tap formula moved to ${version} in ${outcome.tapPr}` : outcome.formula === 'current' ? `the tap formula already points at ${version}` : 'the tap was skipped';
      console.log(`\n${installNotice(version, formula)}`);
    }
    return 0;
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
