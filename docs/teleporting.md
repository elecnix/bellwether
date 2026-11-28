# Teleporting a child to another machine

`agent_teleport` carries a child to another machine and restarts it there under the same child id, whether the child is live or stopped. Use it when a child needs more memory or CPU than its machine has, or when its machine is about to go down and the child's work should carry over instead of starting again.

```text
agent_teleport child=worker machine=hawthorne cwd=/home/me/Source/repo/main reason="needs more memory"
bellwether teleport worker --to hawthorne --cwd /home/me/Source/repo/main --reason "needs more memory"
```

Leave out `machine` when the parent's machine knows exactly one other machine. `local` refers to the parent's own machine. Leave out `cwd` when the child resumes at the same path it runs in now, which must exist at the destination.

## What Bellwether does

Bellwether performs three steps and no others.

1. At the destination, the child starts in a directory that already exists there and resumes its session. Bellwether copies the harness session and checks every byte of the copy, as [agent_move](moving.md) does.

2. Proof of life is the child's model reading the notice and starting a turn. When no turn follows, Bellwether falls back to herdr detecting the harness on the same session in the new pane, and the record labels that weaker proof `detected`.

3. Before its first turn, the child hears about the teleport. The notice arrives as a message in the child's session, never as keystrokes in its pane. It gives both machines and both directories, who asked and why, and what didn't cross.

## Preparing the destination

Whoever asks for the teleport prepares the destination before the child arrives, including any folder, worktree or assets the child needs. Bellwether never copies a worktree or creates a directory, and it moves only the conversation. Shell jobs and files outside the session stay on the source machine, and so does the worktree.

## Live and stopped children

- Bellwether carries a live, idle child the way `agent_move` does. It copies the session, then stops the child's tab on the source. If the session grew, it copies again. Finally, it starts the child at the destination.
- Bellwether also moves a stopped child, which `agent_move` refuses. The source machine must still answer the copy. Bellwether starts the child at the destination at once, because a child has to run to read its notice.
- Bellwether refuses a working or blocked child, because a teleport never cuts a turn short.

## The notice

The resumed session reads the notice as its first input, after Bellwether answers its startup dialogs. When the child has a brief it never read, that brief follows the notice in the same message, so nothing lands between them. A parent message sent during the teleport waits behind the notice.

When the session receives the notice but its model never starts a turn on it, the child keeps running at the destination, because the session is intact and stopping it would lose more than it saves. The reply's first line says the child wasn't told. Bellwether keeps the reason under `notice.undelivered`, logs `teleported-untold` in `teleport.log`, and the daemon offers the notice again when the child's session next connects. It never types the notice.

## What it refuses

Bellwether checks every condition below before it changes anything on either machine. Each refusal says what failed:

- a destination directory that doesn't exist. Bellwether doesn't create it.
- a destination harness older than the one that wrote the session, as `agent_move` refuses it
- a destination with no inbound path for the notice, such as a machine whose Bellwether predates `relay-message`. Bellwether refuses to teleport a child it cannot notify. This refusal is separate from the one for an older harness, because the repair differs.
- an adopted child. Its parent's record and the daemon that watches its pane can disagree about it ([#219](https://github.com/elecnix/bellwether/issues/219)), and a teleport would carry that disagreement along.
- every other refusal of `agent_move` (see [moving.md](moving.md)), including a move to the same machine, a missing recorded session, a pi pair the destination lacks, and a route on another machine

## Recovering from a failed start

When the destination can't start the child, Bellwether removes the copy there. It restarts a live child on its source, from the session still there. A stopped child keeps its record as it was and stays stopped.

## The record

Each child record keeps a `teleports` list, newest last. An entry gives the time, who asked and why, whether the child was live or stopped, the source and destination with their directories and panes, the session file and its size, how the notice arrived, and the proof that the child is alive. Bellwether writes one line per outcome to `teleport.log` in the Bellwether home.

`bellwether doctor` prints an `info` line for a teleport in the last day. Until the child reads its notice, doctor prints a `warn` line instead, with the reason Bellwether recorded.

## Limits

A parent session can't teleport, because its registry, spool, outbox and relay connections belong to the daemon on its own machine. Teleporting a parent would hand that daemon's registry to another daemon, a design question of its own ([#235](https://github.com/elecnix/bellwether/issues/235)).
