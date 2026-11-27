# Children on another machine

`agent_spawn` with `machine` starts the child on another machine's herdr. The child's reports travel back to the parent over SSH.

## Requirements

- Bellwether installed on both machines, at the same protocol, because each end of a hop runs the `bellwether` command.
- A saved herdr profile for the other machine on the parent's machine, so that `herdr machine list` shows it.
- SSH from the parent's machine to the child's machine, with a key and no prompt. Bellwether reaches the child's herdr through `herdr remote-api-bridge` on that connection, the way `herdr --machine` does.
- SSH from the child's machine back to the parent's machine, with a key and no prompt, under the parent's host name.

When SSH knows the parent's machine by another name, set that name on the parent's machine in `~/.bellwether/config.json`:

```json
{"sshTarget": "name"}
```

Bellwether uses your SSH configuration as it stands, with `BatchMode=yes`. It doesn't add a key or write anything under `~/.ssh`.

## Report path

Each machine runs its own daemon. The parent's daemon keeps the registry of record.

1. Before the child's tab opens, the parent's daemon runs `bellwether relay-register` on the child's machine. That writes a relay record with the child, the parent and the parent's SSH target, and, for a Claude Code child, its MCP config.

2. The child calls `parent_report`, which goes to the daemon on its own machine. That daemon writes the report to its relay outbox, then forwards it in one SSH command.

3. On the parent's machine, `bellwether report` hands the report to the local daemon, and starts one when none answers. That daemon checks the parent and the child against its registry, and accepts each receipt once, so a retried forward is safe.

`agent_read` on a remote child reads its transcript in place over the same hop, after it exits too. When the hop fails, it returns the child's last report.

A resume goes back to the child's original machine.

## Reports that do not arrive

When registration fails, the child still starts and herdr status still follows it. Read the spawn's reply for why the child can't report.

A failed hop leaves the report in the relay outbox under `~/.bellwether/relay/outbox/` on the child's machine. Retries back off from 2 seconds to 5 minutes, and the daemon keeps running until the outbox empties. In the relay record under `~/.bellwether/relay/children/`, `unforwarded` counts those reports and `lastForwardError` shows the newest error. Each attempt logs its host in the daemon log.

A refusal from the parent's daemon is final. The report stays on disk, marked `refused`.

Daemons refuse report text longer than 100,000 bytes, because a forward puts the report on one SSH command line.
