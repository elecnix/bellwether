# Moving a child to another machine

`agent_move` takes a live child off the machine it runs on and onto another one. It can bring the child back later the same way. The child keeps its id, its name and its conversation, so `agent_read`, `agent_send`, `agent_stop` and its reports keep working against the same child. Only claude and pi children move, and only to a machine that runs the same harness.

```text
agent_move child=worker machine=hawthorne cwd=/home/me/Source/repo/main
bellwether move worker --machine hawthorne --cwd /home/me/Source/repo/main
```

Leave out `machine` when the parent's machine knows exactly one other machine. Bellwether then picks that one. When `herdr machine list` shows more than one other machine, the call fails and names them. `local` names the parent's own machine. Leave out `cwd` when the child resumes in the directory it runs in now. That directory then has to exist on the other machine too.

To carry a stopped child, or to tell the child where it went before its first turn, use [agent_teleport](teleporting.md).

## What it needs

- Everything a [child on another machine](remote-machines.md) needs. Bellwether must run on both machines. The parent's machine also needs a saved herdr profile for the other one, and SSH to it with a key and no prompt. Bellwether on the other machine must also have the `move-*` commands, which `bellwether help` lists.
- The child's harness on the target machine, at a version at least as new as the one that wrote the session. For Claude Code, that is the newest version recorded in the transcript, and the one on the source machine. For pi, it is the version on the source machine.
- For a pi child, the provider and model pair the session last used, as `pi --list-models` offers it on the target. pi needs both together.
- The working directory on the target. Bellwether moves the conversation, not the repository. Check out the same work there first, such as a worktree of the same branch.
- An idle child. A move closes the child's tab, and that would cut a turn short.
- A recorded session, which herdr reports only through its integration for the harness on the child's machine. Run `herdr integration install pi`, or `claude`, on every machine a child may start on, before it starts.

`bellwether doctor` lists, for each known machine, the claude and pi versions, how many pi models it offers and the Bellwether version. When pi on a machine has no provider, doctor says pi there doesn't offer a pair. Other output from `pi --list-models`, such as an error line where the table should be, makes doctor report the models as unknown and quote that line, because it would rather say it does not know than count a sentence as a model. The same line says whether herdr on that machine has its claude and pi integrations, from the `integration.list` call a move makes there. A missing one comes with the `herdr integration install` command to run there, and a herdr that does not answer makes them unknown. For each live claude or pi child, it then says whether each other machine could take it, and why not. It checks the working directory only when the move runs.

## What it refuses

Bellwether checks every condition below before it changes anything on either machine. Each refusal says what failed.

- a different harness on the target, such as `kind: pi` for a claude child, because a session belongs to the harness that wrote it
- a harness that is missing on the target, or one with no reported version
- a target harness older than the one that wrote the session. An older harness may not read a newer session format, and the move would lose the conversation.
- a pi pair the target doesn't offer. The error gives the pair, and the `models.json` on the target that would need to declare it.
- a working directory that doesn't exist on the target
- a child that is working or blocked
- a child that has exited
- a child with no recorded session. When herdr on the child's machine lacks its integration for the harness, the refusal says so, and gives the `herdr integration install` command to run there before you spawn the child again.
- a child that another resume or move holds. The lock file under `~/.bellwether/locks/` is the same one a resume takes.
- a child that would leave work behind on the source, unless the call passes `accept_loss`. [Work left behind](#work-left-behind) says what counts.

## Work left behind

A session crosses to the other machine, but its processes and worktrees remain on the source. The source machine checks two things before the move changes anything. Each item it finds appears in the refusal.

- **A background job.** Every process that the child's tab starts has the child's id in its environment. That covers the pane's shell, the harness and its servers, all of which belong to the child. A move happens only between turns, so any shell the harness started that still runs is a background job, such as a gate suite or a `gh monitor` watch. So does a program the harness started more than a minute after its own start, such as the `gh monitor` that a pi extension runs, because the harness starts its servers as the session opens. A watch never finishes on its own, so a move always cuts it. Processes outside the harness's tree also count when they hold the id. Closing the tab ends every job, and the session on the target would then wait for a result that never arrives. The refusal gives each job's process id and command line.
- **A worktree with work that exists only there.** Checked directories are the child's working directory and each directory that the transcript shows the session working in. Claude Code records a working directory on each transcript entry, and each tool call's input holds paths. Bellwether skips output that a tool printed back. It checks each linked worktree among them, but not a main worktree or one where another live child stands. Retirement's checks judge each worktree. Such a worktree passes when it has no uncommitted path and no stash on its branch, and when a merge, a push or a merged pull request covers that branch. A detached HEAD counts as unproven, as it does for retirement.

Bellwether refuses too when it cannot tell, which happens if herdr does not report the pane's shell and foreground process, or if Bellwether on the source predates this check.

After the move, a `request_retirement` from the child reaches the parent's daemon. That daemon retires each worktree the child left on the parent's machine, including one from an earlier move. The record keeps every place the child left under `departures`, and the newest as `movedFrom` ([Retiring a child there](remote-machines.md#retiring-a-child-there)).

To move anyway, pass `accept_loss`, or `--accept-loss` to `bellwether move`. With that flag, the reply lists what the move left behind, and the `moved` line in `move.log` keeps the same list under `leftBehind`. Bellwether never changes a worktree or stops a job during a move.

## Order of operations

1. Bellwether resolves both ends: the child's machine and harness, and the target machine and the session file on the source.
2. It refuses on any condition above.
3. It copies the session to the target, to a path the harness reads from the target's working directory. The target computes that path from its own home and environment. Under Claude Code's state root, the path is `projects/<encoded directory>`. Under pi's agent directory, it is `sessions/--<encoded directory>--`. Bellwether copies a Claude Code transcript byte for byte, along with the directory of its tool results. It rewrites the header of a pi session to name the target's working directory, because pi opens a session in the directory that header names.
4. The target reads every file back. Each file must match the bytes and the SHA-256 checksum that the source sent. If a file from another conversation already sits at that path, the target refuses to overwrite it. An earlier copy of the same session is fine, because the new content starts with it. That happens when a child moves back.
5. Bellwether closes the child's tab on the source, then checks that herdr no longer shows the session there. The watcher ignores that close, so the parent hears no exit. Bellwether then reads the session again and copies it once more if the child wrote to it as it stopped.
6. It starts the child on the target with its harness's resume flag, under the same child id and name, and answers Claude Code's startup dialogs as a spawn does. A Claude Code child gets its MCP config from the target machine, which also records the child for the relay.
7. If the start fails, Bellwether removes the copy and starts the child again on the source. It uses the session file there, which the move never changed. The reply says the move failed and gives the child's pane.
8. On success, Bellwether keeps the copy and points the record at the new machine. From then on, the parent's daemon collects the child's reports there. Bellwether also removes the child's brief and MCP config from the machine it left. It drains each machine the child left once more, so a report the child left there still arrives, even after a quick chain of moves. Each outcome goes to `~/.bellwether/move.log` as one JSON line. The line includes both machines, the reason and the session paths.

The source machine keeps its copy of the session after a successful move, as history.

## Move outcomes

Each outcome in `move.log` says how far the move got:

| Outcome | What happened | Where the child runs |
| -- | -- | -- |
| `moved` | The child resumed on the target. | the target |
| `abandoned` | The copy or its check failed before the source stopped. Bellwether removed the copy. | the source, untouched |
| `rolled-back` | The target couldn't start the child. Bellwether removed the copy and started the child again on the source. | the source, in a new pane |
| `stranded` | The target couldn't start the child, and the restart on the source failed too. | nowhere. Call `agent_spawn` with `resume` to start it on the source, from the session named in the reply. |

## While a move runs

From the moment a move marks the child until it runs on the target, the child is unreachable, not exited. `agent_list` shows `moving to <machine> since <time>` in its state column, and `bellwether doctor` prints an `info  crossing:` line for it. The window lasts about two minutes at worst. It covers the copy and its check, up to 30 s for Claude Code's startup dialogs, and up to 30 s more for the child's session to connect. A teleport adds its notice, two copies at 20 s each. `MOVE_WINDOW_MS`, 15 minutes, bounds it.

A child left `stranded` keeps `crossingFailed` on its record, with the step, the error, the session file on the source and the resume that brings it back. `agent_list` adds `on neither machine since a crossing failed` to its state, and `bellwether doctor` prints a `fail` line until the child runs again.

## Recovering a move after the daemon stops

The mark on the child record names the daemon process that runs the move, the last step it finished, the files it copied and where the child ran before. A daemon that starts and finds a mark from another daemon process finishes or undoes that move. It goes by what the two machines show, because the old daemon may have stopped between an act and the mark for it:

| What the machines show | What the next daemon does | `move.log` |
| -- | -- | -- |
| The target runs the session. | It points the record at the target and keeps the copy. | `moved`, with `recovered: true` |
| The target doesn't run it, and the source still does. | It removes the copy and changes nothing else. | `abandoned`, with `recovered: true` |
| Neither runs it, and the child ran when the move began. | It removes the copy and resumes the child on the source, from its session there. | `rolled-back`, or `stranded` with `crossingFailed` when that resume fails |
| Neither runs it, and the child had stopped before the move began. | It removes the copy and leaves the child stopped. | `abandoned`, with `recovered: true` |
| Bellwether can't read one of the machines. | It doesn't change anything, so it never runs the session twice, and it tries again at its next start. Once the window has passed, doctor prints a `warn` line. | nothing yet |

## Trying a move across two machines

On the parent's machine, with Bellwether installed on both:

```sh
bellwether doctor                       # each machine's harness versions and models
bellwether spawn --kind claude --name mover --cwd ~/Source/repo/main --prompt 'Say hello, then wait.'
bellwether move mover --machine hawthorne --reason 'try a move'
bellwether read mover                   # the same conversation, from the new machine
bellwether move mover --machine local   # and back
tail -n 2 ~/.bellwether/move.log
```
