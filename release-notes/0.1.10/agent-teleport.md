---
prs: []
---
`agent_teleport` and `bellwether teleport` move a child to another machine and start it there under the same child id, whether the child is live or stopped. Before its first turn, the child's session reads a notice that gives both machines and both directories, who asked for the move, and why. Bellwether delivers the notice as a message and never types it into the pane.

Bellwether refuses a destination directory that does not exist, a destination harness older than the one that wrote the session, a destination with no inbound path for the notice, and an adopted child. It never copies a worktree. Whoever asks for the teleport prepares the destination first.
