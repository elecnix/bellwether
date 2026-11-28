# Upgrading

Bellwether reaches a machine through three installs: the `bellwether` command, the Pi extension and the Claude Code plugin. Each one updates on its own. None needs a restart.

A session you start by hand after the upgrade runs the new code and hands the daemon over to it. A session that started earlier keeps working until it ends, so nobody has to coordinate the switch across a busy machine. On a machine where a daemon starts every session, nothing moves the daemon until you run one command, given in step 4.

## What you run on each machine

1. `brew upgrade bellwether` where the machine uses the tap. Without Homebrew, run `npm install -g @elecnix/bellwether`. On an SSH machine, a login shell finds both commands: `ssh host 'bash -lc "command -v brew bellwether"'`. You can also give the absolute path, such as `/opt/homebrew/bin/brew`. A plain `ssh host command -v brew` runs without the login shell's `PATH`. On a Mac, Homebrew adds `/opt/homebrew/bin` only in that login shell, so the plain probe finds neither `brew` nor `bellwether` on a machine that has both.
2. `pi install npm:@elecnix/bellwether` for the Pi extension, which Homebrew doesn't touch. When `pi list` also shows Bellwether at a checkout or another directory, the install adds the npm package beside that entry and leaves it there. Remove the old entry first, then install:

   ```sh
   cd ~/.pi/agent
   pi remove ../../path/to/bellwether
   pi install npm:@elecnix/bellwether
   ```

   Give `pi remove` the source exactly as `pi list` prints it, and run it from `~/.pi/agent`. pi's settings hold a relative source relative to that directory, but `pi remove` resolves it against the working directory, so from anywhere else it answers `No matching package found`. Order matters because a session started by hand loads every copy its settings list, and pi exits at startup when two extensions register the same tool. With the old entry removed first, a session that starts before the install ends runs without Bellwether tools, where the other order leaves a moment in which a new session doesn't start at all.
3. `claude plugin marketplace update elecnix-plugins`, then `claude plugin update bellwether@elecnix-plugins`. The marketplace installs the plugin from this repository's default branch, not from npm.
4. Start your next session by hand, as you would any other, and it hands the daemon over. On a machine where nobody starts a session by hand, because a parent's daemon starts every one, run the new install's `bellwether relay-bridge < /dev/null` instead. It hands the daemon over, then connects briefly. It exits when its input closes. Over SSH, give its absolute path or run it through `bash -lc`, as in step 1.

Leave the sessions that are already open alone. Then run `bellwether doctor` from the new install, and check that its `versions:` line shows the daemon on the new release.

## What happens next

One daemon runs per machine. Any client from a newer install hands it over on connecting, so the install that connects newest sets the daemon's code. Each of these is such a client:

- a Pi or Claude Code session you start by hand, which loads the extension or the plugin from its install
- `bellwether relay-bridge`, which a parent's daemon on another machine runs over SSH, and which you can run yourself
- `bellwether report`, which a child without an adapter runs to report
- a client that doesn't find a daemon at all, which starts one from its own install

Children that a daemon starts never hand that daemon over. The daemon gives each child the adapter from its own install: a pi child gets `-e` naming that install's extension, and a newer copy in pi's settings registers nothing. A Claude Code child's MCP config runs that install's channel server. So the child's adapter is never newer than the daemon's install. It loads whatever files sit at that install's path when the child starts. A daemon running from a directory with a version in its name, such as a Claude Code plugin cache, keeps giving its children that version after every install on the machine has moved on.

The first client from the new install finds the old daemon and hands it over in three steps:

- It asks the old daemon to drain. The old daemon stops taking connections, answers the calls it is running, a spawn halfway through included, and exits.
- Then a daemon starts from the new install. The registry, the outboxes and the relay outbox live on disk, so the new daemon picks up every child, every unread event and every report that waits for a parent on another machine.
- Each open session reconnects to the new daemon within a second. The new daemon serves every protocol back to the last change that broke an older session, so an older session's tools keep working. Those tools run in the new daemon, so even an older session gets the fixes that live there.

An older session keeps the adapter it loaded when it started: the Pi extension or the Claude Code channel server. A live session can't swap its adapter. When the session ends, its next start loads the new one. A session that a daemon started ends only when its parent stops or restarts it.

A daemon can run from none of the three installs. A Claude Code session that started from an older plugin cache can have started the daemon from that cache, and the daemon keeps running from there after the plugin updates. The `versions:` line in `bellwether doctor` gives the running daemon's version and its entry point. An entry point under `~/.claude/plugins/cache/` with an older version in its path is such a daemon. `bellwether relay-bridge < /dev/null` from the new install replaces it.

Sessions from two installs can run at once on one machine, such as a checkout and a package. The newer release always keeps the daemon, so the two never take turns replacing it.

On a machine you reach by SSH, the upgrade works the same way. When a parent's daemon connects, `bellwether relay-bridge` runs from that machine's install and hands over that machine's daemon if it is older.

## Tool lists across versions

A session's tool list comes from the daemon. The hello lists the tools, built from its feature table, and the session's adapter offers that list to the model. A session connected to an older adapter still gets each tool a newer daemon serves, such as `agent_move` and `agent_restart`, once that daemon answers.

Claude Code asks for the list again when the server says it changed. The pi extension takes each new tool into the running session. Neither needs a restart. A daemon from before the list leaves the choice to the adapter, which offers its own tools less each one that daemon does not serve.

## How to read doctor's upgrade status

`bellwether doctor` reports, for the machine it runs on:

- one `versions:` line. It gives this install's version, build and protocol, and the client protocols a daemon from it serves. It gives the running daemon's pid, version, protocol, build and entry point. Doctor reads the build and the entry point from the lock too, so it can report them even when the daemon doesn't answer. A daemon that `bellwether daemon` started records the daemon entry point of its own install, and doctor says a person started it by hand on its socket. A lock that a build before 0.1.5 wrote for such a daemon has no entry point, and doctor says so. It says whether the two are the same build, and what a session started from this install would do: keep the daemon, or hand it over. Doctor takes that clause from `decideHandOver`, which every client follows, so it never promises a hand-over that won't happen. A daemon with the same version as the install but another build keeps running until `bellwether drain` replaces it. `npm run build` records its commit and its time in `dist/build.json`, and the sources of a git checkout show their commit with `run from a checkout`.
- each socket under the Bellwether home, and whether something answers on it
- anything a crashed process left behind:
  - a lock whose pid no longer runs
  - a stale `daemon.starting` marker
  - a socket file that nothing answers on
- each connected session once, with the version, build and protocol of its adapter. Doctor tells sessions apart by their harness session id. A connection without one counts by its parent id. A Claude Code session whose plugin and per-child server both connect shows once, with the number of connections. For a session on code other than the daemon's, doctor lists the live children that would lose their parent if the session ended, and the unread events that wait for it.
- how this install and the running daemon pair up. Doctor gives the protocol each one speaks and the protocol they share. It lists each tool and request the daemon lacks, with the protocol and release that brought it. It also lists each tool the daemon serves that this install doesn't offer. Each list says which side gains by updating.
- for each remote machine the relay connects to: its daemon's release, and the tools that machine gains by updating
- one `tools` line for each harness. The line shows the server or extension that gives a session started by hand its Bellwether tools, and what a spawned child gets instead. For Claude Code, it lists each plugin or server the spawn keeps out of a child, and how. A session started by hand with two Bellwether servers gets a warning, because Bellwether can't remove one for you. For pi, a copy in pi's settings without the stand-down guard fails the line.
- what `agent_move` would find on each machine. Doctor gives each SSH call of this check 6 seconds, and a probe of another machine takes two calls, so a machine whose SSH doesn't connect shows as unknown instead of holding doctor for SSH's own timeout. Unknown means only that it did not answer in time: `agent_move` waits 120 seconds for each call, and a slow machine can still take a child.

Its last daemon line says one of five things:

- `upgrade: finished` when every session's adapter runs the daemon's build, or an older release that the daemon still serves. The daemon must also be running and accepting calls, with its hand-over done and every crash leftover gone. The line gives the daemon's build. `describeUpgrade` in `src/daemon/upgrade-status.ts` holds this definition.
- `upgrade: in progress` with the reason, such as an older daemon or a session on the daemon's version but another commit, and what the upgrade waits for. You don't need to restart anything. For an older daemon, the line says that the daemon's own children never hand it over, and gives `bellwether relay-bridge < /dev/null` to run from this install. For a session on another build, it waits for that session to end, which for a session a daemon started means its parent stops or restarts it. For a hand-over under way, it waits up to 90 s.
- `upgrade: not known to be finished` when doctor can't compare builds: the daemon didn't list its sessions, or the daemon or a session doesn't report its commit.
- `upgrade: this install ... is older than the daemon` when another install on the machine started a newer daemon. This install's sessions keep working on the daemon's code, without the tools named on the pairing line. Update this install when convenient.
- `upgrade: nothing to finish` when no daemon runs

A daemon from before 0.1.5 can't list its sessions. Until the first hand-over, doctor shows only its version and protocol, read from the lock.

`bellwether --version` prints the version and the commit of the install it runs from. It answers from the install alone, so a daemon of any protocol can't make it fail.

## Daemon protocol changes

A change to the wire between sessions and the daemon is additive whenever it can be. A new request or a new optional field doesn't need a new protocol number, because each side ignores what it doesn't know. Only a change an older peer would misread raises the protocol number.

A session and a daemon of different releases work out what they share, so neither side has to restart for the other:

- The session always sends hello first, and the daemon's reply tells it whether the two can talk.
- When the session can't start daemons or can't order the two releases, an older daemon stays and the session speaks its protocol. A tool the daemon lacks fails with its name, such as `` "`agent_move` needs protocol 4 (Bellwether 0.1.5); this daemon serves protocol 3 (Bellwether 0.1.4). Upgrade the machine holding the daemon when convenient." `` Everything else works as before.
- The session logs a reply it doesn't know, such as a new push or a new field, once and ignores it.

The daemon serves every protocol back to the last change that removed a request or changed its meaning. A change that only adds leaves that floor in place.

Today the floor is protocol 2, so a 0.1.3 or 0.1.4 session works with the current daemon.

A session below the floor gets an error. The error quotes the daemon's protocols and names the install to update. End that session and start it again from the new install. To recover a child that still has to report, stop it and resume it with `agent_spawn` and `resume`, which starts it on the new install.

A parent's machine and a child's machine each run their own install. Protocol 4 changed the relay between them. A machine still on a 0.1.x release from before protocol 4 can't take part until it updates. Until then, `bellwether doctor` on the parent's machine shows that machine as `reconnecting`, with the error from the far end.

## A build npm hasn't published

To run a commit ahead of the next release, build it in a checkout. npm takes a tarball packed from that checkout, and pi takes the checkout directory itself. Never install from a git URL such as `npm install -g github:elecnix/bellwether#main`.

Every npm tested in [#57](https://github.com/elecnix/bellwether/issues/57) fails that command, and uninstalling first doesn't help. npm leaves the installed package as it was.

```sh
git clone --depth 1 https://github.com/elecnix/bellwether.git && cd bellwether
npm ci && npm run build && npm install -g "$(npm pack --silent)"
```

For the Pi extension, run `pi install /path/to/bellwether`, naming the built checkout. pi loads a local package only from a directory.

Never give pi the tarball. `pi install ./elecnix-bellwether-0.1.4.tgz` accepts the path and writes it into `~/.pi/agent/settings.json`, and the next session start then fails with `Failed to load extension ".../elecnix-bellwether-0.1.4.tgz": Unknown file extension ".tgz"`. That session doesn't load any Bellwether extension at all, so it has no Bellwether tools and hears no events from its children.

To repair a settings entry that points at a tarball, remove it with `pi remove`. Pass the source exactly as `pi list` prints it. Then install the checkout you packed the tarball from, and restart the session:

```sh
pi remove /path/to/elecnix-bellwether-0.1.4.tgz
pi install /path/to/bellwether
```

To confirm that the checkout and the tarball contain the same build, unpack the tarball and compare the two `dist/` directories. The `diff` prints nothing when they match:

```sh
mkdir /tmp/bw-dist && tar -xzf elecnix-bellwether-0.1.4.tgz -C /tmp/bw-dist
diff -rq /tmp/bw-dist/package/dist /path/to/bellwether/dist
```

A build like this has the version number of the release it follows. A daemon with that same number doesn't hand over to it, so run `bellwether drain` after the install to start the build's daemon.

A release installs from the npm registry and doesn't need this. It installs over the version already there, with no uninstall first, and `npm run release` proves that before it stages anything: it installs the release tarball into an empty global prefix and over the previous release, then checks `bellwether --version` and `bellwether help` in each. When either install fails, the release stops before npm sees it, with the case, npm's exit code and npm's own error line.

Check a doubtful install with `npm ls -g @elecnix/bellwether` and `bellwether help | grep relay-bridge`. Repair a missing or partial package directory in three steps:

1. Run `npm uninstall -g @elecnix/bellwether`.
2. Delete any `<prefix>/lib/node_modules/@elecnix/.bellwether-*` directory npm left behind. `npm prefix -g` prints `<prefix>`.
3. Install from the registry, or from a packed tarball for a build npm hasn't published.

Every git-URL install in [#57](https://github.com/elecnix/bellwether/issues/57) left an existing package whole. These steps are for one that doesn't.

## If it goes wrong

`bellwether drain` stops the running daemon once its calls finish, whatever its version. Each open session then reconnects and starts a daemon from its own install. The daemon that comes back is the one from the first session to reconnect.

Use drain when doctor shows a daemon that won't hand over, or to choose between two copies of the same release, such as a checkout and a package.

To go back to the old procedure in full, run `bellwether drain`, then end and restart every Pi and Claude Code session on the machine. You shouldn't need it. It is still the answer when a session runs a release older than the daemon serves.
