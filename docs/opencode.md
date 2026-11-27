# Running a child on OpenCode

Bellwether can start a child on OpenCode when `agent_spawn` receives `kind: "opencode"`. It targets OpenCode 2 only, as npm publishes it in `@opencode/cli`. The code targets 2.4.2. The `opencode-ai` package still publishes 1.x, and Bellwether refuses it.

## Launch arguments and the session check

Before launch, Bellwether picks the session id itself, in the form OpenCode mints, and launches the child with these arguments:

```sh
opencode --standalone --session ses_… --prompt "Your task is in <cwd>/.bellwether/brief-<child id>.md. Read it, then do what it says."
```

- `--session` makes OpenCode create its first session under that id. `--prompt` fills the first message and submits it.
- `--standalone` gives the child a private OpenCode server. Without it, the child joins the shared background server, which reads its configuration from the environment of whichever client started it first. The private server inherits the child's tab environment, which carries two variables: `OPENCODE_CONFIG`, the child's own configuration under `~/.bellwether/mcp/`, and `OPENCODE_DB`, the path of the store.
- The brief file goes in `.bellwether/` inside the child's working directory, with mode 0600 and a `.gitignore` of `*`. OpenCode asks a question before it reads outside its directory, so a brief anywhere else would stop the child at a dialog. herdr refuses a line break in an argument, so the prompt stays on one line and points to the file.

Up to 30 seconds, the spawn waits for a matching row, since herdr doesn't report a session for OpenCode and the store is the only proof that the brief arrived. A matching row must:

- carry the id Bellwether picked,
- have no parent session,
- sit in the child's directory,
- come from OpenCode 2, and
- hold a user message with the prompt.

Without such a row, the spawn fails. Its error gives the store and what it last found. It closes the tab but keeps the brief file for inspection. A row under that id that belongs to a subagent, to another directory or to another major version fails the spawn at once.

The daemon takes the store path from `OPENCODE_DB` when its environment sets it. Otherwise the daemon uses `opencode.db` in OpenCode's data directory, `~/.local/share/opencode` by default. Both sides read one file, because the child gets the same path. The child record keeps that path as `store`.

## Refusals

The spawn refuses each of these before it opens a tab:

- An `opencode` on the daemon's `PATH` whose version is not 2. The error reports the version found, the binary, and the version Bellwether needs. When the daemon sees no `opencode` at all, the spawn goes ahead, because the tab's shell may have another `PATH`. The store check reads the version from the child's server instead.
- A spawn without `cwd`, because the brief has to sit inside the working directory.
- A `model` that is not `provider/model`, optionally with `#variant`. OpenCode 2's terminal UI takes no model flag, so the model goes in the child's configuration as its default. OpenCode's terminal UI uses that default only when the model appears in its own model list. In 2.4.2, a provider defined only in configuration didn't appear there, and the UI picked another model. On a route whose `harnesses` list `opencode`, the route's tier picks the model instead, and the configuration names none. [routes.md](routes.md) describes routes.
- A child on another machine. Its store and version live on that machine, and Bellwether doesn't read them there yet.
- A daemon from a release before this harness. Such a daemon lists `opencode` as a kind but launches it with a sentence that OpenCode 2 reads as a directory. The client refuses the call and names `agent_spawn.kind=opencode` with the release that brings it.

`resume`, `agent_move` and `agent_restart` don't cover OpenCode children yet. Each refuses them by kind.

## Capabilities of an OpenCode child

| Capability | How it works |
| -- | -- |
| `parent_report` | The child's private server starts Bellwether's MCP server from `mcp.servers` in its configuration, with the child id, so the parent receives the report. OpenCode 2 offers MCP tools through its code mode, so the model calls `tools.bellwether.parent_report` inside an `execute` call. |
| Read its brief | Its working directory contains the brief, so no dialog interrupts the read. |
| Spawn its own children | The same MCP server lists the parent tools, and the depth ceiling applies as it does for any child. |
| Hear its own children | No. OpenCode has no channel that wakes a session. An OpenCode parent sees its children's events only through `agent_list` and `agent_read`. |
| Take a message | `agent_send` types into the pane through herdr's `agent.prompt`, as it does for any harness. |

## Status sources

| State | Source |
| -- | -- |
| Working and idle | herdr's status events, as for every harness. The watcher also reads the session's update time from the store, so it sees a child making progress without a screen read. |
| Blocked | herdr's status events, and the screen read the watcher already does before an `idle` event. OpenCode keeps a pending permission or question in memory, never in the store. |
| Exited | herdr's pane events. |

`agent_read` returns the newest assistant answer from the store, joining its text parts. A turn that ended in an error without text returns that error. With no answer yet, it reports whether the session is mid-turn or idle, and adds the screen.

## The drill

`test/lab/opencode-lab.test.ts` runs a real OpenCode 2 under a lab herdr of its own. The child reads its brief, calls `parent_report`, and `agent_read` returns its final answer from the store. The lab's home configures no provider, and the lab strips every provider key from its environment, so OpenCode answers with its free hosted model. That model runs on OpenCode's service and receives the brief, so the case runs only when you set `BELLWETHER_OPENCODE_DRILL=1`:

```sh
npm install --prefix /tmp/oc2 @opencode/cli@2.4.2
BELLWETHER_OPENCODE_DRILL=1 PATH=/tmp/oc2/node_modules/.bin:$PATH npm run test:lab
```
