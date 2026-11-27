# Releasing

Maintainers use this page. npm's staged publishing carries every version, so the operator's one-time code approves it. `npm run release` does the rest, and you run it twice:

```sh
npm run release -- 0.1.5    # gates, version bump, release PR, merge, stage, review
npx -y npm@12 stage approve <stage id> --otp <code>    # the person, with their code
npm run release -- 0.1.5    # the Homebrew formula and the documentation site
```

Each run reads where the release stands, then takes it one stage further:

1. Once npm serves the version, the script bumps `Formula/bellwether.rb` in `elecnix/homebrew-tap`. It downloads the tarball and writes the new `url` and `sha256` on a `bellwether-<version>` branch through the GitHub API. Then it opens the pull request and merges it once the tap's CI passes. The script leaves a formula alone when the formula already points at the version, or when the version is older than npm's `latest`.

   Next, it reads [the documentation site](https://elecnix.github.io/bellwether/) until the byline on its first page shows the version. The `pages` workflow deploys the site from `main`, which carries the version since the release pull request merged. It reads the page every 30 seconds for up to 15 minutes, because a deploy takes about two minutes and GitHub Pages lets a CDN serve a cached copy for ten more.

   When the site still shows another version after 15 minutes, the run fails. Its error gives the URL, the version on the page and the version released. Re-run the `pages` workflow, or run `npm run site` and inspect `_site/index.html`, then run the release again.

   On a machine without network access to the site, pass `--skip-site`. The script then prints that it skipped the site, and you open the page and check its byline yourself.

2. With the version staged on npm, the script waits up to 30 minutes while the registry's review shows `validating`, then prints the `stage approve` command. A rejected stage stops it.

3. If `origin/main` already declares the version, the script checks out the commit that set it in a `release-<version>` worktree beside the current one. After `npm ci` there, it checks that the packed tarball installs. Then it stages the version and continues as in step 2.

   The check installs the tarball into an empty global prefix and over the version npm serves as `latest`, each a throwaway prefix, then reads `bellwether --version` and `bellwether help`. A failed install stops the script before `npm stage publish`, naming the case and npm's error.

4. While a pull request from `release/<version>` is open, the script waits for its CI with `gh monitor`. Once every check passes, it squash-merges. A failing check stops it and leaves the pull request open.

5. With none of those in place, the script refuses a checkout with uncommitted changes, and an `origin/main` whose last `ci` run didn't pass. Next, it creates the `release-<version>` worktree from `origin/main` and runs `npm ci`, typecheck, the three test tiers and `doctor`. Then it bumps the version in `package.json` and `package-lock.json` and pushes `release/<version>` with a pull request. From there, it continues as in step 4.

Run it again after any stop, whether a failed check, a timeout or a closed terminal, and it resumes from the same stage. The script stops at the `stage approve` command and leaves the code to the person. The script runs on the machine's `gh` and `npm` logins, which need write access to both repositories and publish rights on the package. It doesn't use a token or an Actions secret.

After the release, follow [upgrading.md](upgrading.md) on each machine.

## The release pull request's description

`prBody` in `scripts/release.ts` writes the description of the release pull request from three parts, in this order:

1. The version it moves to, and the release before it.
2. A list headed "What <version> adds", with one line for each entry of `src/daemon/features.ts` whose `version` is the version released. The script reads the table from the `release-<version>` worktree, so the list matches the commit it releases. Tools come first, then requests, notices and arguments. A harness entry with `since` counts as the argument `agent_spawn.kind=<kind>`, so a new harness appears in its release. A release with no such entry says so in one line.
3. Whether the daemon protocol moves, with the steps for a protocol change when it does.

Each entry in `features.ts` carries a one-sentence `summary`, and the line repeats it. `npm run check:prose` lints the description for every version the table names, so a summary that fails Vale fails the `prose` job before it can fail a release. `test/unit/release.test.ts` fails when the description for a version leaves out an entry recorded under it.

## A release that changes the daemon protocol

Changing `DAEMON_PROTOCOL` in `src/daemon/protocol.ts` needs a new entry in `PROTOCOL_HISTORY` beside it. The entry says whether the change breaks the protocol before it. A daemon serves every protocol back to the newest breaking entry, so a change that only adds doesn't drop any session.

`npm run release` compares the value with the published `latest`, and flags a change in the release pull request and beside the approve command. Prefer an additive change, which doesn't need a new number. A new request or tool still gets an entry in `src/daemon/features.ts`, with the protocol and release that bring it and a one-sentence summary, so a newer session can name it when an older daemon refuses it and the release pull request lists it under its version.

Before the person approves a release that changes the protocol, the releasing agent does this:

1. Lists the live sessions with `bellwether doctor`, which gives the adapter version and protocol of each one.

2. Tells the person which sessions run a protocol below the new floor, if the change breaks one. Only those fail their tool calls after the upgrade, and each recovers when it restarts.

3. After the install steps, starts a session from the new install, which hands the daemon over. It stops a child of a refused session that still has to report, and resumes it with `agent_spawn` and `resume`, which starts it on the new install.
