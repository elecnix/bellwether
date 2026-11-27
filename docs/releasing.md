# Releasing

Maintainers use this page. npm's staged publishing carries every version, so the operator's one-time code approves it. `npm run release` does the rest, and you run it twice:

```sh
npm run release -- 0.1.5    # gates, version bump, release PR, merge, stage, review
npx -y npm@12 stage approve <stage id> --otp <code>    # the person, with their code
npm run release -- 0.1.5    # the Homebrew formula: bump, tap CI, merge
```

Each run reads where the release stands, then takes it one stage further:

1. Once npm serves the version, the script bumps `Formula/bellwether.rb` in `elecnix/homebrew-tap`. It downloads the tarball and writes the new `url` and `sha256` on a `bellwether-<version>` branch through the GitHub API. Then it opens the pull request and merges it once the tap's CI passes. The script leaves a formula alone when the formula already points at the version, or when the version is older than npm's `latest`.

2. With the version staged on npm, the script waits up to 30 minutes while the registry's review shows `validating`, then prints the `stage approve` command. A rejected stage stops it.

3. If `origin/main` already declares the version, the script checks out the commit that set it in a `release-<version>` worktree beside the current one. After `npm ci` there, it checks that the packed tarball installs. Then it stages the version and continues as in step 2.

   The check installs the tarball into an empty global prefix and over the version npm serves as `latest`, each a throwaway prefix, then reads `bellwether --version` and `bellwether help`. A failed install stops the script before `npm stage publish`, naming the case and npm's error.

4. While a pull request from `release/<version>` is open, the script waits for its CI with `gh monitor`. Once every check passes, it squash-merges. A failing check stops it and leaves the pull request open.

5. With none of those in place, the script refuses a checkout with uncommitted changes, and an `origin/main` whose last `ci` run didn't pass. Next, it creates the `release-<version>` worktree from `origin/main` and runs `npm ci`, typecheck, the three test tiers and `doctor`. Then it bumps the version in `package.json` and `package-lock.json` and pushes `release/<version>` with a pull request. From there, it continues as in step 4.

Run it again after any stop, whether a failed check, a timeout or a closed terminal, and it resumes from the same stage. The script stops at the `stage approve` command and leaves the code to the person. The script runs on the machine's `gh` and `npm` logins, which need write access to both repositories and publish rights on the package. It doesn't use a token or an Actions secret.

After the release, follow [upgrading.md](upgrading.md) on each machine.

## A release that changes the daemon protocol

Changing `DAEMON_PROTOCOL` in `src/daemon/protocol.ts` makes every running client either drain the daemon or fail. `npm run release` compares the value with the published `latest`, and flags a change in the release pull request and beside the approve command.

Before the person approves a release that changes the protocol, the releasing agent does this:

1. Lists the live sessions with `bellwether parents`, with the children each one runs.

2. Tells the person which sessions and children will fail their tool calls after the upgrade. Each recovers when it restarts.

3. After the install steps, runs `bellwether drain`, restarts its own session and asks the person to restart the others. It stops a child that still has to report and resumes it with `agent_spawn` and `resume`, which starts it on the new install.
