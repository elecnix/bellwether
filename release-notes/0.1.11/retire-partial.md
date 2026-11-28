---
prs: [284]
---
Retirement now ends `partial` rather than `removed` when a child still has a worktree it did not remove. That worktree can be on another machine, where the parent's daemon can't run retirement's checks. It can also be here, after it failed them. The record, the `retire.log` line and the reply to `agent_stop` give its path and machine, and `agent_list` shows `retired in part`. Before, `agent_stop` of a child that had teleported back said `Retired: removed worktree …`, and nothing pointed at the worktree on the other machine.
