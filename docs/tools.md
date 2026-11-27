# Tools and events

Every session with Bellwether gets these tools, in Pi and in Claude Code alike.

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab, on this machine or on a saved herdr machine named by `machine`. With `resume`, it messages an earlier child instead, and reopens its session when herdr no longer has it. |
| `agent_adopt` | any session | makes a running agent this session didn't start into its child, and refuses a pane another session watches |
| `agent_list` | any session | lists this session's children with status, age and unread events |
| `agent_read` | any session | returns a child's last assistant message, or its screen when you pass `lines` |
| `agent_send` | any session | prompts a child, or sends keys when herdr refuses a blocked one |
| `agent_stop` | any session | closes a child's tab, and refuses a working child unless you pass `force` |
| `agent_restart` | any session | restarts a child, a session or a live agent on the same session, or the caller when it omits the target |
| `parent_report` | a child Bellwether started or resumed | sends `done`, `needs-input` or `progress` to its parent |
| `request_retirement` | a child Bellwether started | asks the daemon to remove the child's worktree and branch once herdr reports its pane gone |

A parent sends input only to the panes it started, resumed or adopted.

A pi child runs on its parent's provider and model, so a spawn never bills another account by accident. pi needs both values, so Bellwether passes `--provider` and `--model` together.

A caller who names both, in `provider` and `model` or in `args`, wins. Naming one without the other fails the spawn, and the error gives this session's pair. A Claude Code parent has no pi pair to pass, so its pi child starts on pi's own default.

Either way, the spawn reply states the provider account and model the child runs on, since the account is what pays. For a default, Bellwether reads the pair from the child's session file once pi writes it, and `agent_list` shows it beside the kind. Before that, the reply gives the pair that pi's settings point to, along with the setting and its file. It marks that pair unverified.

A child record keeps the session file that herdr reports for a pi child, including after the child exits and the daemon retires it. `agent_read` reads the child's last message from that file. When pi gives the child a name of its own, the record keeps it as `agentName`, beside the parent's chosen name. `agent_list` shows both names. The other tools accept either one, unless two children answer to the same name.

## Events a parent receives

Each event below starts a new turn for the parent. herdr reports the state, and Bellwether then waits out the settle time.

| Event | Signal | Settle |
| -- | -- | -- |
| report | The child calls `parent_report`. | none |
| idle | herdr reports `idle` or `done` for a new turn, and no report covered that turn. | 5 s |
| blocked | herdr reports `blocked`, on a question other than Claude Code's startup questions. | 3 s |
| stuck | herdr reports `working` or `unknown`, and the child has been quiet past the threshold. | 10 min |
| inactive | No status change, output, new turn or report for the child's inactivity threshold. | none |
| exited | The pane exits or closes, or herdr stops detecting the agent. | none |

An unread `blocked` or `stuck` event drops out once the child moves on, so a dialog someone already answered never reaches the parent's next turn.

The inactivity threshold defaults to 5 minutes. Pass `inactive_minutes` to `agent_spawn` to change it for one child, from 1 minute to 24 hours. No setting turns this notice off. Bellwether sends it once per quiet period, and output or a report starts a new one.

## A child's environment

A child started by `agent_spawn` gets these variables, for its own scripts and for the `bellwether report` command, which reads `--child` from `BELLWETHER_CHILD` when the flag is absent.

| Variable | Meaning |
| -- | -- |
| `BELLWETHER_PARENT` | the parent session's registry id |
| `BELLWETHER_CHILD` | this child's record id |
| `BELLWETHER_CHILD_NAME` | this child's name |
| `BELLWETHER_DEPTH` | how many levels deep this child sits |
| `BELLWETHER_HARNESS` | `pi`, `claude-code`, or `other` |
