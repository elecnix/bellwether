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

3. On PARENT, `export RELAY_CHECK_HOME=$X/home RELAY_CHECK_PREFIX_FILE=$PWD/prefix`, write `$X/prefix` into that file, and start `node scripts/relay-check/parent.ts --home <dir> --host CHILD`. It prints the `relay-register` command for the next step.

4. On CHILD, run that command with `BELLWETHER_HOME=$X/home BELLWETHER_DAEMON_SOCKET=$X/home/daemon.sock` and `$X/prefix/bin/bellwether`.

5. Run checks 1 to 4 below. Where a check says `bellwether` on CHILD, use `$X/prefix/bin/bellwether` with the same two variables. Where it says `~/.bellwether`, read `$X/home`. A report from the child is `bellwether report --child relay-check-child --status done --text <text>`. Check 4 switches the far end by writing `$X/old` into the prefix file, then cuts the connection as check 3 does.

6. Stop `parent.ts`, run `$X/prefix/bin/bellwether drain --socket $X/home/daemon.sock` on CHILD, and delete `$X`.

## The harness skips the global lookup and the spawn

The harness covers the transport, from the connection and its keepalives through the reconnect and the bridge's exit to a far end on the old protocol. It skips the two parts that the operator's own use depends on:

- **The remote PATH lookup of a global `bellwether`.** The wrapper's PATH prefix decides which binary runs, so a CHILD whose non-interactive PATH can't find the global install passes the harness.
- **The spawn step.** You register the placeholder child with `relay-register` yourself, and its reports come from `bellwether report`. A spawn never runs, so the harness doesn't open a tab or show a real child calling `parent_report`.

A green harness doesn't prove either. Only the global path proves them, so run it as well, on a CHILD with nothing to lose.

## Set-up for the global path

1. Install the build under test on both machines from a packed tarball, as `docs/upgrading.md` describes under "A build npm hasn't published". A global install from a git URL fails.

2. `bellwether help | grep relay-bridge` prints one line on both machines. The line tells the two builds apart, because both may print the same `bellwether --version`.

3. On CHILD, `pi install npm:@elecnix/bellwether`. Without it, the pi spawn in step 5 fails: `relay-register --kind pi` refuses when CHILD's pi settings load an older Bellwether, one without the guard from [#50](https://github.com/elecnix/bellwether/pull/50).

4. Drain CHILD with `bellwether drain`.

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
- During the freeze, `bellwether doctor` on PARENT prints `fail  relay CHILD: reconnecting` within 45 to 60 seconds, with an error that mentions a timeout. `ServerAliveInterval=15` and `ServerAliveCountMax=3` set that window.
- PARENT then reconnects on a new session, and doctor prints `connected` again.
- Ask the child to report while the old session is frozen. The report arrives once, over the new connection.
- When the subshell ends, it resumes the old session. That session has lost its connection, so it exits, and the bridge under it exits within seconds. `pgrep -af 'bellwether relay-bridge'` on CHILD then prints one process.

A `kill -9` of that subshell is the one exit no trap can catch. If a check fails partway, look for a session left stopped, and resume it:

```sh
ps -o pid=,stat=,args= -u "$USER" | awk '$2 ~ /^T/ && $3 ~ /^sshd/'
kill -CONT <pid>
```

## 3. The bridge exits when sshd hangs up

- On CHILD, `pgrep -af 'bellwether relay-bridge'` prints one process. Note its pid.
- On PARENT, `pkill -f relay-bridge` ends the ssh client.
- On CHILD, the noted pid exits within seconds, and the parent's reconnect starts one new bridge with another pid.

A real network failure differs from check 2 in one way. The sshd on CHILD never hears about the failure, so the old bridge lingers until sshd notices the dead TCP connection. With the default `ClientAliveInterval 0`, that takes hours. [#55](https://github.com/elecnix/bellwether/issues/55) tracks the lingering bridge, with a heartbeat on the relay stream as the fix.

## 4. A far end on the old protocol

- On CHILD, `npm install -g @elecnix/bellwether@0.1.4`, then `bellwether drain`.
- On PARENT, `bellwether doctor` prints `fail  relay CHILD: reconnecting`, and PARENT retries with backoff.
- Today the error in that line is the tail of 0.1.4's stack trace. PARENT keeps the last three lines of stderr, and the line that states the problem, `Error: invalid_hello: the parent needs a session, cwd, host and herdr socket`, sits above them. A pending change makes the error quote that line and name the machine to update.
- 0.1.4 handles an unknown command by opening a `cli-<directory>` registry on CHILD. Remove that file from `~/.bellwether/parents/` afterwards.
- Install the build under test on CHILD again, the same way as in the set-up.

## Results

On 2026-11-27 the isolated harness ran all four checks between two Linux machines on one network, against `main`:

- Check 1: PARENT connected in under a second, and the report arrived once. The daemon on CHILD held its Unix socket and nothing else: it ran without an ssh child, a child process or a TCP socket.
- Check 2: PARENT lost the frozen session 57 seconds after the freeze and reconnected one second later. A report written during the freeze arrived once. The trap resumed the session after 90 seconds, and the old session and its bridge exited within 5 seconds.
- Check 3: the bridge exited within 4 seconds of the ssh client, and PARENT reconnected within 2 seconds.
- Check 4: PARENT kept reconnecting with backoff while CHILD ran 0.1.4, showing the stack-trace tail described above, and reconnected once CHILD ran the build under test again.

Afterwards, CHILD's live daemon kept its pid, and the harness left its global install and live `~/.bellwether` as they were. The global path has not run yet. CHILD's operator scheduled a reboot, so the global path waits for that machine to come back.
