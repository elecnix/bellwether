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
| `parent_report` | a child Bellwether started or resumed, here or on a saved herdr machine | sends `done`, `needs-input` or `progress` to the parent that holds the child's record |
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

### Reports from another machine

A child on another machine runs on that machine's herdr. Bellwether reaches it the way `herdr --machine` does, through `herdr remote-api-bridge` over SSH to the saved profile's target, so the profile must exist in `herdr machine list` and SSH must log in without a prompt.

Each machine runs one Bellwether daemon. The parent's daemon keeps the registry of record, so a report from a child on another machine goes there. A child's own daemon serves such a report only when it has a parent record for that child, as step 2 describes.

1. Before the child's tab opens, the parent's daemon runs `bellwether relay-register` on the child's machine over SSH. The command writes a relay record, `~/.bellwether/relay/children/<child id>.json`, with mode 0600. The record lists the child, the parent id and the parent machine's SSH target. For a Claude Code child, the MCP config goes there too.

2. The child calls `parent_report`, and the call goes to the daemon on its own machine. If that daemon has a parent record for the child, it serves the report locally. Otherwise, the relay record decides. The daemon writes the report to `~/.bellwether/relay/outbox/<receipt>.json` with mode 0600, then forwards it in one SSH command. A local parent record means the daemon forwards nothing.

3. On the parent's machine, the command is `bellwether report --parent <id> --child <id> --receipt <id> --status <status> --text <text>`. It posts the report to that machine's daemon over its local socket, and it starts the daemon when none answers. The daemon checks the parent and the child against its own registry, and it accepts each receipt once, so a retried forward is safe.

A failed hop leaves the report in the outbox. The daemon retries it with backoff from 2 seconds to 5 minutes, and it keeps running until the outbox empties. The relay record counts the reports in `unforwarded` and shows the newest error in `lastForwardError`. Every attempt appears in the daemon log with its host.

A refusal from the parent's daemon is final. Bellwether marks the report `refused` and stops retrying it, but the report stays on disk. With no parent host, a relay record refuses the report and shows its path.

Bellwether connects to the parent's machine by its host name. When SSH knows that machine by another name, set the name in `~/.bellwether/config.json` on the parent's machine, as `{"sshTarget": "name"}`. Bellwether uses the operator's SSH configuration with `BatchMode=yes`. It doesn't add a key, and it doesn't write anything under `~/.ssh`. Both machines need Bellwether installed, because each end of a hop runs the `bellwether` command.

Because a forward puts the report on one SSH command line, the daemon refuses any text longer than 100,000 bytes, and the report doesn't go out. If registration fails, the spawn still starts the child, and herdr status still follows it. The spawn's reply says why the child can't report.

For a remote child, `agent_read` reads the transcript in place through `bellwether last-message` over the same hop. That works after the child exits, for as long as the transcript stays on disk. If the hop fails, it returns the child's last report, which the parent's registry keeps.

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

The plugin is for a parent session, one you start yourself. You don't set anything up for a child: `agent_spawn`, with or without `resume`, starts each Claude Code child with its own server, passed as `--mcp-config=~/.bellwether/mcp/<child id>.json`. The file has mode 0600 and lists one server, which runs this package's channel entry point with `--child <child id>`. Bellwether deletes it when the child exits or the spawn fails. A child on another machine gets its file from that machine, written by `bellwether relay-register` under that machine's `~/.bellwether/mcp/`.

You don't need a `mcpServers` entry in your Claude Code settings for children. A user-level `bellwether` entry is harmless, and children don't use it. For the tools in a session you start by hand, install the plugin above.

The server speaks MCP over stdio, so each log line goes to stderr and stdout carries only the protocol. It exits when stdin closes, which keeps a leftover process from showing the session as listening.

### Check the install

```sh
bellwether doctor
```

It reports the installed version and daemon protocol, the herdr socket, the herdr API version, the Pi extension path, the MCP entry point and every registered parent with its children. When a daemon runs, doctor also reads its version and protocol from `~/.bellwether/daemon.lock`, and says when they differ from the install. A Pi extension path that does not resolve, or an MCP entry without its executable bit, fails the check. `bellwether --version` prints the installed version alone.

## Release

Every version goes through npm's staged publishing, so the operator's one-time code approves it. `npm run release` does everything else, and you run it twice:

```sh
npm run release -- 0.1.4    # gates, version bump, release PR, merge, stage, review
npx -y npm@12 stage approve <stage id> --otp <code>    # the person, with their code
npm run release -- 0.1.4    # the Homebrew formula: bump, tap CI, merge
```

Each run reads where the release stands, then takes it one stage further:

1. Once npm serves the version, the script bumps `Formula/bellwether.rb` in `elecnix/homebrew-tap`. It downloads the tarball and writes the new `url` and `sha256` on a `bellwether-<version>` branch through the GitHub API. Then it opens the pull request, waits for the tap's CI and merges. A formula that already points at the version stays as it is, and so does the formula for any version older than npm's `latest`.
2. With the version staged on npm, the script waits up to 30 minutes while the registry's review shows `validating`, then prints the `stage approve` command. A rejected stage stops it.
3. If `origin/main` already declares the version, the script checks out the commit that set it, in a `release-<version>` worktree beside the current one. It runs `npm ci` and `npm stage publish` there, and continues as in step 2.
4. While a pull request from `release/<version>` is open, the script waits for its CI with `gh monitor`. It squash-merges once every check passes. A failing check stops it and leaves the pull request open.
5. With none of those in place, the script refuses a checkout with uncommitted changes, and an `origin/main` whose last `ci` run did not pass. It creates the `release-<version>` worktree from `origin/main` and runs `npm ci`, typecheck, the three test tiers and `doctor`. After that it bumps the version in `package.json` and `package-lock.json`. Last, it pushes `release/<version>` with a pull request, and continues as in step 4.

Run it again after any stop, whether a failed check, a timeout or a closed terminal, and it resumes from the same stage. Approval stays with the person: the script stops at the `stage approve` command and leaves the code to them. It runs on the `gh` and `npm` logins of the machine, which must have write access to both repositories and publish rights on the package. It doesn't use a token or an Actions secret.

### Install on each machine, in this order

Bellwether reaches a machine through three channels, and each one updates on its own. A machine can use any mix of them.

1. **Approve and publish.** Until the operator approves the stage, npm serves the previous version, and every install below gets that one.
2. **`brew upgrade bellwether`** on a machine that uses the tap. It replaces the `bellwether` and `bellwether-mcp` commands. Without Homebrew, run `npm install -g @elecnix/bellwether` instead, which needs Node 22.18 or newer.
3. **`pi install npm:@elecnix/bellwether`** for the Pi extension, which Homebrew doesn't touch. When `pi list` shows the extension at a local checkout, Pi keeps loading that checkout after a `brew upgrade`, and this command points it back at the npm package. Pi loads the new extension at the next session start.
4. **`/plugin marketplace update bellwether`** in Claude Code, where parent sessions use the plugin. The plugin follows this repository's default branch, not npm.
5. **`bellwether drain`.** A running daemon keeps the code it started with: each open session holds a connection to it, and it exits only when idle. `drain` lets it finish its current calls and exit. Each connected session reconnects within a second and starts a daemon from its own install, so until every session restarts, the new daemon may come from an older install.
6. **`bellwether doctor`**, to compare the installed version with the running daemon's.

On a second machine, `command -v brew` picks the route: `brew upgrade bellwether` when it prints a path, and `npm install -g @elecnix/bellwether` when it fails. Steps 3 through 6 then apply as written. Both machines need the new version before a remote child reports across a protocol change, because each end of an SSH hop runs the `bellwether` command.

### A release that changes the daemon protocol

Change `DAEMON_PROTOCOL` in `src/daemon/protocol.ts`, and every running client either drains the daemon or fails. `npm run release` compares the value with the published `latest`, and flags a change in the release pull request and beside the approve command.

A user sees one of three things, by which side updated first:

- **A newer session meets an older daemon.** The session drains it and starts its own on the new protocol. The old daemon finishes its current calls before it exits, so every call gets its answer.
- **An older session meets a newer daemon.** The daemon keeps running. Each tool call from that session fails with `the running daemon speaks protocol N, newer than this client's M. Update this Bellwether install.` until the session restarts on the new install. A child started before the upgrade runs its MCP server from the old install, so its `parent_report` fails the same way. The watcher still turns its herdr status into events for the parent.
- **No session has updated.** The old daemon keeps running until a session or `bellwether drain` replaces it.

A releasing agent whose release changes the protocol does this before the person approves:

1. Lists the live sessions with `bellwether parents`, with the children each one runs.
2. Tells the person which sessions and children will fail their tool calls after the upgrade, and that each recovers when it restarts.
3. After the install steps, runs `bellwether drain`, restarts its own session and asks the person to restart the others. For a child that still has to report, it stops the child and resumes it with `agent_spawn` and `resume`, which starts it on the new install.

When the protocol stays the same, none of this applies: after `bellwether drain`, sessions reconnect to the new daemon without an error.

## Environment

A child started by `agent_spawn` receives these variables in its tab, for its own scripts and for the `bellwether report` command, which takes `--child` from `BELLWETHER_CHILD` when the flag is absent. The MCP server identifies its child with `--child` instead, and the daemon looks up the parent in its records.

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
