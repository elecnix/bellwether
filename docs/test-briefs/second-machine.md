# Checks on a second machine

The fake `ssh` in tier 2 cannot show four properties of the relay between a parent and a child on another machine. Run these checks by hand. Use two real machines, and run them before any release that changes the relay.

PARENT is the machine where the parent session runs. CHILD is the label of the other machine in `herdr machine list --json` on PARENT.

The checks use only the one key that spawning already needs: SSH from PARENT to CHILD, with no prompt. They don't need a key on CHILD for PARENT, and they don't need root on either machine.

## Set-up

1. Install the build under test on both machines from a packed tarball, as `docs/upgrading.md` describes under "A build npm hasn't published". A global install from a git URL fails.

2. `bellwether help | grep relay-bridge` prints one line on both machines. The line tells the two builds apart, because both may print the same `bellwether --version`.

3. Before you drain, make sure you don't need any Bellwether child on CHILD. `bellwether drain` there replaces its daemon, and a child on the old protocol cannot report to the new one.

4. Drain CHILD with `bellwether drain`.

5. From a parent session on PARENT, call `agent_spawn` with `kind: "pi"`, `name: "relay-check"` and `machine: "CHILD"`.

## 1. The profile resolves from PARENT

- On PARENT, `bellwether doctor` prints `ok    relay CHILD: connected since <time> as <target>`, where `<target>` is the SSH target from the profile.
- Ask the child to call `parent_report`. The parent session receives the report, and `ls ~/.bellwether/relay/outbox/` on CHILD lists nothing.
- On CHILD, run `D=$(node -p 'require(process.env.HOME + "/.bellwether/daemon.lock").pid')`. Then `pgrep -P "$D" -l ssh` and `ss -tnp | grep "pid=$D,"` both come back empty. The daemon on CHILD has no ssh child and no TCP connection of its own, so it never connects to PARENT.

## 2. Keepalives catch a dead link

The SSH session on CHILD that carries the bridge runs as your own user, so you can stop it without root. A frozen session can't answer keepalives, and PARENT sees that as a dead link.

- On CHILD, find the session with `P=$(pgrep -f 'bellwether relay-bridge' | head -1); while [ "$P" -gt 1 ] && ! ps -o args= -p "$P" | grep -q '^sshd'; do P=$(ps -o ppid= -p "$P" | tr -d ' '); done; ps -o pid=,user=,args= -p "$P"`. The output shows your user and `sshd: <you>@notty`.
- Freeze the session for 90 seconds in a subshell that resumes it on the way out, even when you press Control-C or the terminal closes: `( trap 'kill -CONT "$P"' EXIT HUP INT TERM; kill -STOP "$P"; sleep 90 )`.
- During the freeze, `bellwether doctor` on PARENT prints `fail  relay CHILD: reconnecting` within about 45 seconds of the freeze. The error mentions a timeout. The 45 seconds come from `ServerAliveInterval=15` and `ServerAliveCountMax=3`.
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
- On PARENT, `bellwether doctor` prints `fail  relay CHILD: reconnecting`, with `does not speak the relay protocol` and `Update @elecnix/bellwether on machine CHILD`. If 0.1.4 fails before it prints its usage, the error shows its stderr instead.
- 0.1.4 handles an unknown command by opening a `cli-<directory>` registry on CHILD. Remove that file from `~/.bellwether/parents/` afterwards.
- Install the build under test on CHILD again, the same way as in the set-up.
