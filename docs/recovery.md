# Resuming, restarting, unsticking and retiring a child

## A child that stopped

Call `agent_spawn` with `resume` and a `prompt`. The target can be the child's name, its id or its session id. herdr decides what happens next, not the registry:

- When herdr still shows the child's session in the pane this parent started, the prompt goes there as an ordinary message.
- When herdr has no pane for the session, Bellwether opens a tab on the child's original machine and starts the harness with `--resume` for Claude Code or `--session` for Pi. The child keeps its id, so its events and receipts continue.
- When the registry and herdr disagree, herdr wins, and the reply opens with a line that says so.
- When the session runs in a pane this parent didn't start, Bellwether refuses and points at `agent_adopt`. It never types into that pane.

Passing `kind` with a session id that none of this parent's children ran starts a new child on that session, with `name`, `cwd` and `machine` as for a spawn.

Bellwether refuses a live agent that isn't a child, a harness with no resume flag, a retired child whose session it never recorded, and a target that doesn't match anything. Each refusal says what to pass instead.

A second call for the same child can't open a second tab. A lock file per child under `~/.bellwether/locks/` fails that call at once, naming the process that holds the lock. Each resume also locks the session itself, so two parents can't start one session in two panes either: one that knows the session as its child, and one that names it by its id. Bellwether takes over a lock whose process has exited or that is older than five minutes.

To resume a Claude Code child by hand, run `claude --resume <session id>`. The registry keeps the session id and the transcript path after the child exits.

### Briefs after a resume

If its provider has no key, a harness can exit before it reads its brief. The session then has no copy of the task, so a resume that sent only its own prompt would leave the child without its work. Bellwether keeps every brief a child starts on in a file of its own, and the record lists them as `briefs`.

The spawn's brief is `~/.bellwether/prompts/<child id>.md`. Each resume that brings a prompt writes the next number: `<child id>-2.md`, `<child id>-3.md`, and so on. Resumes never overwrite an earlier brief.

A child on another machine reads its own copy there, and this machine keeps the numbered files for the next resume.

Before it writes, a resume checks the record. Proof that the child read the newest brief is a report sent after Bellwether wrote that brief, a finished turn in the pane that started on it, or the read of the session message that carried it. With either one, the child gets only the new prompt. A status or a run time doesn't count, because a harness can run without reading anything.

Without that proof, the new file places the unread brief first and the prompt after it. Resuming with no prompt hands the unread brief over again.

The reply to such a resume gives the path of the file with the first brief. Any brief the child hasn't read stays on disk after the child exits or `agent_stop` closes it, and the prune keeps it too. Once the child has read its newest brief, its exit removes all the briefs, and the session transcript keeps the text.

## Restarting an agent

`agent_restart` restarts a session and keeps it. Its harness, session id and working directory stay the same, and the conversation continues in a new process. It takes an optional target, and with no target it restarts the session that called it. A target is a child's name, id or pane, or another session by its parent id, session id or pane. Either way the new tab opens first and the harness starts in it only after the old pane closes, so one process holds the session at a time and you have no old pane to close. A session alone in its herdr workspace keeps that workspace, because herdr closes a workspace with its last pane and the new tab is already in it. When herdr closes the workspace anyway, the session comes back in a new workspace under the old label.

Children come back in a new tab under the same child id, so their history, receipts and retire state continue. Bellwether closes the child's tab first, but only a pane Bellwether started, and only once the child is idle or done. Before anything closes, the record releases the pane, so the close counts as part of the restart. Without that step, a watcher would read it as the child exiting on its own.

Each new tab gets the same environment, label and directory, and the harness starts with `--resume` for Claude Code or `--session` for Pi. For a Claude Code child, the daemon writes the MCP configuration again and answers the spawn's startup dialogs as it does at spawn. Its record gains `restartedAt`.

One JSON line goes to `~/.bellwether/restart.log`. It records what it stopped and what it started. That line also records the new pane and whether herdr reported the session that the restart requested.

A parent session restarts from its own record, which stores its session id, its working directory and its pane. The daemon closes that pane only when herdr reports the same session id there. When herdr reports another session or another harness in it, the daemon refuses and leaves it open. A session that is itself a child restarts as that child, under its child id.

Pi sessions restart with the file under `~/.pi/agent/sessions` passed to `--session`. Claude Code sessions restart with `--resume` and the `plugin:bellwether@elecnix-plugins` channel flag, the one the install guide starts a parent with, so the new process loads Bellwether again. The daemon sends the accepting key to the channel question in the new pane.

The daemon refuses to restart a live agent that is missing from every registry, and it never starts a second copy of a running session. It closes only a pane it can identify from a registry. It also refuses a session that runs in a pane its record doesn't name, as after a resume by hand. Its record follows the session to that pane once its Bellwether adapter connects from there.

Sessions that restart themselves hear back first. That call records `restartRequestedAt` and registers the work with the daemon. It answers with what will happen.

Meanwhile, the daemon waits for herdr to report the caller idle or done, and only then closes the caller's pane and starts the new one. Closing that pane ends the caller's adapter, and the daemon finishes the restart anyway.

Killing its own caller mid-call would leave a tool with nowhere to send its answer. Anyone watching would see nothing happen. When a daemon stops during the wait, it runs the request again as soon as the session's service starts next.

A busy session may never end a turn, because each message it takes starts the next one. So while the restart waits, the daemon keeps that session's Bellwether events in the outbox, unread, and the new session receives them when it connects. The wait lasts 5 minutes, and the first reply states that limit. A second call while the restart waits reports what it waits for. It specifies the pane and the status herdr reports for it, with the time that status began. It also lists the held events and the children still working, along with messages delivered to the session by the daemon. `bellwether doctor` prints the same as an `info` line.

When the 5 minutes run out, the daemon reads the pane from herdr once, because herdr doesn't send an event for a pane whose status stays the same. An idle pane restarts. Any other status closes nothing. The record then keeps `restartStalled`, with the time, the request time, the pane and the cause. The cause identifies the live turn, or states that herdr didn't send a status for the pane.

The record also lists the children that were working and the messages delivered to the session during the wait. `restart.log` records `outcome: timeout` with the same cause, and the held events go to the session. The next `agent_restart` call starts a new wait.

Every request ends by its deadline, whatever it waits for (issue #220). An act refused after the turn ended, such as a pane that now runs another session, records `restartStalled` with the refusal, and `restart.log` records `outcome: refused`. A daemon that finds a request with no pane on its record gives up on it at once.

An older daemon could leave a request with no wait on its record. The next call replaces that request. `bellwether doctor` prints a `warn` line for each restart that gave up, with its pane and request time, until the session restarts. It prints a `warn` line too for a request that nothing waits on.

That reply includes the new pane, the tab and the session id, so the caller can report them instead of "restart requested".

A restart can close the old pane and then fail to start the session, which leaves the session gone. The record keeps `restartFailed`, with the time, the last pane, its workspace, the error and how to bring the session back. A child's parent receives one `exited` event that says the child did not come back from a restart. `bellwether doctor` prints a `fail` line for each such session, naming it and its last pane, until a restart, a resume or the session's own return clears it. The line in `~/.bellwether/restart.log` records `outcome: failed`.

herdr can close the old pane and still return an error for the close, as a timeout does. The restart now reads herdr's pane list before it decides what to do next. If the list no longer includes the old pane, the close worked. The restart then goes on, and the line in `restart.log` carries `closeError`.

When herdr does not reply to either request, the reply says the old pane's state is unknown, and `restart.log` records `outcome: failed` with `oldPaneState: unknown`. If the list still shows the pane instead, the restart closes the new tab and leaves everything else as it was.

While herdr closes the old pane, the record keeps that pane, marked `closing` for at most 30 seconds. Because of that mark, the watcher does not report the close as an exit, and a daemon that stops mid-close still leaves a record that points to a real pane.

Restarting a child that runs on another machine happens on that machine. The parent's daemon sends the request over the relay connection to the daemon there, which restarts the child through its own herdr under the same child id. The [Restarting a child there](remote-machines.md#restarting-a-child-there) section lists the cases it refuses.

The daemon refuses a restart when:

- the target has no recorded session, and the refusal includes the child and its pane
- the child runs on another machine, and that machine refuses the restart
- Bellwether did not start the pane of an adopted child
- the target is a live agent missing from every registry
- the parent's pane now holds another session or another harness
- the record contains a process marker instead of a session id
- the Pi session's file no longer exists
- herdr shows the pane with no agent
- the target is still mid-turn when the wait runs out
- the session runs in a pane other than the one its record names

By default the wait lasts 30 seconds, and `wait_seconds` raises it. It stays under 45 seconds so the call still answers inside the client's own timeout. One lock per target spans the wait and the restart, so two callers produce one restart. That second caller gets a refusal that reports the process that holds the lock.

## A session with no pane

A failed restart, a closed tab or a removed workspace can leave a session with no pane. `agent_spawn` with `resume` reopens only this session's own children, so it can't bring back a parent session. Its record keeps the values a person would otherwise type: the session and its folder, plus the workspace and the tab label. `bellwether resume` reads them and does the rest:

```sh
bellwether resume claude-code-<session id>
```

Name the session by registry id, session id or pi session file, or by the last pane it ran in. The daemon opens a tab in the session's folder and starts the harness on the session. Claude Code gets `--resume` with the Bellwether channel flag. pi gets `--session` with the session file. The tab goes in the session's workspace, or in a new one when herdr has removed it. Its label is the one the record keeps, or `<folder>-<end of the session id>`, and `--label` sets another. Last, the reply lists the pane, the tab, the workspace and the command, and it ends with the herdr link.

`bellwether resume` refuses, and opens nothing, when:

- no record matches the target, or more than one does, and the refusal lists them
- the session ran on another machine
- the folder on the record no longer exists
- the session file no longer exists, and the refusal states the file it looked for
- the session is a child of a parent on this machine, which brings it back under its child id with `agent_spawn` and `resume`, so its reports still reach that parent
- herdr shows a pane that already runs the session, which `agent_restart` restarts in place instead

Starting is a parent restart with no pane to close. It takes the same lock and writes the same `restartFailed` line when the harness doesn't come up.

### Finding a session with no pane

`bellwether doctor` prints one `info` line for each session on this machine that has lost its pane, newest first. After a day without a connection, a session drops off the list. Each line identifies the session and gives its folder and tab label. It then reports the last pane and what became of it, followed by the `bellwether resume` command:

```
info  session pi-<id> (pi session <id>, folder /work/repo): last pane w74:p1 closed, and herdr removed its workspace w74; its Bellwether connection closed at 2026-11-28T01:42:16.353Z. Resume it with `bellwether resume pi-<id>`.
```

For a child session, the line gives its parent and the `agent_spawn` call that resumes it, in place of the command.

Each session's record follows the pane its adapter last connected from, and keeps the time its last connection closed. So two sessions in one folder show different panes and different times.

For an exited child, `agent_list` says how its pane ended:

- the pane exited, with its exit code when herdr gave one
- the pane closed
- the pane went, and no event said how
- the harness exited and left the pane open on its shell
- a restart closed the pane and didn't start the session again

When herdr no longer lists the child's workspace, `agent_list` adds that herdr removed it.

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
4. No live child stands in the worktree or in a folder inside it, under any parent on this machine, and no process works inside it. The registry protects the working directory of a child that has not exited, whatever the process table shows, and the refusal gives that child's name, id, pane and parent session.

A resume, a restart and a move each take the child's lock, and the cleanup takes the same lock from its first check to the removal. A resume that arrives during the checks waits for the verdict. When a resume already has the lock, the cleanup leaves everything in place until the next exit or daemon start. Before it removes anything, it reads the child's record again. A child that came back keeps its worktree, and its record doesn't get an outcome ([#211](https://github.com/elecnix/bellwether/issues/211)).

The removal runs `git worktree remove` without `--force`, so git itself refuses a worktree that holds changes.

Bellwether leaves a child it adopted, a child on another machine, a detached HEAD and any main worktree in place. The one exception is the worktree a child left on the parent's machine when it moved away: a request from the moved child retires that worktree, as [Retiring a child there](remote-machines.md#retiring-a-child-there) describes. A worktree counts as main when its git directory is the repository itself, when git lists it first, when it has the default branch checked out, or when its name is `main` or `master`.

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
