---
prs: [294]
---
An `idle` event from a child on another machine now quotes the child's last message, read over the relay connection, where it used to quote the child's screen, often an empty Claude Code prompt. When the read fails, the event says so and labels the screen lines it gives instead. A child that moved away no longer quotes the transcript it left on the parent's machine, which ends before the move.
