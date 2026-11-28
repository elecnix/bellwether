# Tools and events

Every session with Bellwether gets these tools, in Pi and in Claude Code alike.

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab, on this machine or on a saved herdr machine named by `machine`, in your workspace or the one `workspace` names. With `resume`, it messages an earlier child instead, and reopens its session when herdr no longer has it. |
| `agent_adopt` | any session | makes a running agent this session didn't start into its child, on this machine or another one, and refuses a pane another session watches. [remote-machines.md](remote-machines.md#adopting-an-agent-on-another-machine) covers another machine |
| `agent_list` | any session | lists this session's children with status, age, workspace and unread events, and how an exited child's last pane ended |
| `agent_read` | any session | returns a child's last assistant message, or its screen when you pass `lines` |
| `agent_send` | any session | sends a child a message, or keys for a dialog. [Messages to a child](#messages-to-a-child) gives the path a message takes |
| `agent_move` | any session | moves a live claude or pi child to another machine, under the same id and with its session. [moving.md](moving.md) lists the refusals. |
| `agent_stop` | any session | closes a child's tab and retires it, removing its worktree once the work provably merged, and refuses a working child unless you pass `force` |
| `agent_restart` | any session | closes a child's or a session's pane and reopens the same session in a new one, or restarts the caller when it omits the target |
| `parent_report` | a child Bellwether started or resumed, and an adopted session that loaded Bellwether at its start | sends `done`, `needs-input` or `progress` to its parent. [Adopted sessions](#adopted-sessions) gives which adopted sessions get it |
| `request_retirement` | a child Bellwether started | asks the daemon to remove the child's worktree and branch once herdr reports its pane gone; the child leaves the worktree in place |
| `agent_request_depth` | a child Bellwether started or resumed | asks its parent for a deeper ceiling, and returns at once with a request id |
| `agent_grant_depth` | any session | answers a child's depth request: grants levels, or refuses with 0 |

A parent sends input only to the panes it started, resumed or adopted.

[harnesses.md](harnesses.md) lists what a child of each kind can do, and why `agent_spawn` starts each `cline` child in Cline's sandbox mode. An `opencode` child needs OpenCode 2 and a `cwd`. [opencode.md](opencode.md) gives its launch, its session check and what it can report. A `codex` child needs a `cwd`, and [codex.md](codex.md) gives its launch, its session lookup and the three tools it can call.

A pi child runs on its parent's provider and model, so a spawn never bills another account by accident. pi needs both values, so Bellwether passes `--provider` and `--model` together.

A caller who names both, in `provider` and `model` or in `args`, wins. Naming one without the other fails the spawn, and the error gives this session's pair. A Claude Code parent has no pi pair to pass. Its pi child on this machine then starts on pi's saved default, `defaultProvider` and `defaultModel` from pi's settings, and Bellwether passes that pair as flags. Left to itself, pi would take the first entry of `enabledModels` whenever that list leaves the saved default out, and nobody chose that entry for the child. The reply mentions the first entry only when it differs from the saved default. When pi's settings don't save a default, or the child runs on another machine, pi picks the pair itself.

Either way, the spawn reply states the provider account and model the child runs on, since the account is what pays. When pi picks, Bellwether reads the pair from the child's session file once pi writes it, and `agent_list` shows it beside the kind. Before that, the reply gives the pair that pi's settings point to, along with the setting and its file. It marks that pair unverified.

A spawn reports a child that failed to start as a failure, not as a start the parent has to disprove later. Until herdr detects the harness, the spawn checks the pane's foreground process every half second. When the shell regains the foreground from the harness, the harness has exited. At once, the spawn fails and shows the harness's printed lines.

A pi child can also stay up after an error it cannot recover from, such as a provider it has no key for. It prints `Error: No API key found for <provider>.` and waits at its prompt. So once herdr detects a pi child, the spawn waits up to 20 s for its first status. `working` confirms the start. `idle` or `done` with an `Error:` line on screen fails the spawn, and the error quotes that line.

A child that doesn't show a status within 20 s is slow, not dead. The spawn succeeds and its reply says the start is unconfirmed. The watcher reports the child's exit if one follows.

With `via`, a spawn starts the child behind a route. A route is a launcher wrapper that this machine's routes file defines, and `model` then names one of its tiers. `key_file` runs that launcher under the key in a file, and the record keeps only the file's path.

`agent_restart` and `agent_spawn` with `resume` also take `via`, which moves a child onto a route or off it on the same session. `agent_list` shows each child's route in its `route` column, or `bare`.

[routes.md](routes.md) describes the routes file, the launch and the refusals.

A child record keeps the session file that herdr reports for a pi child, including after the child exits and the daemon retires it. `agent_read` reads the child's last message from that file. When pi gives the child a name of its own, the record keeps it as `agentName`, beside the parent's chosen name. `agent_list` shows both names. The other tools accept either one, unless two children answer to the same name.

## Adopted sessions

An agent that a person or a script started has no child id, but its session can still run Bellwether. pi loads the extension when pi's settings list Bellwether's package. Claude Code loads the server from Bellwether's plugin, or from an entry under `mcpServers` in the user settings.

That adapter connects to the daemon on its own machine. It says which herdr pane it runs in and which harness session it is. Until something adopts it, it offers the parent tools only.

Once adoption takes that pane, the daemon on the pane's machine sends the adapter a new tool list, and the list now has `parent_report`. The daemon sends it over the adapter's open connection. Claude Code hears `notifications/tools/list_changed`, and pi registers the new tool. A report from that session goes to the parent that adopted it.

A message from `agent_send` enters that session over the same connection when its adapter takes messages. The pi extension takes them in any session from 0.1.8 on. Claude Code puts a server's message in a session only when the session started with that server as a channel. The server reads Claude Code's command line, and takes messages from 0.1.9 on when `--channels` or `--dangerously-load-development-channels` names `plugin:bellwether@…` or `server:bellwether`. Without that flag, `agent_send` types into its pane, and the reply says why.

Claude Code starts its servers before an interactive `--resume` picks a session, and keeps them across a `/resume`. So from 0.1.9 on, the server reads the session Claude Code shows now from `sessions/<pid>.json` in Claude Code's config directory, and says hello again when it changes. A session resumed into the adopted one keeps `parent_report` and its messages.

On the same machine, the daemon finds the parent by the pane. On another machine, the daemon there finds the claim that the parent left at the adoption. It keeps the report in its relay outbox for the parent's daemon to collect.

The adoption compares the harness session in the pane with the one the adapter names. herdr reuses a pane id once its agent ends, so a later session in the same pane doesn't get a parent.

The `agent_adopt` reply says which case applies:

| The adopted session | What the parent gets |
| -- | -- |
| has the pi extension from 0.1.8 on | its status changes, its `parent_report`, and each `agent_send` message in its session |
| has the pi extension from 0.1.7, or a Claude Code server | its status changes and its `parent_report`, while `agent_send` types into its pane |
| has an older adapter | its status changes, and its `parent_report` after its next connection to the daemon, such as the one after an upgrade that transfers the daemon to a new process |
| doesn't have a Bellwether adapter | its status changes, and `agent_send` types into its pane. It can't report |

A session with no adapter stays that way while it runs. Neither Claude Code nor pi loads a new MCP server or extension into a running session, and Bellwether never types into a pane to install one. [Issue #149](https://github.com/elecnix/bellwether/issues/149) records what each harness would need.

## Messages to a child

`agent_send` with `text` puts the message into the child's session when the child's harness offers a way in. When it offers none, Bellwether types the message into the child's pane. A spawn with `resume` that finds its child alive takes the same path, and so does a depth grant. Bellwether writes the grant to the child's record before the child hears of it. So the delivery path changes how the child learns of a grant, not what the grant means.

| Kind | How the message arrives |
| -- | -- |
| `claude` | in the session, as a channel notification from the child's own Bellwether server |
| `pi`, `omp` | in the session, through the Bellwether pi extension's `pi.sendMessage` |
| `codex`, `cline`, `kilo`, `opencode` | typed into the pane through herdr's `agent.prompt`, because each loads Bellwether as an ordinary MCP server, and its MCP client takes no message from a server into the session |

Even a `claude`, `pi` or `omp` child can receive a message in its pane. That happens in four cases:

- The child runs on another machine whose Bellwether predates `relay-message`, or the connection to it is down. [remote-machines.md](remote-machines.md#messages-to-a-child-there) gives the path a message takes there.
- The child is `blocked`. herdr refuses the prompt and shows the dialog, as before.
- No Bellwether session of the child holds a connection to this daemon.
- The child is an adopted session whose adapter takes no message, and the reason names that adapter.
- The session doesn't take the message within 5 seconds.

The reply gives the reason for the pane fallback. Each message takes exactly one of the two paths.

A busy child takes a session message after the tool calls in flight and before its next model call. Typed input reaches the child at that same point, so a correction arrives mid-turn instead of after the turn ends. Claude Code queues a channel message the way it queues a typed prompt. The pi extension steers it with `deliverAs: 'steer'`. An idle child starts a turn on the message.

The child record keeps the newest 20 messages. Each entry records its id, its path and, for a typed message, the reason. `agent_list` prints the newest three per child.

A session message counts as read once the child's model has it. Claude Code reports that when the transcript records the channel message, and pi reports it at `message_end`. Bellwether can't tell when a model reads typed input, and `agent_list` says so. Until then, the message shows as unread.

A child session that reconnects takes its unread message again, after a daemon hand-over or a restart of its server. Before it resends, the adapter checks the session's history, so the model never sees the same message twice.

If a child exits before it reads a message, Bellwether raises an exit event identifying the message, and the record marks the message undelivered.

### The brief

A `claude`, `pi` or `omp` child starts without a brief on its launch line. After the harness starts, Bellwether waits for herdr to detect it. Startup questions come first: a session that waits on one can't read a message, so the spawn answers them before anything else. Bellwether then sends the brief through the child's own Bellwether server or extension, the same path `agent_send` takes. It waits up to 30 seconds for that session to connect, then up to 5 seconds for the adapter to receive the brief. That receipt shows only that the message arrived at the adapter. The adapter connects while its harness is still starting, before the model can take a turn, so a brief can arrive at the adapter and never get through to the model. Bellwether then waits up to 20 more seconds for a sign that only the model gives: herdr reports the harness `working`, or the adapter reports that the model read the message. If neither comes, Bellwether sends the brief once more, and the reply says so. A second copy that does not get a turn or a read within another 20 seconds fails the spawn with `BriefNotTaken`, and its pane and record go away. Its pane shows the task itself, not a path to a file.

Bellwether types the brief into the pane instead when the session path isn't available. The fallback covers a harness with no way in, a session that never connects or doesn't take the brief in time, and a far machine whose Bellwether predates the wait. A harness that exits before it takes the brief fails the spawn, and the error quotes the line it printed. A failed spawn doesn't keep a record, so nothing claims that the brief arrived. Bellwether never types a brief at the shell a harness left behind.

`codex`, `cline`, `kilo` and `opencode` keep a one-line pointer to the brief file as the first prompt on their launch line. Those harnesses don't take a message in their sessions. Each one's store shows the session with that prompt, which proves the brief arrived.

The child record keeps each brief's delivery on the brief, at `children[].briefs[].delivery`, and not on the child. Each resume that brings a prompt adds a brief, and each brief can take its own path. `agent_list` prints each child's newest brief and how it arrived, under a heading that gives that record path.

Each entry under `briefs` records how the brief arrived as `delivery`: `session` with the adapter that received it as `via`, `keystrokes` with the reason, or `launch` with the reason. In a `session` entry, `receivedAt` records when the adapter received the brief, and `takenAt` records when the model began a turn on it or read it. `takenBy` says which, as `turn` or `read`. If the brief went twice, `resentFrom` names the first message. The reply keeps the two facts in their own words: the adapter *received* the brief, and the model *began a turn on it* or *read it*. A brief sent as a message also appears under `messages`, marked with its number, so `agent_list` shows when the model read it. The spawn's reply says which path carried the brief. The brief file stays on disk, so a parent can read it again.

A resume that brings a brief delivers it the same way, once. When the new brief includes an earlier one the child never read, the session isn't offered that earlier message again. A restart doesn't send a brief. That session already has the one it took, and a session that reconnects before its model reads the brief receives it once more, like any unread message.

## Workspaces

A child opens in your own herdr workspace unless the spawn sets `workspace` to another one. The value `"new"` asks herdr for a workspace of the child's own, labelled with the child's name, or with `workspace_label` when you pass one. The child runs in that workspace's first tab, so no empty shell sits beside it.

Its own children open in that workspace too. Each session's children default to its own workspace, so a whole subtree stays out of yours.

Any other value identifies an existing workspace, by id and then by label. A name that doesn't match any workspace fails the spawn before Bellwether writes anything, and the error lists the workspaces there. A label that two workspaces share fails the same way. `"new"` always means a new workspace, even where an existing workspace has the label `new`. A child on another machine gets its workspace on that machine, because `"new"` creates it through that machine's herdr. A workspace id from this machine means nothing there. Passing one fails the spawn. The error identifies the workspace on this machine and lists the ones on the child's machine.

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
| blocked | The child waits on a dialog. herdr reports `blocked`, or a pi child says a dialog is open. When herdr reports `idle`, the screen can also show one. Claude Code's startup questions don't count, nor its read and dangerous-rm questions in a child Bellwether started, because Bellwether answers them. | 3 s |
| stuck | herdr reports `working` or `unknown`, and the child has been quiet past the threshold. | 10 min |
| inactive | No status change, output, new turn or report for the child's inactivity threshold. | none |
| exited | The pane exits or closes, or the harness ends and leaves its pane open. | none |

A harness can end and leave its pane open on the shell that ran it, as pi does when it can't read its brief. herdr then releases the agent, and the parent gets `exited` at once. When the harness ends before herdr ever detects it, herdr keeps it as pending. Twenty seconds after the start, Bellwether checks such a child once. If the shell is the pane's foreground process again, the parent gets `exited`. A child that ended before it reported anything gets an `exited` event that says it never started, so a dead child and a child still thinking don't look the same. Bellwether leaves its tab open on what the harness printed: `agent_read` shows that screen, and `agent_stop` closes the tab.

An unread `blocked` or `stuck` event drops out once the child moves on, so a dialog someone already answered never reaches the parent's next turn.

### One event per turn

The parent hears about each turn once. When a child ends its turn with a `done` or `needs-input` report, the parent gets only the `report` event. A `progress` report leaves the turn open. One `idle` event still follows when that turn ends, and it quotes the turn's own last message, from the transcript or the screen, never a report.

When a child has not called `parent_report` since its latest start, resume or adoption, its `idle` event says so in the first line: `builder (w1:p3) went idle after 4 min, and it has not called parent_report since it started at 2026-11-27T14:02:10Z:`. A harness that refuses the child's report ends the turn like a quiet finish, and so does a model that never calls the tool. Read the child with `agent_read` to learn which.

That clause states the fact without a reason, because the child record doesn't keep one, and it doesn't wake the parent a second time.

Its limits:

- An adopted child counts from its adoption, so a report it sent to another parent before then doesn't count.
- When the daemon reads a report after the `idle` event settled, the report arrives as a `report` event of its own, and the earlier `idle` event still carries the clause.
- When a harness doesn't keep a transcript, the clause comes before the screen lines, which may be all the parent has to read.

Bellwether compares each finished turn with the last turn it told the parent about, not with herdr's current status. The child record keeps that turn as `turnNotified`, with the pane that ran it, so herdr repeating a status doesn't resend the turn. Nor does a later snapshot of the same turn, or a daemon that takes over. An adopted child starts from the turns its pane had already finished, and its first event is the end of its next turn.

For the same child, a newer event replaces an older unread one, except for a report, which stays until the parent reads it.

### A child waiting on a dialog

A `blocked` event names the dialog in one line of at most 100 characters, such as `Bash command: Do you want to proceed?`, so a parent can tell a trust question from a permission question. `agent_read` shows the whole screen. Bellwether never approves a permission: that is the operator's decision. To answer such a dialog, the parent sends keys with `agent_send`, or a person types in the pane.

### Questions Bellwether answers for a child it started

A Claude Code child starts with its reads settled. Its settings file lists the Bellwether home, which holds its brief, as a directory the session may read beside its working directory: `permissions.additionalDirectories` for the file tools, and `sandbox.filesystem.allowRead` for sandboxed shell commands. So the child never asks whether it may read its own brief, on any machine. Claude Code adds the operator's own settings to these lists, so a machine can let a child read more, but none can take the home away. The operator's home and other checkouts stay outside the list.

The read set is what a child reads without a question. It is not a limit. Whether Claude Code asks about a read outside the set depends on the machine, and Bellwether can decline only what Claude Code asks. In auto mode, Claude Code 2.1.332 offers the question only until the machine has shown it once, which it records as `hasSeenAutoModeOutsideReadPrompt` in `~/.claude.json`. A machine can also allow such reads in its own settings. On such a machine a child reads outside its set without asking. With nothing on the screen to answer, Bellwether stays out of it: the record and the parent's events show only what the child itself says about the read. A live check on 2026-11-27 showed it: a child whose set named one skill directory read a file in another, with no dialog. No settings file controls that flag, so the same child can ask on one machine and read freely on another.

On a machine that still asks, Claude Code can put either of these to the child while it works, and Bellwether picks a No for it:

| Question | Answer | Why |
| -- | -- | -- |
| `Allow this read outside the working directories?` | `No, and ask again next time` | The read is beyond what the launch gave the child. The other No would save a block into the operator's settings, and both Yes answers grant the read. |
| A shell command under `Dangerous rm operation not ruled out` | `No, and tell Claude what to do differently` | Claude Code's parser could not rule out a dangerous rm. Only a person approves such a command, never Bellwether. |

A declined read doesn't end in a page. The child hears No and finds another way or ends its turn. If it reaches for the same path again, Bellwether declines it again and counts it. So on such a machine, a brief that needs a path outside the floor has to say so at launch. `agent_spawn` takes `reads`, a list of absolute paths the child reads beside its worktree and the Bellwether home. A path is a directory with everything under it, or one file. Its launch settings list each one, and a resume keeps them. `agent_restart` takes the same `reads` for a child that already runs, replacing its list on the same session, and `[]` clears it. Bellwether refuses the filesystem root, the operator's home and any directory above it, and a path written with `~`. It also refuses `reads` for a harness whose launch takes no read set.

The answer goes on the child's record under `decisions`. Each entry keeps the question as the screen asked it and the option chosen. It also keeps the keys sent, in order, with the time and the part of Bellwether that answered. Each entry has an `outcome`. Both questions above record `declined`, and a declined read also keeps the `path` that the dialog showed. No `blocked` event goes out. The parent's next event about the child names the answer under its first line. A declined read leads with the path and with the field that widens the set: `Bellwether declined builder (w1:p3)'s read of /srv/other/eslint.config.js: …. If the brief needs that path, widen the child's read set rather than send the instruction again: agent_restart with reads ["/srv/other"] keeps its session, and agent_spawn takes the same field.` The second decline of one path adds `This is the second time Bellwether declined that path for it, so the brief needs it.` A declined command reads like this: `Bellwether declined for builder (w1:p3): the dangerous-rm question, "Do you want to proceed?", answered "No, and tell Claude what to do differently" (keys 2). It declined the shell command, which Claude Code could not prove safe and asks a person to approve. The child was told No and goes on without it; tell it another way with agent_send.` The entries live in the parent's registry, not in the worktree, so retirement leaves them in place. When the parent hasn't heard of a decline yet, the child's `exited` event carries it. A spawn's reply lists any answer it gave during the start. Claude Code tells the child that the answer was No, and the parent can suggest another way with `agent_send`.

A startup question that Bellwether doesn't know fails the spawn within a second. The error quotes the question, and Bellwether closes the tab and removes the record, as for any failed spawn. When a question that matches no entry comes while the child works, the parent gets a `blocked` event, as before.

Bellwether never answers a dialog in an adopted child's pane. Someone else started that session under settings Bellwether didn't choose, and a parent types only into panes it started. The parent gets a `blocked` event for each of its dialogs, including the two above.

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

### Text a child's harness suggests

Claude Code shows a suggested next message in its input box, and Codex shows a placeholder there. Both draw that text faint. herdr's plain text read drops the styling, so a suggestion looks like a message somebody typed. Bellwether reads every screen in herdr's ANSI format, and it treats faint text as a suggestion and never as content.

- Bellwether first checks whether a question is on screen, and it reads every line for that, faint ones too, because a dialog often dims the options it has not selected. The selection marker and a `(y/n)` question must be solid, though. A faint `(y/n)` suggestion in the input box leaves the child `idle`.
- A screen with a question on it has no input box. Its `❯` line is the selected option, so it never reads as a draft or a suggestion.
- The spawn walks to an accepting option even when the dialog dims it, and it presses Enter only when a solid marker is on that option. A faint line is never a startup answer or a fatal error.
- A screen that a parent reads leaves faint text out. This covers `agent_read`, the screen lines in a `stuck`, `inactive` or `idle` event, the dialog after a refused `agent_send`, and the screen `agent_stop` shows. The parent never sees the words of a suggestion.
- That screen ends with one line about the input box. `Input box: EMPTY.` means nothing is in it. `Input box: GHOST.` means it holds a suggestion that nobody typed. `Input box: DRAFT.` means someone typed the text on its line and did not send it. Typed text beside a faint tail counts as a draft, and the screen shows the typed part.
- When a dialog covers the box, or the screen has no box, Bellwether omits the line. An older herdr that answers without styling gives `Input box: unknown.`, because there a suggestion and a draft look the same. An empty box still reads `EMPTY`.

The rule treats every harness alike. A harness that draws nothing faint never shows `GHOST`. Bellwether finds the box with the same method as the herdr skill's `herdr-box-state.sh`. That is the last line that starts with Claude Code's `❯` or Codex's `›`, or, for pi, the lines between its two rules when pi's cursor sits there.

### Delivery to the parent

A busy parent gets each event at its next turn: after the tool calls in flight, before the next model call. For an idle parent, the event starts a turn. Several events from one burst arrive together in one message, oldest first, and an event more than a minute old gets a note such as `(late by 4m34s: it happened at 07:25:46 UTC)` after its receipt.

Bellwether marks an event read once its own message is in front of the model. A shell read of the outbox file under `~/.bellwether/outbox/` shows the same receipts, but it leaves them unread, and the notification still arrives. That file stores the read flag, so a restarted daemon replays only the unread events.

The inactivity threshold defaults to 5 minutes. Pass `inactive_minutes` to `agent_spawn` to change it for one child, from 1 minute to 24 hours. No setting turns this notice off. Bellwether sends it once per quiet period, and output or a report starts a new one.

### The other children

Events mention only the children that changed. For a parent with other children still running, one more line about them can precede the closing line:

```
children 5: 2 working, 1 idle 12m, 1 blocked
```

The first number counts each child that has not exited, including those the message names. Everything else counts the other children by state: working, idle, blocked, unknown. One age appears, on the state of the child that has waited longest, because that number tells a parent whether a call is worth making. The states leave out each child the message names, and the line leaves out each child that exited.

Each child's state comes from its record, read when the alert goes out. A child with a dialog open reads `blocked`, and a child whose turn ended reads `idle`.

Both harnesses share one rule for when an alert gets the line, and the daemon enforces it:

- With no other child running, the message reads as before. A parent with one child never sees the line.
- A line that matches the last one the parent received, ignoring the age, stays out.
- After a line goes out, the next one waits at least 10 minutes, so a burst of alerts gets one line.

A restarted daemon follows the same rule because the parent record keeps the last line and its time as `rosterSent`. Claude Code's channel sends one notification per event, and the line goes on the last notification of a flush.

The inactivity notice handles a quiet child, naming it once per quiet period. The line never arrives alone. It only hints that a call to `agent_list` or `agent_read` may be worth making.

## A child's environment

A child started by `agent_spawn` gets these variables, for its own scripts and for the `bellwether report` command, which reads `--child` from `BELLWETHER_CHILD` when the flag is absent.

| Variable | Meaning |
| -- | -- |
| `BELLWETHER_PARENT` | the parent session's registry id |
| `BELLWETHER_CHILD` | this child's record id |
| `BELLWETHER_CHILD_NAME` | this child's name |
| `BELLWETHER_DEPTH` | how many levels deep this child sits |
| `BELLWETHER_HARNESS` | `pi`, `claude-code`, `opencode`, `codex`, or `other` |

## The agent tree

`bellwether ancestry AGENT --json` prints the ancestors of one agent, nearest first, and marks which of them still run. A program that needs the tree runs this command instead of reading the files under `~/.bellwether`, whose layout can change in any release. The JSON in this section is the interface, and its fields keep their names and meanings. A change that would break a reader raises `schema`.

`AGENT` takes the form `<harness>:<session>`: `claude:<session id>` for Claude Code, `pi:<session id>` for pi, and the kind for another harness, such as `codex:<session id>`. A pi session file path works too, and the command reads the id from its name. A bare value matches a child id or a session of any harness.

The command queries the daemon on this machine and never starts one. It exits 0 whenever it prints an answer, including `unknown` and `stale`, and exits 1 when the argument is missing.

```json
{
  "schema": 1,
  "query": "claude:claude-leaf-session",
  "stale": false,
  "source": "daemon",
  "status": "known",
  "agent": {
    "agent": "claude:claude-leaf-session",
    "harness": "claude-code",
    "session": "claude-leaf-session",
    "childId": "leaf000000000001",
    "childName": "name-leaf000000000001",
    "registryId": null,
    "host": "local",
    "depth": 2,
    "alive": false,
    "evidence": "exited",
    "since": "2026-11-01T12:00:00.000Z",
    "retiredAt": null,
    "match": { "rule": "single", "records": [{ "childId": "leaf000000000001", "parentId": "pi-pi-mid-session", "startedAt": "2026-11-01T10:00:00.000Z" }] }
  },
  "chain": [
    { "agent": "pi:pi-mid-session", "harness": "pi", "childName": "name-mid0000000000001", "alive": true, "evidence": "watched", "...": "the same fields" },
    { "agent": "claude:claude-root-session", "harness": "claude-code", "childName": null, "alive": true, "evidence": "connected", "...": "the same fields" }
  ],
  "nearestAlive": 0,
  "top": "root"
}
```

| Field | Meaning |
| -- | -- |
| `schema` | The layout, 1. Check it before you read the rest. |
| `status` | `known`, or `unknown` when no Bellwether record matches the agent. An unknown agent is absent from the tree, which differs from an agent with no living ancestor. An unknown answer has `agent: null` and an empty `chain`. |
| `stale` | `true` when the daemon did not answer and the command read the registry itself. `staleReason` then gives the cause: no daemon answers on the socket, or the daemon predates the request. |
| `source` | `daemon`, or `registry` for a stale answer. |
| `agent` | The agent queried, as one level. |
| `chain` | Its ancestors, nearest first. A root has an empty chain. |
| `nearestAlive` | The index in `chain` of the nearest level where `alive` is `true`, or `null` when no level has it. |
| `top` | Where the chain stops: `root` at a session with no parent, or `outside` at a session whose parent's registry sits on another machine. |

Each level has these fields:

| Field | Meaning |
| -- | -- |
| `agent` | `<harness>:<session>`, or `null` until the harness reports a session. |
| `harness`, `session` | The harness and its session id. |
| `childId`, `childName` | The id and name that the parent's spawn assigned, or `null` for a root. |
| `registryId` | The session's own parent id, `<harness>-<session>`, once it has completed the hello exchange with a daemon. |
| `host`, `depth` | Herdr machine where the session runs (`local` for this one), and generation, 0 at the root. |
| `alive`, `evidence`, `since` | Whether the session runs, how the daemon knows, and since when. The next section explains these three fields. |
| `retiredAt` | When Bellwether removed its worktree and branch, or `null`. |
| `match` | The records that reference this session, with the chosen record first, and the `rule` that selected it. |

### What alive means

`alive: true` means the daemon can vouch, at the moment it answers, that the session runs. The session holds a connection to the daemon (`connected`). Otherwise, the daemon watches the child's pane through its parent's herdr subscription, and herdr has not reported the pane gone (`watched`). `since` is then the latest start, resume or restart, or the time a root connected.

`alive: false` comes from a recorded exit, in which case `since` is the exit time (`exited`). It also comes from a session that is nobody's child here and has no connection (`disconnected`).

`alive: null` means the daemon cannot know. A child's record has no recorded exit, and no running service watches its parent, so nothing would have recorded an exit (`unwatched`). In a stale answer, every level without a recorded exit reads `null` with `stale`, because the files record exits but not which sessions run.

The daemon cannot know two things. First, a root session can run while its Bellwether server is down, and it then reads `disconnected`. Second, a session with `connected` or `watched` can end in the moment after the answer.

### Choosing between two records

When a parent resumes a child under another parent, two records share one session. The answer keeps one record per level. `match.rule` names the rule used to choose the record:

1. `single`: one record matches the session.
2. `alive`: the record whose session runs wins, and a record of unknown state beats one with a recorded exit.
3. `latest-start`: among records that tie on the first test, Bellwether picks the record with the latest start. A resume and a restart both count as starts.
4. `child-id`: when both tests tie, the lower child id wins. The answer then stays the same for the same files.

`match.records` lists every candidate in that order, so a caller can see the rejected record.
