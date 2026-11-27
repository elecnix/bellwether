# Running a child on kilo

`agent_spawn` with `kind: "kilo"` starts a child on the Kilo CLI. Bellwether supports Kilo CLI 7, published on npm as `@kilocode/cli`, and its code targets 7.8.40. Kilo CLI 7 is a fork of OpenCode 1.x, so its store and flags differ from OpenCode 2's.

## Install the native binary under the name kilo

herdr detects kilo by the name of its process, `kilo`. npm's `kilo` is a Node launcher, and it runs the real binary under the name `.kilo`, so herdr never detects a child started through it and Bellwether can't watch that child. Put the native binary first on `PATH` under the name `kilo`:

```sh
npm install -g @kilocode/cli
ln -s "$(npm root -g)/@kilocode/cli/bin/.kilo" ~/.local/bin/kilo
```

When the daemon's `kilo` is a script, the spawn refuses before it opens a tab, and the error gives the same fix.

## Launch arguments and the session check

Each child starts with one argument that points at its brief:

```sh
kilo --prompt "Your task is in <cwd>/.bellwether/brief-<child id>.md. Read it, then do what it says."
```

- `--prompt` fills the first message and submits it. A `model` goes in front as `--model provider/model`.
- Bellwether writes the brief file to `.bellwether/` inside the child's working directory, with mode 0600. kilo asks for permission before it reads a file outside its directory, so a brief anywhere else would stop the child at a dialog.
- The child's tab sets `KILO_CONFIG` to the child's own configuration under `~/.bellwether/mcp/`, and `KILO_DB` to the store.

kilo refuses a `--session` id that it didn't create, so Bellwether can't pick the session id. herdr reports a kilo session only through herdr's own kilo integration, which an operator may not have installed. So the spawn finds the session in kilo's store and waits up to 30 seconds for a row that:

- has no parent session,
- sits in the child's directory,
- started after the spawn began,
- comes from Kilo CLI 7, and
- holds a user message with the prompt.

The prompt contains the path of the brief file, whose name includes the child id, so only the child's own session matches. Without such a row, the spawn fails. Its error gives the store and what the last check found. The spawn closes the tab and keeps the brief file for inspection.

When the daemon's environment sets `KILO_DB`, that file is the store. Otherwise it's `kilo.db` in kilo's data directory, `~/.local/share/kilo` by default. The child gets the same path, so both sides read one file. The child record keeps that path as `store`.

## Status, dialogs and the conversation

- **Status.** herdr reports `working`, `idle` and `blocked` for a kilo pane. With herdr's kilo integration installed, the status comes from kilo's own events. Without it, herdr reads the screen with its own rules for kilo.
- **Dialogs.** kilo keeps a pending permission in memory, not in its store. herdr's rule for kilo reads "Permission required" on the screen as `blocked`. Bellwether reports the dialog and never answers it.
- **Conversation.** `agent_read` and the watcher read the last answer from the `message` and `part` tables of the store, not from the screen.
- **Activity.** Each step writes a part, so the store shows activity without a screen read.

kilo's default agent runs MCP tools without a permission question, so the child's `parent_report` doesn't wait for approval. A permission rule in the operator's own kilo configuration still applies, and a question it raises reaches the parent as `blocked`.

## Refusals

The spawn refuses these before it writes a record:

- a `kilo` on the daemon's `PATH` that is a script, such as npm's launcher,
- a `kilo` whose version isn't 7, or whose `--version` output doesn't state a version,
- a spawn without `cwd`, because the brief goes inside it,
- a `model` that isn't in `provider/model` form, and
- a `machine` other than this one, because Bellwether reads the store and the version on the machine where the child runs.

`agent_move` doesn't move a kilo child. `agent_spawn` with `resume` and `agent_restart` reopen its session with `kilo --session <id>`.
