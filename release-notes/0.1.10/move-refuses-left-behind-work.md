---
prs: [232]
---
`agent_move` now refuses a child whose move would leave work on its current machine. Such work is either a background job that the child's session still runs, which ends when the tab closes, or a worktree the session worked in that has uncommitted changes, a stash or unpushed commits. The refusal gives each job and each worktree. To move anyway, pass `accept_loss`. The reply then lists what the move left behind.
