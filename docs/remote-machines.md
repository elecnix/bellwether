# Children on another machine

`agent_spawn` with `machine` starts the child on another machine's herdr. The parent's machine opens every connection. Its daemon dials the child's machine and collects the child's reports there. The child's machine never connects back.

## Requirements

- Bellwether installed on both machines, at the same protocol. The far end of each connection runs the `bellwether` command. SSH's non-interactive shell often has a shorter PATH than a login shell, so when that PATH has no `bellwether`, the far end tries `~/.local/bin`, `~/.npm-global/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and the `bin` directory of each nvm Node, newest first, and runs the first `bellwether` it finds. A global npm install under `~/.local` works on a machine whose non-interactive PATH leaves out `~/.local/bin`.
- A saved herdr profile for the other machine on the parent's machine, so that `herdr machine list` shows it.
- herdr's integration for the child's harness on the child's machine: run `herdr integration install pi` there for a pi child, and `herdr integration install claude` for a Claude Code child. herdr reports a session only through that integration, and a child without a recorded session can't move, restart or resume. The spawn reply warns when it is missing ([harnesses](harnesses.md#capabilities-by-kind)).
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

   - From standard input, the command reads the child's brief, so the brief never appears on a command line. It writes the brief inside the child's working directory on that machine, as `.bellwether/brief-<child id>.md` with mode 0600, and a harness whose launch line carries a pointer to its brief points at that copy. A harness reads a file there without asking to leave its working directory. A `claude`, `pi` or `omp` child takes its brief as a message instead: the parent's daemon sends `relay-message` with `awaitSession`, and the daemon there waits for the child's session to connect before it pushes the brief. The copy on that machine stays as a reference for a person there. The parent's machine stores a copy of what the parent sent. A resume reads that copy, and it wins when the two differ. That `.bellwether` directory holds a `.gitignore` of `*`, so git ignores it and `git status` doesn't list it. A spawn with no `cwd` puts the brief in that machine's `~/.bellwether/prompts/<child id>.md`. A `cwd` that doesn't exist on that machine fails the spawn.
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

## Messages to a child there

`agent_send` to a `claude`, `pi` or `omp` child on another machine puts the message in the child's session, as it does on this machine. Over the connection it already holds for reports, the parent's daemon sends `relay-message`. The daemon on the child's machine pushes the message to the child's own Bellwether server or extension there, and its result says whether the session took it.

Wherever the child runs, the timing matches: a busy child takes the message after the tool calls in flight and before its next model call, while an idle one starts a turn on it.

Until the child's model reads the message, its text stays on the child's relay record on that machine. A session that reconnects to that daemon takes it again. The read then waits in that machine's relay outbox, as a report does, and the parent's daemon takes it once and acknowledges it. `agent_list` shows the message as read from then on.

herdr on that machine types the message into the far pane instead, with the reason on the record, in these cases:

- That machine runs a Bellwether that predates `relay-message`. Its daemon answers `unknown_type`, and the reason gives the release that brings the request.
- The connection to that machine is down.
- The child's session there never connected to that machine's daemon with an inbox, or it didn't take the message within 5 seconds.

## Adopting an agent on another machine

`agent_adopt` takes a pane on another machine. Name the machine with `machine`, or write the target as `machine:pane`, as in `child-box:w1:p5` or `child-box:first-mate`. The parent's daemon reads the pane from that machine's herdr, through the same `herdr remote-api-bridge` connection that watches a child it spawned there. It then sends `relay-adopt` over its relay connection to that machine, and the daemon there records the adoption as a relay record with the pane, the harness session and `adopted: true`.

That daemon answers who watches the pane, because its registry lists the children of the parents on that machine, and its relay records list the adoptions of parents on other machines. Bellwether refuses an adoption in four cases, and each refusal says why:

- herdr has no saved machine by that name, and the error lists the saved ones;
- herdr recognizes no agent in that pane;
- a parent already watches that pane, on that machine or through an earlier adoption from a third machine, and the error gives that parent and the child's name;
- the Bellwether on that machine predates `relay-adopt`, and the error gives the version it runs and the release that brings the request, 0.1.6.

An adoption from a third machine stops counting once herdr shows a different session in that pane, because herdr reused the pane id for another agent.

The child record on the parent's machine has the machine as `host`, the pane, the session id from that machine's herdr and `origin: adopt`. Its transcript stays on that machine, and `agent_read` reads it over the relay connection.

When the connection to that machine drops, the child is unreachable, not exited. `agent_list` shows `unreachable since <time> (last seen <status>)` in its state column. The watcher never reports that child stuck or exited while the link is down, because its silence is the link's. Once the child's inactivity period passes, the inactivity notice starts the parent's turn and says the child is unreachable, not exited.

When the machine answers again, the watcher takes a fresh snapshot and the child goes on under the same child id, with no second adoption. A turn that finished during the outage arrives once, as an `idle` event. A restart of the daemon on that machine drops only the relay connection, which reconnects, and the herdr connection that carries the child's status stays up. The new daemon reads the adoption from its relay record on disk.

An adopted child on that machine can call `parent_report` when its session loaded Bellwether at its start, through pi's package or Claude Code's plugin. That machine must also run Bellwether 0.1.7 or later.

The adapter in the session already has a connection open to the daemon there. That daemon gives the adapter `parent_report` once the claim arrives. It then keeps each report from that session under the adoption's child id in its relay outbox. A message from `agent_send` crosses to that session over the relay when its adapter takes messages, and that machine runs Bellwether 0.1.8 or later.

The parent's daemon collects it over the same connection as a report from a spawned child. A session that didn't load a Bellwether adapter can't report, and the `agent_adopt` reply says which kind of session the parent adopted. [tools.md](tools.md#adopted-sessions) covers both kinds, on this machine and on another.

When the child's pane closes, the watcher runs `bellwether relay-cleanup` there, which removes the adoption.

A harness can quit and leave its pane open, and then the child exits. `relay-cleanup` drops that claim too. Bellwether keeps watching the pane, as the exit event says. Resuming the same session there makes the same child, as after a quit and a `--resume`. Under its child id, the watcher brings it back and records the claim on that machine again. It then follows the child's status. Its session gets `parent_report` and its messages back. Another session in the pane, or the pane closing, ends the wait.

Should the parent's watcher miss the return, as when its daemon was down, `agent_adopt` on the pane brings the child back under its child id, and the reply reports it. A daemon on that machine may hold the session under another child id, and that id then stands for the session. The reply gives both ids, and the old record keeps its exited status and gets `replacedBy`.

## Restarting a child there

An `agent_restart` of a child on another machine travels over the relay connection that carries its reports. The request goes out as a `relay-restart`, and the daemon on that machine restarts the child as it would one of its own. It opens a new tab in the child's workspace and closes the old pane. Then it writes the child's start files again and resumes the same session under the same child id.

That daemon replies with the new pane, which the parent's record takes. Everything else in the record stays as it was, so the child's history, receipts and messages carry on.

The parent's record keeps naming the old pane, marked as closing, for as long as it asks. The parent's watcher then reads the close on that machine as part of the restart, not as the child exiting. If the daemon there refuses, the mark goes, and nothing changes on either machine.

A connection can end after the request went out and before the answer came back. By then the daemon on that machine may have restarted the child, so the parent doesn't claim an outcome. Bellwether replies that the outcome is unknown. `restartInDoubt` sits on the record, `restart.log` records `outcome: unknown`, and `bellwether doctor` prints a `warn` line. Bellwether turns away a second restart while the record is in doubt, since a second start could run the session twice on the far machine.

The answer isn't lost. On the far side, the daemon keeps it in the relay outbox, and the parent's daemon takes it when the connection returns, after which the record shows the new pane or the failure and `restart.log` records the outcome with `learned: true`.

Each case below refuses a restart, and the refusal gives the reason that applied:

- the daemon there predates the request, which came with Bellwether 0.1.10; the refusal reports the version that machine runs
- no herdr answers on that machine at the socket of the herdr session that the saved machine profile names
- the child's session is not on that machine, because its harness never wrote the session's file there
- that machine doesn't have a relay record of the child for this parent
- the machine is unreachable; the refusal reports the state of the connection

A failure can come late, after the old pane there has closed and before the session starts again. Bellwether marks the child as gone on the parent's record in that case, as it does when a restart fails on the parent's own machine.

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
