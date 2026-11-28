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

3. If `origin/main` already declares the version, the script checks the pull requests merged into that commit, as [A pull request that merges during the gates](#a-pull-request-that-merges-during-the-gates) describes. It then checks out the commit that set the version in a `release-<version>` worktree beside the current one. After `npm ci` there, it checks that the packed tarball installs. Then it stages the version and continues as in step 2.

   The check installs the tarball into an empty global prefix and over the version npm serves as `latest`, each a throwaway prefix, then reads `bellwether --version` and `bellwether help`. A failed install stops the script before `npm stage publish`, naming the case and npm's error.

4. While a pull request from `release/<version>` is open, the script waits for its CI with `gh monitor`. Once every check passes, it squash-merges. A failing check stops it and leaves the pull request open.

5. With none of those in place, the script refuses a checkout with uncommitted changes, and an `origin/main` whose last `ci` run didn't pass. Next, it creates the `release-<version>` worktree from `origin/main` and runs `npm ci`. It then stops on any pull request merged since the last release that has no line, as [Each merged pull request needs a line](#each-merged-pull-request-needs-a-line) describes. After that it runs `vale sync`, then typecheck, the three test tiers and `doctor`. Then it bumps the version in `package.json` and `package-lock.json` and pushes `release/<version>` with a pull request. From there, it continues as in step 4.

   A new worktree has no Vale style packs, and the prose gate in the unit tier needs them. `vale sync` fetches the two packages that `.vale.ini` pins, so the gate runs with the rules CI uses. A failed sync stops the run before the tests start, and its error gives the command to run in that worktree.

   Typecheck, tests and `doctor` run by hand in a new worktree need the same step: run `vale sync` there after `npm ci`. Without it, `npm run check:prose` and the prose cases in the unit tier stop with the same command.

Run it again after any stop, whether a failed check, a timeout or a closed terminal, and it resumes from the same stage. The script stops at the `stage approve` command and leaves the code to the person. The script runs on the machine's `gh` and `npm` logins, which need write access to both repositories and publish rights on the package. It doesn't use a token or an Actions secret.

After the release, follow [upgrading.md](upgrading.md) on each machine.

## The release pull request's description

`prBody` in `scripts/release.ts` writes the description of the release pull request from four parts, in this order:

1. The version it moves to, and the release before it.
2. A list headed "What <version> changes", with one line for each note under `release-notes/<version>/`. Each line gives the note's text and the pull requests that brought it, in the order they merged.
3. A list headed "What <version> adds to the protocol", with one line for each entry of `FEATURES` whose `version` is the version released. Tools come first, then requests, notices and arguments. A harness entry with `since` counts as the argument `agent_spawn.kind=<kind>`, so a new harness appears in its release.
4. Whether the daemon protocol moves, with the steps for a protocol change when it does.

A reader learns what the release does before what it adds to the wire. When a list would be empty, the description says so in one line. The script reads the notes and the table from the `release-<version>` worktree, so the lists match the commit it releases.

Each note and each entry's `summary` is one paragraph, and the line repeats it. `npm run check:prose` lints the description for every version a note or the table names, so a note that fails Vale fails the `prose` job before it can fail a release. `test/unit/release.test.ts` fails when the description for a version leaves out an entry recorded under it.

## Each merged pull request needs a line

The 0.1.7 description listed four wire entries but left out three changes a person would want to read about:

- an adopted session gaining `parent_report` ([#152](https://github.com/elecnix/bellwether/pull/152))
- the roster line ([#154](https://github.com/elecnix/bellwether/pull/154))
- retirement removing a worktree ([#151](https://github.com/elecnix/bellwether/pull/151))

None of them was a wire feature, so nothing prompted an entry ([#157](https://github.com/elecnix/bellwether/issues/157)).

Before its gates, the script lists the pull requests merged into `origin/main` since the commit that set `package.json` to the previous release. Main takes squash merges, so the number at the end of each first-parent subject names the pull request. Each one's labels come from `gh pr view`. The release stops when a pull request has neither of these:

- a note under `release-notes/<version>/` for a change in what Bellwether does, or the `prs` of a `FEATURES` entry for a tool, request, notice or argument;
- the `release-note: none` label, for a change a person would not read about. Examples are a test fix, a typo, a dependency bump and a fix to the release tooling.

The error lists each such pull request with its title and how to add either one. It stops before any push or stage, so notes go in through a pull request of their own, never mid-release.

### A pull request that merges during the gates

GitHub squash-merges the release branch into `origin/main` as main stands at that moment. A pull request that merged while the gates ran goes out in the release, although the check before the gates never saw it ([#211](https://github.com/elecnix/bellwether/issues/211)). So the script checks again before it stages. It lists the pull requests from the previous release commit up to the release commit, and reads the notes and `FEATURES` on `origin/main` as it stands then. When one of them has neither a line nor the label, the release stops before `npm stage publish`. Add a note under `release-notes/<version>/` whose front matter names that pull request, or give it the label, then run the script again.

### A note under a published version

Both checks also stop on a note added since the previous release under that version or an older one, when that version's release commit doesn't carry the change. npm already serves that version, so no release would list the note, and a label on its pull request would hide it. The error lists each such file with the reason. Move it under the version you release.

A note stays under its version when its front matter lists each pull request it describes, and the commit that set that version has all of them as ancestors. [#206](https://github.com/elecnix/bellwether/pull/206) moved the notes that 0.1.7 to 0.1.9 had published into files after 0.1.9, and each of those lists pull requests that merged before its version's release. The check reads that ancestry from git, never from a date, because a squash merge keeps its author's date and a rebase moves it.

A note with no `prs:` belongs to the pull request that added it. That pull request merged after the previous release, so leaving the front matter out never gets a note past the check.

### A pull request that deletes another's record

Suppose a commit has the current `main` as its parent but contains the tree of an older checkout. Its squash merge writes that older tree over `main`, which deletes every pull request merged since then. Nothing in CI fails. Each deleted feature took its tests with it, and what remains still compiles. `e16cc52`, the squash of [#289](https://github.com/elecnix/bellwether/pull/289), deleted three merged pull requests this way ([#296](https://github.com/elecnix/bellwether/issues/296)).

The `merged-work` check fails a pull request whose diff against its merge base deletes a file under `release-notes/` or removes an entry from `FEATURES`. That diff starts at the merge base, so a branch behind `main` passes, and a note the pull request added itself never shows as deleted. Run `npm run check:merged-work -- --base origin/main` to get the same answer locally.

To remove merged work on purpose, a person applies the `removes-merged-work` label and writes the reason in the description.

The check reads only these two records. A reverted code change with no note or entry passes it, as does a deletion of something that has neither. It runs only on a pull request, so a commit pushed or merged outside one never meets it.

## A note is a file of its own

A change in behavior adds one file, `release-notes/<version>/<name>.md`, in its own pull request. Its one paragraph says what someone can now do, or what now happens. Name it after the change, in lowercase letters, digits, dots and hyphens:

```markdown
Doctor gives each SSH call of its move check 6 s, and reports a machine that does not answer in time as unknown.
```

The note doesn't need the pull request's number, which doesn't exist while you write it. Main takes squash merges, so the commit that adds the file ends with `(#N)`, and the release reads the number from that commit. A later edit to the file keeps it on the pull request that added it.

A note that a later pull request adds, for a change that merged without one, names that change in front matter. Otherwise the release would credit the note to the later pull request:

```markdown
---
prs: [181]
---
A spawn counts a brief taken once the child's model begins a turn on it or reads it.
```

Front matter also covers a note for several pull requests, and a note moved to another version's directory, because git records a move as a rename rather than an addition.

Until 0.1.9, every note was a line in one array in `src/daemon/features.ts`. Each pull request appended to its end, so two pull requests open together conflicted on adjacent lines. One pull request merged `main` three times in twenty minutes for that reason, and each merge cost a full CI run ([#182](https://github.com/elecnix/bellwether/issues/182)). Each pull request now adds a file of its own, and git merges them without a conflict. `test/unit/release-notes.test.ts` shows both against a real repository. The entries already recorded moved to files that name their pull requests in front matter.

## A release that changes the daemon protocol

Changing `DAEMON_PROTOCOL` in `src/daemon/protocol.ts` needs a new entry in `PROTOCOL_HISTORY` beside it. The entry says whether the change breaks the protocol before it. A daemon serves every protocol back to the newest breaking entry, so a change that only adds doesn't drop any session.

`npm run release` compares the value with the published `latest`, and flags a change in the release pull request and beside the approve command. Prefer an additive change, which doesn't need a new number. A new request or tool still gets an entry in `src/daemon/features.ts`, with the protocol and release that bring it, the pull request, and a one-sentence summary, so a newer session can name it when an older daemon refuses it and the release pull request lists it under its version.

Before the person approves a release that changes the protocol, the releasing agent does this:

1. Lists the live sessions with `bellwether doctor`, which gives the adapter version and protocol of each one.

2. Tells the person which sessions run a protocol below the new floor, if the change breaks one. Only those fail their tool calls after the upgrade, and each recovers when it restarts.

3. After the install steps, starts a session from the new install, which hands the daemon over. It stops a child of a refused session that still has to report, and resumes it with `agent_spawn` and `resume`, which starts it on the new install.
