---
prs: [270]
---
A parent's `agent_stop` of a child that moved to another machine now retires each worktree that child left on the parent's machine, as the child's own `request_retirement` does. Before this change, the stop treated the whole child as out of bounds, so the worktree stayed until the child asked. The reply to the stop now lists each worktree the child has on another machine, where the parent's daemon has no way to run retirement's checks.
