---
prs: [222]
---
An adopted child now exits when its pane starts another session, after a `/clear`, a `/resume` or a reused pane id. Its record keeps the session its parent adopted. Before, the watcher wrote the new session onto the old child id. One id then stood for two sessions, and a parent on another machine kept watching a pane that another parent had adopted.

Adopting a pane over a claim whose session has left it now removes that claim, so each session in a pane answers to one parent.
