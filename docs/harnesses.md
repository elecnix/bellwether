# Harnesses

Each `agent_spawn` kind names the harness a child runs in, and Bellwether's harness registry has one entry per kind. An entry sets how the child starts and where its brief goes. It also says how Bellwether finds the session and reads the conversation, and which states come from an API rather than the screen. Finally, it sets how the child gets its Bellwether tools.

## Capabilities by kind

| Kind | Starts | Brief | Session | Conversation | Reports through | Dialogs | Resume | Move | Other machine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pi` | yes | `@file`, attached | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | pi's extension | `--session` | yes | yes |
| `claude` | yes | `@file`, attached | herdr, as an id | transcript file | its own MCP server, through `--mcp-config` | a `Notification` hook | `--resume` | yes | yes |
| `opencode` | yes | a sentence that references a file in the working directory | the spawn picks the id and finds it in OpenCode's store | OpenCode's store | its own MCP server, named in `OPENCODE_CONFIG` | the screen | no | no | no |
| `omp` | yes, after you run `herdr integration install omp` | `@file`, attached | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | herdr's omp integration, then the screen | `--session` | no | no |
| `codex` | no | none | none | none | not yet | the screen | no | no | none |
| `cline` | no | none | none | none | not yet | the screen | no | no | none |

herdr reports `working`, `idle`, `blocked` and `done` for every kind it detects. When a child's dialog shows as `idle`, Bellwether names it through the child's own adapter where one exists: pi's extension or Claude Code's hook. Otherwise it reads the screen before an `idle` event. The screen check looks for a selection list with a marked option, or for a question that takes y/n. Bellwether reports a dialog and never answers it, apart from Claude Code's startup questions ([tools](tools.md)).

## Each kind in three lines

Each kind has the same three bullets, so a reader can line up two kinds. The bullets give the child's abilities, its limits and its Bellwether tools.

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

- **Can:** report, request retirement, request depth, and start and message children of its own within its depth ceiling.
- **Cannot:** start until you run `herdr integration install omp`, since only that integration reports the child's state and session file to herdr. It cannot run on another machine yet, because the setting that skips omp's setup wizard reaches only a local tab. It cannot move, because `agent_move` finds only pi and Claude Code session files.
- **How:** the same Bellwether pi extension, passed with `-e`. omp runs pi extensions, and its extension API has every call this one makes. The extension stores this child's id, and the tab sets `OMP_SKIP_SETUP`, so omp's setup wizard doesn't block the brief. Bellwether answers no omp dialog.

### `codex` and `cline`

- **Can:** `agent_adopt` takes their pane once they run, and their status changes still start your turns.
- **Cannot:** run through `agent_spawn`, because Bellwether does not yet give either child its own Bellwether server.
- **How:** none yet. The spawn refuses rather than start a child whose reports would go nowhere.

## Refusing a child no one can hear

A child calls `parent_report` through a Bellwether server or extension that holds its child id. When a harness has no such server, its entry says so. `agent_spawn` then refuses the spawn before it writes a record, a brief or a tab. The refusal reads:

```
worker was not started: Bellwether does not give a codex child its own Bellwether server yet, so the child could not call parent_report. A codex child can be adopted with agent_adopt once it runs, and its status changes still reach you; see docs/harnesses.md.
```

Codex and Cline are in that state. Bellwether can't start either one yet. herdr detects both, so `agent_adopt` can take a pane that runs either one, and its status changes still start your turns. Before this release, a spawn of either one started a child whose reports went nowhere.

## An older daemon

When a release changes a kind's entry, the running daemon must serve the argument `agent_spawn.kind=<kind>`. If the daemon predates the change, the call fails and reports the operation and the release that brought it. It never falls back to the old launch method ([upgrading](upgrading.md)). Bellwether has applied this check to the OpenCode and omp kinds since 0.1.5.

## Launch details

The topic for [OpenCode](opencode.md) covers the launch arguments, the store lookup and the refusals.

An omp child starts as `omp [--model provider/id] -e <pi extension> @<brief>`. omp takes the model as one value, either `provider/id` or a name it matches, so `agent_spawn` refuses a separate `provider` for this kind.

Without a model, omp uses the default in its own settings. `agent_list` shows the model once omp writes the first `model_change` entry to its session file.

herdr's omp integration reports a tool approval and omp's `ask` tool as `blocked`, while a dialog from another omp extension shows as `idle`. The screen check names that dialog.
