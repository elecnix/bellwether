---
prs: [293]
---
A move or a teleport whose daemon stopped after it wrote the copy at the destination, but before the mark listed its files, no longer leaves those files behind. The destination now writes its own list of the files a copy plans before it writes the first one. Removing or keeping the copy then settles each file on that list. A copy written twice in one crossing also no longer keeps the first copy as a backup. Removing it now deletes the file that the crossing created.
