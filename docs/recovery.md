# Resuming, restarting, unsticking and retiring a child

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

### Briefs after a resume

If its provider has no key, a harness can exit before it reads its brief. The session then has no copy of the task, so a resume that sent only its own prompt would leave the child without its work. Bellwether keeps every brief a child starts on in a file of its own, and the record lists them as `briefs`.

The spawn's brief is `~/.bellwether/prompts/<child id>.md`. Each resume that brings a prompt writes the next number: `<child id>-2.md`, `<child id>-3.md`, and so on. Resumes never overwrite an earlier brief.

A child on another machine reads its own copy there, and this machine keeps the numbered files for the next resume.

Before it writes, a resume checks the record. Proof that the child read the newest brief is a report sent after Bellwether wrote that brief, a finished turn in the pane that started on it, or the read of the session message that carried it. With either one, the child gets only the new prompt. A status or a run time doesn't count, because a harness can run without reading anything.

Without that proof, the new file places the unread brief first and the prompt after it. Resuming with no prompt hands the unread brief over again.

The reply to such a resume gives the path of the file with the first brief. Any brief the child hasn't read stays on disk after the child exits or `agent_stop` closes it, and the prune keeps it too. Once the child has read its newest brief, its exit removes all the briefs, and the session transcript keeps the text.

## Restarting an agent

`agent_restart` restarts a session and keeps it. Its harness, session id and working directory stay the same, and the conversation continues in a new process. It takes an optional target, and with no target it restarts the session that called it. A target is a child's name, id or pane, or another session by its parent id, session id or pane. Either way the old pane closes before the new one starts, so one process holds the session at a time and you have no old pane to close.

Children come back in a new tab under the same child id, so their history, receipts and retire state continue. Bellwether closes the child's tab first, but only a pane Bellwether started, and only once the child is idle or done. Before anything closes, the record releases the pane, so the close counts as part of the restart. Without that step, a watcher would read it as the child exiting on its own.

Each new tab gets the same environment, label and directory, and the harness starts with `--resume` for Claude Code or `--session` for Pi. For a Claude Code child, the daemon writes the MCP configuration again and answers the spawn's startup dialogs as it does at spawn. Its record gains `restartedAt`.

One JSON line goes to `~/.bellwether/restart.log`. It records what it stopped and what it started. That line also records the new pane and whether herdr reported the session that the restart requested.

A parent session restarts from its own record, which stores its session id, its working directory and its pane. The daemon closes that pane only when herdr reports the same session id there. When herdr reports another session or another harness in it, the daemon refuses and leaves it open. A session that is itself a child restarts as that child, under its child id.

Pi sessions restart with the file under `~/.pi/agent/sessions` passed to `--session`. Claude Code sessions restart with `--resume` and the `plugin:bellwether@elecnix-plugins` channel flag, the one the install guide starts a parent with, so the new process loads Bellwether again. The daemon sends the accepting key to the channel question in the new pane.

The daemon refuses to restart a live agent missing from every registry. It closes only a pane it can identify from a registry, and it never starts a second copy of a running session.

Sessions that restart themselves hear back first. That call records `restartRequestedAt` and registers the work with the daemon. It answers with what will happen.

Meanwhile, the daemon waits for herdr to report the caller idle or done, and only then closes the caller's pane and starts the new one. Closing that pane ends the caller's adapter, and the daemon finishes the restart anyway.

Killing its own caller mid-call would leave a tool with nowhere to send its answer. Anyone watching would see nothing happen. When a daemon stops during the wait, it runs the request again as soon as the session's service starts next.

That reply includes the new pane, the tab and the session id, so the caller can report them instead of "restart requested".

The daemon refuses a restart when:

- the target has no recorded session, and the refusal includes the child and its pane
- the child runs on another machine
- Bellwether did not start the pane of an adopted child
- the target is a live agent missing from every registry
- the parent's pane now holds another session or another harness
- the record contains a process marker instead of a session id
- the Pi session's file no longer exists
- herdr shows the pane with no agent
- the target is still mid-turn when the wait runs out

By default the wait lasts 30 seconds, and `wait_seconds` raises it. It stays under 45 seconds so the call still answers inside the client's own timeout. One lock per target spans the wait and the restart, so two callers produce one restart. That second caller gets a refusal that reports the process that holds the lock.

## A blocked or stuck child

When a `blocked` event arrives, the child waits on a question. Read its screen with `agent_read` and `lines`, then answer with `agent_send`. If herdr refuses a prompt to a blocked pane, `agent_send` sends keys instead.

A `stuck` event means herdr still reports the child as working, but nothing has changed for 10 minutes. Read its screen first. If the child hangs, stop it with `agent_stop` and `force`, then resume it as above.

With an `inactive` event, the child has been inactive for its threshold. It may have finished without reporting, so read its last message before you decide.

## Retiring a child

A child never removes its own worktree. Its harness starts commands in that directory, and pi resets to it before every command, so a child that deletes it fails each command after that, `cd ~` included. The daemon removes the worktree after the tab closes, and only when it can prove the work exists somewhere else.

A finished child calls `request_retirement` and then closes its own tab. The worktree stays where it is. Alternatively, a parent's `agent_stop` closes a child and retires it, whether or not the child asked. Either call records the worktree and the branch on the child record before the tab closes. The stop and herdr's report that the pane closed both start the cleanup. It runs once, from whichever finds the pane gone first, and never waits for a daemon restart.

Once herdr reports the pane gone, the daemon removes the worktree and the branch, but only when all of these hold:

1. herdr lists neither the pane nor any pane in its tab.
2. The worktree isn't a main worktree, matches the one recorded, has a clean status and no stash on its branch.
3. One of three proofs shows the work exists elsewhere:
   - The default branch contains the branch's tip.
   - Every commit on the branch is on a remote branch as of the last fetch.
   - GitHub shows a merged pull request whose head is the tip.

   A pull request closed without merging doesn't count as a proof.
4. No process works inside the worktree.

The removal runs `git worktree remove` without `--force`, so git itself refuses a worktree that holds changes.

Bellwether leaves a child it adopted, a child on another machine, a detached HEAD and any main worktree in place. A worktree counts as main when its git directory is the repository itself, when git lists it first, when it has the default branch checked out, or when its name is `main` or `master`.

`agent_stop` waits up to 10 seconds for the cleanup, and its reply ends with one line about the worktree:

| Case | The line |
| --- | --- |
| Removed | `Retired: removed worktree <dir> and branch <branch>, because <proof>.` |
| No proof | `Retirement left worktree <dir> and branch <branch> in place, because Bellwether could not prove the work merged: <what git found>. Push the branch or merge it, then remove the worktree and the branch by hand.` |
| Another check failed | `Retirement left worktree <dir> and branch <branch> in place, because <the check and what to do>` |
| Pane still listed | `Retirement pending: Bellwether removes worktree <dir> and branch <branch> once herdr no longer lists the pane, if it can still prove the work merged. agent_list and retire.log show the outcome.` |
| Not a git worktree | `Its working directory <dir> is not a git worktree, so retirement leaves it in place.` |
| Main worktree | `Retirement leaves <dir> in place: it is the repository's main worktree (<why>), and Bellwether never removes a main worktree.` |
| Directory already gone | `<name>'s working directory <dir> no longer exists, so retirement had no worktree left to remove.` |

On the child record, `retireOutcome` shows `removed` or `refused`. After a removal, `retireProof` names the proof. After a refusal, `retireReason` states the failed check and what a person would do about it.

Each outcome also goes to `~/.bellwether/retire.log` as one JSON line, and `agent_read` puts the line above the child's last message. After a restart mid-retirement, the daemon finishes the remaining steps. Resuming a child cancels its request. Bellwether refuses to resume a child whose retirement removed its worktree until the directory exists again.

## A working directory that no longer exists

When a child's working directory no longer exists, `agent_read` says so on its first line, before the child's last message, and `request_retirement` refuses with the same news. The child's Bellwether tools don't run in that directory, so it can still call `parent_report`. `agent_stop` still closes it.

## Pruning old parent records, briefs and logs

Every session that says hello writes a parent record under `~/.bellwether/parents/`, and each spawn writes a brief and, for Claude Code, an MCP configuration. The daemon prunes these files a minute after it starts, then every hour. `parentVerdict` and `childFileVerdict` in `src/core/hygiene.ts` decide what goes.

The daemon keeps a parent record while any of these is true:

- a session of that parent has a connection to the daemon;
- one of its children has not exited;
- its outbox contains an unread event, or its spool contains a report the parent has not read;
- it asked for a restart, or one of its children is partway through retirement.

When none of them is true, the record goes with its outbox and spool, once it has been quiet for its period:

| Record | Period | Why |
| --- | --- | --- |
| never had a child | 1 hour | It stores only the session's identity, which the next hello writes again. |
| had children, all exited | 7 days | A resumed session finds its children by it, and a person resumes an exited child by name. |

Briefs and MCP configurations go once their child exits or a prune removes its record. A brief the child never read stays until its record goes, so a resume can still hand it over. A spawn writes these files a moment before it saves the record, so a file whose child is missing from every record gets an hour's grace. Files of a child that runs here for a parent on another machine stay until `bellwether relay-cleanup` removes them.

Logs rotate at 1 MiB: `retire.log`, `move.log` and `restart.log` each move to `<name>.1`, replacing the older copy. Each fresh log starts with one line that names that file, so each log keeps at most 2 MiB.

`bellwether doctor` shows the growth before it becomes a problem:

```
  info  state: 65 parent records, 42 stale; 6 briefs, 6 MCP configurations; 3 outbox files holding 0 unread events; 3 spool files
  info  logs: retire.log 1 KiB, each moved to <name>.1 past 1 MiB
  info  prune: last ran 2026-11-27T09:00:00.000Z, removed 42 parent records
```

Stale means the next prune would remove it. Doctor's prune line comes from `~/.bellwether/hygiene.json`. Parents with a running child each get a line of their own, while the rest appear in the count.
