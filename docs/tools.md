# Tools and events

Every session with Bellwether gets these tools, in Pi and in Claude Code alike.

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab, on this machine or on a saved herdr machine named by `machine`. With `resume`, it messages an earlier child instead, and reopens its session when herdr no longer has it. |
| `agent_adopt` | any session | makes a running agent this session didn't start into its child, and refuses a pane another session watches |
| `agent_list` | any session | lists this session's children with status, age and unread events |
| `agent_read` | any session | returns a child's last assistant message, or its screen when you pass `lines` |
| `agent_send` | any session | prompts a child, or sends keys when herdr refuses a blocked one |
| `agent_move` | any session | moves a live claude or pi child to another machine, under the same id and with its session. [moving.md](moving.md) lists the refusals. |
| `agent_stop` | any session | closes a child's tab, and refuses a working child unless you pass `force` |
| `agent_restart` | any session | closes a child's or a session's pane and reopens the same session in a new one, or restarts the caller when it omits the target |
| `parent_report` | a child Bellwether started or resumed | sends `done`, `needs-input` or `progress` to its parent |
| `request_retirement` | a child Bellwether started | asks the daemon to remove the child's worktree and branch once herdr reports its pane gone |
| `agent_request_depth` | a child Bellwether started or resumed | asks its parent for a deeper ceiling, and returns at once with a request id |
| `agent_grant_depth` | any session | answers a child's depth request: grants levels, or refuses with 0 |

A parent sends input only to the panes it started, resumed or adopted.

A pi child runs on its parent's provider and model, so a spawn never bills another account by accident. pi needs both values, so Bellwether passes `--provider` and `--model` together.

A caller who names both, in `provider` and `model` or in `args`, wins. Naming one without the other fails the spawn, and the error gives this session's pair. A Claude Code parent has no pi pair to pass, so its pi child starts on pi's own default.

Either way, the spawn reply states the provider account and model the child runs on, since the account is what pays. For a default, Bellwether reads the pair from the child's session file once pi writes it, and `agent_list` shows it beside the kind. Before that, the reply gives the pair that pi's settings point to, along with the setting and its file. It marks that pair unverified.

A child record keeps the session file that herdr reports for a pi child, including after the child exits and the daemon retires it. `agent_read` reads the child's last message from that file. When pi gives the child a name of its own, the record keeps it as `agentName`, beside the parent's chosen name. `agent_list` shows both names. The other tools accept either one, unless two children answer to the same name.

## Depth

Depth limits how far a tree of children can grow. Each child has a ceiling: the deepest generation its own descendants may be at. Picture a child at depth 2 with a ceiling of 2. It can't spawn, because the spawn would put its child at depth 3. The depth-0 session sets the tree's ceiling through `max_depth` on its spawns, which defaults to 2. Sessions below depth 0 hand their own ceiling to their spawns, and that ceiling caps any higher `max_depth` they pass along.

A child that needs more depth calls `agent_request_depth` with the number of levels and one sentence describing the work. Calling it returns a request id at once, and the child continues at its current depth. Parents receive the request as a `needs-input` report and answer with `agent_grant_depth`. Either answer reaches the child as a message.

- Granting a request raises the child's ceiling to its depth plus the levels granted.
- Beyond the parent's own ceiling, a grant becomes a new request to the grandparent. That request identifies the child that asked and gives its reason. An ancestor with room can grant it, and that answer passes down to every child on the chain.
- Over the whole tree, the depth-0 session's ceiling is the limit. Anything above it gets an immediate refusal, which states the ceiling and says that only the person can raise it.
- A refusal doesn't need a reason. Refused children get two options: do the work with fewer children, or ask the person.

The child record stores each grant, recording the granter, the time, the number of levels and the reason. `agent_list` shows each child's depth and ceiling, along with its open requests and grants. Requests don't work across machines. A child whose parent runs on another machine gets a refusal with the same two options.

## Events a parent receives

Each event below starts a new turn for the parent. herdr reports the state, and Bellwether then waits out the settle time.

| Event | Signal | Settle |
| -- | -- | -- |
| report | The child calls `parent_report`. | none |
| idle | herdr reports `idle` or `done` for a new turn, no report covered that turn, and no dialog is open. | 5 s |
| blocked | The child waits on a dialog. herdr reports `blocked`, or a pi child says a dialog is open. When herdr reports `idle`, the screen can also show one. Claude Code's startup questions don't count, because Bellwether answers them. | 3 s |
| stuck | herdr reports `working` or `unknown`, and the child has been quiet past the threshold. | 10 min |
| inactive | No status change, output, new turn or report for the child's inactivity threshold. | none |
| exited | The pane exits or closes, or the harness ends and leaves its pane open. | none |

A harness can end and leave its pane open on the shell that ran it, as pi does when it can't read its brief. herdr then releases the agent, and the parent gets `exited` at once. When the harness ends before herdr ever detects it, herdr keeps it as pending. Twenty seconds after the start, Bellwether checks such a child once. If the shell is the pane's foreground process again, the parent gets `exited`. A child that ended before it reported anything gets an `exited` event that says it never started, so a dead child and a child still thinking don't look the same. Bellwether leaves its tab open on what the harness printed: `agent_read` shows that screen, and `agent_stop` closes the tab.

An unread `blocked` or `stuck` event drops out once the child moves on, so a dialog someone already answered never reaches the parent's next turn.

### A child waiting on a dialog

A `blocked` event names the dialog in one line of at most 100 characters, such as `Bash command: Do you want to proceed?`, so a parent can tell a trust question from a permission question. `agent_read` shows the whole screen. Bellwether never answers the dialog: approving a permission question is the operator's decision. To answer it, the parent sends keys with `agent_send`, or a person types in the pane.

herdr reports `idle` for a harness that waits on a dialog it never reported, so Bellwether checks two sources before it sends `idle`:

- A pi child's own Bellwether extension tells the daemon when pi opens and closes a dialog, from pi's `ui_prompt_start` and `ui_prompt_end` events, which pi 0.84.4 added. That covers any dialog an extension raises through `ctx.ui`.
- For any other harness, the watcher reads the screen once before it sends `idle`. It recognizes a selection list with a marked option, or a y/n question, near the bottom of the screen.

A child that answers its dialog and works on stays in the same turn. Closing the dialog doesn't send an event, and the parent gets one `idle` event when the turn ends.

### Delivery to the parent

A busy parent gets each event at its next turn: after the tool calls in flight, before the next model call. For an idle parent, the event starts a turn. Several events from one burst arrive together in one message, oldest first, and an event more than a minute old gets a note such as `(late by 4m34s: it happened at 07:25:46 UTC)` after its receipt.

Bellwether marks an event read once its own message is in front of the model. A shell read of the outbox file under `~/.bellwether/outbox/` shows the same receipts, but it leaves them unread, and the notification still arrives. That file stores the read flag, so a restarted daemon replays only the unread events.

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
