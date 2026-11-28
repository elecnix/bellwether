---
prs: [194]
---
A daemon finds herdr through HERDR_BIN_PATH, its inherited PATH, the login shell's PATH and the usual install directories, so a daemon started over SSH no longer fails every herdr command with `spawn herdr ENOENT`. Doctor fails when the running daemon can't find herdr, and lists each place it looked.
