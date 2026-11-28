---
prs: []
---
Each request that a session makes now ends by a deadline, and `bellwether doctor` prints every request still in flight with that deadline and the code that will end it. Doctor prints a `fail` line for a request past its deadline. A request is a restart that a session asked for of itself, a teleport that a child asked for, a move or teleport under way, or a retirement whose pane herdr no longer lists.

Before this change, four modules each decided when a request was over. A restart could wait for hours with no deadline, and an act that refused could leave a request that nothing would end.

The same owner also changes what follows.

- A daemon that recovers a teleport cut short by a stop now ends the child's own teleport request. The next daemon no longer arms a second teleport of a child already at its destination.
- A daemon that arms a waiting teleport again writes a fresh deadline, so doctor no longer reads the deadline of a wait that ended with the old daemon.
- Bellwether refuses a second teleport request while one waits, and the refusal gives the machine and time of the first.
- A retirement intent now lists every worktree the child has on another machine, whichever path wrote it.
