# Harnesses

Each `agent_spawn` kind names the harness a child runs in. Bellwether's harness registry has one entry per kind. Each entry sets how the child starts, where its brief goes, how Bellwether finds its session and reads its conversation, how the child gets its Bellwether tools, and which of its states come from an API rather than from its screen.

## Capabilities by kind

| Kind | Starts | Brief | Session | Conversation | Reports through | Dialogs | Resume | Move | Other machine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pi` | yes | `@file`, attached | herdr, as a file path | session file | the Bellwether pi extension, loaded with `-e` | pi's extension | `--session` | yes | yes |
| `claude` | yes | `@file`, attached | herdr, as an id | transcript file | its own MCP server, through `--mcp-config` | a `Notification` hook | `--resume` | yes | yes |
| `opencode` | yes | a sentence that references a file in the working directory | the spawn picks the id and finds it in OpenCode's store | OpenCode's store | its own MCP server, named in `OPENCODE_CONFIG` | the screen | no | no | no |
| `codex` | no | none | none | none | not yet | the screen | no | no | none |
| `cline` | no | none | none | none | not yet | the screen | no | no | none |

herdr reports `working`, `idle`, `blocked` and `done` for every kind it detects. When a child's dialog shows as `idle`, Bellwether names it through the child's own adapter where one exists: pi's extension or Claude Code's hook. Otherwise it reads the screen before an `idle` event. The screen check looks for a selection list with a marked option, or for a question that takes y/n. Bellwether reports a dialog and never answers it, apart from Claude Code's startup questions ([tools](tools.md)).

## Refusing a child no one can hear

A child calls `parent_report` through a Bellwether server or extension that carries its child id. When a harness has no such server, its entry says so, and `agent_spawn` refuses it before it writes a record, a brief or a tab:

```
worker was not started: Bellwether does not give a codex child its own Bellwether server yet, so the child could not call parent_report. A codex child can be adopted with agent_adopt once it runs, and its status changes still reach you; see docs/harnesses.md.
```

Codex and Cline are in that state. herdr detects both, so `agent_adopt` can take a pane that runs either one, and its status changes still start your turns. Before this release, a spawn of either started a child whose reports went nowhere.

## An older daemon

When a release changes a kind's entry, the running daemon must serve the argument `agent_spawn.kind=<kind>`. If the daemon predates the change, the call fails and names the operation and the release that brought it. It never falls back to the old launch method ([upgrading](upgrading.md)). Bellwether has applied this check to OpenCode's kind since 0.1.5.

## Launch details

The topic for [OpenCode](opencode.md) covers the launch arguments, the store lookup and the refusals.
