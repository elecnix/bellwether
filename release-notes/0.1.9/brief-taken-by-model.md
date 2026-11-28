---
prs: [181]
---
A spawn counts a brief taken once the child's model begins a turn on it or reads it, rather than when its adapter receives it. It sends the brief once more when the model doesn't begin a turn, and fails with `BriefNotTaken` when the second copy doesn't start one either.
