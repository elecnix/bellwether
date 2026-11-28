---
prs: []
---
Retirement now ends `partial` rather than `removed` when it removes a child's worktree on the parent's machine but the child has another worktree that is still there. That other worktree is on another machine, where the parent's daemon can't run retirement's checks, or the child left it here and it failed them.

The record, the `retire.log` line and the reply to `agent_stop` or `agent_list` each give the path and machine of that worktree. Before this change, `agent_stop` of a child that had teleported back from another machine said `Retired: removed worktree …`, and nothing pointed at the worktree left on the other machine.
