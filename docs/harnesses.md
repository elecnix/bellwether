# Harnesses

Each `agent_spawn` kind names the harness a child runs in, and Bellwether's harness registry has one entry per kind. An entry sets how the child starts and where its brief goes. It also says how Bellwether finds the session and reads the conversation, and which states come from an API rather than the screen. Finally, it sets how the child gets its Bellwether tools.

## Capabilities by kind

| Kind | Starts | Brief | Session | Conversation | Reports through | Dialogs | Resume | Move | Other machine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pi` | yes | `@file`, attached | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | pi's extension | `--session` | yes | yes |
| `claude` | yes | `@file`, attached | herdr, as an id | transcript file | its own MCP server, through `--mcp-config` | a `Notification` hook | `--resume` | yes | yes |
| `opencode` | yes | a sentence that references a file in the working directory | the spawn picks the id and finds it in OpenCode's store | OpenCode's store | its own MCP server, named in `OPENCODE_CONFIG` | the screen | no | no | no |
| `omp` | yes, after you run `herdr integration install omp` | `@file`, attached | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | herdr's omp integration, then the screen | `--session` | no | yes |
| `codex` | yes | a sentence that references a file | the spawn finds it in Codex's rollouts | the rollout | its own MCP server, defined in a `-c` override on its launch line | the screen | `codex resume` | no | no |
| `kilo` | yes, on the native binary | a sentence that references a file in the working directory | found in kilo's store by directory, start time and prompt | kilo's store | its own MCP server, named in `KILO_CONFIG` | herdr's screen rule for kilo | `--session` | no | no |
| `cline` | only with `-y` | a sentence that references a file | in Cline's `sessions.db` | Cline's `sessions.db` | its own MCP server, named in `CLINE_MCP_SETTINGS_PATH` | the screen | no | no | no |

herdr reports `working`, `idle`, `blocked` and `done` for every kind it detects. Some dialogs show as `idle`. Where the child has an adapter of its own, pi's extension or Claude Code's hook names such a dialog; otherwise Bellwether reads the screen before an `idle` event, looking for a marked selection or a y/n question. Bellwether reports a dialog and never answers it, apart from Claude Code's startup questions ([tools](tools.md)).

Codex doesn't ask its folder-trust question, because its launch line marks the folder trusted for that run.

## Each kind in three lines

Each kind has the same three bullets, so a reader can line up two kinds. The bullets give the child's abilities and limits, then say how it gets its Bellwether tools.

### `pi`

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling.
- **Cannot:** send input to a pane it did not start, resume or adopt.
- **How:** the Bellwether pi extension, loaded with `-e` from the package that spawned it. The extension stores this child's id, so each call reaches only its own parent.

### `claude`

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling.
- **Cannot:** send input to a pane it did not start, resume or adopt.
- **How:** its own MCP server, configured in a per-child file passed with `--mcp-config`. That file gives this child's id, and the operator's `~/.claude` settings aren't changed.

### `opencode`

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling.
- **Cannot:** run on another machine, or resume a session.
- **How:** its own MCP server, configured in a per-child file that `OPENCODE_CONFIG` points to. Only the child's private server (`--standalone`) reads that file, so no other OpenCode session gets the tools.

### `omp`

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling. It runs on another machine once herdr there has its omp integration.
- **Cannot:** start until you run `herdr integration install omp`, since only that integration reports the child's state and session file to herdr. It cannot move, because `agent_move` finds only pi and Claude Code session files.
- **How:** the same Bellwether pi extension, passed with `-e`. omp runs pi extensions, and its extension API has every call this one makes. The extension stores this child's id, and the tab sets `OMP_SKIP_SETUP`, so omp's setup wizard doesn't block the brief. On another machine, `bellwether relay-register` there names the extension and hands the variable back for the tab. The spawn refuses a machine whose Bellwether hands back no variables, with an error that specifies the variable and the upgrade that machine needs. Bellwether answers no omp dialog.

### `codex`

- **Can:** report, and request retirement and depth.
- **Cannot:** start children or message other agents, because Codex's approval policy refuses every other Bellwether tool. It cannot run on another machine either.
- **How:** its own MCP server, set by a `-c` override on its launch line that pre-approves those three tools. The approval reaches only that child, and Bellwether never sends a key to a Codex dialog.

### `kilo`

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling. A parent resumes it with `--session`.
- **Cannot:** run on another machine, because Bellwether reads kilo's store and version on the machine where it runs. It can't start through npm's `kilo` launcher either, because herdr detects kilo by its process name and that launcher runs the binary as `.kilo`.
- **How:** its own MCP server, configured in a per-child file that `KILO_CONFIG` points to. kilo merges that file over the operator's global configuration and leaves it unchanged, and the child's `bellwether` server replaces one by that name in the global configuration.

### `cline`

- **Can:** `agent_adopt` takes a Cline pane, and Bellwether reads its conversation from Cline's `sessions.db`. A child started with `-y` also reports, requests retirement and depth, and takes an `agent_send` follow-up after its first task.
- **Cannot:** start through `agent_spawn` by default, because Cline runs every terminal session inside a shared background hub. It can't run on another machine or resume either.
- **How:** the explicit `-y` opt-in in `agent_spawn`'s `args`, which runs the session in the child's own process with its own MCP server, named in `CLINE_MCP_SETTINGS_PATH`. When the caller turns `-y` on, the spawn reply prints what it costs.

## Refusing a child no one can hear

A child calls `parent_report` through a Bellwether server or extension that holds its child id. When a harness has no such server, its entry says so. `agent_spawn` then refuses the spawn before it writes a record, a brief or a tab. The refusal reads:

```
worker was not started: Bellwether does not give an example child its own Bellwether server yet, so the child could not call parent_report. An example child can be adopted with agent_adopt once it runs, and its status changes still reach you; see docs/harnesses.md.
```

No kind here lacks one today. Cline has its server too, but `agent_spawn` still refuses Cline's default launch, for a different reason: the shared background hub that the next section describes, where the server would not stay with its child.

## Cline and its shared hub

Cline 3.0.76 reads the MCP settings file that `CLINE_MCP_SETTINGS_PATH` names, so each child could have its own server. Whether that works depends on where the session runs, and `-y` changes that.

### Without `-y`: refused

`cline -i` joins Cline's shared background hub when one runs, and starts one when none does. MCP servers load in the hub, which keeps the environment of the session that started it, so in a test with two children on one machine the second child's session ran in the first child's hub and loaded the first child's server. What goes wrong:

- A second child's reports would go out under the first child's id.
- The hub keeps running after the child that started it exits, and your own Cline sessions join that hub and load the child's server.

No Cline setting stops a terminal session from joining the hub. The terminal UI ignores the environment variable meant for it ([cline/cline#13631](https://github.com/cline/cline/issues/13631)). [cline/cline#15881](https://github.com/cline/cline/issues/15881) asks for a per-session MCP configuration or a hub-off switch. Until Cline has one, `agent_spawn` refuses this launch, and its refusal states the hub and these consequences.

### With `-y`: allowed, at a cost

Passing `-y` (or `--yolo`) in `args` runs the session in the child's own process. That process never starts or joins a hub. In the same test, a `-y` child loaded only its own server while another session's hub ran, and it stayed up after its first task. It answered a follow-up typed at its prompt, so `agent_send` reaches it.

The cost is Cline's benchmark mode, which the spawn reply prints when the caller turns it on:

- Another system prompt.
- Six built-in tools, `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `editor` and `ask_question`, plus the MCP tools, where the default mode offers 26.
- No skills, sub-agents or teams.
- Cline's own help, which calls `-y` "DANGEROUS: use only in sandboxed environments."

### The session store

Bellwether finds a cline child's session in Cline's `sessions.db`. For an adopted pane, `agent_read` and the watcher use the newest live top-level session in the pane's directory. The store is at the first of these paths that applies:

- `CLINE_DB_DATA_DIR`
- `CLINE_DATA_DIR/db`
- `CLINE_DIR/data/db`
- `~/.cline/data/db`

## An older daemon

When a release changes a kind's entry, the running daemon must serve the argument `agent_spawn.kind=<kind>`. If the daemon predates the change, the call fails and reports the operation and the release that brought it. It never falls back to the old launch method ([upgrading](upgrading.md)). Bellwether has applied this check to the OpenCode, omp, Codex, kilo and Cline kinds since 0.1.5.

## Launch details

The [OpenCode](opencode.md) and [Codex](codex.md) topics cover the launch arguments, the session lookup and the refusals, and so does the [kilo](kilo.md) topic.

An omp child starts as `omp [--model provider/id] -e <pi extension> @<brief>`. omp takes the model as one value, either `provider/id` or a name it matches, so `agent_spawn` refuses a separate `provider` for this kind.

Without a model, omp uses the default in its own settings. `agent_list` shows the model once omp writes the first `model_change` entry to its session file.

herdr's omp integration reports a tool approval and omp's `ask` tool as `blocked`, while a dialog from another omp extension shows as `idle`. The screen check names that dialog.
