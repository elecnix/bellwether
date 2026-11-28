---
prs: [228]
---
Self-restarts now end at their 5-minute deadline, when the daemon reads the pane once, since herdr doesn't send an event for an unchanged status. An idle pane restarts. Any other status, or none, gives up and records its cause. A restart refused after the turn ended is no longer pending: `restartStalled` keeps its request time, pane and refusal. A request with no pane on its record gives up at once, and the next call replaces one left with no wait.
