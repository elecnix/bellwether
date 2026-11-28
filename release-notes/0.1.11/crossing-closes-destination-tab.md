---
prs: [PR1]
---
A move or a teleport no longer runs its session on both machines when its daemon stops after it types the launch line at the destination, and before herdr reports the session there. The next daemon found nothing running at the destination, resumed the child on the source, and the destination's harness then came up as well, with nothing watching it.

Now the crossing records that tab in the mark before it types the launch line. The next daemon closes that tab before it resumes the child on the source. If the tab won't close, the next daemon leaves everything as it is and tries again at its next start.
