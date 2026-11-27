# Children on another machine

`agent_spawn` with `machine` starts the child on another machine's herdr. The parent's machine opens every connection. Its daemon dials the child's machine and collects the child's reports there. The child's machine never connects back.

## Requirements

- Bellwether installed on both machines, at the same protocol. The far end of each connection runs the `bellwether` command.
- A saved herdr profile for the other machine on the parent's machine, so that `herdr machine list` shows it.
- SSH from the parent's machine to the child's machine, with a key and no prompt. The target in the saved herdr profile has to resolve on the parent's machine, which is the only direction Bellwether connects in. Bellwether reaches the child's herdr through `herdr remote-api-bridge` on that connection, the same way `herdr --machine` does.

The child's machine never reaches the parent's machine, so it doesn't store a key, a route or a name for it. Bellwether uses your SSH configuration as it stands, with `BatchMode=yes` and keepalives. It doesn't add a key or write anything under `~/.ssh`.

## Report path

Each machine runs its own daemon, and the parent's daemon keeps the registry of record.

Each report moves through the following steps. Step one runs over SSH from the parent's machine.

1. Before the child's tab opens, the parent's daemon runs `bellwether relay-register` on the child's machine. On that machine, the command writes a relay record that lists the child and the parent id, plus the MCP config for a Claude Code child. That record leaves out any address for the parent's machine.

   - From standard input, the command reads the child's brief, so the brief never appears on a command line. It writes the brief to that machine's `~/.bellwether/prompts/<child id>.md` with mode 0600, and the harness gets an `@` reference to that copy.
   - If the copy fails, the spawn fails before any tab opens, so no child starts without its task. When the child exits, when `agent_stop` closes it, or when its spawn fails, `bellwether relay-cleanup` removes the brief and the MCP config on that machine.

2. For each machine that runs one of its children, the parent's daemon keeps one SSH connection open. At the far end, `bellwether relay-bridge` joins the connection to the machine's daemon socket and starts that daemon if none runs. Over the connection, the parent's daemon subscribes to the reports that wait there for its parents.

3. The child calls `parent_report`, which goes to the daemon on its own machine. That daemon writes the report to its relay outbox under `~/.bellwether/relay/outbox/`, with mode 0600. It then hands the report to the parent's daemon when that daemon has a connection to it.

4. The parent's daemon checks the parent and the child against its registry, including the child's host. It writes the report to the parent's spool once per receipt, then acknowledges it. Only after that acknowledgement does the child's machine delete its copy. If a connection drops between the two steps, the report arrives again on the next connection, and the parent's daemon drops the second copy. Each receipt lands once.

`agent_read` on a remote child reads its transcript on that machine over the same connection, and it works after the child exits too.

When the machine is unreachable, the reply says so and returns the child's last report.

A resume goes back to the child's original machine.

## Connection state

Backoff runs from 1 second to 5 minutes when the parent's daemon retries a connection that fails or drops.

A machine is in one of three states: `connecting`, `connected` or `reconnecting`. Alongside that state, the daemon keeps the error from its last failed attempt and the time of its last connection. It also keeps the last drain. That is the most recent time the parent had every report waiting on that machine.

- `bellwether doctor` prints that state for each machine. It counts a machine it can't reach as a failure.
- Each connection, loss and drain gets a line in the daemon log.
- `agent_list` marks a child as not heard from while its machine is unreachable.
- For such a child, the inactivity notice adds that the parent isn't hearing from that machine, and that a report may wait there.

After a child there exits, the daemon keeps a connection open to that machine until it has drained the machine once. Across a daemon restart, the last drain of each machine stays in `~/.bellwether/relay/hosts.json`.

## Reports that do not arrive

When registration fails for a child with no brief, the child still starts, and herdr status still follows it. The spawn's reply says why the child can't report.

Outages leave each new report in the relay outbox on the child's machine. A new connection starts by sending the reports that wait for its parents, so a report from an outage arrives once the parent's daemon reconnects. Under `~/.bellwether/relay/children/`, the relay record counts waiting reports as `unforwarded`, and `bellwether doctor` on the child's machine counts them too.

Refusals from the parent's daemon are final. A refused report stays on disk, marked `refused`, and the child's machine doesn't send it again.

Each report crosses to the parent's machine as one line of the daemon protocol, and that line can't exceed 4 MiB. On the child's machine, the daemon refuses a longer report before it saves it. Its error message tells the child to report a shorter summary and leave the rest in a file.

An older Bellwether may have saved a longer report already. When a parent's daemon connects, the child's daemon marks that report `refused` and leaves it on disk, and the reports after it still arrive.
