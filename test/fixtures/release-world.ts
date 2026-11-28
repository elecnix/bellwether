// A release run against real git: a scratch origin, a clone where other people's
// pull requests merge, and the operator's clone that runs scripts/release.ts.
// npm and gh are scripted. GitHub's squash merge of the release pull request
// lands on main as it stands at that moment, after anything that merged while
// the gates ran, as it does on GitHub. The run stops at `npm pack`, the first
// step of staging, so a run that reaches it would have staged the version.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { release, type ReleaseDeps, type RunOptions, type RunResult } from '../../scripts/release.ts';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_EDITOR: 'false',
};
const STAGING = 'SENTINEL: the release reached staging';
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function git(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: GIT_ENV }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function mustGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** What one release run did: reached staging, or refused with the pull requests it named. */
export interface ReleaseRun {
  staged: boolean;
  /** The pull request numbers the refusal lists, one per `  #N title` line. */
  missing: number[];
  error?: string;
  logs: string[];
  /** The release pull request's description as the run left it, from `gh pr create` and any later `gh pr edit`. */
  description?: string;
}

export interface ReleaseRunOptions {
  /** Runs while `npm test` runs in the release worktree, after the release check. */
  duringGates?: () => Promise<void>;
  /** Runs once GitHub has squash-merged the release pull request, before the run reads main again. */
  afterRelease?: () => Promise<void>;
}

export interface ReleaseWorld {
  root: string;
  /** Squash-merge a pull request onto main: its subject ends with `(#N)` when it has a number. */
  merge(subject: string, files: Record<string, string>, labels?: string[]): Promise<void>;
  /** Run the release of `version` from the operator's clone, up to staging. */
  release(version: string, options?: ReleaseRunOptions): Promise<ReleaseRun>;
  /** npm serves `version` from now on, as an approved stage would make it. */
  publish(version: string): void;
  /** Give a merged pull request a label, as `gh pr edit --add-label` does. */
  label(pr: number, name: string): void;
}

export async function releaseWorld(first = '0.1.0'): Promise<ReleaseWorld & { cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'bellwether-release-world-'));
  const origin = path.join(root, 'origin.git');
  const side = path.join(root, 'side');
  const top = path.join(root, 'main');
  await mustGit(root, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  await mustGit(root, ['clone', '--quiet', origin, side]);

  const labels = new Map<number, string[]>();
  const titles = new Map<number, string>();
  const published: string[] = [];
  let nextPr = 900;
  // GitHub keeps a merged release pull request, so a later run of the same version finds it by its head.
  const releasePrs = new Map<string, { number: number; state: 'OPEN' | 'MERGED'; url: string; branch: string; body: string }>();
  let releasePr: { number: number; state: 'OPEN' | 'MERGED'; url: string; branch: string; body: string } | undefined;

  async function write(dir: string, files: Record<string, string>): Promise<void> {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
  }

  async function merge(subject: string, files: Record<string, string>, prLabels: string[] = []): Promise<void> {
    await mustGit(side, ['fetch', '--quiet', 'origin']);
    // The first commit goes onto an empty origin, which has no main to start from.
    if ((await git(side, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])).code === 0) {
      await mustGit(side, ['checkout', '--quiet', '-B', 'main', 'origin/main']);
    }
    await write(side, files);
    await mustGit(side, ['add', '-A']);
    await mustGit(side, ['commit', '--quiet', '-m', subject]);
    await mustGit(side, ['push', '--quiet', 'origin', 'HEAD:main']);
    const match = /^(.*) \(#(\d+)\)$/.exec(subject);
    if (match) {
      labels.set(Number(match[2]), prLabels);
      titles.set(Number(match[2]), match[1]!);
    }
  }

  // The commit that set the first published version, with the files a release reads.
  await merge(`release: ${first}`, {
    'package.json': json({ name: '@elecnix/bellwether', type: 'module', version: first }),
    'package-lock.json': json({ name: '@elecnix/bellwether', version: first }),
    '.claude-plugin/plugin.json': json({ name: 'bellwether', version: first }),
    'src/daemon/features.ts': 'export const FEATURES = [];\n',
    'src/daemon/protocol.ts': 'export const DAEMON_PROTOCOL = 3;\n',
  });
  published.push(first);
  await mustGit(root, ['clone', '--quiet', origin, top]);

  async function squashRelease(): Promise<void> {
    const pr = releasePr!;
    await mustGit(side, ['fetch', '--quiet', 'origin']);
    await mustGit(side, ['checkout', '--quiet', '-B', 'main', 'origin/main']);
    await mustGit(side, ['merge', '--quiet', '--squash', `origin/${pr.branch}`]);
    await mustGit(side, ['commit', '--quiet', '-m', `release: ${pr.branch.slice('release/'.length)} (#${pr.number})`]);
    await mustGit(side, ['push', '--quiet', 'origin', 'HEAD:main']);
    await mustGit(side, ['push', '--quiet', 'origin', '--delete', pr.branch]);
    pr.state = 'MERGED';
  }

  async function runRelease(version: string, options: ReleaseRunOptions = {}): Promise<ReleaseRun> {
    const logs: string[] = [];
    releasePr = releasePrs.get(`release/${version}`);
    const run = async (cmd: string, args: string[], runOptions: RunOptions = {}): Promise<RunResult> => {
      const line = `${cmd} ${args.join(' ')}`;
      const cwd = runOptions.cwd ?? top;
      if (cmd === 'git') return git(cwd, args);
      if (line.startsWith('npm view @elecnix/bellwether@') && line.endsWith(' version')) {
        const asked = args[1]!.split('@').pop()!;
        return published.includes(asked) ? ok(`${asked}\n`) : { code: 1, stdout: '', stderr: 'npm error code E404' };
      }
      if (line === 'npm view @elecnix/bellwether dist-tags.latest') return ok(`${published.at(-1)}\n`);
      if (line.endsWith(' dist.tarball')) return ok('https://registry.npmjs.org/@elecnix/bellwether/-/bellwether.tgz\n');
      if (line.startsWith('tar -xzOf')) return ok('export const DAEMON_PROTOCOL = 3;\n');
      if (line.startsWith('npx -y npm@12 stage list')) return ok('[]');
      if (line === 'npm ci' || line === 'vale sync' || line === 'npm run typecheck' || line === 'npm run doctor') return ok();
      if (line === 'npm test') {
        await options.duringGates?.();
        return ok();
      }
      if (line.startsWith('npm version ')) {
        for (const file of ['package.json', 'package-lock.json']) {
          const manifest = JSON.parse(await readFile(path.join(cwd, file), 'utf8')) as Record<string, unknown>;
          await writeFile(path.join(cwd, file), json({ ...manifest, version: args[1] }));
        }
        return ok();
      }
      if (line.startsWith('npm pack')) throw new Error(STAGING);
      if (line.startsWith('gh run list')) return ok(JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success' }]));
      if (line.startsWith('gh pr list')) return ok(JSON.stringify(releasePr ? [{ number: releasePr.number, state: releasePr.state, url: releasePr.url }] : []));
      if (line.startsWith('gh pr create')) {
        const branch = args[args.indexOf('--head') + 1]!;
        const number = nextPr++;
        const body = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
        releasePr = { number, state: 'OPEN', url: `https://github.com/elecnix/bellwether/pull/${number}`, branch, body };
        releasePrs.set(branch, releasePr);
        return ok(`${releasePr.url}\n`);
      }
      if (line.startsWith('gh pr edit') && args.includes('--body-file')) {
        if (!releasePr || Number(args[2]) !== releasePr.number) throw new Error(`gh pr edit names #${args[2]}, which is not the release pull request`);
        releasePr.body = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
        return ok(`${releasePr.url}\n`);
      }
      if (line.startsWith('gh monitor')) return ok(`${JSON.stringify({ type: 'ci-all-green' })}\n`);
      if (line.startsWith('gh pr merge')) {
        await squashRelease();
        await options.afterRelease?.();
        return ok();
      }
      if (line.startsWith('gh pr view')) {
        const number = Number(args[2]);
        return ok(JSON.stringify({ number, title: titles.get(number) ?? `release ${number}`, labels: (labels.get(number) ?? []).map((name) => ({ name })) }));
      }
      throw new Error(`the release world has no script for: ${line}`);
    };
    const deps: ReleaseDeps = {
      run,
      fetchBytes: async () => new Uint8Array(),
      fetchText: async () => ({ status: 500, text: '' }),
      sleep: async () => {},
      log: (entry) => logs.push(entry),
      cwd: top,
    };
    try {
      await release({ version, skipSite: true, skipTap: true }, deps);
      return { staged: false, missing: [], error: 'release() returned before staging', logs };
    } catch (error) {
      const message = (error as Error).message;
      const description = releasePr?.body;
      if (message.includes(STAGING)) return { staged: true, missing: [], logs, description };
      return { staged: false, missing: [...message.matchAll(/^ {2}#(\d+) /gm)].map((m) => Number(m[1])), error: message, logs, description };
    } finally {
      // The operator's next run starts from a clean slate, as after a finished release.
      await git(top, ['worktree', 'remove', '--force', path.join(root, `release-${version}`)]);
      await git(top, ['branch', '-D', `release/${version}`]);
    }
  }

  return {
    root,
    merge,
    release: runRelease,
    publish: (version) => void published.push(version),
    label: (pr, name) => void labels.set(pr, [...(labels.get(pr) ?? []), name]),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
