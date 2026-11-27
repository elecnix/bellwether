# Running a child on Codex

Bellwether starts a child on Codex when `agent_spawn` receives `kind: "codex"`. The build and its checks target Codex 0.160.0.

A codex child can report to its parent (`parent_report`), ask to retire (`request_retirement`) and ask for more depth (`agent_request_depth`). Codex's approval policy refuses every other Bellwether tool, so a codex child can't start children or message another agent. Bellwether doesn't send keystrokes to a Codex dialog.

## Launch arguments

Bellwether asks herdr to start Codex with these arguments:

```sh
codex -a never -s workspace-write \
  -c 'projects={"<cwd>"={trust_level="trusted"}}' \
  -c 'mcp_servers.bellwether={command="<node>",args=[…,"--child","<child id>"],env_vars=[…],tools={parent_report={approval_mode="approve"},request_retirement={approval_mode="approve"},agent_request_depth={approval_mode="approve"}}}' \
  'Your task is in ~/.bellwether/prompts/<child id>.md. Read it, then do what it says.'
```

- `-a never` and `-s workspace-write` let the child work unattended. Codex never stops to ask, and a failing command goes back to the model. A caller's own `-a` or `-s` in `args` replaces the default, because Codex refuses either flag twice. Under `workspace-write`, a command can't write outside the working directory, so a worktree whose git directory sits elsewhere can't commit. Pass a sandbox that fits the task.
- A `projects` override marks the child's directory trusted for this run. Codex otherwise asks a folder-trust question on the first start in a git working tree. The operator approves every spawn, so Bellwether answers yes for any folder, as it does for Claude Code. It leaves `~/.codex/config.toml` unchanged.
- Another override, `mcp_servers.bellwether`, gives the child its own Bellwether server, which carries the child id. It replaces any server of that name in `~/.codex/config.toml`, for this run only. Codex starts a server with few variables, such as `HOME` and `PATH`, so `env_vars` forwards the seven variables that Bellwether's server reads: `BELLWETHER_PARENT`, `BELLWETHER_CHILD`, `BELLWETHER_DEPTH`, `BELLWETHER_HOME`, `BELLWETHER_DAEMON_SOCKET`, `HERDR_PANE_ID` and `HERDR_WORKSPACE_ID`.
- Codex asks before each MCP tool call, and under `-a never` it refuses the call. Its `tools` table pre-approves `parent_report`, `request_retirement` and `agent_request_depth` on this child's own server, and no other tool. The approval lives only on this child's launch line, so no other Codex session inherits it, and `~/.codex` never receives it.
- Its brief stays in `~/.bellwether/prompts/` with mode 0600. The prompt is one sentence that names it, and under `-a never` Codex reads it without a question.

herdr types the line into a shell and cuts any command at 1,024 bytes. When the line would pass that cap, the spawn fails before herdr starts Codex. That error reports the length.

Each tab sets `CODEX_HOME` to match the daemon. The daemon uses `~/.codex` unless its own environment names another home. The child and the daemon then read the same sessions.

## Finding the session

herdr detects Codex but doesn't report a session for it. herdr 0.9.5 lists a codex integration that would install a `SessionStart` hook, and without that hook herdr has no session to report. So Bellwether finds the session in Codex's own files. Codex writes one rollout per session, at `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<local time>-<session id>.jsonl`. The first line gives the session's id, working directory and start time. Each message follows on a line of its own.

Codex writes the rollout once the first prompt is in. For up to 30 seconds, the spawn waits for a rollout that

- started after Bellwether wrote the child's record,
- runs in the child's directory, as given or as resolved,
- does not belong to a subagent, and
- holds a user message with the brief's sentence.

The sentence points at the brief file, whose name is the child id, so only one session can match. The child record keeps the session id, the Codex home as `store`, and the rollout as `transcript`. Without a match, the spawn fails. Its error gives the sessions directory and what the last look found. The spawn closes the tab and keeps the brief file for inspection.

`agent_read` returns the last assistant message in the rollout. The watcher reads the same message for an `idle` event, and it counts a growing rollout as activity.

## Dialogs

Codex holds a pending approval in memory, not in the rollout. So Bellwether reads a dialog off the screen, where Codex marks the selected option with `›`.

Codex shows "Hooks need review" on the first start after `~/.codex/hooks.json` changes. Trusting a hook lets it run outside the sandbox, so Bellwether never answers that dialog, and no keystroke does either. The spawn fails and names the dialog. To continue, run `codex` once in a terminal, review the hooks, and spawn again. herdr can show the pane as `idle` while that dialog waits, so the spawn also checks the screen when the rollout never appears.

## Resume and refusals

`agent_spawn` with `resume` and `agent_restart` reopen a codex child with `codex … resume <session id>`, under the same child id. The session keeps its rollout.

The spawn refuses each of these before it opens a tab:

- A spawn without `cwd`, because the trust override and the session lookup both need the directory.
- A child on another machine. Its rollouts are on that machine, and Bellwether doesn't read them there yet.
- A daemon from a release before this harness, which refused codex. The client names `agent_spawn.kind=codex` with the release that brings it.

`agent_move` doesn't cover codex children.
