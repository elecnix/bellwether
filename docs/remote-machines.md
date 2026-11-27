# Children on another machine

`agent_spawn` with `machine` starts the child on another machine's herdr. The parent's machine opens every connection. Its daemon dials the child's machine and collects the child's reports there. The child's machine never connects back.

## Requirements

- Bellwether installed on both machines, at the same protocol. The far end of each connection runs the `bellwether` command. SSH's non-interactive shell often has a shorter PATH than a login shell, so when that PATH has no `bellwether`, the far end tries `~/.local/bin`, `~/.npm-global/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and the `bin` directory of each nvm Node, newest first, and runs the first `bellwether` it finds. A global npm install under `~/.local` works on a machine whose non-interactive PATH leaves out `~/.local/bin`.
- A saved herdr profile for the other machine on the parent's machine, so that `herdr machine list` shows it.
- SSH from the parent's machine to the child's machine, with a key and no prompt. The target in the saved herdr profile has to resolve on the parent's machine, which is the only direction Bellwether connects in. Bellwether reaches the child's herdr through `herdr remote-api-bridge` on that connection, the same way `herdr --machine` does.

A pi child on the other machine also needs that machine's pi to load a Bellwether extension with the guard from [#50](https://github.com/elecnix/bellwether/pull/50), or the spawn refuses. The 0.1.4 on npm lacks it. Until npm publishes a release that includes the guard, install the build under test there from a packed tarball, as [Upgrading](upgrading.md) describes, and point pi at the installed package directory:

```sh
pi remove npm:@elecnix/bellwether
pi install "$(npm root -g)/@elecnix/bellwether"
```

That setting is temporary. Once npm has the release, `pi remove` the directory and run `pi install npm:@elecnix/bellwether` again.

The child's machine never reaches the parent's machine, so it doesn't store a key, a route or a name for it. Bellwether uses your SSH configuration as it stands, with `BatchMode=yes` and keepalives. It doesn't add a key or write anything under `~/.ssh`.

## Report path

Each machine runs its own daemon, and the parent's daemon keeps the registry of record.

Each report moves through the following steps. Step one runs over SSH from the parent's machine.

1. Before the child's tab opens, the parent's daemon runs `bellwether relay-register` on the child's machine. On that machine, the command writes a relay record that lists the child and the parent id, plus the MCP config for a Claude Code child. That record leaves out any address for the parent's machine.

   - From standard input, the command reads the child's brief, so the brief never appears on a command line. It writes the brief inside the child's working directory on that machine, as `.bellwether/brief-<child id>.md` with mode 0600, and the harness gets an `@` reference to that copy. A harness reads a file there without asking to leave its working directory. That `.bellwether` directory holds a `.gitignore` of `*`, so git ignores it and `git status` doesn't list it. A spawn with no `cwd` puts the brief in that machine's `~/.bellwether/prompts/<child id>.md`. A `cwd` that doesn't exist on that machine fails the spawn.
   - For a pi or omp child, the command prints the path of that machine's pi extension, which the child loads with `-e`.
   - The command prints the variables that the harness needs in the child's tab, as `env`. It computes them on that machine, so a path in one points at a file there. The parent's daemon passes them to the tab and writes them in no record, on either machine. A variable that points at a key file stays a path. Registration never opens the file, and the harness reads it in the tab.
   - The command leaves out a variable that only means something on one machine: herdr's `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` and `HERDR_ENV`, Bellwether's `BELLWETHER_HOME` and `BELLWETHER_DAEMON_SOCKET`, and a path under a home directory that machine doesn't have. It lists each one it left out in `envDropped`, and the spawn reply lists them once, by name and reason, never by value.
   - When the harness can't start without a variable, as omp can't without `OMP_SKIP_SETUP`, the spawn refuses a machine whose Bellwether hands back no variables, or one that left that variable out.
   - The command also prints the version and build of that machine's Bellwether, and a refusal from an older install quotes them.
   - If the copy fails, the spawn fails before any tab opens, so no child starts without its task. When the child exits, when `agent_stop` closes it, or when its spawn fails, `bellwether relay-cleanup` removes the brief, the MCP config and the relay record on that machine. A relay record whose reports still wait for the parent's daemon stays until that daemon collects the last of them. When `agent_stop` can't reach the machine, its reply says which files stay there and the command that removes them.

2. For each machine that runs one of its children, the parent's daemon keeps one SSH connection open. At the far end, `bellwether relay-bridge` joins the connection to the machine's daemon socket and starts that daemon if none runs. Over the connection, the parent's daemon subscribes to the reports that wait there for its parents.

3. The child calls `parent_report`, which goes to the daemon on its own machine. That daemon writes the report to its relay outbox under `~/.bellwether/relay/outbox/`, with mode 0600. It then hands the report to the parent's daemon when that daemon has a connection to it.

4. The parent's daemon checks the parent and the child against its registry, including the child's host. It writes the report to the parent's spool once per receipt, then acknowledges it. Only after that acknowledgement does the child's machine delete its copy. If a connection drops between the two steps, the report arrives again on the next connection, and the parent's daemon drops the second copy. Each receipt lands once.

`agent_read` on a remote child reads its transcript on that machine over the same connection, and it works after the child exits too.

When the machine is unreachable, the reply says so and returns the child's last report.

A resume goes back to the machine where the child last ran. To change that machine, call `agent_move`. [moving.md](moving.md) describes it.

## Connection state

Backoff runs from 1 second to 5 minutes when the parent's daemon retries a connection that fails or drops. The first reply on each connection gives the version and build of the child's machine, and `bellwether doctor` prints both on the `relay` line for that machine. Machines on one version number but different builds then show different lines.

The parent's daemon also sends a heartbeat line every 15 seconds, and `bellwether relay-bridge` exits after three intervals of silence, so a dead network link ends on the child's machine too.

A machine is in one of three states: `connecting`, `connected` or `reconnecting`. Alongside that state, the daemon keeps the error from its last failed attempt and the time of its last connection. It also keeps the last drain. That is the most recent time the parent had every report waiting on that machine.

- `bellwether doctor` prints that state for each machine. It counts a machine it can't reach as a failure.
- Each connection, loss and drain gets a line in the daemon log.
- `agent_list` marks a child as not heard from while its machine is unreachable.
- For such a child, the inactivity notice adds that the parent isn't hearing from that machine, and that a report may wait there.

After a child there exits, the daemon keeps a connection open to that machine until it has drained the machine once. Across a daemon restart, the last drain of each machine stays in `~/.bellwether/relay/hosts.json`.

## Errors from the child's machine

The parent's daemon runs `bellwether relay-register`, `relay-cleanup`, `relay-bridge` and the `move-*` commands on the child's machine over SSH. When one fails, the error quotes the line that machine meant as its error, plus at most two lines of context after it. Node.js crashes place stack frames and a version banner around that line, so the daemon takes the first match in this order:

1. the line a `bellwether` command prints for its own failure, `bellwether <command>: …`;
2. the line Node prints for the thrown error, such as `Error: …` or `TypeError: …`;
3. the first line that is not a stack frame, a `Node.js v…` banner, a source excerpt or a Node warning.

A Node warning, such as `(node:3263) ExperimentalWarning: …`, comes from a program that went on to work, so the error never reports it as the cause. When the far machine printed nothing else, the error quotes the warning after `it printed only a Node warning, which is not the cause:`, and the ssh exit code before it stays the cause.

Each failure's full output goes to `~/.bellwether/logs/ssh/`, and the daemon keeps the newest 20 files. When the error left lines out, it gives that file's path.

Upgrade advice appears only when the far end shows a release difference:

- a daemon protocol mismatch;
- an argument or a command the far end refused, which a known release brought;
- no `bellwether` at all.

Where the far end lacks something, the message specifies the release that brought it. If this machine runs a build from before that release, the message tells the operator to install that same build on the far end, because npm doesn't have it yet.

If the far machine already has that release, SSH reached another copy, one earlier on the non-interactive `PATH`.

On either machine, a failing `bellwether` command prints `bellwether <command>: <message>` and exits non-zero. Add `--debug`, or set `BELLWETHER_DEBUG=1`, to see the stack trace.

## Reports that do not arrive

When registration fails for a child with no brief, an opencode child still starts, and herdr status still follows it. The spawn's reply says why the child can't report.

Without that machine's extension path, a pi child would have no tools, so its spawn fails instead.

Claude Code spawns fail too.

Only the server that registration writes holds the child's id, so a Bellwether plugin or server the machine loads by itself would send the child's `parent_report` to no parent.

Outages leave each new report in the relay outbox on the child's machine. A new connection starts by sending the reports that wait for its parents, so a report from an outage arrives once the parent's daemon reconnects. Under `~/.bellwether/relay/children/`, the relay record counts waiting reports as `unforwarded`, and `bellwether doctor` on the child's machine counts them too.

Refusals from the parent's daemon are final. A refused report stays on disk, marked `refused`, and the child's machine doesn't send it again.

Each report crosses to the parent's machine as one line of the daemon protocol, and that line can't exceed 4 MiB. On the child's machine, the daemon refuses a longer report before it saves it. Its error message tells the child to report a shorter summary and leave the rest in a file.

An older Bellwether may have saved a longer report already. When a parent's daemon connects, the child's daemon marks that report `refused` and leaves it on disk, and the reports after it still arrive.
