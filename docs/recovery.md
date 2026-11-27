# Resuming, unsticking and retiring a child

## A child that stopped

Call `agent_spawn` with `resume` and a `prompt`. The target can be the child's name, its id or its session id. herdr decides what happens next, not the registry:

- When herdr still shows the child's session in the pane this parent started, the prompt goes there as an ordinary message.
- When herdr has no pane for the session, Bellwether opens a tab on the child's original machine and starts the harness with `--resume` for Claude Code or `--session` for Pi. The child keeps its id, so its events and receipts continue.
- When the registry and herdr disagree, herdr wins, and the reply opens with a line that says so.
- When the session runs in a pane this parent didn't start, Bellwether refuses and points at `agent_adopt`. It never types into that pane.

Passing `kind` with a session id that none of this parent's children ran starts a new child on that session, with `name`, `cwd` and `machine` as for a spawn.

Bellwether refuses a live agent that isn't a child, a harness with no resume flag, a retired child whose session it never recorded, and a target that doesn't match anything. Each refusal says what to pass instead.

A second call for the same child can't open a second tab. A lock file per child under `~/.bellwether/locks/` fails that call at once, naming the process that holds the lock. Bellwether takes over a lock whose process has exited or that is older than five minutes.

To resume a Claude Code child by hand, run `claude --resume <session id>`. The registry keeps the session id and the transcript path after the child exits.

## A blocked or stuck child

When a `blocked` event arrives, the child waits on a question. Read its screen with `agent_read` and `lines`, then answer with `agent_send`. If herdr refuses a prompt to a blocked pane, `agent_send` sends keys instead.

A `stuck` event means herdr still reports the child as working, but nothing has changed for 10 minutes. Read its screen first. If the child hangs, stop it with `agent_stop` and `force`, then resume it as above.

With an `inactive` event, the child has been inactive for its threshold. It may have finished without reporting, so read its last message before you decide.

## Retiring a child

A child that has finished calls `request_retirement`, then closes its own tab. The call only records the request. It reports which checks already pass, such as uncommitted changes, stashes on the branch, and whether its commits exist anywhere else.

Once herdr reports the pane gone, the daemon removes the worktree and the branch, but only when all of these hold:

1. herdr lists neither the pane nor any pane in its tab.
2. The worktree isn't a main worktree, matches what the child asked about, has a clean status and no stash on its branch.
3. The default branch contains the branch, or GitHub shows a merged or closed pull request whose head is the branch's commit.
4. No process works inside the worktree.

Bellwether refuses a child it adopted, a child on another machine, a detached HEAD and any main worktree. A worktree counts as main when its git directory is the repository itself, when git lists it first, when it has the default branch checked out, or when its name is `main` or `master`.

On the child record, `retireOutcome` shows `removed` or `refused`. After a refusal, `retireReason` states the failed check and what a person would do about it. Each outcome also goes to `~/.bellwether/retire.log` as one JSON line. After a restart mid-retirement, the daemon finishes the remaining steps. Resuming a child cancels its request.
