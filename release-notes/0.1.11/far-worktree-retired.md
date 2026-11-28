---
prs: [288]
---
Once a child's pane closes, the daemon on each other machine where the child worked now retires its worktree there, at the parent's request. That daemon runs retirement's checks against its own git and process table, and removes the worktree only when they pass. A machine with no connection from the parent's daemon keeps its worktree, with the machine and the directory on the record. Before this change, every such worktree stayed until a person removed it by hand.
