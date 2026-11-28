---
prs: [222]
---
An adopted child now exits when its pane starts another session, after a `/clear`, a `/resume` or a reused pane id, and its record keeps the session its parent adopted. Before, the watcher wrote the new session onto the old child id, so one id stood for two sessions and two parents could watch one pane. Adopting a pane over a claim whose session has left it now removes that claim.
