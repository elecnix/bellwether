# Tools and events

Every session with Bellwether gets these tools, in Pi and in Claude Code alike.

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab, on this machine or on a saved herdr machine named by `machine`, in your workspace or the one `workspace` names. With `resume`, it messages an earlier child instead, and reopens its session when herdr no longer has it. |
| `agent_adopt` | any session | makes a running agent this session didn't start into its child, and refuses a pane another session watches |
| `agent_list` | any session | lists this session's children with status, age, workspace and unread events |
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

[harnesses.md](harnesses.md) lists what a child of each kind can do, and why `agent_spawn` refuses `codex` and `cline` for now. An `opencode` child needs OpenCode 2 and a `cwd`. [opencode.md](opencode.md) gives its launch, its session check and what it can report.

A pi child runs on its parent's provider and model, so a spawn never bills another account by accident. pi needs both values, so Bellwether passes `--provider` and `--model` together.

A caller who names both, in `provider` and `model` or in `args`, wins. Naming one without the other fails the spawn, and the error gives this session's pair. A Claude Code parent has no pi pair to pass, so its pi child starts on pi's own default.

Either way, the spawn reply states the provider account and model the child runs on, since the account is what pays. For a default, Bellwether reads the pair from the child's session file once pi writes it, and `agent_list` shows it beside the kind. Before that, the reply gives the pair that pi's settings point to, along with the setting and its file. It marks that pair unverified.

With `via`, a spawn starts the child behind a route. A route is a launcher wrapper that this machine's routes file defines, and `model` then names one of its tiers. `key_file` runs that launcher under the key in a file, and the record keeps only the file's path.

`agent_restart` and `agent_spawn` with `resume` also take `via`, which moves a child onto a route or off it on the same session. `agent_list` shows each child's route in its `route` column, or `bare`.

[routes.md](routes.md) describes the routes file, the launch and the refusals.

A child record keeps the session file that herdr reports for a pi child, including after the child exits and the daemon retires it. `agent_read` reads the child's last message from that file. When pi gives the child a name of its own, the record keeps it as `agentName`, beside the parent's chosen name. `agent_list` shows both names. The other tools accept either one, unless two children answer to the same name.

## Workspaces

A child opens in your own herdr workspace unless the spawn sets `workspace` to another one. The value `"new"` asks herdr for a workspace of the child's own, labelled with the child's name, or with `workspace_label` when you pass one. The child runs in that workspace's first tab, so no empty shell sits beside it. Its own children open in that workspace too. Each session's children default to its own workspace, so a whole subtree stays out of yours.

Any other value identifies an existing workspace, by id and then by label. A name that doesn't match any workspace fails the spawn before Bellwether writes anything, and the error lists the workspaces there. A label that two workspaces share fails the same way. `"new"` always means a new workspace, even where an existing workspace has the label `new`.

A child on another machine gets its workspace on that machine, because `"new"` creates it through that machine's herdr. A workspace id from this machine means nothing there. Passing one fails the spawn. The error identifies the workspace on this machine and lists the ones on the child's machine.

`max_depth` counts the same in a new workspace as anywhere else.

Bellwether closes only a workspace it created, and only once no tab remains in it. herdr closes a workspace with its last tab, so the close covers a herdr that leaves an empty one. A workspace that still has another tab remains open, and so does any workspace a person made, even an empty one. A restart or resume of a child whose workspace herdr has closed opens a new one under the same label.

`agent_list` has a `workspace` column, and `bellwether doctor` names the workspace of each live child. Both mark a workspace Bellwether made for the child with `[made for it]`.

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
| idle | herdr reports `idle` or `done` for a new turn, no `done` or `needs-input` report covered that turn, and no dialog is open. The text is the turn's last message. | 5 s |
| blocked | The child waits on a dialog. herdr reports `blocked`, or a pi child says a dialog is open. When herdr reports `idle`, the screen can also show one. Claude Code's startup questions don't count, because Bellwether answers them. | 3 s |
| stuck | herdr reports `working` or `unknown`, and the child has been quiet past the threshold. | 10 min |
| inactive | No status change, output, new turn or report for the child's inactivity threshold. | none |
| exited | The pane exits or closes, or the harness ends and leaves its pane open. | none |

A harness can end and leave its pane open on the shell that ran it, as pi does when it can't read its brief. herdr then releases the agent, and the parent gets `exited` at once. When the harness ends before herdr ever detects it, herdr keeps it as pending. Twenty seconds after the start, Bellwether checks such a child once. If the shell is the pane's foreground process again, the parent gets `exited`. A child that ended before it reported anything gets an `exited` event that says it never started, so a dead child and a child still thinking don't look the same. Bellwether leaves its tab open on what the harness printed: `agent_read` shows that screen, and `agent_stop` closes the tab.

An unread `blocked` or `stuck` event drops out once the child moves on, so a dialog someone already answered never reaches the parent's next turn.

### One event per turn

The parent hears about each turn once. When a child ends its turn with a `done` or `needs-input` report, the parent gets only the `report` event. A `progress` report leaves the turn open. One `idle` event still follows when that turn ends, and it quotes the turn's own last message, from the transcript or the screen, never a report.

Bellwether compares each finished turn with the last turn it told the parent about, not with herdr's current status. The child record keeps that turn as `turnNotified`, with the pane that ran it, so herdr repeating a status doesn't resend the turn. Nor does a later snapshot of the same turn, or a daemon that takes over. An adopted child starts from the turns its pane had already finished, and its first event is the end of its next turn.

For the same child, a newer event replaces an older unread one, except for a report, which stays until the parent reads it.

### A child waiting on a dialog

A `blocked` event names the dialog in one line of at most 100 characters, such as `Bash command: Do you want to proceed?`, so a parent can tell a trust question from a permission question. `agent_read` shows the whole screen. Bellwether never answers the dialog: approving a permission question is the operator's decision. To answer it, the parent sends keys with `agent_send`, or a person types in the pane.

herdr reports `idle` for a harness that waits on a dialog it never reported, so Bellwether checks three sources before it sends `idle`:

- A pi child's own Bellwether extension tells the daemon when pi opens and closes a dialog, from pi's `ui_prompt_start` and `ui_prompt_end` events, which pi 0.84.4 added. That covers any dialog an extension raises through `ctx.ui`.
- A Claude Code child starts with settings of its own, passed with `--settings`, that add one `Notification` hook. Claude Code runs it for a permission dialog (`permission_prompt`) and for an MCP server's form or link (`elicitation_dialog`, `elicitation_url_dialog`), about 6 s after the dialog opens if nobody answered it first. The hook tells the daemon, and the `blocked` event carries Claude Code's own line, such as `Claude needs your permission to use Bash`. The record keeps the dialog open until herdr reports the child working again, or leaving `blocked`. The settings add to the operator's `~/.claude/settings.json` without editing it, and since the hook doesn't print a decision, the dialog waits for the operator.
- When neither source has named a dialog, the watcher reads the screen once before it sends `idle`. It recognizes a selection list with a marked option, or a y/n question, near the bottom of the screen.

The screen check has four limits:

- It misses a dialog with no marked option, such as a free-text box.
- It reads the screen once per turn, so it misses a dialog that opens after `idle` went out. The Claude Code hook reports that one.
- A dialog it found counts as open until herdr reports a new status, even after someone answers it.
- A finished answer that ends in a y/n question reads as a dialog.

A child on another machine has neither the pi notice nor the hook, because each reaches only the daemon on the child's own machine, so its dialogs come from the screen.

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
| `BELLWETHER_HARNESS` | `pi`, `claude-code`, `opencode`, or `other` |
