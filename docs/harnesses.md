# Harnesses

Each `agent_spawn` kind names the harness a child runs in, and Bellwether's harness registry has one entry per kind. An entry sets how the child starts and where its brief goes. It also says how Bellwether finds the session and reads the conversation, and which states come from an API rather than the screen. Finally, it sets how the child gets its Bellwether tools.

## Capabilities by kind

| Kind | Starts | Brief | Session | Conversation | Reports through | Dialogs | Resume | Move | Other machine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pi` | yes | a message through the Bellwether pi extension, typed as the fallback | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | pi's extension | `--session` | yes | yes |
| `claude` | yes | a message through its own Bellwether server, typed as the fallback | herdr, as an id | transcript file | its own MCP server, through `--mcp-config` | a `Notification` hook | `--resume` | yes | yes |
| `opencode` | yes | a sentence that references a file in the working directory | the spawn picks the id and finds it in OpenCode's store | OpenCode's store | its own MCP server, named in `OPENCODE_CONFIG` | the screen | no | no | no |
| `omp` | yes, after you run `herdr integration install omp` | a message through the Bellwether pi extension, typed as the fallback | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | herdr's omp integration, then the screen | `--session` | no | yes |
| `codex` | yes | a sentence that references a file | the spawn finds it in Codex's rollouts | the rollout | its own MCP server, defined in a `-c` override on its launch line | the screen | `codex resume` | no | no |
| `kilo` | yes, on the native binary | a sentence that references a file in the working directory | found in kilo's store by directory, start time and prompt | kilo's store | its own MCP server, named in `KILO_CONFIG` | herdr's screen rule for kilo | `--session` | no | no |
| `cline` | yes, in Cline's sandbox mode | a sentence that references a file | in the child's own `sessions.db` | the child's `sessions.db` | its own MCP server, named in `CLINE_MCP_SETTINGS_PATH` | the screen | no | no | no |

herdr reports `working`, `idle`, `blocked` and `done` for every kind it detects. Some dialogs show as `idle`. Where the child has an adapter of its own, pi's extension or Claude Code's hook names such a dialog; otherwise Bellwether reads the screen before an `idle` event, looking for a marked selection or a y/n question. Bellwether reports a dialog and never answers it, apart from Claude Code's startup questions and the two questions it declines for a child it started ([tools](tools.md#questions-bellwether-answers-for-a-child-it-started)).

herdr reports a `pi`, `claude` or `omp` session only through its own integration for that harness, which `herdr integration install pi`, `claude` or `omp` writes on each machine. `herdr integration status` lists what a machine has. Without that integration, herdr shows the child's pane with no session, so Bellwether records none, and the child can't move, restart or resume by its session. `agent_spawn` asks herdr on the child's machine and warns in its reply when the integration is missing. A move, a restart or a resume that then refuses for the missing session gives the integration and the command that installs it. An `omp` spawn refuses outright, because herdr would report none of that child's states either.

Codex doesn't ask its folder-trust question, because its launch line marks the folder trusted for that run.

A `claude`, `pi` or `omp` child takes a parent's message, and its brief, in its session, and herdr types a message into the pane of any other kind. [tools.md](tools.md#messages-to-a-child) gives the cases and the record, and [the brief](tools.md#the-brief) gives the order a spawn takes.

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

- **Can:** start through `agent_spawn`, report, request retirement and depth. `agent_adopt` takes a Cline pane, and Bellwether reads each child's conversation from a Cline `sessions.db`.
- **Cannot:** run on another machine, resume or move.
- **How:** each child gets Cline's sandbox mode and a data directory of its own. Its session then runs in the child's own process, with only the MCP server that `CLINE_MCP_SETTINGS_PATH` names. `-y` in `args` adds Cline's benchmark mode, and the spawn reply prints what that costs.

## Refusing a child no one can hear

A child calls `parent_report` through a Bellwether server or extension that holds its child id. When a harness has no such server, its entry says so. `agent_spawn` then refuses the spawn before it writes a record, a brief or a tab. The refusal reads:

```
worker was not started: Bellwether does not give an example child its own Bellwether server yet, so the child could not call parent_report. An example child can be adopted with agent_adopt once it runs, and its status changes still reach you; see docs/harnesses.md.
```

No kind here lacks one today.

## Cline, its hub and its sandbox mode

Cline 3.0.76 reads the MCP settings file that `CLINE_MCP_SETTINGS_PATH` names, so each child can have its own Bellwether server. The server loads in the process that runs the session, and Cline picks that process when the session starts.

### The shared hub

`cline -i` requests Cline's "auto" backend. That backend joins Cline's background hub when one runs, and starts one when none does.

The hub inherits the environment of the session that started it. It keeps running after that session ends, and its code has no idle exit. A second session that joins the hub runs there and loads the first session's MCP servers, so a second Bellwether child would report under the first child's id.

The terminal UI passes "auto" as an argument, and Cline reads `CLINE_SESSION_BACKEND_MODE` only when no argument specifies a backend.

### Each child in its own sandbox

The terminal UI runs the session in its own process, and doesn't start a hub, in two cases: under `-y`, and in sandbox mode. Cline turns sandbox mode on for `--data-dir <dir>` or `CLINE_SANDBOX=1`, and `CLINE_SANDBOX_DATA_DIR` names the directory. Sandbox mode keeps Cline's default mode, with all 26 built-in tools, skills, sub-agents and teams.

So `agent_spawn` starts each `cline` child with `CLINE_SANDBOX=1` and `CLINE_SANDBOX_DATA_DIR=~/.bellwether/cline/<child id>`. Children never share a process, and none of them starts or joins a hub. Your own Cline sessions keep using your hub, and they never load a child's server.

Sandbox mode moves Cline's data under that directory, including the session store, the messages and the provider settings. It keeps `~/.cline` itself, which holds skills, rules, workflows, hooks and plugins, and it keeps the MCP and global settings paths.

For the child to sign in as you do, the spawn links the child's `settings` directory to yours, `~/.cline/data/settings` by default. Cline replaces `providers.json` by renaming a new file over it inside that directory, so when the child refreshes a sign-in, Cline writes it to your own file. When `CLINE_PROVIDER_SETTINGS_PATH` points at a file with another name than `providers.json`, the link can't serve it, and the spawn refuses the child before it writes anything.

The spawn reply gives the child's data directory. The child's sessions sit in its own store, so `cline history` does not list them, and `agent_read` reads them. The directory stays after the child exits, so `agent_read` still answers then.

### With `-y`: benchmark mode, at a cost

Passing `-y` (or `--yolo`) in `args` also puts the child in Cline's benchmark mode. It stays up after its first task and answers a follow-up typed at its prompt, so `agent_send` reaches it. The spawn reply prints the cost when the caller turns it on:

- Another system prompt.
- Six built-in tools, `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `editor` and `ask_question`, plus the MCP tools, where the default mode offers 26.
- No skills, sub-agents or teams.
- Cline's own help, which calls `-y` "DANGEROUS: use only in sandboxed environments."

### The session store

Bellwether finds a spawned cline child's session in `~/.bellwether/cline/<child id>/db/sessions.db`. For an adopted pane, `agent_read` and the watcher use the newest live top-level session in the pane's directory, in your own Cline store. That store is at the first of these paths that applies:

- `CLINE_DB_DATA_DIR`
- `CLINE_DATA_DIR/db`
- `CLINE_DIR/data/db`
- `~/.cline/data/db`

## An older daemon

When a release changes a kind's entry, the running daemon must serve the argument `agent_spawn.kind=<kind>`. If the daemon predates the change, the call fails and reports the operation and the release that brought it. It never falls back to the old launch method ([upgrading](upgrading.md)). Bellwether has applied this check to the OpenCode, omp, Codex, kilo and Cline kinds since 0.1.5.

## Launch details

The [OpenCode](opencode.md) and [Codex](codex.md) topics cover the launch arguments, the session lookup and the refusals, and so does the [kilo](kilo.md) topic.

An omp child starts as `omp [--model provider/id] -e <pi extension>`, and takes its brief as a message once it runs. omp takes the model as one value, either `provider/id` or a name it matches, so `agent_spawn` refuses a separate `provider` for this kind.

Without a model, omp uses the default in its own settings. `agent_list` shows the model once omp writes the first `model_change` entry to its session file.

herdr's omp integration reports a tool approval and omp's `ask` tool as `blocked`, while a dialog from another omp extension shows as `idle`. The screen check names that dialog.
