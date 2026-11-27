# Bellwether

Bellwether gives a coding agent in herdr tools to start another agent in a new herdr tab, of any kind herdr can start. When a child reports, goes idle, blocks, stalls or exits, the parent agent gets a fresh turn that says so. One herdr subscription streams each child state change to the parent.

The MVP covers Pi and Claude Code, each as a parent and as a child.

## Parts

A parent session runs an adapter: a Pi extension, or a Claude Code MCP channel server. Both are clients of one local daemon that runs the Bellwether core. The daemon starts on demand from the first session that needs it, and one daemon serves every session on the machine. When a session resumes, it receives the events it missed. With nothing left to watch, the daemon exits.

- **Daemon.** One per machine, on a socket under the Bellwether home. It is the only process that holds state: the registry, the outbox and the herdr subscriptions. An adapter keeps none of that. It starts without the identity variables of the session that launched it, so its own environment never decides who a call came from. A lock file and a version handshake keep a second client from starting a second daemon. When a client is newer than the daemon it found, the client sends a drain request and the old daemon exits once no call is in flight. `bellwether daemon` runs it in the foreground when you want to watch it.
- **herdr client.** Newline-delimited JSON on the herdr socket, one connection per request and one held open for the subscription. The subscription checks the `subscription_started` acknowledgement and buffers any event that arrives with it.
- **Registry.** One JSON file per parent session, under `~/.bellwether/parents/`, written by the daemon. Each child record stores its name, kind, pane, tab, start time, last status, last `completion_seq` and transcript path. Bellwether writes the record before it asks herdr for anything, so a crash mid-spawn still says what it asked herdr for.
- **Watcher.** It subscribes to `pane.agent_status_changed` for each child pane, plus `pane.exited`, `pane.closed` and `pane.agent_detected`. On connect it subscribes first, then reads a snapshot on a second connection, then reconciles. A dropped subscription reconnects with backoff and takes a fresh snapshot, because herdr does not replay events.
- **Classifier.** It turns herdr states into child events, with a settle time for each. It is a pure function of state, clock and observation.
- **Outbox.** One pending entry per child, where a newer state replaces an older one. The receipt id in the entry marks it read once the parent's model context shows that id.

## Child events

| Event | Signal | Settle |
| -- | -- | -- |
| report | The child calls `parent_report`. | none |
| idle | herdr reports `idle` or `done` with a new `completion_seq`, and no report covered that turn. | 5 s |
| blocked | herdr reports `blocked`, on a question other than Claude Code's startup questions. | 3 s |
| stuck | herdr reports `working` or `unknown` and the child has been quiet past the threshold. | 10 min |
| inactive | The child has shown no status change, output, new turn or report for its inactivity threshold. Any status counts, `blocked` included. | none |
| exited | `pane.exited`, `pane.closed`, or herdr stops detecting the agent. | none |

A Claude Code child asks two questions before its prompt: whether to trust the folder, and whether to load the development channel. `agent_spawn` answers both before it returns. It moves the selection to "Yes, I trust this folder" and to "I am using this for local development", checks each on screen, and then presses Enter. It says yes to the folder question for any folder, which gives the child write access to whatever directory the spawn names. When a question is still on screen after the spawn's 30 seconds, the spawn fails, and the error names that question. The parent hears about neither question. A resumed session shows the channel question again, and the watcher answers it the same way.

At delivery, the watcher drops an unread `blocked` or `stuck` event once the child has moved on. A dialog someone already answered stays out of the parent's next turn.

The registry keeps each child's harness session, `session.kind` and `session.value`, and its transcript path after the child exits. To resume a retired child, call `agent_spawn` with `resume`. By hand, a retired Claude Code child resumes with `claude --resume <value>`.

The inactivity threshold defaults to 5 minutes. `agent_spawn` takes `inactive_minutes` to set it for one child. A value is clamped to 1 minute through 24 hours, and no value turns the notice off. The notice fires once per quiet period. Output or a report starts a new one.

## Tools

| Tool | Who gets it | What it does |
| -- | -- | -- |
| `agent_spawn` | any session | starts a child in a new tab, on this machine or on a saved herdr machine named by `machine`, or with `resume` messages an earlier child, reopening its session in a new tab when herdr no longer has it |
| `agent_adopt` | any session | makes a running agent this session did not start into its child, such as one `herdr-spawn.sh` started, and refuses a pane another session watches |
| `agent_list` | any session | lists this session's children with status, age and unread events |
| `agent_read` | any session | returns a child's last assistant message, or its screen when you pass `lines` |
| `agent_send` | any session | prompts a child, or sends keys when herdr refuses a blocked one |
| `agent_stop` | any session | closes a child's tab, refusing a working child unless you pass `force` |
| `parent_report` | a child Bellwether started or resumed on this machine | sends `done`, `needs-input` or `progress` to the parent that holds the child's record |
| `request_retirement` | a session whose environment carries `BELLWETHER_CHILD` | asks the daemon to remove the child's worktree and branch after herdr drops its pane, and doesn't remove anything itself |

Bellwether sends input only to panes that belong to this parent: the ones it started, resumed or adopted.

Each adapter sends its session's identity with every tool call: the herdr pane it runs in, and the child id its spawn gave it. The daemon matches that identity against the child records it keeps, so a `parent_report` reaches the parent whose registry lists the child, whichever client process made the call. Adapters read the parent from the daemon's records, never from an environment variable. When no record matches, the error gives the pane and the path of the MCP config file the spawn should have written.

### Retirement

A child that has finished its work calls `request_retirement`, then closes its own tab. The call runs while the child is alive, so the child hears which checks pass now. Those cover uncommitted changes, stashes on the branch, and whether its commits exist anywhere else. On the child record go `retireRequestedAt` and `retireIntent` (worktree, repository, branch, commit), and nothing on disk changes. Bellwether refuses, and leaves the record as it was, for a caller with no child record, an adopted child, a child on another machine, a detached HEAD, or a main worktree.

The daemon does the cleaning. It already holds the registry, watches every pane and keeps running after each child exits, so no other process takes part. When the watcher sees the child's pane exit, it runs these steps in order, and it doesn't remove anything until each one holds:

1. herdr lists neither the pane nor any pane in its tab. Otherwise the retirement waits for the next exit event.
2. The worktree must not be a main worktree. It must also match what the child asked about, with a clean status and no stash on its branch.
3. The default branch contains the branch, or GitHub shows a merged or closed pull request whose head is the branch's commit.
4. No process has its working directory inside the worktree.
5. `git worktree remove`, then `git branch -D`, then a check against git and the filesystem that neither remains.

The daemon writes the outcome to the child record as `retiredAt` and `retireOutcome` (`removed` or `refused`). A refusal also gets `retireReason`, which states the failed condition and what a person would do about it. One JSON line per outcome goes to `~/.bellwether/retire.log`. `retireStage` records each removal as it completes, so a daemon that starts again finishes an unfinished retirement without repeating a step. Bellwether treats a worktree as main when its git directory is the repository itself or git lists it first. The checkout of the default branch counts too, as does any worktree named `main` or `master`. Resuming a child clears its request.

### Resume through `agent_spawn`

`agent_spawn` accepts a `resume` target: a child's name, its id or its session id. It also takes the same `prompt` as any spawn. herdr, not the registry, decides what happens next.

- When herdr shows the child's session in the pane this parent started for it, the prompt goes to that pane as an ordinary message. No tab opens, and the child keeps its id.
- When herdr has no pane for the session, Bellwether treats the child as retired. It opens a tab on the child's original machine and starts the harness with `--resume` for Claude Code or `--session` for Pi. The child keeps its id, so its events and receipts continue, and Bellwether passes the prompt in a file with mode 0600.
- When the registry and herdr disagree, herdr wins, and the reply opens with a line that says so. Bellwether resumes a record still marked running whose session herdr no longer has. For a record marked exited whose session herdr still shows in its own pane, Bellwether sends the message and clears the exit mark.
- When the session runs in a pane this parent did not start, Bellwether refuses. The refusal gives the child, the pane and `agent_adopt`. Bellwether never types into that pane.

When the call passes `kind` with a session id that this parent's children did not run, Bellwether starts a new child, with `name`, `cwd` and `machine` as for a spawn.

Bellwether also refuses a live agent that isn't a child, a harness without a resume flag, or a retired child whose session was never recorded, along with a target that doesn't match any child or session. Each refusal tells the caller what to pass instead.

A lock file under `~/.bellwether/locks/`, one per child, covers the decision and the resume. A second call for the same child fails at once with the process that holds the lock, so two callers open one tab between them. Bellwether takes over a lock whose process has exited or that is older than five minutes.

A child on another machine runs on that machine's herdr. Bellwether reaches it the way `herdr --machine` does, through `herdr remote-api-bridge` over SSH to the saved profile's target, so the profile must exist in `herdr machine list` and SSH must log in without a prompt. That child's `parent_report` writes to its own machine's disk, which the parent never reads, so Bellwether follows it through herdr status alone.

Each child record keeps its `host` after the child exits, so a resume goes back to the same machine. A registry file written before version 2 gains `host: local` for each child the next time Bellwether writes it.

## Install

### Pi

```sh
pi install npm:@elecnix/bellwether
```

The package declares its extension under `pi.extensions`, so Pi loads it at the next session start.

### Claude Code

Add the marketplace, then install the plugin:

```text
/plugin marketplace add elecnix/bellwether
/plugin install bellwether@bellwether
```

Channels are a research preview. A plugin outside the organization allowlist needs the development flag when the session starts:

```sh
claude --dangerously-load-development-channels plugin:bellwether@bellwether
```

The plugin runs `bin/bellwether-mcp.js` as an MCP server and enables it as a channel, and that declaration is what delivers child events. Load the server as a plain MCP server and the tools arrive, with events waiting in the outbox.

The plugin is for a parent session, one you start yourself. You don't set anything up for a child: `agent_spawn`, with or without `resume`, starts each Claude Code child with its own server, passed as `--mcp-config=~/.bellwether/mcp/<child id>.json`. The file has mode 0600 and lists one server, which runs this package's channel entry point with `--child <child id>`. Bellwether deletes it when the child exits or the spawn fails. A child on another machine doesn't get a file, because the daemon on that machine doesn't store a record of it.

You don't need a `mcpServers` entry in your Claude Code settings for children. A user-level `bellwether` entry is harmless, and children don't use it. For the tools in a session you start by hand, install the plugin above.

The server speaks MCP over stdio, so each log line goes to stderr and stdout carries only the protocol. It exits when stdin closes, which keeps a leftover process from showing the session as listening.

### Check the install

```sh
bellwether doctor
```

It reports the herdr socket, the herdr API version, the Pi extension path, the MCP entry point and every registered parent with its children. A Pi extension path that does not resolve, or an MCP entry without its executable bit, fails the check.

## Environment

A child started by `agent_spawn` receives these variables in its tab, for its own scripts and for the `bellwether report` command. The MCP server identifies its child with `--child` instead, and the daemon looks up the parent in its records.

| Variable | Meaning |
| -- | -- |
| `BELLWETHER_PARENT` | the parent session's registry id |
| `BELLWETHER_CHILD` | this child's record id |
| `BELLWETHER_CHILD_NAME` | this child's name |
| `BELLWETHER_DEPTH` | how many levels deep this child sits |
| `BELLWETHER_HARNESS` | `pi`, `claude-code`, or `other` |

## Layout

```
src/core/          herdr client, registry, watcher, classifier, outbox, spawn, report
src/daemon/        the daemon: protocol, server, client, lock, parent service
src/integrations/  the tool list, shared by both adapters
src/integrations/pi/       the Pi extension
src/integrations/claude/   the Claude Code MCP channel server
bin/               the bellwether command and MCP server, run from the sources in a checkout
dist/              the compiled JavaScript that npm publishes, built by `npm run build`
docs/              probe results and notes
test/unit/         tier 1: fake clock, in-memory registry
test/integration/  tier 2: a fake herdr socket and the daemon, tier 3: a real isolated herdr server
```

## License

MIT
