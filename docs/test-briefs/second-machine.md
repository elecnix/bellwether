# Checks on a second machine

The fake `ssh` in tier 2 runs every hop on one machine, so it can't show how the relay behaves between two. Before any release that changes the relay, run the checks below by hand on two real machines.

PARENT is the machine where the parent session runs. CHILD is the label of the other machine in `herdr machine list --json` on PARENT. Both paths use only the one key that spawning already needs: SSH from PARENT to CHILD, with no prompt. You don't need a key on CHILD for PARENT, and you don't need root on either machine.

Run the isolated harness first. It leaves CHILD's live Bellwether alone. Then run the global path, which proves the two parts the harness skips, at the cost of taking over CHILD's live Bellwether install, its daemon and its `~/.bellwether` while it runs.

## The global path changes the live install on CHILD

In order, the global path changes CHILD like this:

1. Set-up step 1, `npm install -g`, replaces the global Bellwether install on CHILD. Each Claude Code child on CHILD starts its MCP server from that install, so it runs the new version from its next start.

2. Set-up step 4, `bellwether drain`, drains CHILD's live daemon. From then on, a child on CHILD that runs the old protocol can't report to its parent.

3. Set-up step 5, the spawn, opens a tab in CHILD's live herdr. On CHILD, `relay-register` writes the child's record, brief and MCP config into the live `~/.bellwether`.

4. Every check talks to CHILD's live daemon. The bridge finds the global `bellwether` through CHILD's PATH and runs against CHILD's default home and socket.

Pick a CHILD with no Bellwether child you want to keep. That choice is what makes the global path safe.

## The isolated harness

`scripts/relay-check/` holds a harness that runs all four checks against a Bellwether home and an install prefix under `/tmp` on CHILD:

- `parent.ts` starts a daemon on PARENT with a home of its own. Its registry holds one placeholder child on CHILD. That child is kind `claude` and runs nowhere, because a `pi` child would make `relay-register` check CHILD's pi settings.
- `parent.ts` gives its daemon `ssh.sh` in place of `ssh`. The script calls the real `ssh` with the same options, and runs the remote command with `BELLWETHER_HOME`, `BELLWETHER_DAEMON_SOCKET` and a PATH prefix under `/tmp` on CHILD.

The harness writes to three places:

- On PARENT, the home given to `parent.ts`.
- On CHILD, a directory such as `/tmp/bwc-x` with a home and one install prefix per build.
- On CHILD, entries in the npm cache under `~/.npm`.

Afterwards, CHILD shows only the npm cache entries and its SSH log lines, once you delete the `/tmp` directory. Its live daemon keeps its pid, and the global install and the live `~/.bellwether` stay as they were.

To run it:

1. On PARENT, build and pack the build under test: `npm ci && npm run build && npm pack`. Copy the tarball to CHILD.

2. On CHILD, `X=$(mktemp -d /tmp/bwc-XXXXXX)`, then `npm install -g --prefix "$X/prefix" <tarball>` and, for check 4, `npm install -g --prefix "$X/old" @elecnix/bellwether@0.1.4`. Both prefixes stay under `$X`.

   Run `$X/old/bin/bellwether` only with the two variables of step 4 set. The 0.1.4 on npm has no `--version`: it reads any word it doesn't know as a session command, and it connects to the daemon of whatever home it finds. When none answers, it starts one there, and without the variables, that is CHILD's live `~/.bellwether`. npm's 0.1.4 and a build of `main` both call themselves 0.1.4, so a version check tells two builds apart only when the build under test is a packed tarball, whose `bellwether --version` prints its commit. Tell npm's 0.1.4 by `bellwether help | grep relay-bridge`, which doesn't print anything there.

3. On PARENT, make the home with `PH=$(mktemp -d /tmp/bwp-XXXXXX)`. The daemon's socket is in that home, and a Unix socket path can't exceed 108 bytes on Linux or 104 on macOS, so a home under a long directory, such as an agent's scratchpad, fails with `listen EINVAL`. Then `export RELAY_CHECK_HOME=$X/home RELAY_CHECK_PREFIX_FILE=$PWD/prefix`, write `$X/prefix` into that file, and start `node scripts/relay-check/parent.ts --home "$PH" --host CHILD`. It prints the `relay-register` command for the next step.

4. On CHILD, run that command with `BELLWETHER_HOME=$X/home BELLWETHER_DAEMON_SOCKET=$X/home/daemon.sock` and `$X/prefix/bin/bellwether`.

5. Run checks 1 to 4 below. Where a check says `bellwether` on CHILD, use `$X/prefix/bin/bellwether` with the same two variables. Where it says `~/.bellwether`, read `$X/home`. A report from the child is `bellwether report --child relay-check-child --status done --text <text>`. Check 4 switches the far end by writing `$X/old` into the prefix file, then cuts the connection as check 3 does.

6. Stop `parent.ts`, run `BELLWETHER_HOME=$X/home $X/prefix/bin/bellwether drain --socket $X/home/daemon.sock` on CHILD, and delete `$X` on CHILD and `$PH` on PARENT. Without `BELLWETHER_HOME`, drain describes the lock in `~/.bellwether` rather than the daemon it drained, and can print `from before 0.1.5 on protocol unknown` for a daemon on protocol 4 ([#110](https://github.com/elecnix/bellwether/issues/110)).

## The harness skips the global lookup and the spawn

The harness covers the transport, from the connection and its keepalives through the reconnect and the bridge's exit to a far end on the old protocol. It skips the two parts that the operator's own use depends on:

- **The remote PATH lookup of a global `bellwether`.** The wrapper's PATH prefix decides which binary runs, so a CHILD whose non-interactive PATH can't find the global install passes the harness.
- **The spawn step.** You register the placeholder child with `relay-register` yourself, and its reports come from `bellwether report`. A spawn never runs, so the harness doesn't open a tab or show a real child calling `parent_report`.

A green harness doesn't prove either. Only the global path proves them, so run it as well, on a CHILD with nothing to lose.

## Set-up for the global path

1. Install the build under test on both machines from a packed tarball, as `docs/upgrading.md` describes under "A build npm hasn't published". A global install from a git URL fails. Put it first on the PATH: on a PARENT whose `bellwether` comes from Homebrew, `npm install -g --prefix ~/.npm-global <tarball>` works when `~/.npm-global/bin` comes earlier, and leaves the Homebrew package alone.

2. On both machines, `bellwether --version` prints the commit under test, and `bellwether help | grep relay-bridge` prints one line. npm's 0.1.4 fails both: it has no `--version`, and its help has no `relay-bridge`.

3. On CHILD, point pi at the installed package directory: `pi remove npm:@elecnix/bellwether`, then `pi install "$(npm root -g)/@elecnix/bellwether"`. Without it, the pi spawn in step 5 fails: `relay-register --kind pi` refuses when CHILD's pi settings load an older Bellwether, one without the guard from [#50](https://github.com/elecnix/bellwether/pull/50). `pi install npm:@elecnix/bellwether` installs npm's 0.1.4, which lacks that guard, and pi takes a directory, never the tarball. Remove the npm entry first, because two copies register the tools twice.

   The directory stays in pi's settings until a release includes the guard; once npm has it, `pi remove` the directory and `pi install npm:@elecnix/bellwether` again.

4. Drain both machines with `bellwether drain`, so that each starts its next daemon from the install under test. A parent session may run its own copy, such as a Claude Code plugin. Whichever session reconnects first starts the daemon.

   On PARENT, run `bellwether drain` and start `bellwether daemon` detached in the same command. Then check that each machine's `daemon.lock` names a daemon of the build under test. The lock's `entry` must lie under the tarball's install. For a daemon that `bellwether daemon` started, which writes a lock without an `entry`, check instead that a pid's command line runs that install, because doctor's claim that the daemon predates the field is wrong for that case ([#111](https://github.com/elecnix/bellwether/issues/111)).

5. From a parent session on PARENT, call `agent_spawn` with `kind: "pi"`, `name: "relay-check"` and `machine: "CHILD"`.

## 1. The profile resolves from PARENT

- On PARENT, `bellwether doctor` prints `ok    relay CHILD: connected since <time> as <target>`, where `<target>` is the SSH target from the profile. Doctor leaves out `as <target>` when the target equals the label.
- Ask the child to call `parent_report`. The parent session receives the report, and `ls ~/.bellwether/relay/outbox/` on CHILD lists nothing.
- On CHILD, run `D=$(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.bellwether/daemon.lock", "utf8")).pid')`. With the harness, read `$X/home/daemon.lock` instead. Then `pgrep -P "$D" -l ssh` and `ss -tnp | grep "pid=$D,"` both come back empty. The daemon on CHILD has no ssh child and no TCP connection of its own, so it never connects to PARENT.

An earlier version of this page read the lock with `require`, which fails: the lock has no `.json` extension, so Node parses it as JavaScript. The pid then comes back empty, and the empty results after it don't prove anything.

## 2. Keepalives catch a dead link

The SSH session on CHILD that carries the bridge runs as your own user, so you can stop it without root. A frozen session can't answer keepalives, and PARENT sees that as a dead link.

- On CHILD, find the session with `P=$(pgrep -f 'bellwether relay-bridge' | head -1); while [ "$P" -gt 1 ] && ! ps -o args= -p "$P" | grep -q '^sshd'; do P=$(ps -o ppid= -p "$P" | tr -d ' '); done; ps -o pid=,user=,args= -p "$P"`. The output shows your user and `sshd-session: <you>@notty` on OpenSSH 9.8 and later, or `sshd: <you>@notty` before it. The `^sshd` test matches both.
- Freeze the session for 90 seconds in a subshell that resumes it on the way out, even when you press Control-C or the terminal closes: `( trap 'kill -CONT "$P"' EXIT HUP INT TERM; kill -STOP "$P"; sleep 90 )`.
- During the freeze, PARENT loses the link within 45 to 60 seconds. `ServerAliveInterval=15` and `ServerAliveCountMax=3` set that window.
- PARENT then reconnects on a new session, and doctor prints `connected` with a new `since` time.
- Read the loss and the reconnect in the parent daemon's log, `relay: lost machine CHILD` and then `relay: connected to machine CHILD`. On one network the reconnect takes under two seconds, and one `bellwether doctor` call takes about four, because doctor also probes every machine for moves. So doctor almost never prints `fail  relay CHILD: reconnecting` in this check, and the log is the evidence. A daemon you started detached with its output on `/dev/null` doesn't keep a log: start it with its output in a file.
- The error in the `lost machine` line should mention a timeout. While the far machine's Node prints a warning on standard error, the line quotes that warning instead, such as `(node:6467) ExperimentalWarning: SQLite is an experimental feature`, until a release fixes [#109](https://github.com/elecnix/bellwether/issues/109).
- Ask the child to report while the old session is frozen. The report arrives once, over the new connection.
- About 45 seconds after the freeze, before the subshell ends, the bridge under the frozen session exits: its parent has sent nothing for three heartbeats. `pgrep -af 'bellwether relay-bridge'` on CHILD then prints one process. A build from before the heartbeat keeps both bridges until the session resumes.
- When the subshell ends, it resumes the old session. That session has lost its connection, so it exits.

A `kill -9` of that subshell is the one exit no trap can catch. If a check fails partway, look for a session left stopped, and resume it:

```sh
ps -o pid=,stat=,args= -u "$USER" | awk '$2 ~ /^T/ && $3 ~ /^sshd/'
kill -CONT <pid>
```

## 3. The bridge exits when sshd hangs up

- On CHILD, `pgrep -af 'bellwether relay-bridge'` prints one process. Note its pid.
- On PARENT, end the ssh client of CHILD's bridge, and only that one: `kill $(pgrep -a -x ssh | awk '/ -T CHILD / && /relay-bridge/ {print $1}')`. Don't use `pkill -f relay-bridge`. It also ends the live daemon's bridges to every other machine, and it matches any shell whose command line holds the words, which can be the shell that runs it.
- On CHILD, the noted pid exits within seconds, and the parent's reconnect starts one new bridge with another pid.

With the default `ClientAliveInterval 0`, sshd on CHILD would take hours to notice a real network failure. Since [#55](https://github.com/elecnix/bellwether/issues/55), the bridge exits after three heartbeats of silence instead, which is what check 2 measures.

## 4. A far end on the old protocol

- On CHILD, stop every child first, because a pi child loads its extension from the global install that the next step replaces. Then `npm install -g @elecnix/bellwether@0.1.4`, then `bellwether drain`.
- On PARENT, `bellwether doctor` prints `fail  relay CHILD: reconnecting`, and PARENT retries after 1, 2, 4, 8, 16, 32 and 64 seconds.
- The error in that line quotes the far end's error line and then gives advice. For a build of `main` from before the 0.1.5 release, it reads `ssh CHILD exited with 1: Error: invalid_hello: the parent needs a session, cwd, host and herdr socket relay-bridge came with Bellwether 0.1.5, and the bellwether that ssh runs on CHILD is older. This machine runs a build of 0.1.4 from before the 0.1.5 release (build <commit>), so install that same build on CHILD. If CHILD already has it, ssh's non-interactive PATH finds an older copy first.` A parent from before the fix for [#78](https://github.com/elecnix/bellwether/issues/78) shows the last three lines of the stack trace instead.
- 0.1.4 handles an unknown command by opening a `cli-<directory>` registry on CHILD. Remove that file from `~/.bellwether/parents/` afterwards.
- Install the build under test on CHILD again, the same way as in the set-up.

## Results

On 2026-11-27 the isolated harness ran all four checks between two Linux machines on one network, against `main`:

- Check 1: PARENT connected in under a second, and the report arrived once. The daemon on CHILD held its Unix socket and nothing else: it ran without an ssh child, a child process or a TCP socket.
- Check 2: PARENT lost the frozen session 57 seconds after the freeze and reconnected one second later. A report written during the freeze arrived once. The trap resumed the session after 90 seconds, and the old session and its bridge exited within 5 seconds.
- Check 3: the bridge exited within 4 seconds of the ssh client, and PARENT reconnected within 2 seconds.
- Check 4: PARENT kept reconnecting with backoff while CHILD ran 0.1.4, showing the stack-trace tail described above, and reconnected once CHILD ran the build under test again.

Afterwards, CHILD's live daemon kept its pid, and the harness left its global install and live `~/.bellwether` as they were.

Later on 2026-11-27, after CHILD rebooted, both paths ran against `main` at b99ba7a between the same two machines.

The isolated harness passed all four checks again:

- Check 1: PARENT connected in under a second, and the report arrived once. CHILD's outbox was empty, and its daemon had only its Unix socket open.
- Check 2: PARENT lost the frozen session 50 seconds after the freeze and reconnected 1.6 seconds later. The report written during the freeze arrived once, and the bridge under the frozen session exited 38 to 45 seconds after the freeze. Doctor never printed `reconnecting`, because the reconnect was faster than one doctor call. The loss error quoted a Node warning rather than a timeout, which is [#109](https://github.com/elecnix/bellwether/issues/109). Both differed from the expectations in the checks above.
- Check 3: the bridge exited within 2 seconds of the ssh client, and PARENT reconnected 1.6 seconds after the loss.
- Check 4: PARENT retried after 1 to 64 seconds with the advice quoted above, and reconnected once the prefix file specified the build under test again.

The global path then proved the two parts the harness skips:

- The remote PATH lookup: CHILD's non-interactive PATH has no `~/.local/bin`, so `command -v bellwether` fails there, and the lookup's list of install directories found the global install under `~/.local`.
- The spawn: `agent_spawn` with `kind: "pi"` opened a tab on CHILD, and the real child's `parent_report` reached the parent session.
- Checks 1 to 3 passed on the live daemons. In check 2 the real child reported during the freeze, the report waited in CHILD's relay outbox, and it reached the parent session once after the reconnect. Doctor again never printed `reconnecting`.
- Check 4 did not run on the global path. It replaces the global install that the live pi child loaded its extension from, and the harness had covered it.

During that run, CHILD's live home went wrong in two ways that shaped the warnings above.

Before the harness started, `$X/old/bin/bellwether --version` ran without the two variables, and npm's 0.1.4 started a daemon on CHILD's live socket. Two minutes later, a daemon from the global install replaced it on that socket, and a minute after that it pruned 41 stale parent records from CHILD's `~/.bellwether/parents`. Their sessions had ended before the reboot, so the registry lost old names and no work.

No one has found which client started that replacement. `pi --list-models` and doctor's move probe, each run alone, don't start a daemon.
